import { parsePoolSchedulerPolicy, schedulerDraw, upstreamCostFactors, type PoolSchedulerPolicy, type PoolSchedulerMetric } from "./pool-scheduler";
const POOL_SCHEMA_VERSION = 1 as const;

export type PoolLeaseStatus = "active" | "released" | "expired";

export interface PoolAccountState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  account_id: string;
  enabled: boolean;
  max_concurrency: number;
  priority: number;
  weight: number;
  recovery_revision: number;
  consecutive_failures: number;
  cooldown_until_ms: number;
  updated_at_ms: number;
}

export interface PoolLeaseState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  request_id: string;
  account_id: string;
  status: PoolLeaseStatus;
  expires_at_ms: number;
  renewal_sequence: number;
  last_renewal_ttl_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PoolAffinityState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  affinity_key: string;
  account_id: string;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PoolMachineState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  config_revision: number;
  config_fingerprint: string;
  accounts: Record<string, PoolAccountState>;
  leases: Record<string, PoolLeaseState>;
  affinities: Record<string, PoolAffinityState>;
  failure_events: Record<string, string>;
  scheduler_metrics?: Record<string, PoolSchedulerMetric>;
}

type PoolCommandEnvelope = { schema_version: typeof POOL_SCHEMA_VERSION };

export type PoolCommand = PoolCommandEnvelope &
  (
    | {
        type: "sync_accounts";
        config_revision: number;
        config_fingerprint: string;
        accounts: Array<{
          account_id: string;
          max_concurrency: number;
          priority: number;
          weight: number;
          /** Absent only for callers predating account recovery support. */
          recovery_revision?: number;
        }>;
      }
    | {
        type: "upsert_account";
        account_id: string;
        enabled: boolean;
        max_concurrency: number;
        priority?: number;
        weight?: number;
      }
    | {
        type: "reserve";
        request_id: string;
        lease_ttl_ms: number;
        preferred_account_id?: string;
        excluded_account_ids?: string[];
        affinity_key?: string;
        affinity_ttl_ms?: number;
        scheduler?: PoolSchedulerPolicy;
        account_cost_rates?: Record<string,number>;
        previous_account_id?:string;
        require_previous_account?:boolean;
      }
    | {
        type: "renew";
        request_id: string;
        renewal_sequence: number;
        lease_ttl_ms: number;
      }
    | { type: "release"; request_id: string }
    | {
        type: "failure";
        event_id: string;
        account_id: string;
        cooldown_ms: number;
      }
  );

export interface PoolTransition {
  state: PoolMachineState;
  idempotent: boolean;
  lease: PoolLeaseState | null;
}

export class PoolStateMachineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PoolStateMachineError";
  }
}

export function createPoolMachineState(): PoolMachineState {
  return {
    schema_version: POOL_SCHEMA_VERSION,
    config_revision: 0,
    config_fingerprint: "",
    accounts: {},
    leases: {},
    affinities: {},
    failure_events: {},
  };
}

export function applyPoolCommand(
  inputState: PoolMachineState,
  command: PoolCommand,
  nowMs: number,
): PoolTransition {
  assertNonNegativeSafeInteger(nowMs, "now_ms");
  if (command.schema_version !== POOL_SCHEMA_VERSION) {
    throw new PoolStateMachineError("unsupported_schema_version", "Unsupported schema_version");
  }

  const state = reclaimExpiredAffinities(reclaimExpiredLeases(inputState, nowMs), nowMs);
  switch (command.type) {
    case "sync_accounts":
      return syncAccounts(state, command, nowMs);
    case "upsert_account":
      return upsertAccount(state, command, nowMs);
    case "reserve":
      return reserve(state, command, nowMs);
    case "renew":
      return renew(state, command, nowMs);
    case "release":
      return release(state, command.request_id, nowMs);
    case "failure":
      return recordFailure(state, command, nowMs);
  }
}

function syncAccounts(
  state: PoolMachineState,
  command: Extract<PoolCommand, { type: "sync_accounts" }>,
  nowMs: number,
): PoolTransition {
  if (!Number.isSafeInteger(command.config_revision) || command.config_revision <= 0) {
    throw new PoolStateMachineError(
      "invalid_config_revision",
      "config_revision must be a positive safe integer",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(command.config_fingerprint)) {
    throw new PoolStateMachineError(
      "invalid_config_fingerprint",
      "config_fingerprint must be a lowercase SHA-256 digest",
    );
  }
  if (command.config_revision === state.config_revision) {
    if (command.config_fingerprint !== state.config_fingerprint) {
      throw new PoolStateMachineError(
        "config_revision_conflict",
        "config_revision was already applied with different accounts",
      );
    }
    return { state, idempotent: true, lease: null };
  }
  if (command.config_revision < state.config_revision) {
    return { state, idempotent: true, lease: null };
  }

  const configuredIds = new Set<string>();
  const accounts: Record<string, PoolAccountState> = {};
  for (const configured of command.accounts) {
    assertIdentifier(configured.account_id, "account_id");
    if (configuredIds.has(configured.account_id)) {
      throw new PoolStateMachineError("duplicate_account", "accounts contains a duplicate account_id");
    }
    configuredIds.add(configured.account_id);
    if (!Number.isSafeInteger(configured.max_concurrency) || configured.max_concurrency <= 0) {
      throw new PoolStateMachineError(
        "invalid_max_concurrency",
        "max_concurrency must be a positive safe integer",
      );
    }
    assertNonNegativeSafeInteger(configured.priority, "priority");
    if (!Number.isSafeInteger(configured.weight) || configured.weight <= 0) {
      throw new PoolStateMachineError("invalid_weight", "weight must be a positive safe integer");
    }
    const recoveryRevision = configured.recovery_revision ?? 0;
    assertNonNegativeSafeInteger(recoveryRevision, "recovery_revision");
    const existing = state.accounts[configured.account_id];
    const recovered = (existing?.recovery_revision ?? 0) < recoveryRevision;
    accounts[configured.account_id] = {
      schema_version: POOL_SCHEMA_VERSION,
      account_id: configured.account_id,
      enabled: true,
      max_concurrency: configured.max_concurrency,
      priority: configured.priority,
      weight: configured.weight,
      recovery_revision: recoveryRevision,
      consecutive_failures: recovered ? 0 : (existing?.consecutive_failures ?? 0),
      cooldown_until_ms: recovered ? 0 : (existing?.cooldown_until_ms ?? 0),
      updated_at_ms: nowMs,
    };
  }
  for (const existing of Object.values(state.accounts)) {
    if (configuredIds.has(existing.account_id)) continue;
    accounts[existing.account_id] = existing.enabled
      ? { ...existing, enabled: false, updated_at_ms: nowMs }
      : existing;
  }
  return {
    state: {
      ...state,
      config_revision: command.config_revision,
      config_fingerprint: command.config_fingerprint,
      accounts,
      affinities: Object.fromEntries(
        Object.entries(state.affinities).filter(([, affinity]) => configuredIds.has(affinity.account_id)),
      ),
    },
    idempotent: false,
    lease: null,
  };
}

export function reclaimExpiredLeases(state: PoolMachineState, nowMs: number): PoolMachineState {
  let leases = state.leases;
  for (const [requestId, lease] of Object.entries(state.leases)) {
    if (lease.status !== "active" || lease.expires_at_ms > nowMs) continue;
    if (leases === state.leases) leases = { ...state.leases };
    leases[requestId] = {
      ...lease,
      status: "expired",
      updated_at_ms: nowMs,
    };
  }
  return leases === state.leases ? state : { ...state, leases };
}

export function reclaimExpiredAffinities(state: PoolMachineState, nowMs: number): PoolMachineState {
  let affinities = state.affinities;
  for (const [affinityKey, affinity] of Object.entries(state.affinities)) {
    if (affinity.expires_at_ms > nowMs) continue;
    if (affinities === state.affinities) affinities = { ...state.affinities };
    delete affinities[affinityKey];
  }
  return affinities === state.affinities ? state : { ...state, affinities };
}

function upsertAccount(
  state: PoolMachineState,
  command: Extract<PoolCommand, { type: "upsert_account" }>,
  nowMs: number,
): PoolTransition {
  assertIdentifier(command.account_id, "account_id");
  if (!Number.isSafeInteger(command.max_concurrency) || command.max_concurrency <= 0) {
    throw new PoolStateMachineError(
      "invalid_max_concurrency",
      "max_concurrency must be a positive safe integer",
    );
  }
  const priority = command.priority ?? existingPriority(state, command.account_id);
  const weight = command.weight ?? existingWeight(state, command.account_id);
  assertNonNegativeSafeInteger(priority, "priority");
  if (!Number.isSafeInteger(weight) || weight <= 0) {
    throw new PoolStateMachineError("invalid_weight", "weight must be a positive safe integer");
  }

  const existing = state.accounts[command.account_id];
  if (
    existing?.enabled === command.enabled &&
    existing.max_concurrency === command.max_concurrency &&
    existing.priority === priority &&
    existing.weight === weight &&
    (command.enabled || !Object.values(state.affinities).some(
      (affinity) => affinity.account_id === command.account_id,
    ))
  ) {
    return { state, idempotent: true, lease: null };
  }

  const account: PoolAccountState = {
    schema_version: POOL_SCHEMA_VERSION,
    account_id: command.account_id,
    enabled: command.enabled,
    max_concurrency: command.max_concurrency,
    priority,
    weight,
    recovery_revision: existing?.recovery_revision ?? 0,
    consecutive_failures: existing?.consecutive_failures ?? 0,
    cooldown_until_ms: existing?.cooldown_until_ms ?? 0,
    updated_at_ms: nowMs,
  };
  return {
    state: {
      ...state,
      accounts: { ...state.accounts, [account.account_id]: account },
      affinities: command.enabled
        ? state.affinities
        : withoutAccountAffinities(state.affinities, command.account_id),
    },
    idempotent: false,
    lease: null,
  };
}

function reserve(
  state: PoolMachineState,
  command: Extract<PoolCommand, { type: "reserve" }>,
  nowMs: number,
): PoolTransition {
  assertIdentifier(command.request_id, "request_id");
  if (!Number.isSafeInteger(command.lease_ttl_ms) || command.lease_ttl_ms <= 0) {
    throw new PoolStateMachineError("invalid_lease_ttl", "lease_ttl_ms must be a positive safe integer");
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - command.lease_ttl_ms) {
    throw new PoolStateMachineError("invalid_lease_ttl", "Lease expiry exceeds safe integer range");
  }
  const hasAffinityKey = command.affinity_key !== undefined;
  const hasAffinityTtl = command.affinity_ttl_ms !== undefined;
  if (hasAffinityKey !== hasAffinityTtl) {
    throw new PoolStateMachineError(
      "invalid_affinity_ttl",
      "affinity_key and affinity_ttl_ms must be provided together",
    );
  }
  if (command.affinity_key !== undefined && !/^[a-f0-9]{64}$/.test(command.affinity_key)) {
    throw new PoolStateMachineError(
      "invalid_affinity_key",
      "affinity_key must be a lowercase SHA-256 digest",
    );
  }
  if (
    command.affinity_ttl_ms !== undefined &&
    (!Number.isSafeInteger(command.affinity_ttl_ms) || command.affinity_ttl_ms <= 0)
  ) {
    throw new PoolStateMachineError(
      "invalid_affinity_ttl",
      "affinity_ttl_ms must be a positive safe integer",
    );
  }
  if (
    command.affinity_ttl_ms !== undefined &&
    nowMs > Number.MAX_SAFE_INTEGER - command.affinity_ttl_ms
  ) {
    throw new PoolStateMachineError(
      "invalid_affinity_ttl",
      "Affinity expiry exceeds safe integer range",
    );
  }

  const existingLease = state.leases[command.request_id];
  if (existingLease !== undefined) {
    return { state, idempotent: true, lease: existingLease };
  }

  const activeCounts = activeLeaseCounts(state);
  const excludedAccountIds = new Set(command.excluded_account_ids ?? []);
  for (const accountId of excludedAccountIds) assertIdentifier(accountId, "excluded_account_id");
  let candidates = Object.values(state.accounts).filter(
    (account) =>
      account.enabled &&
      !excludedAccountIds.has(account.account_id) &&
      (!command.require_previous_account || account.account_id===command.previous_account_id) &&
      account.cooldown_until_ms <= nowMs &&
      (activeCounts[account.account_id] ?? 0) < account.max_concurrency,
  );

  const scheduler = command.scheduler === undefined ? undefined : parsePoolSchedulerPolicy(command.scheduler);
  if (command.preferred_account_id !== undefined) {
    assertIdentifier(command.preferred_account_id, "preferred_account_id");
    const preferred = candidates.find(
      (account) => account.account_id === command.preferred_account_id,
    );
    if (preferred !== undefined) candidates = [preferred];
  } else if (command.affinity_key !== undefined && !(scheduler?.enabled && scheduler.sticky_weighted)) {
    const affinity = state.affinities[command.affinity_key];
    const preferred = affinity === undefined
      ? undefined
      : candidates.find((account) => account.account_id === affinity.account_id);
    if (preferred !== undefined) candidates = [preferred];
  }

  const rates=command.account_cost_rates ?? {};
  const knownRates=candidates.map(a=>rates[a.account_id]).filter((rate):rate is number=>Number.isFinite(rate) && rate>=0);
  const preferRate=!scheduler?.enabled && scheduler?.legacy_low_rate_priority && knownRates.length>=2 && knownRates.some(rate=>rate!==knownRates[0]);
  candidates.sort((left, right) => {
    if(preferRate) {
      const l=rates[left.account_id],r=rates[right.account_id];
      const lk=Number.isFinite(l)&&l>=0,rk=Number.isFinite(r)&&r>=0;
      if(lk!==rk)return lk?-1:1;
      if(lk && l!==r)return l-r;
    }
    if (left.priority !== right.priority) return left.priority - right.priority;
    const leftActive = activeCounts[left.account_id] ?? 0;
    const rightActive = activeCounts[right.account_id] ?? 0;
    const utilizationOrder =
      leftActive * right.max_concurrency * right.weight -
      rightActive * left.max_concurrency * left.weight;
    if (utilizationOrder !== 0) return utilizationOrder;
    if (left.consecutive_failures !== right.consecutive_failures) {
      return left.consecutive_failures - right.consecutive_failures;
    }
    return left.account_id < right.account_id ? -1 : left.account_id > right.account_id ? 1 : 0;
  });

  if (scheduler?.enabled && candidates.length>0) candidates=[selectScheduledAccount(state,command,candidates,nowMs)];
  const account = candidates[0];
  if (account === undefined) {
    throw new PoolStateMachineError("no_capacity", "No healthy account has capacity");
  }

  const lease: PoolLeaseState = {
    schema_version: POOL_SCHEMA_VERSION,
    request_id: command.request_id,
    account_id: account.account_id,
    status: "active",
    expires_at_ms: nowMs + command.lease_ttl_ms,
    renewal_sequence: 0,
    last_renewal_ttl_ms: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
  };
  let affinities = state.affinities;
  if (command.affinity_key !== undefined && command.affinity_ttl_ms !== undefined) {
    const existingAffinity = state.affinities[command.affinity_key];
    const affinity: PoolAffinityState = {
      schema_version: POOL_SCHEMA_VERSION,
      affinity_key: command.affinity_key,
      account_id: account.account_id,
      expires_at_ms: nowMs + command.affinity_ttl_ms,
      created_at_ms: existingAffinity?.created_at_ms ?? nowMs,
      updated_at_ms: nowMs,
    };
    affinities = { ...state.affinities, [affinity.affinity_key]: affinity };
  }
  return {
    state: {
      ...state,
      leases: { ...state.leases, [lease.request_id]: lease },
      affinities,
    },
    idempotent: false,
    lease,
  };
}

function existingPriority(state: PoolMachineState, accountId: string): number {
  return state.accounts[accountId]?.priority ?? 50;
}

function existingWeight(state: PoolMachineState, accountId: string): number {
  return state.accounts[accountId]?.weight ?? 1;
}

function renew(
  state: PoolMachineState,
  command: Extract<PoolCommand, { type: "renew" }>,
  nowMs: number,
): PoolTransition {
  assertIdentifier(command.request_id, "request_id");
  if (!Number.isSafeInteger(command.renewal_sequence) || command.renewal_sequence <= 0) {
    throw new PoolStateMachineError(
      "invalid_renewal_sequence",
      "renewal_sequence must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(command.lease_ttl_ms) || command.lease_ttl_ms <= 0) {
    throw new PoolStateMachineError("invalid_lease_ttl", "lease_ttl_ms must be a positive safe integer");
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - command.lease_ttl_ms) {
    throw new PoolStateMachineError("invalid_lease_ttl", "Lease expiry exceeds safe integer range");
  }

  const lease = state.leases[command.request_id];
  if (lease === undefined) {
    throw new PoolStateMachineError("lease_not_found", "Lease was not found");
  }
  if (lease.status !== "active") {
    throw new PoolStateMachineError("invalid_transition", `Cannot renew a ${lease.status} lease`);
  }
  if (command.renewal_sequence < lease.renewal_sequence) {
    return { state, idempotent: true, lease };
  }
  if (command.renewal_sequence === lease.renewal_sequence) {
    if (lease.last_renewal_ttl_ms === command.lease_ttl_ms) {
      return { state, idempotent: true, lease };
    }
    throw new PoolStateMachineError(
      "renewal_conflict",
      "renewal_sequence was already used with a different lease_ttl_ms",
    );
  }
  if (command.renewal_sequence !== lease.renewal_sequence + 1) {
    throw new PoolStateMachineError(
      "renewal_out_of_order",
      "renewal_sequence must increase by one",
    );
  }

  const renewed: PoolLeaseState = {
    ...lease,
    expires_at_ms: nowMs + command.lease_ttl_ms,
    renewal_sequence: command.renewal_sequence,
    last_renewal_ttl_ms: command.lease_ttl_ms,
    updated_at_ms: nowMs,
  };
  return {
    state: { ...state, leases: { ...state.leases, [lease.request_id]: renewed } },
    idempotent: false,
    lease: renewed,
  };
}

function release(state: PoolMachineState, requestId: string, nowMs: number): PoolTransition {
  assertIdentifier(requestId, "request_id");
  const lease = state.leases[requestId];
  if (lease === undefined) {
    throw new PoolStateMachineError("lease_not_found", "Lease was not found");
  }
  if (lease.status !== "active") return { state, idempotent: true, lease };

  const released: PoolLeaseState = {
    ...lease,
    status: "released",
    updated_at_ms: nowMs,
  };
  return {
    state: { ...state, leases: { ...state.leases, [requestId]: released } },
    idempotent: false,
    lease: released,
  };
}

function recordFailure(
  state: PoolMachineState,
  command: Extract<PoolCommand, { type: "failure" }>,
  nowMs: number,
): PoolTransition {
  assertIdentifier(command.event_id, "event_id");
  assertIdentifier(command.account_id, "account_id");
  assertNonNegativeSafeInteger(command.cooldown_ms, "cooldown_ms");
  const processedAccountId = state.failure_events[command.event_id];
  if (processedAccountId !== undefined) {
    if (processedAccountId !== command.account_id) {
      throw new PoolStateMachineError(
        "failure_event_conflict",
        "event_id was already used for a different account",
      );
    }
    return { state, idempotent: true, lease: null };
  }
  const account = state.accounts[command.account_id];
  if (account === undefined) {
    throw new PoolStateMachineError("account_not_found", "Account was not found");
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - command.cooldown_ms) {
    throw new PoolStateMachineError("invalid_cooldown", "Cooldown exceeds safe integer range");
  }

  const updatedAccount: PoolAccountState = {
    ...account,
    consecutive_failures: account.consecutive_failures + 1,
    cooldown_until_ms: Math.max(account.cooldown_until_ms, nowMs + command.cooldown_ms),
    updated_at_ms: nowMs,
  };
  return {
    state: {
      ...state,
      accounts: { ...state.accounts, [account.account_id]: updatedAccount },
      affinities: withoutAccountAffinities(state.affinities, account.account_id),
      failure_events: { ...state.failure_events, [command.event_id]: command.account_id },
    },
    idempotent: false,
    lease: null,
  };
}

function withoutAccountAffinities(
  affinities: Record<string, PoolAffinityState>,
  accountId: string,
): Record<string, PoolAffinityState> {
  const matches = Object.entries(affinities).filter(([, affinity]) => affinity.account_id === accountId);
  if (matches.length === 0) return affinities;
  const next = { ...affinities };
  for (const [affinityKey] of matches) delete next[affinityKey];
  return next;
}

export function activeLeaseCounts(state: PoolMachineState): Record<string, number> {
  const result: Record<string, number> = {};
  for (const lease of Object.values(state.leases)) {
    if (lease.status === "active") {
      result[lease.account_id] = (result[lease.account_id] ?? 0) + 1;
    }
  }
  return result;
}

export function nextActiveLeaseAlarmAt(
  leases: Iterable<Pick<PoolLeaseState, "status" | "expires_at_ms">>,
  nowMs: number,
): number | null {
  assertNonNegativeSafeInteger(nowMs, "now_ms");
  let earliestExpiry: number | null = null;
  for (const lease of leases) {
    if (lease.status !== "active") continue;
    assertNonNegativeSafeInteger(lease.expires_at_ms, "expires_at_ms");
    earliestExpiry =
      earliestExpiry === null ? lease.expires_at_ms : Math.min(earliestExpiry, lease.expires_at_ms);
  }
  return earliestExpiry === null ? null : Math.max(nowMs, earliestExpiry);
}

function assertIdentifier(value: string, fieldName: string): void {
  if (value.length === 0 || value.length > 128) {
    throw new PoolStateMachineError(
      `invalid_${fieldName}`,
      `${fieldName} must be between 1 and 128 characters`,
    );
  }
}

function assertNonNegativeSafeInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PoolStateMachineError(
      `invalid_${fieldName}`,
      `${fieldName} must be a non-negative safe integer`,
    );
  }
}

export function selectScheduledAccount(state:PoolMachineState,command:Extract<PoolCommand,{type:"reserve"}>,candidates:PoolAccountState[],nowMs:number):PoolAccountState {
  const scheduler=parsePoolSchedulerPolicy(command.scheduler);
  const activeCounts=activeLeaseCounts(state);
    const priorities = candidates.map(a=>a.priority);
    const minPriority=Math.min(...priorities),maxPriority=Math.max(...priorities);
    const ttfts=candidates.map(a=>state.scheduler_metrics?.[a.account_id]?.ttft_ms).filter((v):v is number=>v!==undefined && v!==null);
    const minTTFT=Math.min(...ttfts),maxTTFT=Math.max(...ttfts);
    const stickyAccount=command.affinity_key ? state.affinities[command.affinity_key]?.account_id : undefined;
    const costs=upstreamCostFactors(candidates.map(a=>a.account_id),command.account_cost_rates??{});
    const resets=candidates.map(a=>state.scheduler_metrics?.[a.account_id]?.quota_reset_at_ms).filter((v):v is number=>v!==undefined && v>nowMs);
    const minReset=Math.min(...resets),maxReset=Math.max(...resets);
    const maxQueue=Math.max(1,...candidates.map(a=>state.scheduler_metrics?.[a.account_id]?.queue_depth??0));
    const scored=candidates.map(account=>{
      const metric=state.scheduler_metrics?.[account.account_id];
      const priority=maxPriority>minPriority ? 1-(account.priority-minPriority)/(maxPriority-minPriority) : 1;
      const load=1-Math.min(1,(activeCounts[account.account_id]??0)/(account.max_concurrency*account.weight));
      const error=1-(metric?.error_rate??0);
      const ttft=metric?.ttft_ms!==null && metric?.ttft_ms!==undefined && maxTTFT>minTTFT ? 1-(metric.ttft_ms-minTTFT)/(maxTTFT-minTTFT) : 0.5;
      const hasQuota=(metric?.quota_reset_at_ms??0)>nowMs;
      const quota=hasQuota ? metric?.quota_headroom??0.5 : 0.5;
      const reset=hasQuota ? maxReset>minReset ? 1-(metric!.quota_reset_at_ms!-minReset)/(maxReset-minReset) : 1 : 0;
      const queue=1-(metric?.queue_depth??0)/maxQueue;
      const w=scheduler.weights;
      return {account,score:w.priority*priority+w.load*load+w.error_rate*error+w.ttft*ttft+(w.queue??0)*queue+(w.reset??0)*reset+(w.quota_headroom??0)*quota+(scheduler.sticky_weighted && account.account_id===command.previous_account_id ? w.previous_response??0 : 0)+(w.upstream_cost??0)*((costs[account.account_id]??0.5)-0.5)+(scheduler.sticky_weighted && account.account_id===stickyAccount ? w.session_sticky : 0)};
    }).sort((a,b)=>b.score-a.score || a.account.account_id.localeCompare(b.account.account_id));
    const top=scored.slice(0,scheduler.top_k),minimum=top[top.length-1]!.score;
    let draw=schedulerDraw(command.request_id)*top.reduce((sum,a)=>sum+a.score-minimum+1,0);
    let selected=top[top.length-1]!;
    for(const entry of top){draw-=entry.score-minimum+1;if(draw<0){selected=entry;break}}
    return selected.account;
}

const POOL_SCHEMA_VERSION = 1 as const;

export type PoolLeaseStatus = "active" | "released" | "expired";

export interface PoolAccountState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  account_id: string;
  enabled: boolean;
  max_concurrency: number;
  priority: number;
  weight: number;
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

export interface PoolMachineState {
  schema_version: typeof POOL_SCHEMA_VERSION;
  accounts: Record<string, PoolAccountState>;
  leases: Record<string, PoolLeaseState>;
  failure_events: Record<string, string>;
}

type PoolCommandEnvelope = { schema_version: typeof POOL_SCHEMA_VERSION };

export type PoolCommand = PoolCommandEnvelope &
  (
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
    accounts: {},
    leases: {},
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

  const state = reclaimExpiredLeases(inputState, nowMs);
  switch (command.type) {
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
    existing.weight === weight
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
    consecutive_failures: existing?.consecutive_failures ?? 0,
    cooldown_until_ms: existing?.cooldown_until_ms ?? 0,
    updated_at_ms: nowMs,
  };
  return {
    state: { ...state, accounts: { ...state.accounts, [account.account_id]: account } },
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

  const existingLease = state.leases[command.request_id];
  if (existingLease !== undefined) {
    return { state, idempotent: true, lease: existingLease };
  }

  const activeCounts = activeLeaseCounts(state);
  let candidates = Object.values(state.accounts).filter(
    (account) =>
      account.enabled &&
      account.cooldown_until_ms <= nowMs &&
      (activeCounts[account.account_id] ?? 0) < account.max_concurrency,
  );

  if (command.preferred_account_id !== undefined) {
    assertIdentifier(command.preferred_account_id, "preferred_account_id");
    const preferred = candidates.find(
      (account) => account.account_id === command.preferred_account_id,
    );
    if (preferred !== undefined) candidates = [preferred];
  }

  candidates.sort((left, right) => {
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
  return {
    state: { ...state, leases: { ...state.leases, [lease.request_id]: lease } },
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
      failure_events: { ...state.failure_events, [command.event_id]: command.account_id },
    },
    idempotent: false,
    lease: null,
  };
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

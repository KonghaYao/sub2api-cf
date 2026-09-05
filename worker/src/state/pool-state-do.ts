import {
  applyPoolCommand,
  activeLeaseCounts,
  createPoolMachineState,
  nextActiveLeaseAlarmAt,
  reclaimExpiredLeases,
  type PoolAccountState,
  type PoolAffinityState,
  type PoolCommand,
  type PoolLeaseState,
  type PoolMachineState,
  PoolStateMachineError,
} from "../shared/state-machine/pool";
import {
  errorResponse,
  json,
  optionalString,
  readJsonObject,
  requireBoolean,
  requireSafeInteger,
  requireSchemaVersion,
  requireString,
  STATE_API_SCHEMA_VERSION,
  StateApiError,
} from "./http";

interface PoolAccountRow {
  schema_version: number;
  account_id: string;
  enabled: number;
  max_concurrency: number;
  priority: number;
  weight: number;
  consecutive_failures: number;
  cooldown_until_ms: number;
  updated_at_ms: number;
}

interface PoolLeaseRow {
  schema_version: number;
  request_id: string;
  account_id: string;
  status: PoolLeaseState["status"];
  expires_at_ms: number;
  renewal_sequence: number;
  last_renewal_ttl_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PoolAffinityRow {
  schema_version: number;
  affinity_key: string;
  account_id: string;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export class PoolStateDO {
  constructor(private readonly state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      const nowMs = Date.now();
      this.state.storage.transactionSync(() => {
        this.cleanupTombstones(nowMs);
        this.cleanupExpiredAffinities(nowMs);
        this.reclaimPersistedLeases(nowMs);
      });
      await this.scheduleNextLeaseAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return this.health();
      if (request.method === "GET" && url.pathname === "/snapshot") {
        return await this.snapshot();
      }
      if (request.method === "POST" && url.pathname === "/reclaim") {
        return await this.reclaim(await readJsonObject(request));
      }

      const commandType = commandTypeFor(request.method, url.pathname);
      if (commandType !== null) {
        return await this.executeCommand(commandType, await readJsonObject(request));
      }
      throw new StateApiError(404, "route_not_found", "Durable object route was not found");
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.state.storage.transactionSync(() => {
      this.cleanupTombstones(nowMs);
      this.cleanupExpiredAffinities(nowMs);
      this.reclaimPersistedLeases(nowMs);
    });
    await this.scheduleNextLeaseAlarm();
  }

  private health(): Response {
    const result = Array.from(this.state.storage.sql.exec("SELECT 1 AS healthy"))[0];
    return json({
      schema_version: STATE_API_SCHEMA_VERSION,
      ok: result?.healthy === 1,
      service: "pool-state-do",
      storage: "sqlite",
    });
  }

  private async snapshot(): Promise<Response> {
    const nowMs = Date.now();
    const response = this.state.storage.transactionSync(() => {
      this.cleanupTombstones(nowMs);
      this.cleanupExpiredAffinities(nowMs);
      const reclaimed = this.reclaimPersistedLeases(nowMs).state;
      const activeCounts = activeLeaseCounts(reclaimed);
      return json({
        schema_version: STATE_API_SCHEMA_VERSION,
        config_revision: reclaimed.config_revision,
        config_fingerprint: reclaimed.config_fingerprint,
        idempotency_retention_ms: TOMBSTONE_RETENTION_MS,
        accounts: Object.values(reclaimed.accounts).map((account) => ({
          ...account,
          active_leases: activeCounts[account.account_id] ?? 0,
        })),
        active_leases: Object.values(reclaimed.leases).filter(
          (lease) => lease.status === "active",
        ),
      });
    });
    await this.scheduleNextLeaseAlarm();
    return response;
  }

  private async reclaim(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body);
    const nowMs = Date.now();
    const response = this.state.storage.transactionSync(() => {
      this.cleanupTombstones(nowMs);
      this.cleanupExpiredAffinities(nowMs);
      const { reclaimedCount } = this.reclaimPersistedLeases(nowMs);
      return json({
        schema_version: STATE_API_SCHEMA_VERSION,
        reclaimed: reclaimedCount,
      });
    });
    await this.scheduleNextLeaseAlarm();
    return response;
  }

  private async executeCommand(
    type: PoolCommand["type"],
    body: Record<string, unknown>,
  ): Promise<Response> {
    requireSchemaVersion(body);
    const command = parseCommand(type, body);
    const nowMs = Date.now();

    const response = this.state.storage.transactionSync(() => {
      this.cleanupTombstones(nowMs);
      const requestId = "request_id" in command ? command.request_id : undefined;
      const eventId = "event_id" in command ? command.event_id : undefined;
      const failureAccountId = command.type === "failure" ? command.account_id : undefined;
      const affinityKey = command.type === "reserve" ? command.affinity_key : undefined;
      const affinityAccountId = command.type === "failure" ||
          (command.type === "upsert_account" && !command.enabled)
        ? command.account_id
        : undefined;
      this.cleanupExpiredAffinities(nowMs);
      const current = this.loadMachineState(
        requestId,
        eventId,
        affinityKey,
        affinityAccountId,
      );
      const transition = applyPoolCommand(current, command, nowMs);
      this.persistTransition(current, transition.state, eventId, failureAccountId, nowMs);
      if (
        command.type === "sync_accounts" &&
        transition.state.config_revision !== current.config_revision
      ) {
        // Account sync is hot and normally idempotent, so avoid loading every
        // affinity row into memory. A revision change still converges storage
        // immediately by deleting bindings whose accounts were just disabled.
        this.state.storage.sql.exec(
          `DELETE FROM pool_affinities
            WHERE account_id IN (
              SELECT account_id FROM pool_accounts WHERE enabled = 0
            )`,
        );
      }
      return json({
        schema_version: STATE_API_SCHEMA_VERSION,
        idempotent: transition.idempotent,
        lease: transition.lease,
        account:
          transition.lease === null
            ? accountForCommand(transition.state, command)
            : transition.state.accounts[transition.lease.account_id],
      });
    });
    await this.scheduleNextLeaseAlarm();
    return response;
  }

  private initializeSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
        config_fingerprint TEXT NOT NULL CHECK (length(config_fingerprint) IN (0, 64)),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO pool_config (singleton, config_revision, config_fingerprint, updated_at_ms) VALUES (1, 0, '', 0)",
    );
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_accounts (
        account_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
        priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0),
        weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
        consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        cooldown_until_ms INTEGER NOT NULL CHECK (cooldown_until_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `);
    const accountColumns = new Set(
      Array.from(this.state.storage.sql.exec("PRAGMA table_info(pool_accounts)"))
        .map((row) => (row as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!accountColumns.has("priority")) {
      this.state.storage.sql.exec(
        "ALTER TABLE pool_accounts ADD COLUMN priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0)",
      );
    }
    if (!accountColumns.has("weight")) {
      this.state.storage.sql.exec(
        "ALTER TABLE pool_accounts ADD COLUMN weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0)",
      );
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_leases (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        account_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `);
    const leaseColumns = new Set(
      Array.from(this.state.storage.sql.exec("PRAGMA table_info(pool_leases)"))
        .map((row) => (row as { name?: unknown }).name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!leaseColumns.has("renewal_sequence")) {
      this.state.storage.sql.exec(
        "ALTER TABLE pool_leases ADD COLUMN renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0)",
      );
    }
    if (!leaseColumns.has("last_renewal_ttl_ms")) {
      this.state.storage.sql.exec(
        "ALTER TABLE pool_leases ADD COLUMN last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0)",
      );
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_failure_events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        account_id TEXT NOT NULL,
        processed_at_ms INTEGER NOT NULL CHECK (processed_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pool_affinities (
        affinity_key TEXT PRIMARY KEY CHECK (length(affinity_key) = 64),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        account_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_leases_active_expiry ON pool_leases(status, expires_at_ms)",
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_leases_account_status ON pool_leases(account_id, status)",
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_leases_tombstone_cleanup ON pool_leases(status, updated_at_ms)",
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_failure_events_cleanup ON pool_failure_events(processed_at_ms)",
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_affinities_account ON pool_affinities(account_id)",
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pool_affinities_expiry ON pool_affinities(expires_at_ms)",
    );
  }

  private loadMachineState(
    requestId?: string,
    failureEventId?: string,
    affinityKey?: string,
    affinityAccountId?: string,
  ): PoolMachineState {
    const state = createPoolMachineState();
    const config = Array.from(
      this.state.storage.sql.exec(
        "SELECT config_revision, config_fingerprint FROM pool_config WHERE singleton = 1",
      ),
    )[0] as { config_revision?: unknown; config_fingerprint?: unknown } | undefined;
    if (
      !Number.isSafeInteger(config?.config_revision) ||
      (config!.config_revision as number) < 0 ||
      typeof config?.config_fingerprint !== "string"
    ) {
      throw new PoolStateMachineError("invalid_persisted_state", "Persisted config revision is invalid");
    }
    state.config_revision = config!.config_revision as number;
    state.config_fingerprint = config!.config_fingerprint as string;
    for (const value of this.state.storage.sql.exec(
      `SELECT schema_version, account_id, enabled, max_concurrency, priority, weight, consecutive_failures,
              cooldown_until_ms, updated_at_ms
         FROM pool_accounts`,
    )) {
      const account = toAccountState(value);
      state.accounts[account.account_id] = account;
    }

    const leaseCursor =
      requestId === undefined
        ? this.state.storage.sql.exec(
            `SELECT schema_version, request_id, account_id, status, expires_at_ms,
                    renewal_sequence, last_renewal_ttl_ms, created_at_ms, updated_at_ms
               FROM pool_leases
              WHERE status = 'active'`,
          )
        : this.state.storage.sql.exec(
            `SELECT schema_version, request_id, account_id, status, expires_at_ms,
                    renewal_sequence, last_renewal_ttl_ms, created_at_ms, updated_at_ms
               FROM pool_leases
              WHERE status = 'active' OR request_id = ?`,
            requestId,
          );
    for (const value of leaseCursor) {
      const lease = toLeaseState(value);
      state.leases[lease.request_id] = lease;
    }

    if (failureEventId !== undefined) {
      const existing = Array.from(
        this.state.storage.sql.exec(
          "SELECT event_id, account_id FROM pool_failure_events WHERE event_id = ?",
          failureEventId,
        ),
      )[0] as { event_id: string; account_id: string } | undefined;
      if (existing !== undefined) state.failure_events[failureEventId] = existing.account_id;
    }
    if (affinityKey !== undefined) {
      for (const value of this.state.storage.sql.exec(
        `SELECT schema_version, affinity_key, account_id, expires_at_ms, created_at_ms, updated_at_ms
           FROM pool_affinities
          WHERE affinity_key = ?`,
        affinityKey,
      )) {
        const affinity = toAffinityState(value);
        state.affinities[affinity.affinity_key] = affinity;
      }
    }
    if (affinityAccountId !== undefined) {
      for (const value of this.state.storage.sql.exec(
        `SELECT schema_version, affinity_key, account_id, expires_at_ms, created_at_ms, updated_at_ms
           FROM pool_affinities
          WHERE account_id = ?`,
        affinityAccountId,
      )) {
        const affinity = toAffinityState(value);
        state.affinities[affinity.affinity_key] = affinity;
      }
    }
    return state;
  }

  private persistTransition(
    before: PoolMachineState,
    after: PoolMachineState,
    failureEventId?: string,
    failureAccountId?: string,
    processedAtMs?: number,
  ): void {
    if (after.config_revision !== before.config_revision) {
      this.state.storage.sql.exec(
        `UPDATE pool_config
            SET config_revision = ?, config_fingerprint = ?, updated_at_ms = ?
          WHERE singleton = 1`,
        after.config_revision,
        after.config_fingerprint,
        processedAtMs ?? Date.now(),
      );
    }
    for (const [accountId, account] of Object.entries(after.accounts)) {
      if (account === before.accounts[accountId]) continue;
      this.persistAccount(account);
    }
    for (const [requestId, lease] of Object.entries(after.leases)) {
      if (lease === before.leases[requestId]) continue;
      this.persistLease(lease);
    }
    for (const affinityKey of Object.keys(before.affinities)) {
      if (after.affinities[affinityKey] !== undefined) continue;
      this.state.storage.sql.exec(
        "DELETE FROM pool_affinities WHERE affinity_key = ?",
        affinityKey,
      );
    }
    for (const [affinityKey, affinity] of Object.entries(after.affinities)) {
      if (affinity === before.affinities[affinityKey]) continue;
      this.persistAffinity(affinity);
    }
    if (
      failureEventId !== undefined &&
      failureAccountId !== undefined &&
      processedAtMs !== undefined &&
      before.failure_events[failureEventId] === undefined &&
      after.failure_events[failureEventId] === failureAccountId
    ) {
      const account = after.accounts[failureAccountId];
      if (account === undefined) {
        throw new PoolStateMachineError("invalid_transition", "Failure transition has no account");
      }
      this.state.storage.sql.exec(
        `INSERT INTO pool_failure_events (event_id, schema_version, account_id, processed_at_ms)
         VALUES (?, ?, ?, ?)`,
        failureEventId,
        STATE_API_SCHEMA_VERSION,
        account.account_id,
        processedAtMs,
      );
    }
  }

  private persistAccount(account: PoolAccountState): void {
    this.state.storage.sql.exec(
      `INSERT INTO pool_accounts (
         account_id, schema_version, enabled, max_concurrency, priority, weight, consecutive_failures,
         cooldown_until_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         enabled = excluded.enabled,
         max_concurrency = excluded.max_concurrency,
         priority = excluded.priority,
         weight = excluded.weight,
         consecutive_failures = excluded.consecutive_failures,
         cooldown_until_ms = excluded.cooldown_until_ms,
         updated_at_ms = excluded.updated_at_ms`,
      account.account_id,
      account.schema_version,
      account.enabled ? 1 : 0,
      account.max_concurrency,
      account.priority,
      account.weight,
      account.consecutive_failures,
      account.cooldown_until_ms,
      account.updated_at_ms,
    );
  }

  private persistLease(lease: PoolLeaseState): void {
    this.state.storage.sql.exec(
      `INSERT INTO pool_leases (
         request_id, schema_version, account_id, status, expires_at_ms,
         renewal_sequence, last_renewal_ttl_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         account_id = excluded.account_id,
         status = excluded.status,
         expires_at_ms = excluded.expires_at_ms,
         renewal_sequence = excluded.renewal_sequence,
         last_renewal_ttl_ms = excluded.last_renewal_ttl_ms,
         created_at_ms = excluded.created_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
      lease.request_id,
      lease.schema_version,
      lease.account_id,
      lease.status,
      lease.expires_at_ms,
      lease.renewal_sequence,
      lease.last_renewal_ttl_ms,
      lease.created_at_ms,
      lease.updated_at_ms,
    );
  }

  private persistAffinity(affinity: PoolAffinityState): void {
    this.state.storage.sql.exec(
      `INSERT INTO pool_affinities (
         affinity_key, schema_version, account_id, expires_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(affinity_key) DO UPDATE SET
         schema_version = excluded.schema_version,
         account_id = excluded.account_id,
         expires_at_ms = excluded.expires_at_ms,
         created_at_ms = excluded.created_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
      affinity.affinity_key,
      affinity.schema_version,
      affinity.account_id,
      affinity.expires_at_ms,
      affinity.created_at_ms,
      affinity.updated_at_ms,
    );
  }

  private reclaimPersistedLeases(nowMs: number): {
    state: PoolMachineState;
    reclaimedCount: number;
  } {
    const current = this.loadMachineState();
    const reclaimed = reclaimExpiredLeases(current, nowMs);
    const reclaimedCount = countChangedLeases(current, reclaimed);
    this.persistTransition(current, reclaimed);
    return { state: reclaimed, reclaimedCount };
  }

  private async scheduleNextLeaseAlarm(): Promise<void> {
    const expirations = Array.from(
      this.state.storage.sql.exec(
        `SELECT status, expires_at_ms
           FROM pool_leases
          WHERE status = 'active'`,
      ),
    ) as Array<Pick<PoolLeaseState, "status" | "expires_at_ms">>;
    const nextAlarmAt = nextActiveLeaseAlarmAt(expirations, Date.now());
    if (nextAlarmAt === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(nextAlarmAt);
  }

  private cleanupTombstones(nowMs: number): void {
    const cutoffMs = Math.max(0, nowMs - TOMBSTONE_RETENTION_MS);
    this.state.storage.sql.exec(
      `DELETE FROM pool_leases
        WHERE status IN ('released', 'expired') AND updated_at_ms < ?`,
      cutoffMs,
    );
    this.state.storage.sql.exec(
      "DELETE FROM pool_failure_events WHERE processed_at_ms < ?",
      cutoffMs,
    );
  }

  private cleanupExpiredAffinities(nowMs: number): void {
    this.state.storage.sql.exec(
      "DELETE FROM pool_affinities WHERE expires_at_ms <= ?",
      nowMs,
    );
  }
}

function commandTypeFor(method: string, pathname: string): PoolCommand["type"] | null {
  if (method !== "POST") return null;
  if (pathname === "/accounts/sync") return "sync_accounts";
  if (pathname === "/accounts/upsert") return "upsert_account";
  if (pathname === "/reserve") return "reserve";
  if (pathname === "/renew") return "renew";
  if (pathname === "/release") return "release";
  if (pathname === "/failure") return "failure";
  return null;
}

function parseCommand(
  type: PoolCommand["type"],
  body: Record<string, unknown>,
): PoolCommand {
  switch (type) {
    case "sync_accounts":
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        config_revision: requireSafeInteger(body, "config_revision", { minimum: 1 }),
        config_fingerprint: requireString(body, "config_fingerprint", 64),
        accounts: parseConfiguredAccounts(body.accounts),
      };
    case "upsert_account":
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        account_id: requireString(body, "account_id"),
        enabled: requireBoolean(body, "enabled"),
        max_concurrency: requireSafeInteger(body, "max_concurrency", { minimum: 1 }),
        priority:
          body.priority === undefined
            ? undefined
            : requireSafeInteger(body, "priority", { maximum: 1_000_000 }),
        weight:
          body.weight === undefined
            ? undefined
            : requireSafeInteger(body, "weight", { minimum: 1, maximum: 1_000_000 }),
      };
    case "reserve": {
      const preferredAccountId = optionalString(body, "preferred_account_id");
      const affinityKey = optionalString(body, "affinity_key");
      const affinityTtlMs = body.affinity_ttl_ms === undefined
        ? undefined
        : requireSafeInteger(body, "affinity_ttl_ms", {
            minimum: 1,
            maximum: 30 * 24 * 60 * 60 * 1_000,
          });
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        request_id: requireString(body, "request_id"),
        lease_ttl_ms: requireSafeInteger(body, "lease_ttl_ms", {
          minimum: 1,
          maximum: 86_400_000,
        }),
        ...(preferredAccountId === undefined
          ? {}
          : { preferred_account_id: preferredAccountId }),
        ...(body.excluded_account_ids === undefined
          ? {}
          : { excluded_account_ids: parseAccountIds(body.excluded_account_ids) }),
        ...(affinityKey === undefined ? {} : { affinity_key: affinityKey }),
        ...(affinityTtlMs === undefined ? {} : { affinity_ttl_ms: affinityTtlMs }),
      };
    }
    case "renew":
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        request_id: requireString(body, "request_id"),
        renewal_sequence: requireSafeInteger(body, "renewal_sequence", { minimum: 1 }),
        lease_ttl_ms: requireSafeInteger(body, "lease_ttl_ms", {
          minimum: 1,
          maximum: 86_400_000,
        }),
      };
    case "release":
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        request_id: requireString(body, "request_id"),
      };
    case "failure":
      return {
        schema_version: STATE_API_SCHEMA_VERSION,
        type,
        event_id: requireString(body, "event_id"),
        account_id: requireString(body, "account_id"),
        cooldown_ms: requireSafeInteger(body, "cooldown_ms", {
          maximum: 86_400_000,
        }),
      };
  }
}

function parseAccountIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new StateApiError(
      400,
      "invalid_excluded_account_ids",
      "excluded_account_ids must be an array with at most 10000 entries",
    );
  }
  return value.map((accountId) => {
    if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 256) {
      throw new StateApiError(
        400,
        "invalid_excluded_account_ids",
        "excluded_account_ids entries must be non-empty strings",
      );
    }
    return accountId;
  });
}

function parseConfiguredAccounts(value: unknown): Extract<PoolCommand, { type: "sync_accounts" }>["accounts"] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new StateApiError(400, "invalid_accounts", "accounts must be an array with at most 10000 entries");
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StateApiError(400, "invalid_accounts", "Each account must be an object");
    }
    const account = entry as Record<string, unknown>;
    return {
      account_id: requireString(account, "account_id"),
      max_concurrency: requireSafeInteger(account, "max_concurrency", {
        minimum: 1,
        maximum: 1_000_000,
      }),
      priority: requireSafeInteger(account, "priority", { maximum: 1_000_000 }),
      weight: requireSafeInteger(account, "weight", { minimum: 1, maximum: 1_000_000 }),
    };
  });
}

function toAccountState(value: object): PoolAccountState {
  const row = value as PoolAccountRow;
  assertSchemaVersion(row.schema_version);
  return {
    schema_version: STATE_API_SCHEMA_VERSION,
    account_id: row.account_id,
    enabled: row.enabled === 1,
    max_concurrency: row.max_concurrency,
    priority: row.priority,
    weight: row.weight,
    consecutive_failures: row.consecutive_failures,
    cooldown_until_ms: row.cooldown_until_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function toLeaseState(value: object): PoolLeaseState {
  const row = value as PoolLeaseRow;
  assertSchemaVersion(row.schema_version);
  if (!(["active", "released", "expired"] as const).includes(row.status)) {
    throw new PoolStateMachineError("invalid_persisted_state", "Persisted lease has invalid status");
  }
  return {
    schema_version: STATE_API_SCHEMA_VERSION,
    request_id: row.request_id,
    account_id: row.account_id,
    status: row.status,
    expires_at_ms: row.expires_at_ms,
    renewal_sequence: row.renewal_sequence,
    last_renewal_ttl_ms: row.last_renewal_ttl_ms,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function toAffinityState(value: object): PoolAffinityState {
  const row = value as PoolAffinityRow;
  assertSchemaVersion(row.schema_version);
  if (
    typeof row.affinity_key !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.affinity_key) ||
    typeof row.account_id !== "string" ||
    row.account_id.length === 0 ||
    !Number.isSafeInteger(row.expires_at_ms) ||
    row.expires_at_ms < 0 ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0 ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0
  ) {
    throw new PoolStateMachineError("invalid_persisted_state", "Persisted affinity is invalid");
  }
  return {
    schema_version: 1,
    affinity_key: row.affinity_key,
    account_id: row.account_id,
    expires_at_ms: row.expires_at_ms,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function assertSchemaVersion(value: number): void {
  if (value !== STATE_API_SCHEMA_VERSION) {
    throw new PoolStateMachineError("invalid_persisted_state", "Unsupported persisted schema_version");
  }
}

function countChangedLeases(before: PoolMachineState, after: PoolMachineState): number {
  return Object.entries(after.leases).filter(
    ([requestId, lease]) => lease !== before.leases[requestId],
  ).length;
}

function accountForCommand(
  state: PoolMachineState,
  command: PoolCommand,
): PoolAccountState | null {
  if ("account_id" in command) return state.accounts[command.account_id] ?? null;
  return null;
}

import {
  applyUserCommand,
  assertMicros,
  createUserMachineState,
  DEFAULT_RESERVATION_TTL_MS,
  reclaimExpiredUserReservation,
  STATE_SCHEMA_VERSION,
  StateMachineError,
  type UserCommand,
  type UserMachineState,
  type UserProfileState,
  type UserRequestState,
} from "../shared/state-machine/user";
import {
  createBalanceAdjustmentLedgerEntry,
  createEnabledLedgerEntry,
  createOpeningBalanceLedgerEntry,
  createSettlementLedgerEntry,
  type UserLedgerEntry,
} from "../shared/state-machine/ledger";
import {
  errorResponse,
  json,
  readJsonObject,
  requireBoolean,
  requireSafeInteger,
  requireSchemaVersion,
  requireString,
  StateApiError,
} from "./http";

interface UserProfileRow {
  schema_version: number;
  user_id: string;
  enabled: number;
  balance_micros: number;
  reserved_micros: number;
  settled_micros: number;
  updated_at_ms: number;
}

interface UserRequestRow {
  schema_version: number;
  request_id: string;
  status: UserRequestState["status"];
  reserved_micros: number;
  settled_micros: number | null;
  reservation_expires_at_ms: number | null;
  reservation_ttl_ms: number | null;
  renewal_sequence: number;
  last_renewal_ttl_ms: number | null;
  authorized_at_ms: number;
  updated_at_ms: number;
}

interface UserLedgerRow {
  schema_version: number;
  mutation_key: string;
  mutation_id: string;
  entry_type: UserLedgerEntry["entry_type"];
  user_id: string;
  request_id: string | null;
  amount_delta_micros: number;
  balance_after_micros: number;
  enabled_after: number | null;
  created_at_ms: number;
}

export interface ConfigureUserCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  user_id: string;
  balance_micros: number;
  enabled: boolean;
}

export interface AdjustUserBalanceCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  amount_delta_micros: number;
}

export interface SetUserEnabledCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  enabled: boolean;
}

export class UserStateDO {
  constructor(private readonly state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.state.storage.transactionSync(() => {
        this.expireDueReservations(Date.now());
      });
      await this.scheduleNextReservationAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return this.health();
      if (request.method === "GET" && url.pathname === "/snapshot") return this.snapshot();
      if (request.method === "POST" && url.pathname === "/configure") {
        return this.configure(await readJsonObject(request));
      }
      if (request.method === "POST" && url.pathname === "/balance/adjust") {
        return this.adjustBalance(await readJsonObject(request));
      }
      if (request.method === "POST" && url.pathname === "/enabled") {
        return this.setEnabled(await readJsonObject(request));
      }

      const commandType = userCommandTypeFor(request.method, url.pathname);
      if (commandType !== null) {
        return await this.executeCommand(commandType, await readJsonObject(request));
      }
      throw new StateApiError(404, "route_not_found", "Durable object route was not found");
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => {
      this.expireDueReservations(Date.now());
    });
    await this.scheduleNextReservationAlarm();
  }

  private health(): Response {
    const result = Array.from(this.state.storage.sql.exec("SELECT 1 AS healthy"))[0];
    return json({
      schema_version: STATE_SCHEMA_VERSION,
      ok: result?.healthy === 1,
      service: "user-state-do",
      storage: "sqlite",
    });
  }

  private snapshot(): Response {
    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(Date.now());
      const profile = this.loadProfile();
      if (profile === null) {
        throw new StateApiError(404, "user_not_configured", "User state is not configured");
      }
      const requests = Array.from(
        this.state.storage.sql.exec(
          `SELECT schema_version, request_id, status, reserved_micros, settled_micros,
                  reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
                  last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
             FROM user_requests
            ORDER BY updated_at_ms DESC, request_id DESC
            LIMIT 100`,
        ),
      ).map(toRequestState);
      const ledger = Array.from(
        this.state.storage.sql.exec(
          `SELECT schema_version, mutation_key, mutation_id, entry_type, user_id, request_id,
                  amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
             FROM user_ledger
            ORDER BY created_at_ms DESC, mutation_key DESC
            LIMIT 100`,
        ),
      ).map(toLedgerEntry);

      return json({
        schema_version: STATE_SCHEMA_VERSION,
        profile,
        available_micros: profile.balance_micros - profile.reserved_micros,
        requests,
        ledger,
      });
    });
  }

  private configure(body: Record<string, unknown>): Response {
    const command = parseConfigureUserCommand(body);
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(nowMs);
      const existing = this.loadProfile();
      const mutationKey = `balance:${command.mutation_id}`;
      const existingMutation = this.loadLedgerEntry(mutationKey);
      if (existingMutation !== null) {
        if (
          existingMutation.entry_type !== "opening_balance" ||
          existingMutation.user_id !== command.user_id ||
          existingMutation.balance_after_micros !== command.balance_micros ||
          existingMutation.enabled_after !== command.enabled
        ) {
          throw new StateApiError(
            409,
            "mutation_conflict",
            "mutation_id was already used with different configuration values",
          );
        }
        if (existing === null) {
          throw new StateMachineError(
            "invalid_persisted_state",
            "Balance ledger exists without a user profile",
          );
        }
        return json({
          schema_version: STATE_SCHEMA_VERSION,
          idempotent: true,
          profile: existing,
        });
      }
      if (existing !== null) {
        throw new StateApiError(
          409,
          "user_already_configured",
          "User state is already configured; use a mutation command to change it",
        );
      }

      const profile = createUserMachineState({
        user_id: command.user_id,
        balance_micros: command.balance_micros,
        enabled: command.enabled,
        now_ms: nowMs,
      }).profile;
      const ledgerEntry = createOpeningBalanceLedgerEntry({
        mutation_id: command.mutation_id,
        user_id: command.user_id,
        balance_micros: command.balance_micros,
        enabled: command.enabled,
        now_ms: nowMs,
      });
      this.persistProfile(profile);
      this.appendLedgerEntry(ledgerEntry);
      return json({ schema_version: STATE_SCHEMA_VERSION, idempotent: false, profile });
    });
  }

  private adjustBalance(body: Record<string, unknown>): Response {
    const command = parseAdjustUserBalanceCommand(body);
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(nowMs);
      const profile = this.loadProfile();
      if (profile === null) {
        throw new StateApiError(404, "user_not_configured", "User state is not configured");
      }

      const mutationKey = `balance:${command.mutation_id}`;
      const existingMutation = this.loadLedgerEntry(mutationKey);
      if (existingMutation !== null) {
        if (
          existingMutation.entry_type !== "balance_adjustment" ||
          existingMutation.user_id !== profile.user_id ||
          existingMutation.amount_delta_micros !== command.amount_delta_micros
        ) {
          throw new StateApiError(
            409,
            "mutation_conflict",
            "mutation_id was already used with different balance adjustment values",
          );
        }
        return json({ schema_version: STATE_SCHEMA_VERSION, idempotent: true, profile });
      }

      const balanceAfterMicros = profile.balance_micros + command.amount_delta_micros;
      if (!Number.isSafeInteger(balanceAfterMicros) || balanceAfterMicros < 0) {
        throw new StateApiError(
          409,
          "balance_out_of_range",
          "Balance adjustment must result in a non-negative safe integer balance",
        );
      }
      if (balanceAfterMicros < profile.reserved_micros) {
        throw new StateApiError(
          409,
          "balance_below_reservations",
          "Balance adjustment cannot reduce balance below active reservations",
        );
      }

      const nextProfile: UserProfileState = {
        ...profile,
        balance_micros: balanceAfterMicros,
        updated_at_ms: nowMs,
      };
      const ledgerEntry = createBalanceAdjustmentLedgerEntry({
        mutation_id: command.mutation_id,
        user_id: profile.user_id,
        amount_delta_micros: command.amount_delta_micros,
        balance_after_micros: balanceAfterMicros,
        now_ms: nowMs,
      });
      this.persistProfile(nextProfile);
      this.appendLedgerEntry(ledgerEntry);
      return json({ schema_version: STATE_SCHEMA_VERSION, idempotent: false, profile: nextProfile });
    });
  }

  private setEnabled(body: Record<string, unknown>): Response {
    const command = parseSetUserEnabledCommand(body);
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(nowMs);
      const profile = this.loadProfile();
      if (profile === null) {
        throw new StateApiError(404, "user_not_configured", "User state is not configured");
      }

      const mutationKey = `enabled:${command.mutation_id}`;
      const existingMutation = this.loadLedgerEntry(mutationKey);
      if (existingMutation !== null) {
        if (
          existingMutation.entry_type !== "enabled_change" ||
          existingMutation.user_id !== profile.user_id ||
          existingMutation.enabled_after !== command.enabled
        ) {
          throw new StateApiError(
            409,
            "mutation_conflict",
            "mutation_id was already used with a different enabled value",
          );
        }
        return json({ schema_version: STATE_SCHEMA_VERSION, idempotent: true, profile });
      }

      const nextProfile: UserProfileState = {
        ...profile,
        enabled: command.enabled,
        updated_at_ms: nowMs,
      };
      const ledgerEntry = createEnabledLedgerEntry({
        mutation_id: command.mutation_id,
        user_id: profile.user_id,
        enabled: command.enabled,
        balance_after_micros: profile.balance_micros,
        now_ms: nowMs,
      });
      this.persistProfile(nextProfile);
      this.appendLedgerEntry(ledgerEntry);
      return json({ schema_version: STATE_SCHEMA_VERSION, idempotent: false, profile: nextProfile });
    });
  }

  private async executeCommand(
    type: UserCommand["type"],
    body: Record<string, unknown>,
  ): Promise<Response> {
    requireSchemaVersion(body);
    const requestId = requireString(body, "request_id");
    const command = parseCommand(type, body, requestId);
    const nowMs = Date.now();

    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(nowMs);
      const profile = this.loadProfile();
      if (profile === null) {
        throw new StateApiError(404, "user_not_configured", "User state is not configured");
      }
      const current: UserMachineState = {
        schema_version: STATE_SCHEMA_VERSION,
        profile,
        request: this.loadRequest(requestId),
      };
      const transition = applyUserCommand(current, command, nowMs);
      this.persistProfile(transition.state.profile);
      if (transition.state.request !== null) this.persistRequest(transition.state.request);
      if (command.type === "settle" && !transition.idempotent) {
        this.appendLedgerEntry(
          createSettlementLedgerEntry({
            user_id: transition.state.profile.user_id,
            request_id: requestId,
            amount_micros: command.amount_micros,
            balance_after_micros: transition.state.profile.balance_micros,
            now_ms: nowMs,
          }),
        );
      }

      return json({
        schema_version: STATE_SCHEMA_VERSION,
        idempotent: transition.idempotent,
        profile: transition.state.profile,
        available_micros:
          transition.state.profile.balance_micros - transition.state.profile.reserved_micros,
        request: transition.state.request,
      });
    });
    if (type === "reserve" || type === "renew" || type === "cancel" || type === "settle") {
      await this.scheduleNextReservationAlarm();
    }
    return response;
  }

  private initializeSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        user_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        balance_micros INTEGER NOT NULL CHECK (balance_micros >= 0),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        settled_micros INTEGER NOT NULL CHECK (settled_micros >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        CHECK (reserved_micros <= balance_micros)
      ) STRICT
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_ledger (
        mutation_key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        mutation_id TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK (
          entry_type IN ('opening_balance', 'balance_adjustment', 'enabled_change', 'settlement')
        ),
        user_id TEXT NOT NULL,
        request_id TEXT,
        amount_delta_micros INTEGER NOT NULL,
        balance_after_micros INTEGER NOT NULL CHECK (balance_after_micros >= 0),
        enabled_after INTEGER CHECK (enabled_after IS NULL OR enabled_after IN (0, 1)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (
          (entry_type = 'settlement' AND request_id IS NOT NULL AND enabled_after IS NULL
            AND amount_delta_micros <= 0)
          OR
          (entry_type = 'opening_balance' AND request_id IS NULL AND enabled_after IS NOT NULL
            AND amount_delta_micros >= 0)
          OR
          (entry_type = 'balance_adjustment' AND request_id IS NULL AND enabled_after IS NULL
            AND amount_delta_micros != 0)
          OR
          (entry_type = 'enabled_change' AND request_id IS NULL AND enabled_after IS NOT NULL
            AND amount_delta_micros = 0)
        )
      ) STRICT
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_requests (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        status TEXT NOT NULL CHECK (status IN ('authorized', 'reserved', 'cancelled', 'settled')),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
        reservation_expires_at_ms INTEGER CHECK (
          reservation_expires_at_ms IS NULL OR reservation_expires_at_ms >= 0
        ),
        reservation_ttl_ms INTEGER CHECK (reservation_ttl_ms IS NULL OR reservation_ttl_ms > 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (
          last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0
        ),
        authorized_at_ms INTEGER NOT NULL CHECK (authorized_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_user_requests_status_updated ON user_requests(status, updated_at_ms)",
    );
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_user_requests_status_expiry
         ON user_requests(status, reservation_expires_at_ms)`,
    );
    this.state.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ledger_settlement_request
         ON user_ledger(request_id)
        WHERE entry_type = 'settlement'`,
    );
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_user_ledger_recent
         ON user_ledger(created_at_ms DESC, mutation_key DESC)`,
    );
  }

  private loadProfile(): UserProfileState | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, user_id, enabled, balance_micros, reserved_micros,
                settled_micros, updated_at_ms
           FROM user_profile
          WHERE singleton = 1`,
      ),
    )[0] as unknown as UserProfileRow | undefined;
    if (row === undefined) return null;
    assertDatabaseSchemaVersion(row.schema_version);
    const profile: UserProfileState = {
      schema_version: STATE_SCHEMA_VERSION,
      user_id: row.user_id,
      enabled: row.enabled === 1,
      balance_micros: row.balance_micros,
      reserved_micros: row.reserved_micros,
      settled_micros: row.settled_micros,
      updated_at_ms: row.updated_at_ms,
    };
    assertMicros(profile.balance_micros, "balance_micros");
    assertMicros(profile.reserved_micros, "reserved_micros");
    assertMicros(profile.settled_micros, "settled_micros");
    return profile;
  }

  private loadRequest(requestId: string): UserRequestState | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, request_id, status, reserved_micros, settled_micros,
                reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
                last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
           FROM user_requests
          WHERE request_id = ?`,
        requestId,
      ),
    )[0] as unknown as UserRequestRow | undefined;
    return row === undefined ? null : toRequestState(row);
  }

  private persistProfile(profile: UserProfileState): void {
    this.state.storage.sql.exec(
      `INSERT INTO user_profile (
         singleton, schema_version, user_id, enabled, balance_micros, reserved_micros,
         settled_micros, updated_at_ms
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         schema_version = excluded.schema_version,
         user_id = excluded.user_id,
         enabled = excluded.enabled,
         balance_micros = excluded.balance_micros,
         reserved_micros = excluded.reserved_micros,
         settled_micros = excluded.settled_micros,
         updated_at_ms = excluded.updated_at_ms`,
      profile.schema_version,
      profile.user_id,
      profile.enabled ? 1 : 0,
      profile.balance_micros,
      profile.reserved_micros,
      profile.settled_micros,
      profile.updated_at_ms,
    );
  }

  private persistRequest(request: UserRequestState): void {
    this.state.storage.sql.exec(
      `INSERT INTO user_requests (
         schema_version, request_id, status, reserved_micros, settled_micros,
         reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
         last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         status = excluded.status,
         reserved_micros = excluded.reserved_micros,
         settled_micros = excluded.settled_micros,
         reservation_expires_at_ms = excluded.reservation_expires_at_ms,
         reservation_ttl_ms = excluded.reservation_ttl_ms,
         renewal_sequence = excluded.renewal_sequence,
         last_renewal_ttl_ms = excluded.last_renewal_ttl_ms,
         authorized_at_ms = excluded.authorized_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
      request.schema_version,
      request.request_id,
      request.status,
      request.reserved_micros,
      request.settled_micros,
      request.reservation_expires_at_ms,
      request.reservation_ttl_ms,
      request.renewal_sequence,
      request.last_renewal_ttl_ms,
      request.authorized_at_ms,
      request.updated_at_ms,
    );
  }

  private loadLedgerEntry(mutationKey: string): UserLedgerEntry | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, mutation_key, mutation_id, entry_type, user_id, request_id,
                amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
           FROM user_ledger
          WHERE mutation_key = ?`,
        mutationKey,
      ),
    )[0] as unknown as UserLedgerRow | undefined;
    return row === undefined ? null : toLedgerEntry(row);
  }

  private appendLedgerEntry(entry: UserLedgerEntry): void {
    this.state.storage.sql.exec(
      `INSERT INTO user_ledger (
         mutation_key, schema_version, mutation_id, entry_type, user_id, request_id,
         amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.mutation_key,
      entry.schema_version,
      entry.mutation_id,
      entry.entry_type,
      entry.user_id,
      entry.request_id,
      entry.amount_delta_micros,
      entry.balance_after_micros,
      entry.enabled_after === null ? null : entry.enabled_after ? 1 : 0,
      entry.created_at_ms,
    );
  }

  private expireDueReservations(nowMs: number): number {
    const profile = this.loadProfile();
    if (profile === null) return 0;

    let currentProfile = profile;
    let expiredCount = 0;
    const dueRequests = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, request_id, status, reserved_micros, settled_micros,
                reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
                last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
           FROM user_requests
          WHERE status = 'reserved' AND reservation_expires_at_ms <= ?`,
        nowMs,
      ),
    ).map(toRequestState);
    for (const request of dueRequests) {
      const transition = reclaimExpiredUserReservation(
        { schema_version: STATE_SCHEMA_VERSION, profile: currentProfile, request },
        nowMs,
      );
      if (transition.idempotent) continue;
      currentProfile = transition.state.profile;
      if (transition.state.request !== null) this.persistRequest(transition.state.request);
      expiredCount += 1;
    }
    if (expiredCount > 0) this.persistProfile(currentProfile);
    return expiredCount;
  }

  private async scheduleNextReservationAlarm(): Promise<void> {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT MIN(reservation_expires_at_ms) AS next_alarm_ms
           FROM user_requests
          WHERE status = 'reserved'`,
      ),
    )[0] as { next_alarm_ms: number | null } | undefined;
    if (typeof row?.next_alarm_ms === "number") {
      await this.state.storage.setAlarm(Math.max(row.next_alarm_ms, Date.now()));
    }
  }
}

export function userCommandTypeFor(method: string, pathname: string): UserCommand["type"] | null {
  if (method !== "POST") return null;
  if (pathname === "/authorize") return "authorize";
  if (pathname === "/reserve") return "reserve";
  if (pathname === "/renew") return "renew";
  if (pathname === "/release" || pathname === "/cancel") return "cancel";
  if (pathname === "/settle") return "settle";
  return null;
}

export function parseConfigureUserCommand(body: Record<string, unknown>): ConfigureUserCommand {
  requireSchemaVersion(body);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_id: requireString(body, "mutation_id"),
    user_id: requireString(body, "user_id"),
    balance_micros: requireSafeInteger(body, "balance_micros"),
    enabled: requireBoolean(body, "enabled"),
  };
}

export function parseAdjustUserBalanceCommand(
  body: Record<string, unknown>,
): AdjustUserBalanceCommand {
  requireSchemaVersion(body);
  const amountDeltaMicros = requireSafeInteger(body, "amount_delta_micros", {
    minimum: Number.MIN_SAFE_INTEGER,
  });
  if (amountDeltaMicros === 0) {
    throw new StateApiError(
      400,
      "invalid_amount_delta_micros",
      "amount_delta_micros must be a non-zero safe integer",
    );
  }
  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_id: requireString(body, "mutation_id"),
    amount_delta_micros: amountDeltaMicros,
  };
}

export function parseSetUserEnabledCommand(body: Record<string, unknown>): SetUserEnabledCommand {
  requireSchemaVersion(body);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_id: requireString(body, "mutation_id"),
    enabled: requireBoolean(body, "enabled"),
  };
}

function parseCommand(
  type: UserCommand["type"],
  body: Record<string, unknown>,
  requestId: string,
): UserCommand {
  if (type === "renew") {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      type,
      request_id: requestId,
      renewal_sequence: requireSafeInteger(body, "renewal_sequence", { minimum: 1 }),
      reservation_ttl_ms: requireSafeInteger(body, "reservation_ttl_ms", {
        minimum: 1,
        maximum: 86_400_000,
      }),
    };
  }
  if (type === "reserve" || type === "settle") {
    const reservationTtlMs =
      type === "reserve" && body.reservation_ttl_ms !== undefined
        ? requireSafeInteger(body, "reservation_ttl_ms", {
            minimum: 1,
            maximum: 86_400_000,
          })
        : undefined;
    return {
      schema_version: STATE_SCHEMA_VERSION,
      type,
      request_id: requestId,
      amount_micros: requireSafeInteger(body, "amount_micros", {
        minimum: type === "reserve" ? 1 : 0,
      }),
      ...(type === "reserve"
        ? { reservation_ttl_ms: reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS }
        : {}),
    };
  }
  return { schema_version: STATE_SCHEMA_VERSION, type, request_id: requestId };
}

function toRequestState(value: object): UserRequestState {
  const row = value as UserRequestRow;
  assertDatabaseSchemaVersion(row.schema_version);
  if (!(["authorized", "reserved", "cancelled", "settled"] as const).includes(row.status)) {
    throw new StateMachineError("invalid_persisted_state", "Persisted request has invalid status");
  }
  assertMicros(row.reserved_micros, "reserved_micros");
  if (row.settled_micros !== null) assertMicros(row.settled_micros, "settled_micros");
  return {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: row.request_id,
    status: row.status,
    reserved_micros: row.reserved_micros,
    settled_micros: row.settled_micros,
    reservation_expires_at_ms: row.reservation_expires_at_ms,
    reservation_ttl_ms: row.reservation_ttl_ms,
    renewal_sequence: row.renewal_sequence,
    last_renewal_ttl_ms: row.last_renewal_ttl_ms,
    authorized_at_ms: row.authorized_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

function toLedgerEntry(value: object): UserLedgerEntry {
  const row = value as UserLedgerRow;
  assertDatabaseSchemaVersion(row.schema_version);
  if (
    !(
      ["opening_balance", "balance_adjustment", "enabled_change", "settlement"] as const
    ).includes(row.entry_type)
  ) {
    throw new StateMachineError("invalid_persisted_state", "Persisted ledger entry has invalid type");
  }
  if (!Number.isSafeInteger(row.amount_delta_micros)) {
    throw new StateMachineError(
      "invalid_persisted_state",
      "Persisted ledger delta is outside the safe integer range",
    );
  }
  assertMicros(row.balance_after_micros, "balance_after_micros");
  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_key: row.mutation_key,
    mutation_id: row.mutation_id,
    entry_type: row.entry_type,
    user_id: row.user_id,
    request_id: row.request_id,
    amount_delta_micros: row.amount_delta_micros,
    balance_after_micros: row.balance_after_micros,
    enabled_after: row.enabled_after === null ? null : row.enabled_after === 1,
    created_at_ms: row.created_at_ms,
  };
}

function assertDatabaseSchemaVersion(value: number): void {
  if (value !== STATE_SCHEMA_VERSION) {
    throw new StateMachineError("invalid_persisted_state", "Unsupported persisted schema_version");
  }
}

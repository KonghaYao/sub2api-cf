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
  optionalString,
  readJsonObject,
  requireBoolean,
  requireSafeInteger,
  requireSchemaVersion,
  requireString,
  StateApiError,
} from "./http";
import type {
  Env,
  PlatformEvent,
  UserFinancialEventPayload,
  UserStateChangedPayload,
} from "../env";
import { isProviderPlatform } from "../gateway/platform";
import { groupAccessPredicate } from "../user/group-access";
import { financialSourceForMutation } from "../shared/user-financial-event";

interface UserProfileRow {
  schema_version: number;
  user_id: string;
  enabled: number;
  balance_micros: number;
  reserved_micros: number;
  settled_micros: number;
  spend_debt_micros: number;
  updated_at_ms: number;
}

interface UserRequestRow {
  schema_version: number;
  request_id: string;
  status: UserRequestState["status"];
  reserved_micros: number;
  settled_micros: number | null;
  committed: number;
  funded_micros: number;
  expired: number;
  reservation_expires_at_ms: number | null;
  reservation_ttl_ms: number | null;
  renewal_sequence: number;
  last_renewal_ttl_ms: number | null;
  authorized_at_ms: number;
  updated_at_ms: number;
}

interface UserLedgerRow {
  state_version: number | null;
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

interface UserLedgerExportRow extends UserLedgerRow {
  ledger_sequence: number;
}

interface UserLedgerRecord extends UserLedgerRow {
  ledger_sequence: number;
}

interface UserLedgerExportCursor {
  v: 1;
  user_id: string;
  after_sequence: number;
  high_water_sequence: number;
  ledger_count: number;
  snapshot_state_version: number;
  snapshot_balance_micros: number;
  snapshot_spend_debt_micros: number;
  opening_state_version: number;
}

interface AuthorizationRow {
  group_enabled: number;
  platform: string;
  group_accessible: number;
}

export interface ConfigureUserCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  user_id: string;
  balance_micros: number;
  spend_debt_micros: number;
  enabled: boolean;
  initial_state_version: number;
}

export interface AdjustUserBalanceCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  amount_delta_micros: number;
  actor_user_id?: string;
  actor_session_id?: string;
}

export interface SetUserEnabledCommand {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_id: string;
  enabled: boolean;
  expected_state_version?: number;
  rollback_mutation_id?: string;
}

export class UserStateDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env?: Env,
  ) {
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
      if (request.method === "GET" && url.pathname === "/ledger/export") {
        return this.exportLedger(url);
      }
      if (request.method === "POST" && url.pathname === "/configure") {
        return await this.configure(await readJsonObject(request));
      }
      if (request.method === "POST" && url.pathname === "/balance/adjust") {
        return await this.adjustBalance(await readJsonObject(request));
      }
      if (request.method === "POST" && url.pathname === "/enabled") {
        return await this.setEnabled(await readJsonObject(request));
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
    await this.publishPendingOutbox();
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
                  committed, funded_micros, expired,
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
        state_version: this.loadStateVersion(),
        profile,
        available_micros: profile.balance_micros - profile.reserved_micros,
        requests,
        ledger,
      });
    });
  }

  /**
   * Internal, bounded export of the complete immutable balance ledger. The
   * cursor freezes a rowid high-water mark and the profile values observed at
   * the first page. Later appends therefore cannot shift or enter a traversal.
   */
  private exportLedger(url: URL): Response {
    const limit = parseLedgerExportLimit(url.searchParams.get("limit"));
    const cursorRaw = url.searchParams.get("cursor");
    const suppliedCursor = cursorRaw === null ? null : decodeLedgerExportCursor(cursorRaw);

    return this.state.storage.transactionSync(() => {
      const profile = this.loadProfile();
      if (profile === null) {
        throw new StateApiError(404, "user_not_configured", "User state is not configured");
      }
      let cursor: UserLedgerExportCursor;
      if (suppliedCursor === null) {
        const highWater = this.loadLedgerHighWater();
        const opening = this.loadLedgerExportRow(1);
        const openingStateVersion = requireOpeningStateVersion(
          opening,
          this.loadStateVersion() === highWater - 1 ? 0 : null,
        );
        if (highWater === 0 || opening === null ||
            checkedLedgerVersion(openingStateVersion, highWater) !== this.loadStateVersion()) {
          throw unrecoverableLedgerStateVersion();
        }
        cursor = {
          v: 1,
          user_id: profile.user_id,
          after_sequence: 0,
          high_water_sequence: highWater,
          ledger_count: highWater,
          snapshot_state_version: this.loadStateVersion(),
          snapshot_balance_micros: profile.balance_micros,
          snapshot_spend_debt_micros: profile.spend_debt_micros,
          opening_state_version: openingStateVersion,
        };
      } else {
        cursor = suppliedCursor;
        if (cursor.user_id !== profile.user_id) throw invalidLedgerExportCursor();
      }

      const rows = Array.from(this.state.storage.sql.exec(
        `SELECT ledger_sequence,
                state_version, schema_version, mutation_key, mutation_id, entry_type, user_id,
                request_id, amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
           FROM (
             SELECT rowid AS ledger_sequence, state_version, schema_version,
                    mutation_key, mutation_id, entry_type, user_id,
                    request_id, amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
               FROM user_ledger
             UNION ALL
             SELECT ledger_sequence, state_version, 1 AS schema_version, mutation_key, mutation_id,
                    'enabled_change' AS entry_type, user_id, NULL AS request_id,
                    0 AS amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
               FROM user_ledger_tombstones
           )
          WHERE ledger_sequence > ? AND ledger_sequence <= ?
          ORDER BY ledger_sequence ASC
          LIMIT ?`,
        cursor.after_sequence,
        cursor.high_water_sequence,
        limit + 1,
      )) as unknown as UserLedgerExportRow[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map((row) => {
        const ledgerSequence = requirePersistedSequence(row.ledger_sequence);
        const derivedVersion = checkedLedgerVersion(cursor.opening_state_version, ledgerSequence);
        if (row.state_version !== null && row.state_version !== derivedVersion) {
          throw unrecoverableLedgerStateVersion();
        }
        return {
          ledger_sequence: ledgerSequence,
          state_version: derivedVersion,
          ...toLedgerEntry(row),
        };
      });
      const last = page.at(-1);
      if (hasMore && last === undefined) {
        throw new StateMachineError("invalid_persisted_state", "User ledger export did not advance");
      }
      const nextCursor = hasMore && last !== undefined
        ? encodeLedgerExportCursor({ ...cursor, after_sequence: last.ledger_sequence })
        : null;
      return json({
        schema_version: STATE_SCHEMA_VERSION,
        snapshot: {
          user_id: cursor.user_id,
          state_version: cursor.snapshot_state_version,
          balance_micros: cursor.snapshot_balance_micros,
          spend_debt_micros: cursor.snapshot_spend_debt_micros,
          ledger_count: cursor.ledger_count,
          high_water_sequence: cursor.high_water_sequence,
        },
        entries: page,
        complete: !hasMore,
        next_cursor: nextCursor,
      });
    });
  }

  private async configure(body: Record<string, unknown>): Promise<Response> {
    const command = parseConfigureUserCommand(body);
    const nowMs = Date.now();

    const response = this.state.storage.transactionSync(() => {
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
          state_version: this.loadStateVersion(),
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
        spend_debt_micros: command.spend_debt_micros,
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
      this.setStateVersion(command.initial_state_version);
      this.appendLedgerEntry(ledgerEntry, command.initial_state_version);
      this.appendStateProjection(
        profile,
        command.initial_state_version,
        command.mutation_id,
        nowMs,
        createOpeningFinancialProjection(ledgerEntry, profile),
      );
      return json({
        schema_version: STATE_SCHEMA_VERSION,
        idempotent: false,
        state_version: command.initial_state_version,
        profile,
      });
    });
    await this.publishPendingOutbox();
    await this.scheduleNextReservationAlarm();
    return response;
  }

  private async adjustBalance(body: Record<string, unknown>): Promise<Response> {
    const command = parseAdjustUserBalanceCommand(body);
    const nowMs = Date.now();

    const response = this.state.storage.transactionSync(() => {
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
        return json({
          schema_version: STATE_SCHEMA_VERSION,
          idempotent: true,
          state_version: this.loadStateVersion(),
          profile,
        });
      }

      const debtRepaymentMicros = command.amount_delta_micros > 0
        ? Math.min(command.amount_delta_micros, profile.spend_debt_micros)
        : 0;
      const balanceDeltaMicros = command.amount_delta_micros - debtRepaymentMicros;
      const balanceAfterMicros = profile.balance_micros + balanceDeltaMicros;
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
        spend_debt_micros: profile.spend_debt_micros - debtRepaymentMicros,
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
      const stateVersion = this.advanceStateVersion();
      this.appendLedgerEntry(ledgerEntry, stateVersion);
      this.appendStateProjection(
        nextProfile,
        stateVersion,
        command.mutation_id,
        nowMs,
        createFinancialProjection(ledgerEntry, profile, nextProfile, command),
      );
      return json({
        schema_version: STATE_SCHEMA_VERSION,
        idempotent: false,
        state_version: stateVersion,
        profile: nextProfile,
      });
    });
    await this.publishPendingOutbox();
    await this.scheduleNextReservationAlarm();
    return response;
  }

  private async setEnabled(body: Record<string, unknown>): Promise<Response> {
    const command = parseSetUserEnabledCommand(body);
    const nowMs = Date.now();

    const response = this.state.storage.transactionSync(() => {
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
        if (
          command.rollback_mutation_id === undefined &&
          existingMutation.enabled_after !== profile.enabled
        ) {
          throw new StateApiError(
            409,
            "mutation_superseded",
            "mutation_id was superseded by a newer enabled-state change",
          );
        }
        return json({
          schema_version: STATE_SCHEMA_VERSION,
          idempotent: true,
          state_version: this.loadStateVersion(),
          profile,
        });
      }

      const currentStateVersion = this.loadStateVersion();
      if (
        command.expected_state_version !== undefined &&
        command.expected_state_version !== currentStateVersion
      ) {
        return json({
          schema_version: STATE_SCHEMA_VERSION,
          idempotent: false,
          applied: false,
          state_version: currentStateVersion,
          profile,
        });
      }

      let rollbackKeyToDelete: string | null = null;
      if (command.rollback_mutation_id !== undefined) {
        const rollbackKey = `enabled:${command.rollback_mutation_id}`;
        const rollbackMutation = this.loadLedgerEntry(rollbackKey);
        if (
          rollbackMutation === null ||
          rollbackMutation.entry_type !== "enabled_change" ||
          rollbackMutation.user_id !== profile.user_id
        ) {
          throw new StateApiError(
            409,
            "rollback_mutation_not_found",
            "The enabled-state mutation to roll back was not found",
          );
        }
        const rollbackRecord = this.loadLedgerRecord(rollbackKey);
        if (rollbackRecord === null) {
          throw new StateMachineError(
            "ledger_state_version_unrecoverable",
            "Enabled-state ledger version cannot be recovered safely",
          );
        }
        if (rollbackRecord.state_version === null) {
          rollbackRecord.state_version = this.deriveLegacyLedgerStateVersion(rollbackRecord);
        }
        this.appendLedgerTombstone(rollbackRecord, nowMs);
        rollbackKeyToDelete = rollbackKey;
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
      const stateVersion = this.advanceStateVersion();
      this.appendLedgerEntry(ledgerEntry, stateVersion);
      if (rollbackKeyToDelete !== null) {
        this.state.storage.sql.exec(
          "DELETE FROM user_ledger WHERE mutation_key = ?",
          rollbackKeyToDelete,
        );
      }
      this.appendStateProjection(nextProfile, stateVersion, command.mutation_id, nowMs);
      return json({
        schema_version: STATE_SCHEMA_VERSION,
        idempotent: false,
        state_version: stateVersion,
        profile: nextProfile,
      });
    });
    await this.publishPendingOutbox();
    await this.scheduleNextReservationAlarm();
    return response;
  }

  private async executeCommand(
    type: UserCommand["type"],
    body: Record<string, unknown>,
  ): Promise<Response> {
    requireSchemaVersion(body);
    const requestId = requireString(body, "request_id");
    const command = parseCommand(type, body, requestId);
    const usageEvent = type === "settle" ? parseOptionalUsageEvent(body.usage_event, requestId) : null;
    const nowMs = Date.now();

    if (type === "authorize") {
      await this.verifyAuthorization(body);
    }

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
      let financialEvent: UserFinancialEventPayload | undefined;
      if (command.type === "settle" && !transition.idempotent) {
        const ledgerEntry = createSettlementLedgerEntry({
          user_id: transition.state.profile.user_id,
          request_id: requestId,
          amount_micros: command.amount_micros,
          balance_after_micros: transition.state.profile.balance_micros,
          now_ms: nowMs,
        });
        const nextStateVersion = this.loadStateVersion() + 1;
        if (!Number.isSafeInteger(nextStateVersion)) {
          throw new StateMachineError("state_version_exhausted", "User state version is exhausted");
        }
        this.appendLedgerEntry(ledgerEntry, nextStateVersion);
        financialEvent = createFinancialProjection(
          ledgerEntry,
          profile,
          transition.state.profile,
        );
      }
      const stateVersion = command.type === "settle" && !transition.idempotent
        ? this.advanceStateVersion()
        : this.loadStateVersion();
      if (command.type === "settle" && usageEvent !== null) {
        const payload = usageEvent.payload as Record<string, unknown>;
        if (payload.user_id !== transition.state.profile.user_id) {
          throw new StateApiError(400, "usage_event_user_mismatch", "usage_event user_id does not match user state");
        }
        if (payload.amount_micros !== command.amount_micros) {
          throw new StateApiError(400, "usage_event_amount_mismatch", "usage_event amount does not match settlement");
        }
        this.appendOutboxEvent(usageEvent, `usage:${requestId}`, nowMs);
      }
      if (command.type === "settle" && !transition.idempotent) {
        this.appendStateProjection(
          transition.state.profile,
          stateVersion,
          `settlement:${requestId}`,
          nowMs,
          financialEvent,
        );
      }

      return json({
        schema_version: STATE_SCHEMA_VERSION,
        idempotent: transition.idempotent,
        state_version: stateVersion,
        profile: transition.state.profile,
        available_micros:
          transition.state.profile.balance_micros - transition.state.profile.reserved_micros,
        request: transition.state.request,
      });
    });
    if (type === "reserve" || type === "renew" || type === "cancel" || type === "settle") {
      if (type === "settle") await this.publishPendingOutbox();
      await this.scheduleNextReservationAlarm();
    }
    return response;
  }

  private async verifyAuthorization(body: Record<string, unknown>): Promise<void> {
    const userId = requireString(body, "user_id");
    const apiKeyId = requireString(body, "api_key_id");
    const authVersion = requireSafeInteger(body, "api_key_auth_version", { minimum: 1 });
    if (this.env?.DB === undefined) {
      throw new StateApiError(503, "authorization_store_unavailable", "Authorization store is unavailable");
    }
    const nowMs = Date.now();
    const result = await this.env.DB.prepare(
      `SELECT g.enabled AS group_enabled, g.platform,
              CASE WHEN ${groupAccessPredicate("g", "u.id")}
                   THEN 1 ELSE 0 END AS group_accessible
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         JOIN "groups" g ON g.id = k.group_id
        WHERE k.id = ? AND k.user_id = ? AND k.auth_version = ?
          AND k.enabled = 1 AND k.revoked_at_ms IS NULL
          AND (k.expires_at_ms IS NULL OR k.expires_at_ms > ?)
          AND u.status = 'active'
        LIMIT 1`,
    ).bind(nowMs, nowMs, apiKeyId, userId, authVersion, nowMs).first<AuthorizationRow>();
    if (result === null) {
      throw new StateApiError(401, "invalid_api_key", "API key authorization is no longer valid");
    }
    if (result.group_enabled !== 1 || !isProviderPlatform(result.platform)) {
      throw new StateApiError(403, "group_unavailable", "API key group is unavailable");
    }
    if (result.group_accessible !== 1) {
      throw new StateApiError(
        403,
        "group_access_denied",
        "API key group access is no longer valid",
      );
    }
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
        spend_debt_micros INTEGER NOT NULL DEFAULT 0 CHECK (spend_debt_micros >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        CHECK (reserved_micros <= balance_micros)
      ) STRICT
    `);
    const profileColumns = Array.from(
      this.state.storage.sql.exec("PRAGMA table_info(user_profile)"),
    ) as Array<{ name?: string }>;
    if (!profileColumns.some((column) => column.name === "spend_debt_micros")) {
      this.state.storage.sql.exec(
        "ALTER TABLE user_profile ADD COLUMN spend_debt_micros INTEGER NOT NULL DEFAULT 0 CHECK (spend_debt_micros >= 0)",
      );
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_state_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state_version INTEGER NOT NULL CHECK (state_version >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(
      "INSERT OR IGNORE INTO user_state_metadata (singleton, state_version) VALUES (1, 0)",
    );
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_ledger (
        mutation_key TEXT PRIMARY KEY,
        state_version INTEGER CHECK (state_version IS NULL OR state_version >= 0),
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
    const ledgerColumns = Array.from(
      this.state.storage.sql.exec("PRAGMA table_info(user_ledger)"),
    ) as Array<{ name?: string }>;
    if (!ledgerColumns.some((column) => column.name === "state_version")) {
      this.state.storage.sql.exec(
        "ALTER TABLE user_ledger ADD COLUMN state_version INTEGER CHECK (state_version IS NULL OR state_version >= 0)",
      );
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_requests (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        status TEXT NOT NULL CHECK (status IN ('authorized', 'reserved', 'cancelled', 'settled')),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
        committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
        funded_micros INTEGER NOT NULL DEFAULT 0 CHECK (funded_micros >= 0),
        expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1)),
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
    const requestColumns = Array.from(
      this.state.storage.sql.exec("PRAGMA table_info(user_requests)"),
    ) as Array<{ name?: string }>;
    if (!requestColumns.some((column) => column.name === "committed")) {
      this.state.storage.sql.exec(
        "ALTER TABLE user_requests ADD COLUMN committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))",
      );
    }
    if (!requestColumns.some((column) => column.name === "funded_micros")) {
      this.state.storage.sql.exec(
        "ALTER TABLE user_requests ADD COLUMN funded_micros INTEGER NOT NULL DEFAULT 0 CHECK (funded_micros >= 0)",
      );
      this.state.storage.sql.exec(
        "UPDATE user_requests SET funded_micros = reserved_micros WHERE status = 'reserved'",
      );
    }
    if (!requestColumns.some((column) => column.name === "expired")) {
      this.state.storage.sql.exec(
        "ALTER TABLE user_requests ADD COLUMN expired INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1))",
      );
      this.state.storage.sql.exec(
        `UPDATE user_requests
            SET expired = 1
          WHERE status = 'cancelled'
            AND reservation_expires_at_ms IS NOT NULL
            AND updated_at_ms >= reservation_expires_at_ms`,
      );
    }
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
    this.state.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_ledger_state_version
         ON user_ledger(state_version)
        WHERE state_version IS NOT NULL`,
    );
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_ledger_tombstones (
        state_version INTEGER PRIMARY KEY CHECK (state_version >= 0),
        ledger_sequence INTEGER NOT NULL UNIQUE CHECK (ledger_sequence > 0),
        mutation_key TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        balance_after_micros INTEGER NOT NULL CHECK (balance_after_micros >= 0),
        enabled_after INTEGER NOT NULL CHECK (enabled_after IN (0, 1)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        tombstoned_at_ms INTEGER NOT NULL CHECK (tombstoned_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_outbox (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
        published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      ) STRICT
    `);
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_user_outbox_pending
         ON user_outbox(available_at_ms, event_id)
        WHERE published_at_ms IS NULL`,
    );
  }

  private loadProfile(): UserProfileState | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, user_id, enabled, balance_micros, reserved_micros,
                settled_micros, spend_debt_micros, updated_at_ms
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
      spend_debt_micros: row.spend_debt_micros,
      updated_at_ms: row.updated_at_ms,
    };
    assertMicros(profile.balance_micros, "balance_micros");
    assertMicros(profile.reserved_micros, "reserved_micros");
    assertMicros(profile.settled_micros, "settled_micros");
    assertMicros(profile.spend_debt_micros, "spend_debt_micros");
    return profile;
  }

  private loadRequest(requestId: string): UserRequestState | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT schema_version, request_id, status, reserved_micros, settled_micros,
                committed, funded_micros, expired,
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
         settled_micros, spend_debt_micros, updated_at_ms
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         schema_version = excluded.schema_version,
         user_id = excluded.user_id,
         enabled = excluded.enabled,
         balance_micros = excluded.balance_micros,
         reserved_micros = excluded.reserved_micros,
         settled_micros = excluded.settled_micros,
         spend_debt_micros = excluded.spend_debt_micros,
         updated_at_ms = excluded.updated_at_ms`,
      profile.schema_version,
      profile.user_id,
      profile.enabled ? 1 : 0,
      profile.balance_micros,
      profile.reserved_micros,
      profile.settled_micros,
      profile.spend_debt_micros,
      profile.updated_at_ms,
    );
  }

  private loadStateVersion(): number {
    const row = Array.from(
      this.state.storage.sql.exec(
        "SELECT state_version FROM user_state_metadata WHERE singleton = 1",
      ),
    )[0] as { state_version?: unknown } | undefined;
    if (!Number.isSafeInteger(row?.state_version) || (row!.state_version as number) < 0) {
      throw new StateMachineError("invalid_persisted_state", "User state version is invalid");
    }
    return row!.state_version as number;
  }

  private setStateVersion(stateVersion: number): void {
    this.state.storage.sql.exec(
      "UPDATE user_state_metadata SET state_version = ? WHERE singleton = 1",
      stateVersion,
    );
  }

  private advanceStateVersion(): number {
    const current = this.loadStateVersion();
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new StateMachineError("state_version_exhausted", "User state version is exhausted");
    }
    const next = current + 1;
    this.setStateVersion(next);
    return next;
  }

  private persistRequest(request: UserRequestState): void {
    this.state.storage.sql.exec(
      `INSERT INTO user_requests (
         schema_version, request_id, status, reserved_micros, settled_micros,
         committed, funded_micros, expired,
         reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
         last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         status = excluded.status,
         reserved_micros = excluded.reserved_micros,
         settled_micros = excluded.settled_micros,
         committed = excluded.committed,
         funded_micros = excluded.funded_micros,
         expired = excluded.expired,
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
      request.committed ? 1 : 0,
      request.funded_micros,
      request.expired ? 1 : 0,
      request.reservation_expires_at_ms,
      request.reservation_ttl_ms,
      request.renewal_sequence,
      request.last_renewal_ttl_ms,
      request.authorized_at_ms,
      request.updated_at_ms,
    );
  }

  private loadLedgerEntry(mutationKey: string): UserLedgerEntry | null {
    const row = this.loadLedgerRecord(mutationKey);
    return row === null ? null : toLedgerEntry(row);
  }

  private loadLedgerRecord(mutationKey: string): UserLedgerRecord | null {
    const row = Array.from(
      this.state.storage.sql.exec(
        `SELECT rowid AS ledger_sequence, state_version, schema_version,
                mutation_key, mutation_id, entry_type, user_id, request_id,
                amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
           FROM user_ledger
          WHERE mutation_key = ?`,
        mutationKey,
      ),
    )[0] as unknown as UserLedgerRecord | undefined;
    return row ?? null;
  }

  private loadLedgerExportRow(ledgerSequence: number): UserLedgerExportRow | null {
    const row = Array.from(this.state.storage.sql.exec(
      `SELECT ledger_sequence, state_version, schema_version, mutation_key, mutation_id,
              entry_type, user_id, request_id, amount_delta_micros,
              balance_after_micros, enabled_after, created_at_ms
         FROM (
           SELECT rowid AS ledger_sequence, state_version, schema_version, mutation_key,
                  mutation_id, entry_type, user_id, request_id, amount_delta_micros,
                  balance_after_micros, enabled_after, created_at_ms
             FROM user_ledger
           UNION ALL
           SELECT ledger_sequence, state_version, 1, mutation_key, mutation_id,
                  'enabled_change', user_id, NULL, 0,
                  balance_after_micros, enabled_after, created_at_ms
             FROM user_ledger_tombstones
         )
        WHERE ledger_sequence = ?
        LIMIT 2`,
      ledgerSequence,
    )) as unknown as UserLedgerExportRow[];
    if (row.length > 1) throw unrecoverableLedgerStateVersion();
    return row[0] ?? null;
  }

  private deriveLegacyLedgerStateVersion(record: UserLedgerRecord): number {
    const opening = this.loadLedgerExportRow(1);
    const highWater = this.loadLedgerHighWater();
    const openingVersion = requireOpeningStateVersion(
      opening,
      this.loadStateVersion() === highWater - 1 ? 0 : null,
    );
    const derived = checkedLedgerVersion(openingVersion, record.ledger_sequence);
    if (derived > this.loadStateVersion()) throw unrecoverableLedgerStateVersion();
    return derived;
  }

  private loadLedgerHighWater(): number {
    const row = Array.from(this.state.storage.sql.exec(
      `SELECT MAX(
                COALESCE((SELECT MAX(rowid) FROM user_ledger), 0),
                COALESCE((SELECT MAX(ledger_sequence) FROM user_ledger_tombstones), 0)
              ) AS high_water_sequence`,
    ))[0] as { high_water_sequence?: unknown } | undefined;
    return requirePersistedHighWater(row?.high_water_sequence);
  }

  private appendLedgerEntry(entry: UserLedgerEntry, stateVersion: number): void {
    this.state.storage.sql.exec(
      `INSERT INTO user_ledger (
         mutation_key, state_version, schema_version, mutation_id, entry_type, user_id, request_id,
         amount_delta_micros, balance_after_micros, enabled_after, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.mutation_key,
      stateVersion,
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

  private appendLedgerTombstone(entry: UserLedgerRecord, nowMs: number): void {
    if (entry.state_version === null) {
      throw new StateMachineError(
        "ledger_state_version_unrecoverable",
        "Enabled-state ledger version cannot be recovered safely",
      );
    }
    this.state.storage.sql.exec(
      `INSERT INTO user_ledger_tombstones (
         state_version, ledger_sequence, mutation_key, mutation_id, user_id,
         balance_after_micros, enabled_after, created_at_ms, tombstoned_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.state_version,
      entry.ledger_sequence,
      entry.mutation_key,
      entry.mutation_id,
      entry.user_id,
      entry.balance_after_micros,
      entry.enabled_after,
      entry.created_at_ms,
      nowMs,
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
                committed, funded_micros, expired,
                reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
                last_renewal_ttl_ms, authorized_at_ms, updated_at_ms
           FROM user_requests
          WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
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

  private appendOutboxEvent(
    event: unknown,
    dedupeKey: string,
    nowMs: number,
  ): void {
    const eventId = (event as { event_id?: unknown } | null)?.event_id;
    if (typeof eventId !== "string" || eventId.length === 0 || eventId.length > 256) {
      throw new StateApiError(400, "invalid_outbox_event", "Outbox event id is invalid");
    }
    const existing = Array.from(
      this.state.storage.sql.exec(
        "SELECT payload_json FROM user_outbox WHERE request_id = ?",
        dedupeKey,
      ),
    )[0] as { payload_json: string } | undefined;
    const payloadJson = JSON.stringify(event);
    if (existing !== undefined) {
      if (existing.payload_json !== payloadJson) {
        throw new StateApiError(409, "outbox_event_conflict", "Outbox key already has a different event");
      }
      return;
    }
    this.state.storage.sql.exec(
      `INSERT INTO user_outbox (
         event_id, request_id, payload_json, attempts, available_at_ms, published_at_ms, created_at_ms
       ) VALUES (?, ?, ?, 0, ?, NULL, ?)`,
      eventId,
      dedupeKey,
      payloadJson,
      nowMs,
      nowMs,
    );
  }

  private appendStateProjection(
    profile: UserProfileState,
    stateVersion: number,
    mutationId: string,
    nowMs: number,
    financialEvent?: UserFinancialEventPayload,
  ): void {
    if (this.env?.EVENTS_QUEUE === undefined) return;
    const payload: UserStateChangedPayload = {
      mutation_id: mutationId,
      user_id: profile.user_id,
      state_version: stateVersion,
      balance_micros: profile.balance_micros,
      spend_debt_micros: profile.spend_debt_micros,
      enabled: profile.enabled,
      updated_at_ms: profile.updated_at_ms,
      ...(financialEvent === undefined ? {} : { financial_event: financialEvent }),
    };
    const event: PlatformEvent<UserStateChangedPayload> = {
      schema_version: 1,
      event_id: `user-state:${profile.user_id}:${stateVersion}`,
      event_type: "user.state.changed.v1",
      occurred_at_ms: nowMs,
      aggregate_type: "user",
      aggregate_id: profile.user_id,
      payload,
    };
    this.appendOutboxEvent(event, `state:${stateVersion}`, nowMs);
  }

  private async publishPendingOutbox(): Promise<void> {
    if (this.env?.EVENTS_QUEUE === undefined) return;
    const nowMs = Date.now();
    const rows = Array.from(
      this.state.storage.sql.exec(
        `SELECT event_id, payload_json, attempts
           FROM user_outbox
          WHERE published_at_ms IS NULL AND available_at_ms <= ?
          ORDER BY available_at_ms, event_id
          LIMIT 10`,
        nowMs,
      ),
    ) as Array<{ event_id: string; payload_json: string; attempts: number }>;
    for (const row of rows) {
      try {
        await this.env.EVENTS_QUEUE.send(JSON.parse(row.payload_json));
        this.state.storage.sql.exec(
          "UPDATE user_outbox SET published_at_ms = ? WHERE event_id = ? AND published_at_ms IS NULL",
          Date.now(),
          row.event_id,
        );
      } catch (error) {
        const retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6));
        this.state.storage.sql.exec(
          `UPDATE user_outbox
              SET attempts = attempts + 1, available_at_ms = ?
            WHERE event_id = ? AND published_at_ms IS NULL`,
          retryAt,
          row.event_id,
        );
        console.error("user outbox publish failed", {
          event_id: row.event_id,
          name: error instanceof Error ? error.name : "unknown",
        });
        break;
      }
    }
    this.state.storage.sql.exec(
      "DELETE FROM user_outbox WHERE published_at_ms IS NOT NULL AND published_at_ms < ?",
      Math.max(0, Date.now() - 7 * 24 * 60 * 60 * 1_000),
    );
  }

  private async scheduleNextReservationAlarm(): Promise<void> {
    const reservationRow = Array.from(
      this.state.storage.sql.exec(
        `SELECT MIN(reservation_expires_at_ms) AS next_alarm_ms
           FROM user_requests
          WHERE status = 'reserved' AND committed = 0`,
      ),
    )[0] as { next_alarm_ms: number | null } | undefined;
    const outboxRow = Array.from(
      this.state.storage.sql.exec(
        `SELECT MIN(available_at_ms) AS next_alarm_ms
           FROM user_outbox
          WHERE published_at_ms IS NULL`,
      ),
    )[0] as { next_alarm_ms: number | null } | undefined;
    const candidates = [reservationRow?.next_alarm_ms, outboxRow?.next_alarm_ms].filter(
      (value): value is number => typeof value === "number",
    );
    if (candidates.length > 0) {
      await this.state.storage.setAlarm(Math.max(Math.min(...candidates), Date.now()));
    }
  }
}

function createFinancialProjection(
  entry: UserLedgerEntry,
  previous: UserProfileState,
  next: UserProfileState,
  actor?: Pick<AdjustUserBalanceCommand, "actor_user_id" | "actor_session_id">,
): UserFinancialEventPayload {
  if (entry.entry_type !== "balance_adjustment" && entry.entry_type !== "settlement") {
    throw new StateMachineError(
      "invalid_financial_event",
      "Only balance adjustments and settlements can be projected as financial events",
    );
  }
  const source = financialSourceForMutation(
    entry.mutation_id,
    entry.entry_type,
    entry.request_id,
  );
  return {
    event_type: entry.entry_type,
    ...source,
    request_id: entry.request_id,
    actor_user_id: actor?.actor_user_id ?? null,
    actor_session_id: actor?.actor_session_id ?? null,
    amount_delta_micros: next.balance_micros - previous.balance_micros,
    gross_amount_micros: entry.entry_type === "settlement"
      ? -entry.amount_delta_micros
      : entry.amount_delta_micros,
    spend_debt_delta_micros: next.spend_debt_micros - previous.spend_debt_micros,
    balance_after_micros: next.balance_micros,
    spend_debt_after_micros: next.spend_debt_micros,
  };
}

function createOpeningFinancialProjection(
  entry: UserLedgerEntry,
  profile: UserProfileState,
): UserFinancialEventPayload {
  if (entry.entry_type !== "opening_balance") {
    throw new StateMachineError(
      "invalid_financial_event",
      "Only an opening balance can create the financial history watermark",
    );
  }
  return {
    event_type: "opening_balance",
    ...financialSourceForMutation(entry.mutation_id, "opening_balance", null),
    request_id: null,
    actor_user_id: null,
    actor_session_id: null,
    amount_delta_micros: profile.balance_micros,
    gross_amount_micros: profile.balance_micros,
    spend_debt_delta_micros: profile.spend_debt_micros,
    balance_after_micros: profile.balance_micros,
    spend_debt_after_micros: profile.spend_debt_micros,
  };
}

function parseOptionalUsageEvent(value: unknown, requestId: string): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StateApiError(400, "invalid_usage_event", "usage_event must be an object");
  }
  const event = value as Record<string, unknown>;
  if (
    event.schema_version !== STATE_SCHEMA_VERSION ||
    typeof event.event_id !== "string" ||
    event.event_id.length === 0 ||
    event.event_id.length > 128 ||
    event.event_type !== "usage.settled.v1" ||
    event.aggregate_type !== "user" ||
    event.payload === null ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload) ||
    (event.payload as Record<string, unknown>).request_id !== requestId
  ) {
    throw new StateApiError(400, "invalid_usage_event", "usage_event has an invalid envelope");
  }
  return event;
}

export function userCommandTypeFor(method: string, pathname: string): UserCommand["type"] | null {
  if (method !== "POST") return null;
  if (pathname === "/authorize") return "authorize";
  if (pathname === "/reserve") return "reserve";
  if (pathname === "/renew") return "renew";
  if (pathname === "/ensure") return "ensure";
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
    spend_debt_micros: body.spend_debt_micros === undefined
      ? 0
      : requireSafeInteger(body, "spend_debt_micros"),
    enabled: requireBoolean(body, "enabled"),
    initial_state_version: body.initial_state_version === undefined
      ? 0
      : requireSafeInteger(body, "initial_state_version"),
  };
}

export function parseAdjustUserBalanceCommand(
  body: Record<string, unknown>,
): AdjustUserBalanceCommand {
  requireSchemaVersion(body);
  const actorUserId = optionalString(body, "actor_user_id");
  const actorSessionId = optionalString(body, "actor_session_id");
  if ((actorUserId === undefined) !== (actorSessionId === undefined)) {
    throw new StateApiError(
      400,
      "invalid_financial_actor",
      "actor_user_id and actor_session_id must be supplied together",
    );
  }
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
    ...(actorUserId === undefined ? {} : {
      actor_user_id: actorUserId,
      actor_session_id: actorSessionId,
    }),
  };
}

export function parseSetUserEnabledCommand(body: Record<string, unknown>): SetUserEnabledCommand {
  requireSchemaVersion(body);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_id: requireString(body, "mutation_id"),
    enabled: requireBoolean(body, "enabled"),
    expected_state_version: body.expected_state_version === undefined
      ? undefined
      : requireSafeInteger(body, "expected_state_version"),
    rollback_mutation_id: body.rollback_mutation_id === undefined
      ? undefined
      : requireString(body, "rollback_mutation_id"),
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
  if (type === "ensure") {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      type,
      request_id: requestId,
      target_amount_micros: requireSafeInteger(body, "target_amount_micros"),
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
  if ((row.committed !== 0 && row.committed !== 1) || (row.expired !== 0 && row.expired !== 1)) {
    throw new StateMachineError("invalid_persisted_state", "Persisted request flags are invalid");
  }
  assertMicros(row.funded_micros, "funded_micros");
  return {
    schema_version: STATE_SCHEMA_VERSION,
    request_id: row.request_id,
    status: row.status,
    reserved_micros: row.reserved_micros,
    settled_micros: row.settled_micros,
    committed: row.committed === 1,
    funded_micros: row.funded_micros,
    expired: row.expired === 1,
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

function parseLedgerExportLimit(raw: string | null): number {
  if (raw === null) return 100;
  if (!/^\d+$/.test(raw)) {
    throw new StateApiError(400, "invalid_ledger_limit", "Ledger export limit must be an integer from 1 to 100");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new StateApiError(400, "invalid_ledger_limit", "Ledger export limit must be an integer from 1 to 100");
  }
  return value;
}

function encodeLedgerExportCursor(cursor: UserLedgerExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeLedgerExportCursor(raw: string): UserLedgerExportCursor {
  if (raw.length === 0 || raw.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidLedgerExportCursor();
  }
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - raw.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
      Partial<UserLedgerExportCursor> | null;
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [
        "after_sequence",
        "high_water_sequence",
        "ledger_count",
        "opening_state_version",
        "snapshot_balance_micros",
        "snapshot_spend_debt_micros",
        "snapshot_state_version",
        "user_id",
        "v",
      ].sort().join(",") ||
      value.v !== 1 ||
      typeof value.user_id !== "string" || value.user_id.length === 0 || value.user_id.length > 128 ||
      !isNonNegativeSafeInteger(value.after_sequence) ||
      !isNonNegativeSafeInteger(value.high_water_sequence) ||
      !isNonNegativeSafeInteger(value.ledger_count) ||
      !isNonNegativeSafeInteger(value.opening_state_version) ||
      !isNonNegativeSafeInteger(value.snapshot_state_version) ||
      !isNonNegativeSafeInteger(value.snapshot_balance_micros) ||
      !isNonNegativeSafeInteger(value.snapshot_spend_debt_micros) ||
      (value.after_sequence as number) > (value.high_water_sequence as number) ||
      checkedLedgerVersion(
        value.opening_state_version as number,
        value.high_water_sequence as number,
      ) !== value.snapshot_state_version ||
      ((value.ledger_count as number) === 0) !== ((value.high_water_sequence as number) === 0)
    ) throw invalidLedgerExportCursor();
    return value as UserLedgerExportCursor;
  } catch (error) {
    if (error instanceof StateApiError) throw error;
    throw invalidLedgerExportCursor();
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requirePersistedSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new StateMachineError("invalid_persisted_state", "User ledger sequence is invalid");
  }
  return value as number;
}

function requirePersistedHighWater(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StateMachineError("invalid_persisted_state", "User ledger export metadata is invalid");
  }
  return value as number;
}

function requireOpeningStateVersion(
  opening: UserLedgerExportRow | null,
  inferred: number | null = null,
): number {
  if (
    opening === null || opening.ledger_sequence !== 1 ||
    opening.entry_type !== "opening_balance" || opening.request_id !== null ||
    opening.enabled_after === null || opening.amount_delta_micros !== opening.balance_after_micros
  ) throw unrecoverableLedgerStateVersion();
  if (opening.state_version !== null) return opening.state_version;
  const match = /^d1-user:(0|[1-9]\d*)$/.exec(opening.mutation_id);
  if (match !== null) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) return value;
  }
  if (opening.mutation_id.startsWith("admin-create:")) return 0;
  if (inferred !== null) return inferred;
  throw unrecoverableLedgerStateVersion();
}

function checkedLedgerVersion(openingStateVersion: number, ledgerSequence: number): number {
  const value = openingStateVersion + ledgerSequence - 1;
  if (!Number.isSafeInteger(value) || value < 0) throw unrecoverableLedgerStateVersion();
  return value;
}

function unrecoverableLedgerStateVersion(): StateApiError {
  return new StateApiError(
    409,
    "ledger_state_version_unrecoverable",
    "Historical ledger state versions cannot be recovered from retained evidence",
  );
}

function invalidLedgerExportCursor(): StateApiError {
  return new StateApiError(400, "invalid_ledger_cursor", "Ledger export cursor is invalid");
}

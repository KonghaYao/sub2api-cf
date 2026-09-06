import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env";
import { UserStateDO } from "../../src/state/user-state-do";
import { applyMigrations, createSqliteD1 } from "../helpers/sqlite-d1";

interface StoredProfile {
  schema_version: number;
  user_id: string;
  enabled: number;
  balance_micros: number;
  reserved_micros: number;
  settled_micros: number;
  spend_debt_micros: number;
  updated_at_ms: number;
}

interface StoredLedgerEntry {
  ledger_sequence?: number;
  state_version?: number | null;
  mutation_key: string;
  schema_version: number;
  mutation_id: string;
  entry_type: string;
  user_id: string;
  request_id: string | null;
  amount_delta_micros: number;
  balance_after_micros: number;
  enabled_after: number | null;
  created_at_ms: number;
}

interface StoredRequest {
  schema_version: number;
  request_id: string;
  status: string;
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

interface StoredOutboxEvent {
  event_id: string;
  request_id: string;
  payload_json: string;
  attempts: number;
  available_at_ms: number;
  published_at_ms: number | null;
  created_at_ms: number;
}

class FakeUserStateStorage {
  profile: StoredProfile | null = null;
  stateVersion = 0;
  readonly ledger = new Map<string, StoredLedgerEntry>();
  readonly tombstones = new Map<number, StoredLedgerEntry>();
  readonly requests = new Map<string, StoredRequest>();
  readonly outbox = new Map<string, StoredOutboxEvent>();
  readonly profileColumns = new Set([
    "schema_version", "user_id", "enabled", "balance_micros", "reserved_micros",
    "settled_micros", "spend_debt_micros", "updated_at_ms",
  ]);
  readonly requestColumns = new Set([
    "schema_version", "request_id", "status", "reserved_micros", "settled_micros",
    "committed", "funded_micros", "expired", "reservation_expires_at_ms",
    "reservation_ttl_ms", "renewal_sequence", "last_renewal_ttl_ms", "authorized_at_ms",
    "updated_at_ms",
  ]);
  readonly ledgerColumns = new Set([
    "mutation_key", "state_version", "schema_version", "mutation_id", "entry_type",
    "user_id", "request_id", "amount_delta_micros", "balance_after_micros",
    "enabled_after", "created_at_ms",
  ]);

  constructor(legacySchema = false) {
    if (legacySchema) {
      this.profileColumns.delete("spend_debt_micros");
      this.requestColumns.delete("committed");
      this.requestColumns.delete("funded_micros");
      this.requestColumns.delete("expired");
    }
  }

  readonly sql = {
    exec: (query: string, ...params: unknown[]): object[] => this.exec(query, params),
  };

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  async setAlarm(): Promise<void> {}

  private exec(query: string, params: unknown[]): object[] {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("CREATE ")) return [];
    if (normalized === "PRAGMA table_info(user_profile)") {
      return Array.from(this.profileColumns, (name) => ({ name }));
    }
    if (normalized === "PRAGMA table_info(user_requests)") {
      return Array.from(this.requestColumns, (name) => ({ name }));
    }
    if (normalized === "PRAGMA table_info(user_ledger)") {
      return Array.from(this.ledgerColumns, (name) => ({ name }));
    }
    if (normalized.startsWith("ALTER TABLE user_profile ADD COLUMN spend_debt_micros")) {
      this.profileColumns.add("spend_debt_micros");
      return [];
    }
    if (normalized.startsWith("ALTER TABLE user_requests ADD COLUMN")) {
      const column = normalized.split(" ")[5];
      if (column !== undefined) this.requestColumns.add(column);
      return [];
    }
    if (normalized.startsWith("UPDATE user_requests SET funded_micros = reserved_micros")) {
      for (const request of this.requests.values()) {
        if (request.status === "reserved") request.funded_micros = request.reserved_micros;
      }
      return [];
    }
    if (normalized.startsWith("UPDATE user_requests SET expired = 1")) {
      for (const request of this.requests.values()) {
        if (
          request.status === "cancelled" &&
          request.reservation_expires_at_ms !== null &&
          request.updated_at_ms >= request.reservation_expires_at_ms
        ) request.expired = 1;
      }
      return [];
    }
    if (normalized.startsWith("INSERT OR IGNORE INTO user_state_metadata")) return [];
    if (normalized.includes("SELECT state_version FROM user_state_metadata")) {
      return [{ state_version: this.stateVersion }];
    }
    if (normalized.startsWith("UPDATE user_state_metadata SET state_version =")) {
      this.stateVersion = params[0] as number;
      return [];
    }
    if (normalized.includes("FROM user_profile") && normalized.includes("singleton = 1")) {
      return this.profile === null ? [] : [{ ...this.profile }];
    }
    if (normalized.startsWith("DELETE FROM user_ledger WHERE mutation_key = ?")) {
      this.ledger.delete(params[0] as string);
      return [];
    }
    if (normalized.includes("SELECT MAX(") && normalized.includes("MAX(rowid) FROM user_ledger")) {
      return [{ high_water_sequence: this.maximumLedgerSequence() }];
    }
    if (
      normalized.includes("COUNT(*) AS ledger_count") &&
      normalized.includes("FROM user_ledger") &&
      normalized.includes("rowid <= ?")
    ) {
      const highWaterSequence = params[0] as number;
      return [{ ledger_count: Math.min(this.ledger.size, highWaterSequence) }];
    }
    if (
      normalized.includes("rowid AS ledger_sequence") && normalized.includes("FROM user_ledger") &&
      normalized.includes("ORDER BY ledger_sequence ASC")
    ) {
      const afterSequence = params[0] as number;
      const highWaterSequence = params[1] as number;
      const limit = params[2] as number;
      return this.allLedgerEntries()
        .filter((entry) => (
          entry.ledger_sequence > afterSequence &&
          entry.ledger_sequence <= highWaterSequence
        ))
        .slice(0, limit);
    }
    if (normalized.includes("WHERE ledger_sequence = ?") && normalized.includes("LIMIT 2")) {
      return this.allLedgerEntries().filter((entry) => entry.ledger_sequence === params[0]);
    }
    if (normalized.includes("FROM user_ledger") && normalized.includes("mutation_key = ?")) {
      const entry = this.ledger.get(params[0] as string);
      return entry === undefined ? [] : [{ ...entry, ledger_sequence: this.sequenceOf(entry) }];
    }
    if (normalized.includes("FROM user_requests") && normalized.includes("status = 'reserved'")) {
      if (normalized.includes("MIN(reservation_expires_at_ms)")) {
        return [{ next_alarm_ms: null }];
      }
      return [];
    }
    if (normalized.includes("FROM user_requests") && normalized.includes("request_id = ?")) {
      const request = this.requests.get(params[0] as string);
      return request === undefined ? [] : [{ ...request }];
    }
    if (normalized.includes("FROM user_outbox")) {
      if (normalized.includes("MIN(available_at_ms)")) {
        const pending = [...this.outbox.values()]
          .filter((row) => row.published_at_ms === null)
          .map((row) => row.available_at_ms);
        return [{ next_alarm_ms: pending.length === 0 ? null : Math.min(...pending) }];
      }
      if (normalized.includes("WHERE request_id = ?")) {
        const row = this.outbox.get(params[0] as string);
        return row === undefined ? [] : [{ payload_json: row.payload_json }];
      }
      if (normalized.includes("published_at_ms IS NULL") && normalized.includes("LIMIT 10")) {
        const now = params[0] as number;
        return [...this.outbox.values()]
          .filter((row) => row.published_at_ms === null && row.available_at_ms <= now)
          .sort((left, right) => left.available_at_ms - right.available_at_ms ||
            left.event_id.localeCompare(right.event_id))
          .slice(0, 10)
          .map(({ event_id, payload_json, attempts }) => ({ event_id, payload_json, attempts }));
      }
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_outbox")) {
      const row: StoredOutboxEvent = {
        event_id: params[0] as string,
        request_id: params[1] as string,
        payload_json: params[2] as string,
        attempts: 0,
        available_at_ms: params[3] as number,
        published_at_ms: null,
        created_at_ms: params[4] as number,
      };
      this.outbox.set(row.request_id, row);
      return [];
    }
    if (normalized.startsWith("UPDATE user_outbox SET published_at_ms")) {
      const row = [...this.outbox.values()].find((value) => value.event_id === params[1]);
      if (row !== undefined && row.published_at_ms === null) row.published_at_ms = params[0] as number;
      return [];
    }
    if (normalized.startsWith("UPDATE user_outbox SET attempts")) {
      const row = [...this.outbox.values()].find((value) => value.event_id === params[1]);
      if (row !== undefined && row.published_at_ms === null) {
        row.attempts += 1;
        row.available_at_ms = params[0] as number;
      }
      return [];
    }
    if (normalized.startsWith("DELETE FROM user_outbox")) {
      const cutoff = params[0] as number;
      for (const [key, row] of this.outbox) {
        if (row.published_at_ms !== null && row.published_at_ms < cutoff) this.outbox.delete(key);
      }
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_profile")) {
      this.profile = {
        schema_version: params[0] as number,
        user_id: params[1] as string,
        enabled: params[2] as number,
        balance_micros: params[3] as number,
        reserved_micros: params[4] as number,
        settled_micros: params[5] as number,
        spend_debt_micros: params[6] as number,
        updated_at_ms: params[7] as number,
      };
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_ledger (")) {
      const entry: StoredLedgerEntry = {
        mutation_key: params[0] as string,
        ledger_sequence: this.maximumLedgerSequence() + 1,
        state_version: params[1] as number,
        schema_version: params[2] as number,
        mutation_id: params[3] as string,
        entry_type: params[4] as string,
        user_id: params[5] as string,
        request_id: params[6] as string | null,
        amount_delta_micros: params[7] as number,
        balance_after_micros: params[8] as number,
        enabled_after: params[9] as number | null,
        created_at_ms: params[10] as number,
      };
      if (this.ledger.has(entry.mutation_key)) throw new Error("duplicate mutation key");
      this.ledger.set(entry.mutation_key, entry);
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_ledger_tombstones")) {
      const ledgerSequence = params[1] as number;
      this.tombstones.set(ledgerSequence, {
        state_version: params[0] as number,
        ledger_sequence: ledgerSequence,
        mutation_key: params[2] as string,
        mutation_id: params[3] as string,
        entry_type: "enabled_change",
        schema_version: 1,
        user_id: params[4] as string,
        request_id: null,
        amount_delta_micros: 0,
        balance_after_micros: params[5] as number,
        enabled_after: params[6] as number,
        created_at_ms: params[7] as number,
      });
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_requests")) {
      const request: StoredRequest = {
        schema_version: params[0] as number,
        request_id: params[1] as string,
        status: params[2] as string,
        reserved_micros: params[3] as number,
        settled_micros: params[4] as number | null,
        committed: params[5] as number,
        funded_micros: params[6] as number,
        expired: params[7] as number,
        reservation_expires_at_ms: params[8] as number | null,
        reservation_ttl_ms: params[9] as number | null,
        renewal_sequence: params[10] as number,
        last_renewal_ttl_ms: params[11] as number | null,
        authorized_at_ms: params[12] as number,
        updated_at_ms: params[13] as number,
      };
      this.requests.set(request.request_id, request);
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${normalized}`);
  }

  private sequenceOf(entry: StoredLedgerEntry): number {
    return entry.ledger_sequence ?? [...this.ledger.values()].indexOf(entry) + 1;
  }

  private maximumLedgerSequence(): number {
    return Math.max(0, ...[...this.ledger.values()].map((entry) => this.sequenceOf(entry)), ...this.tombstones.keys());
  }

  private allLedgerEntries(): Array<StoredLedgerEntry & { ledger_sequence: number }> {
    return [...this.ledger.values(), ...this.tombstones.values()]
      .map((entry) => ({ ...entry, state_version: entry.state_version ?? null, ledger_sequence: this.sequenceOf(entry) }))
      .sort((left, right) => left.ledger_sequence - right.ledger_sequence);
  }
}

function createHarness(
  env?: Env,
  options: { legacySchema?: boolean } = {},
): { object: UserStateDO; storage: FakeUserStateStorage } {
  const storage = new FakeUserStateStorage(options.legacySchema);
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState;
  return { object: new UserStateDO(state, env), storage };
}

function post(object: UserStateDO, path: string, body: Record<string, unknown>): Promise<Response> {
  return object.fetch(
    new Request(`https://user-state.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const opening = {
  schema_version: 1,
  mutation_id: "open-1",
  user_id: "user-1",
  balance_micros: 1_000,
  enabled: true,
};

describe("UserStateDO balance contract", () => {
  it("exports a stable ledger snapshot across more than 100 same-timestamp entries", async () => {
    const { object, storage } = createHarness();
    storage.profile = {
      schema_version: 1,
      user_id: "user-1",
      enabled: 1,
      balance_micros: 1_104,
      reserved_micros: 0,
      settled_micros: 0,
      spend_debt_micros: 0,
      updated_at_ms: 1,
    };
    for (let index = 0; index < 105; index += 1) {
      const opening = index === 0;
      const mutationId = opening ? "d1-user:0" : `adjust-${String(index).padStart(3, "0")}`;
      storage.ledger.set(`balance:${mutationId}`, {
        mutation_key: `balance:${mutationId}`,
        schema_version: 1,
        mutation_id: mutationId,
        entry_type: opening ? "opening_balance" : "balance_adjustment",
        user_id: "user-1",
        request_id: null,
        amount_delta_micros: opening ? 1_000 : 1,
        balance_after_micros: 1_000 + index,
        enabled_after: opening ? 1 : null,
        created_at_ms: 1,
      });
    }
    storage.stateVersion = 104;

    const first = await object.fetch(new Request("https://user-state.test/ledger/export?limit=100"));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({
      schema_version: 1,
      snapshot: {
        user_id: "user-1",
        state_version: 104,
        balance_micros: 1_104,
        spend_debt_micros: 0,
        ledger_count: 105,
        high_water_sequence: 105,
      },
      complete: false,
    });
    expect(firstBody.entries).toHaveLength(100);
    expect(firstBody.entries[0]).toMatchObject({
      ledger_sequence: 1,
      entry_type: "opening_balance",
      mutation_id: "d1-user:0",
    });
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    // A later append must not enter the already-started traversal.
    storage.ledger.set("balance:later", {
      mutation_key: "balance:later",
      schema_version: 1,
      mutation_id: "later",
      entry_type: "balance_adjustment",
      user_id: "user-1",
      request_id: null,
      amount_delta_micros: 1,
      balance_after_micros: 1_105,
      enabled_after: null,
      created_at_ms: 1,
    });
    storage.profile.balance_micros = 1_105;
    storage.stateVersion = 105;

    const second = await object.fetch(new Request(
      `https://user-state.test/ledger/export?limit=100&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
    ));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      snapshot: {
        state_version: 104,
        balance_micros: 1_104,
        ledger_count: 105,
        high_water_sequence: 105,
      },
      entries: [
        { ledger_sequence: 101 },
        { ledger_sequence: 102 },
        { ledger_sequence: 103 },
        { ledger_sequence: 104 },
        { ledger_sequence: 105 },
      ],
      complete: true,
      next_cursor: null,
    });
  });

  it("rejects invalid ledger export limits and cursors", async () => {
    const { object } = createHarness();

    const invalidLimit = await object.fetch(
      new Request("https://user-state.test/ledger/export?limit=101"),
    );
    const invalidCursor = await object.fetch(
      new Request("https://user-state.test/ledger/export?cursor=not-a-cursor"),
    );

    expect(invalidLimit.status).toBe(400);
    await expect(invalidLimit.json()).resolves.toMatchObject({
      error: { code: "invalid_ledger_limit" },
    });
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({
      error: { code: "invalid_ledger_cursor" },
    });
  });

  it("adds commitment and spend-debt columns to existing SQLite tables", () => {
    const { storage } = createHarness(undefined, { legacySchema: true });

    expect(storage.profileColumns.has("spend_debt_micros")).toBe(true);
    expect(storage.requestColumns.has("committed")).toBe(true);
    expect(storage.requestColumns.has("funded_micros")).toBe(true);
    expect(storage.requestColumns.has("expired")).toBe(true);
  });

  it("rechecks group entitlement before each authorization transition", async () => {
    const { raw, d1 } = createSqliteD1();
    applyMigrations(raw);
    const now = Date.now();
    raw.exec(`
      INSERT INTO users (
        id, email, display_name, balance_micros, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'user-1@example.test', 'User 1', 1000, ${now}, ${now});
      INSERT INTO "groups" (
        id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'Group 1', 'openai', 1, 'standard', 1, ${now}, ${now});
      INSERT INTO api_keys (
        id, user_id, key_hash, name, enabled, created_at_ms, updated_at_ms,
        group_id, key_prefix, auth_version
      ) VALUES (
        'key-1', 'user-1', '${"a".repeat(64)}', 'Key 1', 1, ${now}, ${now},
        'group-1', 'sk-sub2api-test', 1
      );
      DELETE FROM user_group_permissions
       WHERE user_id = 'user-1' AND group_id = 'group-1';
    `);
    const { object, storage } = createHarness({ DB: d1 } as Env);
    await post(object, "/configure", opening);
    const authorize = (requestId: string) => post(object, "/authorize", {
      schema_version: 1,
      request_id: requestId,
      user_id: "user-1",
      api_key_id: "key-1",
      api_key_auth_version: 1,
    });

    const missingCredential = await post(object, "/authorize", {
      schema_version: 1,
      request_id: "request-without-key",
    });
    expect(missingCredential.status).toBe(400);
    expect(storage.requests.has("request-without-key")).toBe(false);

    const denied = await authorize("request-denied");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "group_access_denied" },
    });
    expect(storage.requests.has("request-denied")).toBe(false);

    raw.prepare(
      `INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
       VALUES ('user-1', 'group-1', ?)`,
    ).run(now);
    expect((await authorize("request-allowed")).status).toBe(200);

    raw.prepare(`UPDATE "groups" SET platform = 'gemini' WHERE id = 'group-1'`).run();
    expect((await authorize("request-gemini")).status).toBe(200);

    raw.prepare(`UPDATE "groups" SET platform = 'unsupported' WHERE id = 'group-1'`).run();
    const unsupported = await authorize("request-unsupported");
    expect(unsupported.status).toBe(403);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "group_unavailable" },
    });

    raw.prepare(`UPDATE "groups" SET platform = 'gemini' WHERE id = 'group-1'`).run();
    raw.prepare(
      `DELETE FROM user_group_permissions WHERE user_id = 'user-1' AND group_id = 'group-1'`,
    ).run();
    const revoked = await authorize("request-revoked");
    expect(revoked.status).toBe(403);
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: "group_access_denied" },
    });
    expect(storage.requests.has("request-revoked")).toBe(false);
    raw.close();
  });

  it("makes configuration create-only while preserving exact retry idempotency", async () => {
    const { object, storage } = createHarness();

    expect((await post(object, "/configure", opening)).status).toBe(200);
    const retry = await post(object, "/configure", opening);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ idempotent: true });

    const differentMutation = await post(object, "/configure", {
      ...opening,
      mutation_id: "overwrite-2",
      balance_micros: 9_000,
    });
    expect(differentMutation.status).toBe(409);
    await expect(differentMutation.json()).resolves.toMatchObject({
      error: { code: "user_already_configured" },
    });
    expect(storage.profile?.balance_micros).toBe(1_000);

    const conflictingRetry = await post(object, "/configure", {
      ...opening,
      balance_micros: 2_000,
    });
    expect(conflictingRetry.status).toBe(409);
    await expect(conflictingRetry.json()).resolves.toMatchObject({
      error: { code: "mutation_conflict" },
    });
  });

  it("publishes one debt-aware opening event as the financial history watermark", async () => {
    const sent: unknown[] = [];
    const queue = { send: vi.fn(async (event: unknown) => { sent.push(event); }) };
    const { object } = createHarness({ EVENTS_QUEUE: queue } as unknown as Env);
    const command = {
      ...opening,
      mutation_id: "d1-user:7",
      balance_micros: 1_000,
      spend_debt_micros: 300,
      initial_state_version: 7,
    };

    expect((await post(object, "/configure", command)).status).toBe(200);
    expect((await post(object, "/configure", command)).status).toBe(200);

    expect(queue.send).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({
        event_id: "user-state:user-1:7",
        event_type: "user.state.changed.v1",
        payload: expect.objectContaining({
          mutation_id: "d1-user:7",
          state_version: 7,
          financial_event: {
            event_type: "opening_balance",
            source_type: "opening_balance",
            source_id: "7",
            request_id: null,
            actor_user_id: null,
            actor_session_id: null,
            amount_delta_micros: 1_000,
            gross_amount_micros: 1_000,
            spend_debt_delta_micros: 300,
            balance_after_micros: 1_000,
            spend_debt_after_micros: 300,
          },
        }),
      }),
    ]);
  });

  it("adjusts balances by a signed delta and retries idempotently", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);

    const adjustment = {
      schema_version: 1,
      mutation_id: "adjust-1",
      amount_delta_micros: -250,
    };
    const first = await post(object, "/balance/adjust", adjustment);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      idempotent: false,
      state_version: 1,
      profile: { balance_micros: 750, enabled: true },
    });
    expect(storage.ledger.get("balance:adjust-1")).toMatchObject({
      entry_type: "balance_adjustment",
      amount_delta_micros: -250,
      balance_after_micros: 750,
      enabled_after: null,
    });

    const retry = await post(object, "/balance/adjust", adjustment);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      idempotent: true,
      state_version: 1,
      profile: { balance_micros: 750 },
    });
    expect(storage.ledger.size).toBe(2);

    const conflict = await post(object, "/balance/adjust", {
      ...adjustment,
      amount_delta_micros: 250,
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "mutation_conflict" },
    });
  });

  it("publishes an exact debt-aware financial event after a balance adjustment", async () => {
    const sent: unknown[] = [];
    const queue = { send: vi.fn(async (event: unknown) => { sent.push(event); }) };
    const { object } = createHarness({ EVENTS_QUEUE: queue } as unknown as Env);
    await post(object, "/configure", {
      ...opening,
      spend_debt_micros: 300,
    });
    sent.length = 0;
    queue.send.mockClear();

    const response = await post(object, "/balance/adjust", {
      schema_version: 1,
      mutation_id: "affiliate-transfer:transfer-1",
      amount_delta_micros: 500,
      actor_user_id: "admin-1",
      actor_session_id: "session-1",
    });

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({
        event_id: "user-state:user-1:1",
        event_type: "user.state.changed.v1",
        aggregate_id: "user-1",
        payload: expect.objectContaining({
          mutation_id: "affiliate-transfer:transfer-1",
          balance_micros: 1_200,
          spend_debt_micros: 0,
          financial_event: {
            event_type: "balance_adjustment",
            source_type: "affiliate_transfer",
            source_id: "transfer-1",
            request_id: null,
            amount_delta_micros: 200,
            gross_amount_micros: 500,
            spend_debt_delta_micros: -300,
            balance_after_micros: 1_200,
            spend_debt_after_micros: 0,
            actor_user_id: "admin-1",
            actor_session_id: "session-1",
          },
        }),
      }),
    ]);
  });

  it.each([
    ["admin-balance:adjust-1", "admin_adjustment", "adjust-1"],
    ["redeem:redemption-1", "redeem_code", "redemption-1"],
    ["affiliate-transfer:transfer-1", "affiliate_transfer", "transfer-1"],
    ["affiliate-refund-clawback:refund-1", "affiliate_refund_clawback", "refund-1"],
    ["auth-source-grant:grant-1", "auth_source_entitlement", "grant-1"],
    ["compensation-1", "other_adjustment", "compensation-1"],
  ])(
    "classifies %s as %s without source-specific D1 writes",
    async (mutationId, sourceType, sourceId) => {
      const sent: any[] = [];
      const queue = { send: vi.fn(async (event: unknown) => { sent.push(event); }) };
      const { object } = createHarness({ EVENTS_QUEUE: queue } as unknown as Env);
      await post(object, "/configure", opening);
      sent.length = 0;
      queue.send.mockClear();

      const response = await post(object, "/balance/adjust", {
        schema_version: 1,
        mutation_id: mutationId,
        amount_delta_micros: 100,
      });

      expect(response.status).toBe(200);
      expect(sent[0]?.payload?.financial_event).toMatchObject({
        source_type: sourceType,
        source_id: sourceId,
        amount_delta_micros: 100,
      });
    },
  );

  it("publishes the funded balance and overdelivery debt for a settlement", async () => {
    const { raw, d1 } = createSqliteD1();
    applyMigrations(raw);
    const now = Date.now();
    raw.exec(`
      INSERT INTO users (
        id, email, display_name, balance_micros, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'user-1@example.test', 'User 1', 1000, ${now}, ${now});
      INSERT INTO "groups" (
        id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
      ) VALUES ('group-1', 'Group 1', 'openai', 1, 'standard', 1, ${now}, ${now});
      INSERT INTO api_keys (
        id, user_id, key_hash, name, enabled, created_at_ms, updated_at_ms,
        group_id, key_prefix, auth_version
      ) VALUES (
        'key-1', 'user-1', '${"a".repeat(64)}', 'Key 1', 1, ${now}, ${now},
        'group-1', 'sk-sub2api-test', 1
      );
    `);
    const sent: unknown[] = [];
    const queue = { send: vi.fn(async (event: unknown) => { sent.push(event); }) };
    const { object } = createHarness({
      DB: d1,
      EVENTS_QUEUE: queue,
    } as unknown as Env);
    await post(object, "/configure", opening);
    sent.length = 0;
    queue.send.mockClear();
    expect((await post(object, "/authorize", {
      schema_version: 1,
      request_id: "request-debt-history",
      user_id: "user-1",
      api_key_id: "key-1",
      api_key_auth_version: 1,
    })).status).toBe(200);
    expect((await post(object, "/reserve", {
      schema_version: 1,
      request_id: "request-debt-history",
      amount_micros: 1_000,
    })).status).toBe(200);
    expect((await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-debt-history",
      target_amount_micros: 1_200,
    })).status).toBe(200);

    const response = await post(object, "/settle", {
      schema_version: 1,
      request_id: "request-debt-history",
      amount_micros: 1_200,
    });

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledOnce();
    expect(sent).toEqual([
      expect.objectContaining({
        event_id: "user-state:user-1:1",
        payload: expect.objectContaining({
          mutation_id: "settlement:request-debt-history",
          financial_event: {
            event_type: "settlement",
            source_type: "usage_settlement",
            source_id: "request-debt-history",
            request_id: "request-debt-history",
            actor_user_id: null,
            actor_session_id: null,
            amount_delta_micros: -1_000,
            gross_amount_micros: 1_200,
            spend_debt_delta_micros: 200,
            balance_after_micros: 0,
            spend_debt_after_micros: 200,
          },
        }),
      }),
    ]);
    raw.close();
  });

  it("commits an underfunded reservation through POST /ensure", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);
    storage.profile!.reserved_micros = 40;
    storage.requests.set("request-overdelivery", {
      schema_version: 1,
      request_id: "request-overdelivery",
      status: "reserved",
      reserved_micros: 40,
      settled_micros: null,
      committed: 0,
      funded_micros: 40,
      expired: 0,
      reservation_expires_at_ms: Date.now() + 300_000,
      reservation_ttl_ms: 300_000,
      renewal_sequence: 0,
      last_renewal_ttl_ms: null,
      authorized_at_ms: Date.now(),
      updated_at_ms: Date.now(),
    });

    const response = await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-overdelivery",
      target_amount_micros: 1_200,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      idempotent: false,
      profile: {
        balance_micros: 1_000,
        reserved_micros: 1_000,
        spend_debt_micros: 0,
      },
      available_micros: 0,
      request: {
        status: "reserved",
        reserved_micros: 1_200,
        committed: true,
        funded_micros: 1_000,
      },
    });
  });

  it("settles an underfunded commitment for its exact target and persists spend debt", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);
    storage.profile!.reserved_micros = 40;
    storage.requests.set("request-debt", {
      schema_version: 1,
      request_id: "request-debt",
      status: "reserved",
      reserved_micros: 40,
      settled_micros: null,
      committed: 0,
      funded_micros: 40,
      expired: 0,
      reservation_expires_at_ms: Date.now() + 300_000,
      reservation_ttl_ms: 300_000,
      renewal_sequence: 0,
      last_renewal_ttl_ms: null,
      authorized_at_ms: Date.now(),
      updated_at_ms: Date.now(),
    });
    expect((await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-debt",
      target_amount_micros: 1_200,
    })).status).toBe(200);

    const settlement = await post(object, "/settle", {
      schema_version: 1,
      request_id: "request-debt",
      amount_micros: 1_200,
    });

    expect(settlement.status).toBe(200);
    await expect(settlement.json()).resolves.toMatchObject({
      profile: {
        balance_micros: 0,
        reserved_micros: 0,
        settled_micros: 1_200,
        spend_debt_micros: 200,
      },
      request: {
        status: "settled",
        committed: true,
        funded_micros: 1_000,
        settled_micros: 1_200,
      },
    });
    expect(storage.ledger.get("settlement:request-debt")).toMatchObject({
      amount_delta_micros: -1_200,
      balance_after_micros: 0,
    });
  });

  it("keeps commitment retries exact and rejects cancellation or a different target", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);
    storage.profile!.reserved_micros = 40;
    storage.requests.set("request-exact", {
      schema_version: 1,
      request_id: "request-exact",
      status: "reserved",
      reserved_micros: 40,
      settled_micros: null,
      committed: 0,
      funded_micros: 40,
      expired: 0,
      reservation_expires_at_ms: Date.now() + 300_000,
      reservation_ttl_ms: 300_000,
      renewal_sequence: 0,
      last_renewal_ttl_ms: null,
      authorized_at_ms: Date.now(),
      updated_at_ms: Date.now(),
    });
    expect((await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-exact",
      target_amount_micros: 100,
    })).status).toBe(200);

    const replay = await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-exact",
      target_amount_micros: 100,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true });

    for (const [path, body, code] of [
      ["/ensure", { target_amount_micros: 101 }, "reservation_commitment_conflict"],
      ["/cancel", {}, "invalid_transition"],
    ] as const) {
      const response = await post(object, path, {
        schema_version: 1,
        request_id: "request-exact",
        ...body,
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    }

    expect((await post(object, "/settle", {
      schema_version: 1,
      request_id: "request-exact",
      amount_micros: 100,
    })).status).toBe(200);
    const settledReplay = await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-exact",
      target_amount_micros: 100,
    });
    expect(settledReplay.status).toBe(200);
    await expect(settledReplay.json()).resolves.toMatchObject({ idempotent: true });
  });

  it("commits naturally expired requests but rejects manually cancelled requests", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);
    const storedRequest = (request_id: string, expired: 0 | 1): StoredRequest => ({
      schema_version: 1,
      request_id,
      status: "cancelled",
      reserved_micros: 40,
      settled_micros: null,
      committed: 0,
      funded_micros: 40,
      expired,
      reservation_expires_at_ms: Date.now() - 1,
      reservation_ttl_ms: 300_000,
      renewal_sequence: 0,
      last_renewal_ttl_ms: null,
      authorized_at_ms: Date.now() - 300_001,
      updated_at_ms: Date.now(),
    });
    storage.requests.set("request-expired", storedRequest("request-expired", 1));
    storage.requests.set("request-cancelled", storedRequest("request-cancelled", 0));

    const recovered = await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-expired",
      target_amount_micros: 1_200,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      request: { status: "reserved", committed: true, funded_micros: 1_000 },
    });

    const rejected = await post(object, "/ensure", {
      schema_version: 1,
      request_id: "request-cancelled",
      target_amount_micros: 40,
    });
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "invalid_transition" },
    });
  });

  it("uses positive balance adjustments to repay spend debt before increasing balance", async () => {
    const { object, storage } = createHarness();
    const configured = await post(object, "/configure", {
      ...opening,
      spend_debt_micros: 50,
    });
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      profile: { balance_micros: 1_000, spend_debt_micros: 50 },
    });

    const partialRepayment = await post(object, "/balance/adjust", {
      schema_version: 1,
      mutation_id: "repay-partial",
      amount_delta_micros: 30,
    });
    expect(partialRepayment.status).toBe(200);
    await expect(partialRepayment.json()).resolves.toMatchObject({
      profile: { balance_micros: 1_000, spend_debt_micros: 20 },
    });

    const repaymentWithRemainder = await post(object, "/balance/adjust", {
      schema_version: 1,
      mutation_id: "repay-rest",
      amount_delta_micros: 50,
    });
    expect(repaymentWithRemainder.status).toBe(200);
    await expect(repaymentWithRemainder.json()).resolves.toMatchObject({
      profile: { balance_micros: 1_030, spend_debt_micros: 0 },
    });
    expect(storage.ledger.get("balance:repay-partial")).toMatchObject({
      amount_delta_micros: 30,
      balance_after_micros: 1_000,
    });
  });

  it("rejects invalid adjustments and balances below active reservations", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);

    for (const amount_delta_micros of [0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await post(object, "/balance/adjust", {
        schema_version: 1,
        mutation_id: `invalid-${amount_delta_micros}`,
        amount_delta_micros,
      });
      expect(response.status).toBe(400);
    }

    for (const [mutation_id, amount_delta_micros] of [
      ["negative-result", -1_001],
      ["unsafe-result", Number.MAX_SAFE_INTEGER],
    ] as const) {
      const response = await post(object, "/balance/adjust", {
        schema_version: 1,
        mutation_id,
        amount_delta_micros,
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "balance_out_of_range" },
      });
    }

    storage.profile!.reserved_micros = 800;
    const belowReservations = await post(object, "/balance/adjust", {
      schema_version: 1,
      mutation_id: "below-reservations",
      amount_delta_micros: -300,
    });
    expect(belowReservations.status).toBe(409);
    await expect(belowReservations.json()).resolves.toMatchObject({
      error: { code: "balance_below_reservations" },
    });
    expect(storage.profile?.balance_micros).toBe(1_000);
  });

  it("changes enabled state through a separate idempotent command", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);

    const command = { schema_version: 1, mutation_id: "disable-1", enabled: false };
    const first = await post(object, "/enabled", command);
    expect(first.status).toBe(200);
    await expect(first.clone().json()).resolves.toMatchObject({ state_version: 1 });
    expect(storage.profile?.enabled).toBe(0);
    expect(storage.profile?.balance_micros).toBe(1_000);
    expect(storage.ledger.get("enabled:disable-1")).toMatchObject({
      entry_type: "enabled_change",
      amount_delta_micros: 0,
      enabled_after: 0,
    });

    const retry = await post(object, "/enabled", command);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ idempotent: true, state_version: 1 });

    const conflict = await post(object, "/enabled", { ...command, enabled: true });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "mutation_conflict" },
    });

    const reenabled = await post(object, "/enabled", {
      schema_version: 1,
      mutation_id: "enable-2",
      enabled: true,
    });
    await expect(reenabled.json()).resolves.toMatchObject({ state_version: 2 });

    const staleConditional = await post(object, "/enabled", {
      schema_version: 1,
      mutation_id: "stale-compensation",
      enabled: false,
      expected_state_version: 1,
    });
    expect(staleConditional.status).toBe(200);
    await expect(staleConditional.json()).resolves.toMatchObject({
      applied: false,
      state_version: 2,
      profile: { enabled: true },
    });
    expect(storage.profile?.enabled).toBe(1);

    const supersededRetry = await post(object, "/enabled", command);
    expect(supersededRetry.status).toBe(409);
    await expect(supersededRetry.json()).resolves.toMatchObject({
      error: { code: "mutation_superseded" },
    });
  });

  it("allows a rolled-back enabled mutation to be retried with the original idempotency key", async () => {
    const { object, storage } = createHarness();
    await post(object, "/configure", opening);
    const disable = {
      schema_version: 1,
      mutation_id: "disable-retryable",
      enabled: false,
    };

    const first = await post(object, "/enabled", disable);
    await expect(first.json()).resolves.toMatchObject({ state_version: 1 });

    // Simulate a pre-state_version object whose opening mutation used the
    // original generic identifier. Its contiguous rowids still prove the
    // versions without a constructor-time ledger scan.
    storage.ledger.get("balance:open-1")!.state_version = null;
    storage.ledger.get("enabled:disable-retryable")!.state_version = null;

    const compensation = await post(object, "/enabled", {
      schema_version: 1,
      mutation_id: "compensate-disable-retryable-1",
      enabled: true,
      expected_state_version: 1,
      rollback_mutation_id: "disable-retryable",
    });
    await expect(compensation.json()).resolves.toMatchObject({
      state_version: 2,
      profile: { enabled: true },
    });
    expect(storage.ledger.has("enabled:disable-retryable")).toBe(false);

    const retry = await post(object, "/enabled", disable);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      idempotent: false,
      state_version: 3,
      profile: { enabled: false },
    });
    expect(storage.profile?.enabled).toBe(0);

    const exported = await object.fetch(
      new Request("https://user-state.test/ledger/export?limit=100"),
    );
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      snapshot: {
        state_version: 3,
        ledger_count: 4,
        high_water_sequence: 4,
      },
      complete: true,
      entries: [
        { ledger_sequence: 1, state_version: 0, entry_type: "opening_balance" },
        {
          ledger_sequence: 2,
          state_version: 1,
          entry_type: "enabled_change",
          mutation_id: "disable-retryable",
        },
        {
          ledger_sequence: 3,
          state_version: 2,
          entry_type: "enabled_change",
          mutation_id: "compensate-disable-retryable-1",
        },
        {
          ledger_sequence: 4,
          state_version: 3,
          entry_type: "enabled_change",
          mutation_id: "disable-retryable",
        },
      ],
    });
  });
});

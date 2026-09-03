import { describe, expect, it } from "vitest";

import { UserStateDO } from "../../src/state/user-state-do";

interface StoredProfile {
  schema_version: number;
  user_id: string;
  enabled: number;
  balance_micros: number;
  reserved_micros: number;
  settled_micros: number;
  updated_at_ms: number;
}

interface StoredLedgerEntry {
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

class FakeUserStateStorage {
  profile: StoredProfile | null = null;
  readonly ledger = new Map<string, StoredLedgerEntry>();

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
    if (normalized.includes("FROM user_profile") && normalized.includes("singleton = 1")) {
      return this.profile === null ? [] : [{ ...this.profile }];
    }
    if (normalized.includes("FROM user_ledger") && normalized.includes("mutation_key = ?")) {
      const entry = this.ledger.get(params[0] as string);
      return entry === undefined ? [] : [{ ...entry }];
    }
    if (normalized.includes("FROM user_requests") && normalized.includes("status = 'reserved'")) {
      if (normalized.includes("MIN(reservation_expires_at_ms)")) {
        return [{ next_alarm_ms: null }];
      }
      return [];
    }
    if (normalized.includes("FROM user_outbox")) {
      if (normalized.includes("MIN(available_at_ms)")) return [{ next_alarm_ms: null }];
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
        updated_at_ms: params[6] as number,
      };
      return [];
    }
    if (normalized.startsWith("INSERT INTO user_ledger")) {
      const entry: StoredLedgerEntry = {
        mutation_key: params[0] as string,
        schema_version: params[1] as number,
        mutation_id: params[2] as string,
        entry_type: params[3] as string,
        user_id: params[4] as string,
        request_id: params[5] as string | null,
        amount_delta_micros: params[6] as number,
        balance_after_micros: params[7] as number,
        enabled_after: params[8] as number | null,
        created_at_ms: params[9] as number,
      };
      if (this.ledger.has(entry.mutation_key)) throw new Error("duplicate mutation key");
      this.ledger.set(entry.mutation_key, entry);
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${normalized}`);
  }
}

function createHarness(): { object: UserStateDO; storage: FakeUserStateStorage } {
  const storage = new FakeUserStateStorage();
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState;
  return { object: new UserStateDO(state), storage };
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
    expect(storage.profile?.enabled).toBe(0);
    expect(storage.profile?.balance_micros).toBe(1_000);
    expect(storage.ledger.get("enabled:disable-1")).toMatchObject({
      entry_type: "enabled_change",
      amount_delta_micros: 0,
      enabled_after: 0,
    });

    const retry = await post(object, "/enabled", command);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ idempotent: true });

    const conflict = await post(object, "/enabled", { ...command, enabled: true });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "mutation_conflict" },
    });
  });
});

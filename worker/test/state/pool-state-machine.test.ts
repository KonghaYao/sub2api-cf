import { describe, expect, it } from "vitest";

import {
  applyPoolCommand,
  createPoolMachineState,
  nextActiveLeaseAlarmAt,
  PoolStateMachineError,
} from "../../src/shared/state-machine/pool";

function poolWithAccount(maxConcurrency = 1) {
  return applyPoolCommand(
    createPoolMachineState(),
    {
      schema_version: 1,
      type: "upsert_account",
      account_id: "account-1",
      enabled: true,
      max_concurrency: maxConcurrency,
    },
    1_000,
  ).state;
}

function poolWithTwoAccounts() {
  return applyPoolCommand(
    createPoolMachineState(),
    {
      schema_version: 1,
      type: "sync_accounts",
      config_revision: 1,
      config_fingerprint: "1".repeat(64),
      accounts: [
        { account_id: "account-1", max_concurrency: 2, priority: 1, weight: 1 },
        { account_id: "account-2", max_concurrency: 2, priority: 0, weight: 1 },
      ],
    },
    1_000,
  ).state;
}

describe("pool state machine", () => {
  it("keeps configured load factors effective in the advanced scheduler without expanding concurrency", () => {
    let state = applyPoolCommand(createPoolMachineState(), {
      schema_version: 1, type: "sync_accounts", config_revision: 1, config_fingerprint: "1".repeat(64),
      accounts: [
        { account_id: "a", max_concurrency: 2, priority: 0, weight: 1, load_factor: 1 },
        { account_id: "b", max_concurrency: 2, priority: 0, weight: 1, load_factor: 10 },
      ],
    }, 1000).state;
    for (const account of ["a", "b"]) {
      state = applyPoolCommand(state, { schema_version: 1, type: "reserve", request_id: `initial-${account}`,
        preferred_account_id: account, lease_ttl_ms: 5000 }, 1100).state;
    }
    const scheduler = { enabled: true, sticky_weighted: false, top_k: 1,
      weights: { priority: 0, load: 1, error_rate: 0, ttft: 0, session_sticky: 0 } };
    const third = applyPoolCommand(state, { schema_version: 1, type: "reserve", request_id: "advanced-third", lease_ttl_ms: 5000, scheduler }, 1100);
    expect(third.lease!.account_id).toBe("b");
    const fourth = applyPoolCommand(third.state, { schema_version: 1, type: "reserve", request_id: "advanced-fourth", lease_ttl_ms: 5000, scheduler }, 1100);
    expect(fourth.lease!.account_id).toBe("a");
    expect(() => applyPoolCommand(fourth.state, { schema_version: 1, type: "reserve", request_id: "advanced-full", lease_ttl_ms: 5000, scheduler }, 1100)).toThrow();
  });

  it("preserves configured load factor on partial account updates and clears it on authoritative sync", () => {
    const configured = applyPoolCommand(poolWithAccount(2), {
      schema_version: 1, type: "upsert_account", account_id: "account-1",
      enabled: true, max_concurrency: 2, load_factor: 10,
    }, 1100).state;
    const updated = applyPoolCommand(configured, {
      schema_version: 1, type: "upsert_account", account_id: "account-1",
      enabled: true, max_concurrency: 3,
    }, 1200).state;
    expect(updated.accounts["account-1"]).toMatchObject({ max_concurrency: 3, load_factor: 10 });
    const cleared = applyPoolCommand(updated, {
      schema_version: 1, type: "sync_accounts", config_revision: 1, config_fingerprint: "1".repeat(64),
      accounts: [{ account_id: "account-1", max_concurrency: 3, priority: 0, weight: 1 }],
    }, 1300).state;
    expect(cleared.accounts["account-1"].load_factor).toBeUndefined();
  });

  it("uses load factor for relative load without increasing actual concurrency slots", () => {
    let state = applyPoolCommand(createPoolMachineState(), {
      schema_version: 1, type: "sync_accounts", config_revision: 1, config_fingerprint: "1".repeat(64),
      accounts: [
        { account_id: "a", max_concurrency: 2, priority: 0, weight: 1, load_factor: 1 },
        { account_id: "b", max_concurrency: 2, priority: 0, weight: 1, load_factor: 10 },
      ],
    }, 1000).state;
    const selected: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = applyPoolCommand(state, { schema_version: 1, type: "reserve", request_id: `factor-${i}`, lease_ttl_ms: 5000 }, 1100);
      state = result.state;
      selected.push(result.lease!.account_id);
    }
    // Both have one active request before reservation three. b's relative load
    // is lower, but its third slot remains unavailable regardless of factor.
    expect(selected).toEqual(["a", "b", "b", "a"]);
    expect(() => applyPoolCommand(state, { schema_version: 1, type: "reserve", request_id: "full", lease_ttl_ms: 5000 }, 1100)).toThrow();
  });

  it("omits accounts excluded by the caller from a reservation", () => {
    const result = applyPoolCommand(
      poolWithTwoAccounts(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-excluding-first-choice",
        lease_ttl_ms: 5_000,
        excluded_account_ids: ["account-2"],
      },
      1_100,
    );

    expect(result.lease?.account_id).toBe("account-1");
  });

  it("atomically replaces configured accounts and rejects stale configuration revisions", () => {
    const revisionTwo = applyPoolCommand(
      createPoolMachineState(),
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 2,
        config_fingerprint: "2".repeat(64),
        accounts: [
          {
            account_id: "account-new",
            max_concurrency: 3,
            priority: 1,
            weight: 2,
          },
        ],
      },
      1_000,
    );
    const stale = applyPoolCommand(
      revisionTwo.state,
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 1,
        config_fingerprint: "1".repeat(64),
        accounts: [
          {
            account_id: "account-stale",
            max_concurrency: 99,
            priority: 0,
            weight: 1,
          },
        ],
      },
      2_000,
    );

    expect(revisionTwo.state.config_revision).toBe(2);
    expect(revisionTwo.state.accounts["account-new"]).toMatchObject({
      enabled: true,
      max_concurrency: 3,
      priority: 1,
      weight: 2,
    });
    expect(stale.idempotent).toBe(true);
    expect(stale.state).toEqual(revisionTwo.state);
    expect(stale.state.accounts["account-stale"]).toBeUndefined();
  });

  it("rejects a different account snapshot that reuses the current revision", () => {
    const configured = applyPoolCommand(
      createPoolMachineState(),
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 1,
        config_fingerprint: "1".repeat(64),
        accounts: [
          { account_id: "account-1", max_concurrency: 1, priority: 0, weight: 1 },
        ],
      },
      1_000,
    );

    expect(() =>
      applyPoolCommand(
        configured.state,
        {
          schema_version: 1,
          type: "sync_accounts",
          config_revision: 1,
          config_fingerprint: "2".repeat(64),
          accounts: [
            { account_id: "account-2", max_concurrency: 1, priority: 0, weight: 1 },
          ],
        },
        2_000,
      ),
    ).toThrowError(new PoolStateMachineError(
      "config_revision_conflict",
      "config_revision was already applied with different accounts",
    ));
  });

  it("disables accounts omitted by a newer configuration without dropping their active leases", () => {
    const configured = applyPoolCommand(
      createPoolMachineState(),
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 1,
        config_fingerprint: "1".repeat(64),
        accounts: [
          { account_id: "account-1", max_concurrency: 1, priority: 0, weight: 1 },
          { account_id: "account-2", max_concurrency: 1, priority: 1, weight: 1 },
        ],
      },
      1_000,
    );
    const leased = applyPoolCommand(
      configured.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
        preferred_account_id: "account-1",
      },
      1_100,
    );
    const replaced = applyPoolCommand(
      leased.state,
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 2,
        config_fingerprint: "2".repeat(64),
        accounts: [
          { account_id: "account-2", max_concurrency: 4, priority: 0, weight: 3 },
        ],
      },
      1_200,
    );

    expect(replaced.state.accounts["account-1"]?.enabled).toBe(false);
    expect(replaced.state.accounts["account-2"]).toMatchObject({
      enabled: true,
      max_concurrency: 4,
      weight: 3,
    });
    expect(replaced.state.leases["request-1"]?.status).toBe("active");
  });

  it("schedules the earliest active lease and ignores tombstones", () => {
    expect(
      nextActiveLeaseAlarmAt(
        [
          { status: "released", expires_at_ms: 1_100 },
          { status: "active", expires_at_ms: 5_000 },
          { status: "active", expires_at_ms: 3_000 },
        ],
        2_000,
      ),
    ).toBe(3_000);
    expect(nextActiveLeaseAlarmAt([], 2_000)).toBeNull();
  });

  it("schedules an overdue active lease immediately for constructor recovery", () => {
    expect(
      nextActiveLeaseAlarmAt([{ status: "active", expires_at_ms: 1_000 }], 2_000),
    ).toBe(2_000);
  });

  it("reserves capacity idempotently by request_id", () => {
    const initial = poolWithAccount();
    const first = applyPoolCommand(
      initial,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
      },
      2_000,
    );
    const repeated = applyPoolCommand(
      first.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
      },
      3_000,
    );

    expect(first.idempotent).toBe(false);
    expect(first.lease).toMatchObject({
      account_id: "account-1",
      request_id: "request-1",
      status: "active",
      expires_at_ms: 7_000,
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.lease).toEqual(first.lease);
  });

  it("binds a hashed session affinity and prefers its healthy account on later requests", () => {
    const affinityKey = "a".repeat(64);
    const first = applyPoolCommand(
      poolWithTwoAccounts(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
        affinity_key: affinityKey,
        affinity_ttl_ms: 60_000,
      },
      2_000,
    );
    const released = applyPoolCommand(
      first.state,
      { schema_version: 1, type: "release", request_id: "request-1" },
      2_100,
    );
    const reprioritized = applyPoolCommand(
      released.state,
      {
        schema_version: 1,
        type: "upsert_account",
        account_id: "account-1",
        enabled: true,
        max_concurrency: 2,
        priority: 0,
        weight: 1,
      },
      2_200,
    );
    const second = applyPoolCommand(
      reprioritized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-2",
        lease_ttl_ms: 5_000,
        affinity_key: affinityKey,
        affinity_ttl_ms: 60_000,
      },
      2_300,
    );

    expect(first.lease?.account_id).toBe("account-2");
    expect(first.state.affinities[affinityKey]).toMatchObject({
      account_id: "account-2",
      expires_at_ms: 62_000,
    });
    expect(second.lease?.account_id).toBe("account-2");
    expect(second.state.affinities[affinityKey]?.expires_at_ms).toBe(62_300);
  });

  it("clears a failed sticky account and rebinds the next attempt to another account", () => {
    const affinityKey = "b".repeat(64);
    const first = applyPoolCommand(
      poolWithTwoAccounts(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
        affinity_key: affinityKey,
        affinity_ttl_ms: 60_000,
      },
      2_000,
    );
    const failed = applyPoolCommand(
      first.state,
      {
        schema_version: 1,
        type: "failure",
        event_id: "failure-1",
        account_id: "account-2",
        cooldown_ms: 30_000,
      },
      2_100,
    );
    const released = applyPoolCommand(
      failed.state,
      { schema_version: 1, type: "release", request_id: "request-1" },
      2_200,
    );
    const second = applyPoolCommand(
      released.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-2",
        lease_ttl_ms: 5_000,
        affinity_key: affinityKey,
        affinity_ttl_ms: 60_000,
      },
      2_300,
    );

    expect(failed.state.affinities[affinityKey]).toBeUndefined();
    expect(second.lease?.account_id).toBe("account-1");
    expect(second.state.affinities[affinityKey]?.account_id).toBe("account-1");
  });

  it("removes affinities for accounts omitted by a newer pool snapshot", () => {
    const affinityKey = "d".repeat(64);
    const bound = applyPoolCommand(
      poolWithTwoAccounts(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
        affinity_key: affinityKey,
        affinity_ttl_ms: 60_000,
      },
      2_000,
    );
    const synced = applyPoolCommand(
      bound.state,
      {
        schema_version: 1,
        type: "sync_accounts",
        config_revision: 2,
        config_fingerprint: "2".repeat(64),
        accounts: [
          { account_id: "account-1", max_concurrency: 2, priority: 0, weight: 1 },
        ],
      },
      2_100,
    );

    expect(bound.state.affinities[affinityKey]?.account_id).toBe("account-2");
    expect(synced.state.accounts["account-2"]?.enabled).toBe(false);
    expect(synced.state.affinities[affinityKey]).toBeUndefined();
  });

  it("rejects raw or partially configured affinity values", () => {
    expect(() =>
      applyPoolCommand(
        poolWithTwoAccounts(),
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-1",
          lease_ttl_ms: 5_000,
          affinity_key: "raw-session-id",
          affinity_ttl_ms: 60_000,
        },
        2_000,
      ),
    ).toThrowError(new PoolStateMachineError(
      "invalid_affinity_key",
      "affinity_key must be a lowercase SHA-256 digest",
    ));

    expect(() =>
      applyPoolCommand(
        poolWithTwoAccounts(),
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-2",
          lease_ttl_ms: 5_000,
          affinity_key: "c".repeat(64),
        },
        2_000,
      ),
    ).toThrowError(new PoolStateMachineError(
      "invalid_affinity_ttl",
      "affinity_key and affinity_ttl_ms must be provided together",
    ));
  });

  it("does not reserve beyond account concurrency", () => {
    const first = applyPoolCommand(
      poolWithAccount(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
      },
      2_000,
    );

    expect(() =>
      applyPoolCommand(
        first.state,
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-2",
          lease_ttl_ms: 5_000,
        },
        3_000,
      ),
    ).toThrowError(new PoolStateMachineError("no_capacity", "No healthy account has capacity"));
  });

  it("reclaims expired leases before selecting an account", () => {
    const first = applyPoolCommand(
      poolWithAccount(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 100,
      },
      2_000,
    );
    const second = applyPoolCommand(
      first.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-2",
        lease_ttl_ms: 100,
      },
      2_101,
    );

    expect(second.state.leases["request-1"]?.status).toBe("expired");
    expect(second.lease?.account_id).toBe("account-1");
  });

  it("releases a lease exactly once", () => {
    const reserved = applyPoolCommand(
      poolWithAccount(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 5_000,
      },
      2_000,
    );
    const released = applyPoolCommand(
      reserved.state,
      { schema_version: 1, type: "release", request_id: "request-1" },
      2_100,
    );
    const repeated = applyPoolCommand(
      released.state,
      { schema_version: 1, type: "release", request_id: "request-1" },
      2_200,
    );

    expect(released.lease?.status).toBe("released");
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state).toEqual(released.state);
  });

  it("renews a long-running lease with an ordered idempotency sequence", () => {
    const reserved = applyPoolCommand(
      poolWithAccount(),
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        lease_ttl_ms: 1_000,
      },
      2_000,
    );
    const renewed = applyPoolCommand(
      reserved.state,
      {
        schema_version: 1,
        type: "renew",
        request_id: "request-1",
        renewal_sequence: 1,
        lease_ttl_ms: 5_000,
      },
      2_500,
    );
    const repeated = applyPoolCommand(
      renewed.state,
      {
        schema_version: 1,
        type: "renew",
        request_id: "request-1",
        renewal_sequence: 1,
        lease_ttl_ms: 5_000,
      },
      3_000,
    );

    expect(renewed.lease).toMatchObject({
      status: "active",
      expires_at_ms: 7_500,
      renewal_sequence: 1,
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.lease).toEqual(renewed.lease);
  });

  it("records failure events idempotently and enforces cooldown", () => {
    const initial = poolWithAccount();
    const failed = applyPoolCommand(
      initial,
      {
        schema_version: 1,
        type: "failure",
        event_id: "event-1",
        account_id: "account-1",
        cooldown_ms: 5_000,
      },
      2_000,
    );
    const repeated = applyPoolCommand(
      failed.state,
      {
        schema_version: 1,
        type: "failure",
        event_id: "event-1",
        account_id: "account-1",
        cooldown_ms: 5_000,
      },
      3_000,
    );

    expect(failed.state.accounts["account-1"]).toMatchObject({
      consecutive_failures: 1,
      cooldown_until_ms: 7_000,
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state).toEqual(failed.state);
    expect(() =>
      applyPoolCommand(
        failed.state,
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-1",
          lease_ttl_ms: 1_000,
        },
        6_999,
      ),
    ).toThrowError(PoolStateMachineError);
  });

  it("clears pool cooldown only when the administrative recovery revision advances", () => {
    const failed = applyPoolCommand(
      applyPoolCommand(
        createPoolMachineState(),
        { schema_version: 1, type: "sync_accounts", config_revision: 1, config_fingerprint: "1".repeat(64),
          accounts: [{ account_id: "account-1", max_concurrency: 1, priority: 0, weight: 1, recovery_revision: 0 }] },
        1_000,
      ).state,
      { schema_version: 1, type: "failure", event_id: "recovery-failure", account_id: "account-1", cooldown_ms: 5_000 },
      2_000,
    );
    const unchanged = applyPoolCommand(
      failed.state,
      { schema_version: 1, type: "sync_accounts", config_revision: 2, config_fingerprint: "2".repeat(64),
        accounts: [{ account_id: "account-1", max_concurrency: 1, priority: 0, weight: 1, recovery_revision: 0 }] },
      2_100,
    );
    const recovered = applyPoolCommand(
      unchanged.state,
      { schema_version: 1, type: "sync_accounts", config_revision: 3, config_fingerprint: "3".repeat(64),
        accounts: [{ account_id: "account-1", max_concurrency: 1, priority: 0, weight: 1, recovery_revision: 1 }] },
      2_200,
    );
    expect(unchanged.state.accounts['account-1']).toMatchObject({ consecutive_failures: 1, cooldown_until_ms: 7_000 })
    expect(recovered.state.accounts['account-1']).toMatchObject({ recovery_revision: 1, consecutive_failures: 0, cooldown_until_ms: 0 })
    expect(applyPoolCommand(recovered.state, {
      schema_version: 1, type: 'reserve', request_id: 'recovered-request', lease_ttl_ms: 1_000,
    }, 2_200).lease?.account_id).toBe('account-1')
  });

  it("rejects reusing a failure event for another account", () => {
    const secondAccount = applyPoolCommand(
      poolWithAccount(),
      {
        schema_version: 1,
        type: "upsert_account",
        account_id: "account-2",
        enabled: true,
        max_concurrency: 1,
      },
      1_100,
    );
    const failed = applyPoolCommand(
      secondAccount.state,
      {
        schema_version: 1,
        type: "failure",
        event_id: "event-1",
        account_id: "account-1",
        cooldown_ms: 1_000,
      },
      2_000,
    );

    expect(() =>
      applyPoolCommand(
        failed.state,
        {
          schema_version: 1,
          type: "failure",
          event_id: "event-1",
          account_id: "account-2",
          cooldown_ms: 1_000,
        },
        2_100,
      ),
    ).toThrowError(PoolStateMachineError);
  });
});

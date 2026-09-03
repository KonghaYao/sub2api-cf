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

describe("pool state machine", () => {
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

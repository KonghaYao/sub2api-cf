import { describe, expect, it } from "vitest";

import {
  applyUserCommand,
  createUserMachineState,
  reclaimExpiredUserReservation,
  StateMachineError,
} from "../../src/shared/state-machine/user";

describe("user state machine", () => {
  it("authorizes a request idempotently", () => {
    const initial = createUserMachineState({
      user_id: "user-1",
      balance_micros: 5_000_000,
      enabled: true,
      now_ms: 1_000,
    });

    const first = applyUserCommand(
      initial,
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const repeated = applyUserCommand(
      first.state,
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      3_000,
    );

    expect(first.idempotent).toBe(false);
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state.request).toEqual(first.state.request);
    expect(repeated.state.request?.status).toBe("authorized");
  });

  it("prevents reservations from exceeding available balance", () => {
    const initial = createUserMachineState({
      user_id: "user-1",
      balance_micros: 100,
      enabled: true,
      now_ms: 1_000,
    });
    const authorized = applyUserCommand(
      initial,
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );

    expect(() =>
      applyUserCommand(
        authorized.state,
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-1",
          amount_micros: 101,
        },
        3_000,
      ),
    ).toThrowError(new StateMachineError("insufficient_funds", "Insufficient available balance"));
  });

  it("reserves and cancels exactly once", () => {
    const initial = createUserMachineState({
      user_id: "user-1",
      balance_micros: 1_000,
      enabled: true,
      now_ms: 1_000,
    });
    const authorized = applyUserCommand(
      initial,
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 400,
      },
      3_000,
    );
    const cancelled = applyUserCommand(
      reserved.state,
      { schema_version: 1, type: "cancel", request_id: "request-1" },
      4_000,
    );
    const repeated = applyUserCommand(
      cancelled.state,
      { schema_version: 1, type: "cancel", request_id: "request-1" },
      5_000,
    );

    expect(reserved.state.profile.reserved_micros).toBe(400);
    expect(cancelled.state.profile.reserved_micros).toBe(0);
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state).toEqual(cancelled.state);
  });

  it("settles a reservation once and releases the unused amount", () => {
    const initial = createUserMachineState({
      user_id: "user-1",
      balance_micros: 1_000,
      enabled: true,
      now_ms: 1_000,
    });
    const authorized = applyUserCommand(
      initial,
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 400,
      },
      3_000,
    );
    const settled = applyUserCommand(
      reserved.state,
      {
        schema_version: 1,
        type: "settle",
        request_id: "request-1",
        amount_micros: 250,
      },
      4_000,
    );
    const repeated = applyUserCommand(
      settled.state,
      {
        schema_version: 1,
        type: "settle",
        request_id: "request-1",
        amount_micros: 250,
      },
      5_000,
    );

    expect(settled.state.profile).toMatchObject({
      balance_micros: 750,
      reserved_micros: 0,
      settled_micros: 250,
    });
    expect(settled.state.request).toMatchObject({
      status: "settled",
      reserved_micros: 400,
      settled_micros: 250,
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state).toEqual(settled.state);
  });

  it("atomically charges actual usage above the estimate when balance remains", () => {
    const authorized = applyUserCommand(
      createUserMachineState({
        user_id: "user-1",
        balance_micros: 1_000,
        enabled: true,
        now_ms: 1_000,
      }),
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 100,
      },
      3_000,
    );
    const settled = applyUserCommand(
      reserved.state,
      {
        schema_version: 1,
        type: "settle",
        request_id: "request-1",
        amount_micros: 250,
      },
      4_000,
    );

    expect(settled.state.profile).toMatchObject({
      balance_micros: 750,
      reserved_micros: 0,
      settled_micros: 250,
    });
  });

  it("rejects negative, fractional, and unsafe monetary values", () => {
    const invalidValues = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1];

    for (const balance_micros of invalidValues) {
      expect(() =>
        createUserMachineState({
          user_id: "user-1",
          balance_micros,
          enabled: true,
          now_ms: 1_000,
        }),
      ).toThrowError(StateMachineError);
    }

    const authorized = applyUserCommand(
      createUserMachineState({
        user_id: "user-1",
        balance_micros: 1_000,
        enabled: true,
        now_ms: 1_000,
      }),
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    expect(() =>
      applyUserCommand(
        authorized.state,
        {
          schema_version: 1,
          type: "reserve",
          request_id: "request-1",
          amount_micros: -1,
        },
        3_000,
      ),
    ).toThrowError(StateMachineError);
  });

  it("reclaims an expired reservation without charging the balance", () => {
    const authorized = applyUserCommand(
      createUserMachineState({
        user_id: "user-1",
        balance_micros: 1_000,
        enabled: true,
        now_ms: 1_000,
      }),
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 400,
        reservation_ttl_ms: 100,
      },
      3_000,
    );
    const reclaimed = reclaimExpiredUserReservation(reserved.state, 3_100);

    expect(reclaimed.idempotent).toBe(false);
    expect(reclaimed.state.profile).toMatchObject({
      balance_micros: 1_000,
      reserved_micros: 0,
      settled_micros: 0,
    });
    expect(reclaimed.state.request?.status).toBe("cancelled");
  });

  it("renews a long-running reservation with an ordered idempotency sequence", () => {
    const authorized = applyUserCommand(
      createUserMachineState({
        user_id: "user-1",
        balance_micros: 1_000,
        enabled: true,
        now_ms: 1_000,
      }),
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 400,
        reservation_ttl_ms: 1_000,
      },
      3_000,
    );
    const renewed = applyUserCommand(
      reserved.state,
      {
        schema_version: 1,
        type: "renew",
        request_id: "request-1",
        renewal_sequence: 1,
        reservation_ttl_ms: 5_000,
      },
      3_500,
    );
    const repeated = applyUserCommand(
      renewed.state,
      {
        schema_version: 1,
        type: "renew",
        request_id: "request-1",
        renewal_sequence: 1,
        reservation_ttl_ms: 5_000,
      },
      3_600,
    );

    expect(renewed.state.request).toMatchObject({
      reservation_expires_at_ms: 8_500,
      renewal_sequence: 1,
      last_renewal_ttl_ms: 5_000,
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.state).toEqual(renewed.state);
  });

  it("rejects settlement totals outside the safe integer range", () => {
    const authorized = applyUserCommand(
      createUserMachineState({
        user_id: "user-1",
        balance_micros: 1,
        enabled: true,
        now_ms: 1_000,
      }),
      { schema_version: 1, type: "authorize", request_id: "request-1" },
      2_000,
    );
    const reserved = applyUserCommand(
      authorized.state,
      {
        schema_version: 1,
        type: "reserve",
        request_id: "request-1",
        amount_micros: 1,
      },
      3_000,
    );
    const atLimit = {
      ...reserved.state,
      profile: {
        ...reserved.state.profile,
        settled_micros: Number.MAX_SAFE_INTEGER,
      },
    };

    expect(() =>
      applyUserCommand(
        atLimit,
        {
          schema_version: 1,
          type: "settle",
          request_id: "request-1",
          amount_micros: 1,
        },
        4_000,
      ),
    ).toThrowError(new StateMachineError("amount_overflow", "settled_micros exceeds the safe integer range"));
  });
});

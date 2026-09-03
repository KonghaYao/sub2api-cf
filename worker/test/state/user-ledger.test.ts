import { describe, expect, it } from "vitest";

import {
  createBalanceAdjustmentLedgerEntry,
  createOpeningBalanceLedgerEntry,
  createSettlementLedgerEntry,
} from "../../src/shared/state-machine/ledger";
import {
  parseConfigureUserCommand,
  userCommandTypeFor,
} from "../../src/state/user-state-do";

describe("user ledger contract", () => {
  it("creates integer opening and adjustment entries with stable mutation keys", () => {
    const opening = createOpeningBalanceLedgerEntry({
      mutation_id: "credit-1",
      user_id: "user-1",
      balance_micros: 1_000,
      enabled: true,
      now_ms: 10,
    });
    const adjustment = createBalanceAdjustmentLedgerEntry({
      mutation_id: "credit-2",
      user_id: "user-1",
      amount_delta_micros: -250,
      balance_after_micros: 750,
      now_ms: 20,
    });

    expect(opening).toMatchObject({
      mutation_key: "balance:credit-1",
      entry_type: "opening_balance",
      amount_delta_micros: 1_000,
      balance_after_micros: 1_000,
    });
    expect(adjustment).toMatchObject({
      mutation_key: "balance:credit-2",
      entry_type: "balance_adjustment",
      amount_delta_micros: -250,
      balance_after_micros: 750,
    });
  });

  it("keys settlements by request and represents charges as integer deltas", () => {
    expect(
      createSettlementLedgerEntry({
        user_id: "user-1",
        request_id: "request-1",
        amount_micros: 250,
        balance_after_micros: 750,
        now_ms: 30,
      }),
    ).toMatchObject({
      mutation_key: "settlement:request-1",
      mutation_id: "request-1",
      entry_type: "settlement",
      request_id: "request-1",
      amount_delta_micros: -250,
    });
  });

  it("requires a retry-safe mutation_id and integer balance for configuration", () => {
    expect(() =>
      parseConfigureUserCommand({
        schema_version: 1,
        user_id: "user-1",
        balance_micros: 100,
        enabled: true,
      }),
    ).toThrow(/mutation_id/);
    expect(() =>
      parseConfigureUserCommand({
        schema_version: 1,
        mutation_id: "credit-1",
        user_id: "user-1",
        balance_micros: 0.5,
        enabled: true,
      }),
    ).toThrow(/safe integer/);
  });

  it("uses release as the canonical path while retaining cancel compatibility", () => {
    expect(userCommandTypeFor("POST", "/release")).toBe("cancel");
    expect(userCommandTypeFor("POST", "/cancel")).toBe("cancel");
  });
});

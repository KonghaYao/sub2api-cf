import { assertMicros, STATE_SCHEMA_VERSION } from "./user";

export type UserLedgerEntryType =
  | "opening_balance"
  | "balance_adjustment"
  | "enabled_change"
  | "settlement";

export interface UserLedgerEntry {
  schema_version: typeof STATE_SCHEMA_VERSION;
  mutation_key: string;
  mutation_id: string;
  entry_type: UserLedgerEntryType;
  user_id: string;
  request_id: string | null;
  amount_delta_micros: number;
  balance_after_micros: number;
  enabled_after: boolean | null;
  created_at_ms: number;
}

interface OpeningBalanceLedgerInput {
  mutation_id: string;
  user_id: string;
  balance_micros: number;
  enabled: boolean;
  now_ms: number;
}

export function createOpeningBalanceLedgerEntry(
  input: OpeningBalanceLedgerInput,
): UserLedgerEntry {
  assertIdentifier(input.mutation_id, "mutation_id");
  assertIdentifier(input.user_id, "user_id");
  assertMicros(input.balance_micros, "balance_micros");
  assertTimestamp(input.now_ms);

  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_key: `balance:${input.mutation_id}`,
    mutation_id: input.mutation_id,
    entry_type: "opening_balance",
    user_id: input.user_id,
    request_id: null,
    amount_delta_micros: input.balance_micros,
    balance_after_micros: input.balance_micros,
    enabled_after: input.enabled,
    created_at_ms: input.now_ms,
  };
}

export function createBalanceAdjustmentLedgerEntry(input: {
  mutation_id: string;
  user_id: string;
  amount_delta_micros: number;
  balance_after_micros: number;
  now_ms: number;
}): UserLedgerEntry {
  assertIdentifier(input.mutation_id, "mutation_id");
  assertIdentifier(input.user_id, "user_id");
  assertNonZeroSignedMicros(input.amount_delta_micros, "amount_delta_micros");
  assertMicros(input.balance_after_micros, "balance_after_micros");
  assertTimestamp(input.now_ms);

  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_key: `balance:${input.mutation_id}`,
    mutation_id: input.mutation_id,
    entry_type: "balance_adjustment",
    user_id: input.user_id,
    request_id: null,
    amount_delta_micros: input.amount_delta_micros,
    balance_after_micros: input.balance_after_micros,
    enabled_after: null,
    created_at_ms: input.now_ms,
  };
}

export function createEnabledLedgerEntry(input: {
  mutation_id: string;
  user_id: string;
  enabled: boolean;
  balance_after_micros: number;
  now_ms: number;
}): UserLedgerEntry {
  assertIdentifier(input.mutation_id, "mutation_id");
  assertIdentifier(input.user_id, "user_id");
  assertMicros(input.balance_after_micros, "balance_after_micros");
  assertTimestamp(input.now_ms);

  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_key: `enabled:${input.mutation_id}`,
    mutation_id: input.mutation_id,
    entry_type: "enabled_change",
    user_id: input.user_id,
    request_id: null,
    amount_delta_micros: 0,
    balance_after_micros: input.balance_after_micros,
    enabled_after: input.enabled,
    created_at_ms: input.now_ms,
  };
}

export function createSettlementLedgerEntry(input: {
  user_id: string;
  request_id: string;
  amount_micros: number;
  balance_after_micros: number;
  now_ms: number;
}): UserLedgerEntry {
  assertIdentifier(input.user_id, "user_id");
  assertIdentifier(input.request_id, "request_id");
  assertMicros(input.amount_micros, "amount_micros");
  assertMicros(input.balance_after_micros, "balance_after_micros");
  assertTimestamp(input.now_ms);

  return {
    schema_version: STATE_SCHEMA_VERSION,
    mutation_key: `settlement:${input.request_id}`,
    mutation_id: input.request_id,
    entry_type: "settlement",
    user_id: input.user_id,
    request_id: input.request_id,
    amount_delta_micros: -input.amount_micros,
    balance_after_micros: input.balance_after_micros,
    enabled_after: null,
    created_at_ms: input.now_ms,
  };
}

function assertIdentifier(value: string, fieldName: string): void {
  if (value.length === 0 || value.length > 128) {
    throw new Error(`${fieldName} must be between 1 and 128 characters`);
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("now_ms must be a non-negative safe integer");
  }
}

function assertNonZeroSignedMicros(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new Error(`${fieldName} must be a non-zero safe integer`);
  }
}

export const STATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RESERVATION_TTL_MS = 300_000;

export type UserRequestStatus =
  | "authorized"
  | "reserved"
  | "cancelled"
  | "settled";

export interface UserProfileState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  user_id: string;
  enabled: boolean;
  balance_micros: number;
  reserved_micros: number;
  settled_micros: number;
  spend_debt_micros: number;
  updated_at_ms: number;
}

export interface UserRequestState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  request_id: string;
  status: UserRequestStatus;
  reserved_micros: number;
  settled_micros: number | null;
  committed: boolean;
  funded_micros: number;
  expired: boolean;
  reservation_expires_at_ms: number | null;
  reservation_ttl_ms: number | null;
  renewal_sequence: number;
  last_renewal_ttl_ms: number | null;
  authorized_at_ms: number;
  updated_at_ms: number;
}

export interface UserMachineState {
  schema_version: typeof STATE_SCHEMA_VERSION;
  profile: UserProfileState;
  request: UserRequestState | null;
}

type UserCommandEnvelope = {
  schema_version: typeof STATE_SCHEMA_VERSION;
  request_id: string;
};

export type UserCommand = UserCommandEnvelope &
  (
    | { type: "authorize" }
    | { type: "reserve"; amount_micros: number; reservation_ttl_ms?: number }
    | { type: "renew"; renewal_sequence: number; reservation_ttl_ms: number }
    | { type: "ensure"; target_amount_micros: number }
    | { type: "cancel" }
    | { type: "settle"; amount_micros: number }
  );

export interface UserTransition {
  state: UserMachineState;
  idempotent: boolean;
}

export class StateMachineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StateMachineError";
  }
}

export function assertMicros(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StateMachineError(
      "invalid_amount",
      `${fieldName} must be a non-negative safe integer in micro-units`,
    );
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StateMachineError("invalid_timestamp", "now_ms must be a non-negative safe integer");
  }
}

function assertRequestId(requestId: string): void {
  if (requestId.length === 0 || requestId.length > 128) {
    throw new StateMachineError("invalid_request_id", "request_id must be between 1 and 128 characters");
  }
}

export function createUserMachineState(input: {
  user_id: string;
  balance_micros: number;
  spend_debt_micros?: number;
  enabled: boolean;
  now_ms: number;
}): UserMachineState {
  assertMicros(input.balance_micros, "balance_micros");
  assertMicros(input.spend_debt_micros ?? 0, "spend_debt_micros");
  assertTimestamp(input.now_ms);
  if (input.user_id.length === 0 || input.user_id.length > 128) {
    throw new StateMachineError("invalid_user_id", "user_id must be between 1 and 128 characters");
  }

  return {
    schema_version: STATE_SCHEMA_VERSION,
    profile: {
      schema_version: STATE_SCHEMA_VERSION,
      user_id: input.user_id,
      enabled: input.enabled,
      balance_micros: input.balance_micros,
      reserved_micros: 0,
      settled_micros: 0,
      spend_debt_micros: input.spend_debt_micros ?? 0,
      updated_at_ms: input.now_ms,
    },
    request: null,
  };
}

export function applyUserCommand(
  state: UserMachineState,
  command: UserCommand,
  nowMs: number,
): UserTransition {
  assertTimestamp(nowMs);
  assertRequestId(command.request_id);
  if (command.schema_version !== STATE_SCHEMA_VERSION) {
    throw new StateMachineError("unsupported_schema_version", "Unsupported schema_version");
  }
  if (state.request !== null && state.request.request_id !== command.request_id) {
    throw new StateMachineError("request_mismatch", "Loaded request does not match command request_id");
  }

  switch (command.type) {
    case "authorize":
      return authorize(state, command.request_id, nowMs);
    case "reserve":
      return reserve(
        state,
        command.request_id,
        command.amount_micros,
        command.reservation_ttl_ms ?? DEFAULT_RESERVATION_TTL_MS,
        nowMs,
      );
    case "cancel":
      return cancel(state, nowMs);
    case "ensure":
      return ensure(state, command.target_amount_micros, nowMs);
    case "renew":
      return renew(
        state,
        command.renewal_sequence,
        command.reservation_ttl_ms,
        nowMs,
      );
    case "settle":
      return settle(state, command.amount_micros, nowMs);
  }
}

function authorize(state: UserMachineState, requestId: string, nowMs: number): UserTransition {
  if (state.request !== null) return { state, idempotent: true };
  if (!state.profile.enabled) {
    throw new StateMachineError("user_disabled", "User is disabled");
  }

  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: state.profile,
      request: {
        schema_version: STATE_SCHEMA_VERSION,
        request_id: requestId,
        status: "authorized",
        reserved_micros: 0,
        settled_micros: null,
        committed: false,
        funded_micros: 0,
        expired: false,
        reservation_expires_at_ms: null,
        reservation_ttl_ms: null,
        renewal_sequence: 0,
        last_renewal_ttl_ms: null,
        authorized_at_ms: nowMs,
        updated_at_ms: nowMs,
      },
    },
  };
}

function reserve(
  state: UserMachineState,
  requestId: string,
  amountMicros: number,
  reservationTtlMs: number,
  nowMs: number,
): UserTransition {
  assertMicros(amountMicros, "amount_micros");
  if (amountMicros === 0) {
    throw new StateMachineError("invalid_amount", "Reservation amount must be greater than zero");
  }
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new StateMachineError(
      "invalid_reservation_ttl",
      "reservation_ttl_ms must be a positive safe integer",
    );
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - reservationTtlMs) {
    throw new StateMachineError(
      "invalid_reservation_ttl",
      "Reservation expiry exceeds safe integer range",
    );
  }
  const request = requireRequest(state);
  if (request.status === "reserved") {
    if (
      request.reserved_micros === amountMicros &&
      request.reservation_ttl_ms === reservationTtlMs
    ) {
      return { state, idempotent: true };
    }
    throw new StateMachineError("reservation_conflict", "Request already has a different reservation");
  }
  if (request.status !== "authorized") {
    throw new StateMachineError("invalid_transition", `Cannot reserve a ${request.status} request`);
  }
  if (!state.profile.enabled) {
    throw new StateMachineError("user_disabled", "User is disabled");
  }

  const availableMicros = state.profile.balance_micros - state.profile.reserved_micros;
  if (amountMicros > availableMicros) {
    throw new StateMachineError("insufficient_funds", "Insufficient available balance");
  }

  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: {
        ...state.profile,
        reserved_micros: state.profile.reserved_micros + amountMicros,
        updated_at_ms: nowMs,
      },
      request: {
        ...request,
        request_id: requestId,
        status: "reserved",
        reserved_micros: amountMicros,
        funded_micros: amountMicros,
        expired: false,
        reservation_expires_at_ms: nowMs + reservationTtlMs,
        reservation_ttl_ms: reservationTtlMs,
        updated_at_ms: nowMs,
      },
    },
  };
}

function ensure(
  state: UserMachineState,
  targetAmountMicros: number,
  nowMs: number,
): UserTransition {
  assertMicros(targetAmountMicros, "target_amount_micros");
  const request = requireRequest(state);
  if (request.status === "settled") {
    if (request.settled_micros === targetAmountMicros) return { state, idempotent: true };
    throw new StateMachineError("reservation_commitment_conflict", "Settled request has a different amount");
  }
  if (request.status === "cancelled" && !request.expired) {
    throw new StateMachineError("invalid_transition", "A manually cancelled request cannot be committed");
  }
  if (request.status !== "reserved" && !(request.status === "cancelled" && request.expired)) {
    throw new StateMachineError("invalid_transition", `Cannot commit a ${request.status} request`);
  }
  if (request.committed) {
    if (request.reserved_micros === targetAmountMicros) return { state, idempotent: true };
    throw new StateMachineError("reservation_commitment_conflict", "Request is committed to a different amount");
  }
  if (targetAmountMicros < request.reserved_micros) {
    throw new StateMachineError(
      "reservation_commitment_decrease",
      "Committed target cannot be lower than the reservation",
    );
  }

  const heldForRequest = request.status === "reserved" ? request.funded_micros : 0;
  const otherReservations = state.profile.reserved_micros - heldForRequest;
  if (!Number.isSafeInteger(otherReservations) || otherReservations < 0) {
    throw new StateMachineError("invalid_persisted_state", "Request funding exceeds total reservations");
  }
  const availableMicros = state.profile.balance_micros - otherReservations;
  if (!Number.isSafeInteger(availableMicros) || availableMicros < 0) {
    throw new StateMachineError("invalid_persisted_state", "Reservations exceed the user balance");
  }
  const fundedMicros = Math.min(targetAmountMicros, availableMicros);
  checkedAddMicros(state.profile.settled_micros, targetAmountMicros, "settled_micros");
  checkedAddMicros(
    state.profile.spend_debt_micros,
    targetAmountMicros - fundedMicros,
    "spend_debt_micros",
  );

  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: {
        ...state.profile,
        reserved_micros: otherReservations + fundedMicros,
        updated_at_ms: nowMs,
      },
      request: {
        ...request,
        status: "reserved",
        reserved_micros: targetAmountMicros,
        committed: true,
        funded_micros: fundedMicros,
        expired: false,
        reservation_expires_at_ms: null,
        updated_at_ms: nowMs,
      },
    },
  };
}

function renew(
  state: UserMachineState,
  renewalSequence: number,
  reservationTtlMs: number,
  nowMs: number,
): UserTransition {
  if (!Number.isSafeInteger(renewalSequence) || renewalSequence <= 0) {
    throw new StateMachineError(
      "invalid_renewal_sequence",
      "renewal_sequence must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs <= 0) {
    throw new StateMachineError(
      "invalid_reservation_ttl",
      "reservation_ttl_ms must be a positive safe integer",
    );
  }
  if (nowMs > Number.MAX_SAFE_INTEGER - reservationTtlMs) {
    throw new StateMachineError(
      "invalid_reservation_ttl",
      "Reservation expiry exceeds safe integer range",
    );
  }

  const request = requireRequest(state);
  if (request.status !== "reserved") {
    throw new StateMachineError("invalid_transition", `Cannot renew a ${request.status} request`);
  }
  if (renewalSequence < request.renewal_sequence) return { state, idempotent: true };
  if (renewalSequence === request.renewal_sequence) {
    if (request.last_renewal_ttl_ms === reservationTtlMs) return { state, idempotent: true };
    throw new StateMachineError("renewal_conflict", "Renewal sequence has different parameters");
  }
  if (renewalSequence !== request.renewal_sequence + 1) {
    throw new StateMachineError("renewal_out_of_order", "Renewal sequence must increase by one");
  }

  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: state.profile,
      request: {
        ...request,
        reservation_expires_at_ms: nowMs + reservationTtlMs,
        renewal_sequence: renewalSequence,
        last_renewal_ttl_ms: reservationTtlMs,
        updated_at_ms: nowMs,
      },
    },
  };
}

function cancel(state: UserMachineState, nowMs: number): UserTransition {
  const request = requireRequest(state);
  if (request.status === "cancelled") return { state, idempotent: true };
  if (request.status === "settled") {
    throw new StateMachineError("invalid_transition", "A settled request cannot be cancelled");
  }
  if (request.committed) {
    throw new StateMachineError("invalid_transition", "A committed request cannot be cancelled");
  }

  const releasedMicros = request.status === "reserved" ? request.funded_micros : 0;
  if (releasedMicros > state.profile.reserved_micros) {
    throw new StateMachineError("invalid_persisted_state", "Request funding is not held");
  }
  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: {
        ...state.profile,
        reserved_micros: state.profile.reserved_micros - releasedMicros,
        updated_at_ms: nowMs,
      },
      request: {
        ...request,
        status: "cancelled",
        expired: false,
        updated_at_ms: nowMs,
      },
    },
  };
}

function settle(state: UserMachineState, amountMicros: number, nowMs: number): UserTransition {
  assertMicros(amountMicros, "amount_micros");
  const request = requireRequest(state);
  if (request.status === "settled") {
    if (request.settled_micros === amountMicros) return { state, idempotent: true };
    throw new StateMachineError("settlement_conflict", "Request already has a different settlement");
  }
  if (request.status !== "reserved") {
    throw new StateMachineError("invalid_transition", `Cannot settle a ${request.status} request`);
  }
  if (request.committed) {
    if (amountMicros !== request.reserved_micros) {
      throw new StateMachineError("settlement_conflict", "Settlement differs from the committed amount");
    }
    const otherReservations = state.profile.reserved_micros - request.funded_micros;
    if (!Number.isSafeInteger(otherReservations) || otherReservations < 0) {
      throw new StateMachineError("invalid_persisted_state", "Committed request funding is not held");
    }
    const availableForRequest = state.profile.balance_micros - otherReservations;
    if (!Number.isSafeInteger(availableForRequest) || availableForRequest < 0) {
      throw new StateMachineError("invalid_persisted_state", "Reservations exceed the user balance");
    }
    const fundedAtSettlement = Math.min(amountMicros, availableForRequest);
    const debtMicros = amountMicros - fundedAtSettlement;
    if (!Number.isSafeInteger(debtMicros) || debtMicros < 0) {
      throw new StateMachineError("invalid_persisted_state", "Committed request funding is invalid");
    }
    const settledMicros = checkedAddMicros(
      state.profile.settled_micros,
      amountMicros,
      "settled_micros",
    );
    const spendDebtMicros = checkedAddMicros(
      state.profile.spend_debt_micros,
      debtMicros,
      "spend_debt_micros",
    );
    if (
      request.funded_micros > state.profile.reserved_micros
    ) {
      throw new StateMachineError("invalid_persisted_state", "Committed request funding is not held");
    }
    return {
      idempotent: false,
      state: {
        schema_version: STATE_SCHEMA_VERSION,
        profile: {
          ...state.profile,
          balance_micros: state.profile.balance_micros - fundedAtSettlement,
          reserved_micros: state.profile.reserved_micros - request.funded_micros,
          settled_micros: settledMicros,
          spend_debt_micros: spendDebtMicros,
          updated_at_ms: nowMs,
        },
        request: {
          ...request,
          status: "settled",
          settled_micros: amountMicros,
          updated_at_ms: nowMs,
        },
      },
    };
  }
  const otherReservations = state.profile.reserved_micros - request.reserved_micros;
  const availableForRequest = state.profile.balance_micros - otherReservations;
  if (amountMicros > availableForRequest) {
    throw new StateMachineError(
      "settlement_exceeds_available_balance",
      "Settlement exceeds the balance available after other reservations",
    );
  }
  const settledMicros = checkedAddMicros(
    state.profile.settled_micros,
    amountMicros,
    "settled_micros",
  );

  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: {
        ...state.profile,
        balance_micros: state.profile.balance_micros - amountMicros,
        reserved_micros: state.profile.reserved_micros - request.reserved_micros,
        settled_micros: settledMicros,
        updated_at_ms: nowMs,
      },
      request: {
        ...request,
        status: "settled",
        settled_micros: amountMicros,
        updated_at_ms: nowMs,
      },
    },
  };
}

export function reclaimExpiredUserReservation(
  state: UserMachineState,
  nowMs: number,
): UserTransition {
  assertTimestamp(nowMs);
  if (
    state.request?.status !== "reserved" ||
    state.request.committed ||
    state.request.reservation_expires_at_ms === null ||
    state.request.reservation_expires_at_ms > nowMs
  ) {
    return { state, idempotent: true };
  }
  const request = state.request;
  if (request.funded_micros > state.profile.reserved_micros) {
    throw new StateMachineError("invalid_persisted_state", "Request funding is not held");
  }
  return {
    idempotent: false,
    state: {
      schema_version: STATE_SCHEMA_VERSION,
      profile: {
        ...state.profile,
        reserved_micros: state.profile.reserved_micros - request.funded_micros,
        updated_at_ms: nowMs,
      },
      request: {
        ...request,
        status: "cancelled",
        expired: true,
        updated_at_ms: nowMs,
      },
    },
  };
}

function checkedAddMicros(left: number, right: number, fieldName: string): number {
  assertMicros(left, fieldName);
  assertMicros(right, fieldName);
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new StateMachineError(
      "amount_overflow",
      `${fieldName} exceeds the safe integer range`,
    );
  }
  return left + right;
}

function requireRequest(state: UserMachineState): UserRequestState {
  if (state.request === null) {
    throw new StateMachineError("request_not_authorized", "Request must be authorized first");
  }
  return state.request;
}

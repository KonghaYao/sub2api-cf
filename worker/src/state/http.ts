import { PoolStateMachineError } from "../shared/state-machine/pool";
import { StateMachineError } from "../shared/state-machine/user";

export const STATE_API_SCHEMA_VERSION = 1 as const;

export class StateApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StateApiError";
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new StateApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StateApiError(400, "invalid_body", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requireSchemaVersion(body: Record<string, unknown>): void {
  if (body.schema_version !== STATE_API_SCHEMA_VERSION) {
    throw new StateApiError(400, "unsupported_schema_version", "schema_version must be 1");
  }
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 128,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new StateApiError(400, `invalid_${field}`, `${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 128,
): string | undefined {
  if (body[field] === undefined) return undefined;
  return requireString(body, field, maxLength);
}

export function requireBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw new StateApiError(400, `invalid_${field}`, `${field} must be a boolean`);
  }
  return value;
}

export function requireSafeInteger(
  body: Record<string, unknown>,
  field: string,
  options: { minimum?: number; maximum?: number } = {},
): number {
  const value = body[field];
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new StateApiError(
      400,
      `invalid_${field}`,
      `${field} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof StateApiError) {
    return json(
      {
        schema_version: STATE_API_SCHEMA_VERSION,
        error: { code: error.code, message: error.message },
      },
      error.status,
    );
  }

  const domainError = asDomainError(error);
  if (domainError !== null) {
    return json(
      {
        schema_version: STATE_API_SCHEMA_VERSION,
        error: { code: domainError.code, message: domainError.message },
      },
      domainStatus(domainError.code),
    );
  }

  console.error("durable object request failed", error);
  return json(
    {
      schema_version: STATE_API_SCHEMA_VERSION,
      error: { code: "internal_error", message: "Internal durable object error" },
    },
    500,
  );
}

function asDomainError(error: unknown): { code: string; message: string } | null {
  if (error instanceof StateMachineError || error instanceof PoolStateMachineError) {
    return { code: error.code, message: error.message };
  }
  return null;
}

function domainStatus(code: string): number {
  if (code === "insufficient_funds" || code === "user_disabled") return 403;
  if (code === "no_capacity") return 429;
  if (code.endsWith("_not_found") || code === "request_not_authorized") return 404;
  if (code.endsWith("_conflict") || code === "invalid_transition") return 409;
  return 400;
}

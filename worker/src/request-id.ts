const requestIds = new WeakMap<Request, string>()

export function requestIdFor(request: Request): string {
  const current = requestIds.get(request)
  if (current !== undefined) return current
  // A caller/edge correlation header must never become a billing idempotency key.
  // All layers handling this Request share one server-generated identity.
  const requestId = crypto.randomUUID()
  requestIds.set(request, requestId)
  return requestId
}

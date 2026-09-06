const requestIds = new WeakMap<Request, string>()

export function requestIdFor(request: Request): string {
  const current = requestIds.get(request)
  if (current !== undefined) return current
  const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID()
  requestIds.set(request, requestId)
  return requestId
}

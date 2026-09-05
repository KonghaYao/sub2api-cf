export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly type = 'invalid_request_error',
    readonly retryAfter?: string,
    readonly param?: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export function gatewayErrorResponse(error: GatewayError, requestId?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  if (requestId) headers.set('x-request-id', requestId)
  if (error.retryAfter) headers.set('retry-after', error.retryAfter)
  return new Response(
    JSON.stringify({
      error: {
        message: error.message,
        type: error.type,
        code: error.code,
        ...(error.param === undefined ? {} : { param: error.param }),
      },
    }),
    { status: error.status, headers },
  )
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  console.error('gateway request failed', error)
  return new GatewayError(500, 'internal_error', 'Internal gateway error', 'server_error')
}

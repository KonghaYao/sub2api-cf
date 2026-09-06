export interface CapturedEmailDelivery {
  idempotency_key: string
  attempt_count: number
  payload: Record<string, unknown>
}

const deliveries = new Map<string, CapturedEmailDelivery>()

/**
 * A process-external Miniflare service binding used as the test mailbox. The
 * application can reach it only through Env.EMAIL_DELIVERY, matching the
 * production Worker-to-Worker adapter boundary.
 */
export async function emailDeliveryFixture(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/v1/challenges') {
    const idempotencyKey = request.headers.get('idempotency-key')
    if (idempotencyKey === null || idempotencyKey.length === 0) {
      return Response.json({ error: 'missing idempotency key' }, { status: 400 })
    }
    const payload = await request.json().catch(() => null)
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return Response.json({ error: 'invalid payload' }, { status: 422 })
    }
    const existing = deliveries.get(idempotencyKey)
    if (existing === undefined) {
      deliveries.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        attempt_count: 1,
        payload: payload as Record<string, unknown>,
      })
    } else {
      existing.attempt_count += 1
    }
    return new Response(null, { status: 202 })
  }

  if (request.method === 'GET' && url.pathname === '/__test/messages') {
    const recipient = url.searchParams.get('recipient')
    const result = Array.from(deliveries.values()).filter((delivery) =>
      recipient === null || delivery.payload.recipient_email === recipient)
    return Response.json(result)
  }

  if (request.method === 'DELETE' && url.pathname === '/__test/messages') {
    deliveries.clear()
    return new Response(null, { status: 204 })
  }

  return Response.json({ error: 'not found' }, { status: 404 })
}

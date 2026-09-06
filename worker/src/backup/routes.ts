import type { Context } from 'hono'

import type { Env } from '../env'
import { constantTimeEqual } from '../gateway/crypto'

type BackupBindings = { Bindings: Env }

const OBJECT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9_-])?$/

export async function handleDurableObjectBackup(
  context: Context<BackupBindings>,
): Promise<Response> {
  const authenticated = authenticate(context)
  if (authenticated !== null) return authenticated

  const namespace = context.req.param('namespace')
  if (namespace !== 'USER_STATE' && namespace !== 'SUBSCRIPTION_STATE') {
    return backupError(404, 'backup_namespace_not_found')
  }
  const objectId = context.req.param('objectId')
  if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) {
    return backupError(400, 'invalid_backup_object_id')
  }
  const action = context.req.param('action')
  const method = context.req.method.toUpperCase()
  if (
    !(
      (method === 'GET' && action === 'verify')
      || (method === 'POST' && (action === 'export' || action === 'restore'))
    )
  ) return backupError(404, 'backup_route_not_found')

  const headers = new Headers()
  headers.set('x-sub2api-backup-environment', context.env.ENVIRONMENT)
  headers.set('x-sub2api-backup-namespace', namespace)
  headers.set('x-sub2api-backup-object-id', objectId)
  const contentType = context.req.header('content-type')
  if (contentType !== undefined) headers.set('content-type', contentType)

  const body = method === 'POST' ? context.req.raw.body : null
  const init: RequestInit & { duplex?: 'half' } = { method, headers }
  if (body !== null) {
    init.body = body
    init.duplex = 'half'
  }
  const binding = namespace === 'USER_STATE'
    ? context.env.USER_STATE
    : context.env.SUBSCRIPTION_STATE
  if (binding === undefined) return backupError(503, 'backup_namespace_not_configured')
  const stub = binding.get(binding.idFromName(objectId))
  return stub.fetch(new Request(`https://durable-state.internal/backup/${action}`, init))
}

function authenticate(context: Context<BackupBindings>): Response | null {
  const configured = context.env.BACKUP_OPERATOR_TOKEN
  if (configured === undefined || configured.length < 32) {
    return backupError(503, 'backup_operator_not_configured')
  }
  const authorization = context.req.header('authorization')?.trim() ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization)
  if (match === null || !constantTimeEqual(match[1], configured)) {
    return backupError(401, 'invalid_backup_operator_token')
  }
  if (context.req.header('x-sub2api-backup-environment') !== context.env.ENVIRONMENT) {
    return backupError(403, 'backup_environment_mismatch')
  }
  return null
}

function backupError(status: number, code: string): Response {
  return Response.json({ schema_version: 1, error: { code } }, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

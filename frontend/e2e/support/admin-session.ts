import type { APIRequestContext, APIResponse } from '@playwright/test'

interface BootstrapAdmin {
  admin_session: string
  user_id: string
}

async function responseData<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as { code?: number; data?: T; error?: unknown }
  if (!response.ok() || body.code !== 0 || body.data === undefined) {
    throw new Error(`Browser E2E admin setup failed (${response.status()}): ${JSON.stringify(body)}`)
  }
  return body.data
}

/**
 * Bootstrap only auto-assigns super_admin to the first administrator in a D1
 * database. Give later per-spec bootstrap administrators the same test-only
 * role, then keep using the session that belongs to that spec's administrator.
 */
export async function ensureBootstrapAdminPermissions(
  request: APIRequestContext,
  adminToken: string,
  bootstrap: BootstrapAdmin,
  idempotencyKey: string,
): Promise<string> {
  const recovery = await responseData<{ admin_session: string }>(await request.post(
    '/api/v1/admin/session/recover',
    { headers: { authorization: `Bearer ${adminToken}` } },
  ))
  const assignments = await responseData<{
    items: Array<{ role_id: string; active: boolean }>
  }>(await request.get(`/api/v1/admin/rbac/users/${bootstrap.user_id}/roles`, {
    headers: { authorization: `Bearer ${recovery.admin_session}` },
  }))

  if (!assignments.items.some((assignment) =>
    assignment.role_id === 'super_admin' && assignment.active
  )) {
    await responseData(await request.put(
      `/api/v1/admin/rbac/users/${bootstrap.user_id}/roles/super_admin`,
      {
        headers: {
          authorization: `Bearer ${recovery.admin_session}`,
          'idempotency-key': idempotencyKey,
          'if-match': '"0"',
        },
      },
    ))
  }

  return bootstrap.admin_session
}

type ApiEnvelope<T> = {
  code?: number
  data?: T
  error?: { code?: string; message?: string }
  message?: string
}

type AdminUser = {
  id: string
  email: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  control_version: number
}

type RoleAssignment = {
  role_id: string
  active: boolean
  control_version: number
}

class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ApiError'
  }
}

function requiredEnv(name: string, trim = true): string {
  const raw = Bun.env[name]
  const value = trim ? raw?.trim() : raw
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

const baseUrl = new URL(requiredEnv('SUB2API_URL'))
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
  throw new Error('SUB2API_URL must be an HTTP(S) origin')
}
baseUrl.pathname = '/'
baseUrl.search = ''
baseUrl.hash = ''

const adminToken = requiredEnv('ADMIN_TOKEN')
const email = requiredEnv('ADMIN_EMAIL').toLowerCase()
const password = requiredEnv('ADMIN_PASSWORD', false)
const displayName = Bun.env.ADMIN_NAME?.trim() || 'Administrator'

if (Array.from(password).length < 8) {
  throw new Error('ADMIN_PASSWORD must contain at least 8 characters')
}

async function api<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')

  const response = await fetch(new URL(path, baseUrl), { ...init, headers })
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null
  if (!response.ok || body?.code !== 0 || body.data === undefined) {
    const code = body?.error?.code || `HTTP_${response.status}`
    const message = body?.error?.message || body?.message || response.statusText
    throw new ApiError(code, `${init.method ?? 'GET'} ${path}: ${message}`)
  }
  return body.data
}

let session: string
try {
  const recovery = await api<{ admin_session: string }>(
    '/api/v1/admin/session/recover',
    adminToken,
    { method: 'POST' },
  )
  session = recovery.admin_session
} catch (error) {
  if (!(error instanceof ApiError) || error.code !== 'active_admin_not_found') throw error

  const bootstrap = await api<{ admin_session: string }>('/api/v1/admin/bootstrap', adminToken, {
    method: 'POST',
    body: JSON.stringify({
      user: { email, display_name: displayName, balance_micros: 1 },
      group: { name: 'Bootstrap Group' },
      account: {
        name: 'Bootstrap Placeholder',
        base_url: Bun.env.BOOTSTRAP_UPSTREAM_URL?.trim() || 'https://bootstrap.invalid/v1',
        api_key: Bun.env.BOOTSTRAP_UPSTREAM_KEY?.trim() || 'bootstrap-placeholder-key',
      },
      models: [{
        public_name: Bun.env.BOOTSTRAP_MODEL?.trim() || 'bootstrap-placeholder',
        input_micros_per_million: 1,
        output_micros_per_million: 1,
      }],
    }),
  })
  session = bootstrap.admin_session
  console.log('Created the first bootstrap administrator')
}

const users = await api<{ items: AdminUser[] }>(
  `/api/v1/admin/users?search=${encodeURIComponent(email)}&page_size=100`,
  session,
)
let user = users.items.find((candidate) => candidate.email.toLowerCase() === email)

if (user) {
  user = await api<AdminUser>(`/api/v1/admin/users/${user.id}`, session, {
    method: 'PUT',
    headers: {
      'idempotency-key': crypto.randomUUID(),
      'if-match': `"${user.control_version}"`,
    },
    body: JSON.stringify({
      display_name: displayName,
      role: 'admin',
      password,
      ...(user.status === 'disabled' ? { status: 'active' } : {}),
    }),
  })
  console.log(`Updated administrator: ${user.email}`)
} else {
  user = await api<AdminUser>('/api/v1/admin/users', session, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      email,
      display_name: displayName,
      role: 'admin',
      password,
    }),
  })
  console.log(`Created administrator: ${user.email}`)
}

const roles = await api<{ items: RoleAssignment[] }>(
  `/api/v1/admin/rbac/users/${user.id}/roles`,
  session,
)
const superAdmin = roles.items.find((assignment) => assignment.role_id === 'super_admin')

if (!superAdmin?.active) {
  await api(`/api/v1/admin/rbac/users/${user.id}/roles/super_admin`, session, {
    method: 'PUT',
    headers: {
      'idempotency-key': crypto.randomUUID(),
      'if-match': `"${superAdmin?.control_version ?? 0}"`,
    },
  })
  console.log('Granted role: super_admin')
} else {
  console.log('Role already granted: super_admin')
}

console.log(`Login: ${new URL('/login', baseUrl)}`)

import type { Context } from 'hono'
import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, queryInteger, readJsonObject, requireExpectedControlVersion, requireResourceId, requireSafeInteger, requireString } from './http'
import { controlIdempotency, controlIdempotencyInsert, findControlIdempotency } from './idempotency'

type C = Context<{ Bindings: Env }>
interface ProxyRow {
  id: string; name: string; protocol: string; host: string; port: number; status: string
  expires_at: number | null; fallback_mode: string; backup_proxy_id: string | null; expiry_warn_days: number
  nonce_b64: string; ciphertext_b64: string; control_version: number; created_at_ms: number; updated_at_ms: number
  account_count?: number
}
const SELECT = `SELECT p.*, (SELECT COUNT(*) FROM accounts a
  WHERE CAST(json_extract(a.ui_config_json, '$.proxy_id') AS TEXT) = p.id) AS account_count FROM proxies p`
const aad = (env: Env, id: string) => `${env.ENVIRONMENT}/proxy/${id}/1`
function masterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new GatewayError(503, 'credential_secret_not_configured', 'Credential encryption secret is not configured')
  }
  return env.CREDENTIALS_MASTER_KEY
}
async function getRow(env: Env, id: string): Promise<ProxyRow> {
  const row = await env.DB.prepare(`${SELECT} WHERE p.id=?`).bind(id).first<ProxyRow>()
  if (!row) throw new GatewayError(404, 'proxy_not_found', 'Proxy not found')
  return row
}
async function project(env: Env, row: ProxyRow, withCount = true) {
  const { nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms, account_count, ...value } = row
  // Reuse the account AES-GCM envelope with a separate proxy AAD namespace.
  const secret = await decryptCredential(nonce_b64, ciphertext_b64, masterKey(env), aad(env, row.id))
  const credentials = JSON.parse(secret.api_key) as { username: string; password: string }
  return { ...value, ...credentials, expires_at: row.expires_at === null ? null : new Date(row.expires_at * 1000).toISOString(),
    created_at: new Date(created_at_ms).toISOString(), updated_at: new Date(updated_at_ms).toISOString(),
    ...(withCount ? { account_count: account_count ?? 0 } : {}) }
}
export async function listAdminProxies(c: C): Promise<Response> {
  try {
    const all = new URL(c.req.url).pathname.endsWith('/all')
    const query = c.req.query()
    const conditions: string[] = []; const values: unknown[] = []
    if (all) conditions.push("p.status='active'")
    else if (query.status) {
      if (['active', 'inactive', 'expired'].includes(query.status)) { conditions.push('p.status=?'); values.push(query.status) }
      else throw new GatewayError(400, 'invalid_status', 'Invalid proxy status')
    }
    if (!all && query.protocol) { conditions.push('p.protocol=?'); values.push(query.protocol) }
    if (!all && query.search?.trim()) {
      conditions.push('(instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.host), lower(?)) > 0)')
      values.push(query.search.trim().slice(0, 100), query.search.trim().slice(0, 100))
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const page = queryInteger(query.page, 'page', 1, 1, 1000000)
    const pageSize = queryInteger(query.page_size, 'page_size', 20, 1, 1000)
    const sort = ({ id: 'p.created_at_ms', name: 'p.name', protocol: 'p.protocol', host: 'p.host', port: 'p.port',
      status: 'p.status', account_count: 'account_count', created_at: 'p.created_at_ms', expires_at: 'p.expires_at' } as Record<string, string>)[query.sort_by ?? 'id']
    if (!sort || (query.sort_order && !['asc', 'desc'].includes(query.sort_order))) throw new GatewayError(400, 'invalid_sort', 'Invalid proxy sort')
    const order = query.sort_order === 'asc' ? 'ASC' : 'DESC'
    const result = await c.env.DB.prepare(`${SELECT}${where} ORDER BY ${sort} ${order}, p.id ${order}${all ? '' : ' LIMIT ? OFFSET ?'}`)
      .bind(...values, ...(all ? [] : [pageSize, (page - 1) * pageSize])).all<ProxyRow>()
    const items = await Promise.all(result.results.map(row => project(c.env, row, !all || query.with_count === 'true')))
    if (all) return controlSuccess(items)
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM proxies p${where}`).bind(...values).first<{ total: number }>()
    return controlSuccess({ items, total: count!.total, page, page_size: pageSize, pages: Math.ceil(count!.total / pageSize) })
  } catch (error) { return controlError(asGatewayError(error)) }
}
export async function getAdminProxy(c: C): Promise<Response> {
  try { return controlSuccess(await project(c.env, await getRow(c.env, requireResourceId(c.req.param('id'), 'proxy')))) }
  catch (error) { return controlError(asGatewayError(error)) }
}

export async function createAdminProxy(c: C): Promise<Response> {
  try {
    return controlSuccess(await createProxyRecord(c.env, await readJsonObject(c.req.raw), c.req.header('idempotency-key') ?? crypto.randomUUID()), 201)
  } catch (error) { return controlError(asGatewayError(error)) }
}

async function createProxyRecord(env: Env, body: Record<string, unknown>, key: string) {
    const receipt = await controlIdempotency('admin.proxy.create', key, body)
    const previous = await findControlIdempotency(env, receipt)
    if (previous) return project(env, await getRow(env, previous.resource_id))
    const id = crypto.randomUUID(); const now = Date.now()
    const input = await parseProxy(env, body, id)
    const encrypted = await encryptCredential({ api_key: JSON.stringify({ username: input.username, password: input.password }) }, masterKey(env), aad(env, id))
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO proxies (id, name, protocol, host, port, status, expires_at, fallback_mode,
          backup_proxy_id, expiry_warn_days, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.name, input.protocol, input.host, input.port,
            input.status, input.expires_at, input.fallback_mode, input.backup_proxy_id, input.expiry_warn_days,
            encrypted.nonce_b64, encrypted.ciphertext_b64, now, now),
        controlIdempotencyInsert(env, receipt, 'proxy', id, { id }, now),
      ])
    } catch (error) {
      const replay = await findControlIdempotency(env, receipt)
      if (!replay) throw error
      return project(env, await getRow(env, replay.resource_id))
    }
    return project(env, await getRow(env, id))
}

export async function updateAdminProxy(c: C): Promise<Response> {
  try {
    const id = requireResourceId(c.req.param('id'), 'proxy')
    const row = await getRow(c.env, id)
    const body = await readJsonObject(c.req.raw)
    const expected = c.req.header('if-match') ? requireExpectedControlVersion(c.req.raw, body) : row.control_version
    if (expected !== row.control_version) throw new GatewayError(409, 'stale_control_version', 'Proxy changed; reload and retry')
    const current = await project(c.env, row)
    // Original admin_proxy.go preserves empty identity/auth fields, while expiry
    // and fallback fields are replaced by the update request's defaults.
    const merged: Record<string, unknown> = { ...body }
    for (const field of ['name', 'protocol', 'host', 'port', 'username', 'password', 'status'] as const) {
      if (!body[field]) merged[field] = current[field]
    }
    const input = await parseProxy(c.env, merged, id)
    const encrypted = await encryptCredential({ api_key: JSON.stringify({ username: input.username, password: input.password }) }, masterKey(c.env), aad(c.env, id))
    const result = await c.env.DB.prepare(`UPDATE proxies SET name=?, protocol=?, host=?, port=?, status=?, expires_at=?,
      fallback_mode=?, backup_proxy_id=?, expiry_warn_days=?, nonce_b64=?, ciphertext_b64=?, control_version=control_version+1,
      updated_at_ms=? WHERE id=? AND control_version=?`).bind(input.name, input.protocol, input.host, input.port, input.status,
        input.expires_at, input.fallback_mode, input.backup_proxy_id, input.expiry_warn_days, encrypted.nonce_b64,
        encrypted.ciphertext_b64, Date.now(), id, expected).run()
    if (result.meta.changes !== 1) throw new GatewayError(409, 'stale_control_version', 'Proxy changed; reload and retry')
    return controlSuccess(await project(c.env, await getRow(c.env, id)))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function deleteAdminProxy(c: C): Promise<Response> {
  try {
    await deleteProxyRecord(c.env, requireResourceId(c.req.param('id'), 'proxy'))
    return controlSuccess({ message: 'Proxy deleted successfully' })
  } catch (error) { return controlError(asGatewayError(error)) }
}

async function deleteProxyRecord(env: Env, id: string): Promise<void> {
    const row = await getRow(env, id)
    const references = await env.DB.prepare('SELECT COUNT(*) AS total FROM proxies WHERE backup_proxy_id=?').bind(id).first<{ total: number }>()
    if (row.account_count || references?.total) throw new GatewayError(409, 'proxy_in_use', 'Proxy is referenced by accounts or another proxy')
    try { await env.DB.prepare('DELETE FROM proxies WHERE id=?').bind(id).run() }
    catch (error) {
      if (String(error).includes('proxy_in_use') || String(error).includes('FOREIGN KEY')) throw new GatewayError(409, 'proxy_in_use', 'Proxy is in use')
      throw error
    }
}

export async function listAdminProxyAccounts(c: C): Promise<Response> {
  try {
    const id = requireResourceId(c.req.param('id'), 'proxy')
    await getRow(c.env, id)
    const result = await c.env.DB.prepare(`SELECT id, name, platform,
      COALESCE(json_extract(ui_config_json, '$.type'), CASE WHEN credential_kind='api_key' THEN 'apikey' ELSE 'oauth' END) AS type,
      CASE WHEN enabled=0 THEN 'inactive' WHEN health_status='unhealthy' THEN 'error' ELSE 'active' END AS status
      FROM accounts WHERE CAST(json_extract(ui_config_json, '$.proxy_id') AS TEXT)=? ORDER BY created_at_ms DESC, id`).bind(id).all()
    return controlSuccess(result.results)
  } catch (error) { return controlError(asGatewayError(error)) }
}

async function parseProxy(env: Env, body: Record<string, unknown>, id: string) {
  const name = requireString(body, 'name', 255); const host = requireString(body, 'host', 255)
  if (/[\s/@?#]/.test(host)) throw new GatewayError(400, 'invalid_host', 'Proxy host must be a hostname or IP address')
  const protocol = requireString(body, 'protocol', 16)
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) throw new GatewayError(400, 'invalid_protocol', 'Invalid proxy protocol')
  const port = requireSafeInteger(body, 'port', 1, 65535)
  const status = body.status ?? 'active'
  if (status !== 'active' && status !== 'inactive') throw new GatewayError(400, 'invalid_status', 'Invalid proxy status')
  const mode = body.fallback_mode || 'none'
  if (!['none', 'proxy', 'direct'].includes(String(mode))) throw new GatewayError(400, 'invalid_fallback_mode', 'Invalid fallback mode')
  const backup = body.backup_proxy_id == null || body.backup_proxy_id === 0 ? null : requireResourceId(String(body.backup_proxy_id), 'proxy')
  if (backup === id) throw new GatewayError(400, 'PROXY_BACKUP_SELF', 'Backup proxy cannot be itself')
  if (mode === 'proxy' && !backup) throw new GatewayError(400, 'PROXY_BACKUP_REQUIRED', 'Backup proxy is required')
  if (backup) await getRow(env, backup)
  const expires = body.expires_at == null ? null : requireSafeInteger(body, 'expires_at', -8640000000000, 8640000000000)
  const auth = (key: string) => {
    const value = body[key] ?? ''
    if (typeof value !== 'string' || value.length > 4096) throw new GatewayError(400, `invalid_${key}`, `Invalid proxy ${key}`)
    return value
  }
  return { name, protocol, host, port, status, expires_at: expires !== null && expires > 0 ? expires : null,
    fallback_mode: String(mode), backup_proxy_id: backup, expiry_warn_days: requireSafeInteger({ expiry_warn_days: 0, ...body }, 'expiry_warn_days', 0, 1000000),
    username: auth('username'), password: auth('password') }
}

export async function batchCreateAdminProxies(c: C): Promise<Response> {
  try {
    const body = await readJsonObject(c.req.raw)
    if (!Array.isArray(body.proxies) || body.proxies.length < 1 || body.proxies.length > 5) {
      throw new GatewayError(400, 'invalid_proxies', 'Each Worker request accepts 1 to 5 proxies')
    }
    const inputs = await Promise.all(body.proxies.map(async value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError(400, 'invalid_proxy', 'Proxy must be an object')
      const item = value as Record<string, unknown>
      const input: Record<string, unknown> = { name: 'default', host: item.host, port: item.port,
        protocol: item.protocol, username: item.username, password: item.password }
      for (const field of ['host', 'protocol', 'username', 'password']) {
        if (typeof input[field] === 'string') input[field] = input[field].trim()
      }
      return parseProxy(c.env, input, crypto.randomUUID())
    }))
    let created = 0; let skipped = 0
    for (const input of inputs) {
      // Original duplicate identity deliberately excludes protocol and name.
      const existing = await c.env.DB.prepare(`${SELECT} WHERE p.host=? AND p.port=?`).bind(input.host, input.port).all<ProxyRow>()
      const duplicates = await Promise.all(existing.results.map(row => project(c.env, row)))
      if (duplicates.some(row => row.username === input.username && row.password === input.password)) { skipped++; continue }
      try { await createProxyRecord(c.env, input, crypto.randomUUID()); created++ }
      catch { skipped++ }
    }
    return controlSuccess({ created, skipped })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function batchDeleteAdminProxies(c: C): Promise<Response> {
  try {
    const body = await readJsonObject(c.req.raw)
    if (!Array.isArray(body.ids) || body.ids.length > 10) throw new GatewayError(400, 'invalid_ids', 'Each Worker request accepts at most 10 proxy IDs')
    const ids = body.ids.map(id => requireResourceId(String(id), 'proxy'))
    const deleted_ids: string[] = []; const skipped: Array<{ id: string; reason: string }> = []
    for (const id of ids) {
      try { await deleteProxyRecord(c.env, id); deleted_ids.push(id) }
      catch (error) {
        const problem = asGatewayError(error)
        skipped.push({ id, reason: problem.status >= 500 ? 'Proxy deletion failed' : problem.message })
      }
    }
    return controlSuccess({ deleted_ids, skipped })
  } catch (error) { return controlError(asGatewayError(error)) }
}

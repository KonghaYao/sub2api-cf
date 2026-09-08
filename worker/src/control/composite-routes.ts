import type { Context } from 'hono'

import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlIdempotency, controlIdempotencyInsert, findControlIdempotency, parseIdempotentResponse } from './idempotency'
import { controlError, controlSuccess, deterministicUuid, optionalBoolean, optionalSafeInteger, optionalString, readJsonObject, requireExpectedControlVersion, requireIdempotencyKey, requireResourceId, requireString } from './http'

type Bindings = { Bindings: Env }
type Endpoint = 'any' | 'messages' | 'count_tokens' | 'responses' | 'chat_completions' | 'embeddings' | 'images' | 'gemini'
interface RouteRow { id: string; group_id: string; public_model: string; match_type: 'exact' | 'prefix'; target_platform: string; upstream_model: string; endpoint: Endpoint; priority: number; enabled: number; notes: string; control_version: number; created_at_ms: number; updated_at_ms: number }
interface Input { public_model: string; match_type: 'exact' | 'prefix'; target_platform: string; upstream_model: string; endpoint: Endpoint; priority: number; enabled: boolean; notes: string }

export async function listCompositeRoutes(context: Context<Bindings>): Promise<Response> {
  try { const groupId = requireResourceId(context.req.param('id'), 'group'); await requireCompositeGroup(context.env, groupId)
    const rows = await context.env.DB.prepare(`SELECT * FROM composite_model_routes WHERE group_id = ? ORDER BY priority, id`).bind(groupId).all<RouteRow>()
    return controlSuccess(rows.results.map(publicRoute))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function createCompositeRoute(context: Context<Bindings>): Promise<Response> {
  try { const groupId = requireResourceId(context.req.param('id'), 'group'); const key = requireIdempotencyKey(context.req.raw); const input = parseInput(await readJsonObject(context.req.raw)); await requireCompositeGroup(context.env, groupId)
    const idem = await controlIdempotency('admin.composite-route.create.v1', key, { groupId, input }); const previous = await findControlIdempotency(context.env, idem); if (previous) return controlSuccess(parseIdempotentResponse(previous, 'composite_route'))
    const now = Date.now(); const id = await deterministicUuid(`composite-route:${groupId}`, key); const route: RouteRow = { id, group_id: groupId, ...input, enabled: input.enabled ? 1 : 0, control_version: 0, created_at_ms: now, updated_at_ms: now }
    await context.env.DB.batch([context.env.DB.prepare(`INSERT INTO composite_model_routes (id, group_id, public_model, match_type, target_platform, upstream_model, endpoint, priority, enabled, notes, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(route.id, route.group_id, route.public_model, route.match_type, route.target_platform, route.upstream_model, route.endpoint, route.priority, route.enabled, route.notes, now, now), controlIdempotencyInsert(context.env, idem, 'composite_route', id, publicRoute(route), now)])
    return controlSuccess(publicRoute(route), 201)
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function updateCompositeRoute(context: Context<Bindings>): Promise<Response> {
  try { const groupId = requireResourceId(context.req.param('id'), 'group'); const routeId = requireResourceId(context.req.param('route_id'), 'composite route'); const key = requireIdempotencyKey(context.req.raw); const body = await readJsonObject(context.req.raw); const input = parseInput(body); const expected = requireExpectedControlVersion(context.req.raw, body); await requireCompositeGroup(context.env, groupId)
    const idem = await controlIdempotency('admin.composite-route.update.v1', key, { groupId, routeId, input, expected }); const previous = await findControlIdempotency(context.env, idem); if (previous) return controlSuccess(parseIdempotentResponse(previous, 'composite_route'))
    const current = await requireRoute(context.env, groupId, routeId); if (current.control_version !== expected) throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
    const next = { ...current, ...input, enabled: input.enabled ? 1 : 0, control_version: expected + 1, updated_at_ms: Date.now() }
    const result = await context.env.DB.prepare(`UPDATE composite_model_routes SET public_model=?, match_type=?, target_platform=?, upstream_model=?, endpoint=?, priority=?, enabled=?, notes=?, control_version=?, updated_at_ms=? WHERE id=? AND group_id=? AND control_version=?`).bind(next.public_model, next.match_type, next.target_platform, next.upstream_model, next.endpoint, next.priority, next.enabled, next.notes, next.control_version, next.updated_at_ms, routeId, groupId, expected).run()
    if (result.meta.changes !== 1) throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
    await context.env.DB.prepare(`INSERT INTO control_idempotency (scope,key_hash,request_hash,resource_type,resource_id,response_json,created_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?,?)`).bind(idem.scope, idem.key_hash, idem.request_hash, 'composite_route', routeId, JSON.stringify(publicRoute(next)), Date.now(), Date.now() + 604800000).run()
    return controlSuccess(publicRoute(next))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function deleteCompositeRoute(context: Context<Bindings>): Promise<Response> {
  try { const groupId = requireResourceId(context.req.param('id'), 'group'); const routeId = requireResourceId(context.req.param('route_id'), 'composite route'); const key = requireIdempotencyKey(context.req.raw); const body = await readJsonObject(context.req.raw); const expected = requireExpectedControlVersion(context.req.raw, body); await requireCompositeGroup(context.env, groupId)
    const idem = await controlIdempotency('admin.composite-route.delete.v1', key, { groupId, routeId, expected }); const previous = await findControlIdempotency(context.env, idem); if (previous) return controlSuccess(parseIdempotentResponse(previous, 'composite_route_delete'))
    const current = await requireRoute(context.env, groupId, routeId); if (current.control_version !== expected) throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
    const response = { message: 'Composite route deleted successfully' }; await context.env.DB.batch([context.env.DB.prepare('DELETE FROM composite_model_routes WHERE id=? AND group_id=? AND control_version=?').bind(routeId, groupId, expected), controlIdempotencyInsert(context.env, idem, 'composite_route_delete', routeId, response, Date.now())]); return controlSuccess(response)
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function previewCompositeRoute(context: Context<Bindings>): Promise<Response> { try { const groupId = requireResourceId(context.req.param('id'), 'group'); await requireCompositeGroup(context.env, groupId); const body = await readJsonObject(context.req.raw); const model = requireString(body, 'model', 256); const endpoint = parseEndpoint(body.endpoint); const route = await resolveCompositeRoute(context.env, groupId, model, endpoint); return controlSuccess(route === null ? { matched:false, source:'', group_id:groupId, public_model:model, target_platform:'', upstream_model:'', endpoint, reason:'No matching composite route' } : { matched:true, source:'route', group_id:groupId, public_model:model, target_platform:route.target_platform, upstream_model:upstream(route, model), endpoint, route:publicRoute(route) }) } catch (error) { return controlError(asGatewayError(error)) } }

export async function resolveCompositeRoute(env: Env, groupId: string, model: string, endpoint: Endpoint): Promise<RouteRow | null> { const rows = await env.DB.prepare(`SELECT * FROM composite_model_routes WHERE group_id=? AND enabled=1 AND (endpoint='any' OR endpoint=?) AND ((match_type='exact' AND public_model=?) OR (match_type='prefix' AND ? LIKE public_model || '%')) ORDER BY priority, CASE match_type WHEN 'exact' THEN 0 ELSE 1 END, length(public_model) DESC, id LIMIT 1`).bind(groupId, endpoint, model, model).all<RouteRow>(); return rows.results[0] ?? null }
function upstream(route: RouteRow, model: string) { return route.upstream_model === '' ? (route.match_type === 'prefix' ? model : route.public_model) : route.upstream_model }
function publicRoute(row: RouteRow) { return { ...row, enabled: row.enabled === 1 } }
async function requireCompositeGroup(env: Env, id: string) { const row = await env.DB.prepare(`SELECT platform FROM "groups" WHERE id=? AND deleted_at_ms IS NULL`).bind(id).first<{platform:string}>(); if (!row) throw new GatewayError(404, 'group_not_found', 'Group was not found'); if (row.platform !== 'composite') throw new GatewayError(409, 'group_not_composite', 'Composite routes require a composite group') }
async function requireRoute(env: Env, groupId: string, id: string) { const row = await env.DB.prepare('SELECT * FROM composite_model_routes WHERE id=? AND group_id=?').bind(id, groupId).first<RouteRow>(); if (!row) throw new GatewayError(404, 'composite_route_not_found', 'Composite route was not found'); return row }
function parseInput(body: Record<string,unknown>): Input { const match = body.match_type === 'prefix' ? 'prefix' : body.match_type === 'exact' || body.match_type === undefined ? 'exact' : invalid('match_type'); const target = requireString(body,'target_platform',32); if (!['openai','anthropic','gemini','codex','grok','antigravity'].includes(target)) invalid('target_platform'); const publicModel = requireString(body,'public_model',256); const upstreamModel = optionalString(body,'upstream_model',256) ?? (match === 'exact' ? publicModel : ''); const endpoint = parseEndpoint(body.endpoint); const priority = optionalSafeInteger(body,'priority',1,1000000) ?? 100; const enabled = optionalBoolean(body,'enabled') ?? true; const notes = optionalString(body,'notes',1000) ?? ''; return { public_model:publicModel,match_type:match,target_platform:target,upstream_model:upstreamModel,endpoint,priority,enabled,notes } }
function parseEndpoint(value: unknown): Endpoint { const endpoint = value === undefined ? 'any' : value; if (typeof endpoint !== 'string' || !['any','messages','count_tokens','responses','chat_completions','embeddings','images','gemini'].includes(endpoint)) invalid('endpoint'); return endpoint as Endpoint }
function invalid(field:string): never { throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`) }

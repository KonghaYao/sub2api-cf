import { accountFetcher, accountProxyId } from '../proxy/account-fetch'
import { authenticateUserRequest } from '../auth/handler';
import type { Context } from 'hono';
import type { Env } from '../env';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { encryptCredential, decryptCredential } from '../gateway/crypto';
import { validateBaseUrl } from '../gateway/repository';
import { buildProviderRequest, type ProviderPlatform } from '../gateway/providers';
import { minimalProbeBody, readBoundedProviderJson, validProviderResponse } from './account-synthetic-probes';
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion } from './http';
import { authenticateAdminSession } from './admin-auth';
import { quotaWindowStart } from '../notifications/scanner';
type C = Context<{
    Bindings: Env;
}>;
type Config = {
    name: string;
    provider: string;
    api_mode: 'chat_completions' | 'responses';
    description?: string;
    endpoint: string;
    primary_model: string;
    extra_models: string[];
    group_name: string;
    enabled: boolean;
    interval_seconds: number;
    jitter_seconds: number;
    extra_headers: Record<string, string>;
    body_override_mode: 'off' | 'merge' | 'replace';
    body_override: Record<string, unknown> | null;
    check_mode: 'probe' | 'quota' | 'quota_probe';
    account_id: string | null;
};
type Row = {
    id: number;
    config_json: string;
    nonce_b64: string;
    ciphertext_b64: string;
    template_id: number | null;
    created_by: string;
    created_at_ms: number;
    updated_at_ms: number;
    last_checked_at_ms: number | null;
};
type History = {
    id: number;
    model: string;
    status: string;
    latency_ms: number | null;
    ping_latency_ms: number | null;
    message: string;
    quota_json: string | null;
    checked_at_ms: number;
};
const AAD = 'channel-monitor:v1';
const defaults: Config = { name: '', provider: 'openai', api_mode: 'chat_completions', endpoint: '', primary_model: '', extra_models: [], group_name: '', enabled: true, interval_seconds: 300, jitter_seconds: 0, extra_headers: {}, body_override_mode: 'off', body_override: null, check_mode: 'probe', account_id: null };
const settingsDefault = { channel_monitor_enabled: false, channel_monitor_mode: 'v1', channel_monitor_default_interval_seconds: 300, channel_monitor_hide_throughput: false, channel_monitor_show_quota: false };
function invalid(message: string): never { throw new GatewayError(400, 'invalid_monitor', message); }
async function response(action: () => Promise<unknown>) { try {
    return controlSuccess(await action());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
function id(c: C) { const n = Number(c.req.param('id')); if (!Number.isSafeInteger(n) || n <= 0)
    invalid('Invalid monitor ID'); return n; }
async function row(env: Env, n: number) { const found = await env.DB.prepare('SELECT * FROM channel_monitors WHERE id=?').bind(n).first<Row>(); if (!found)
    throw new GatewayError(404, 'monitor_not_found', 'Monitor not found'); return found; }
async function template(env: Env, n: number) { const found = await env.DB.prepare('SELECT * FROM channel_monitor_templates WHERE id=?').bind(n).first<Row>(); if (!found)
    throw new GatewayError(404, 'template_not_found', 'Template not found'); return found; }
export async function readChannelMonitorSettings(env: Env) { const saved = await env.DB.prepare("SELECT config_json,control_version FROM channel_monitor_settings WHERE id='global'").first<{
    config_json: string;
    control_version: number;
}>(); return { ...settingsDefault, ...(saved ? JSON.parse(saved.config_json) : {}), control_version: saved?.control_version ?? 0 }; }
export const getChannelMonitorSettings = (c: C) => response(() => readChannelMonitorSettings(c.env));
export const updateChannelMonitorSettings = (c: C) => response(async () => { const body = await readJsonObject(c.req.raw), expected = requireExpectedControlVersion(c.req.raw, body), current = await readChannelMonitorSettings(c.env); if (current.control_version !== expected)
    throw new GatewayError(412, 'control_version_conflict', 'Reload monitor settings'); const next = { ...current }; for (const key of ['channel_monitor_enabled', 'channel_monitor_hide_throughput', 'channel_monitor_show_quota']) {
    if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean')
            invalid(key + ' must be boolean');
        next[key] = body[key];
    }
} if (body.channel_monitor_mode !== undefined) {
    if (!['v1', 'v2'].includes(String(body.channel_monitor_mode)))
        invalid('Invalid monitor mode');
    next.channel_monitor_mode = body.channel_monitor_mode;
} if (body.channel_monitor_default_interval_seconds !== undefined) {
    const n = body.channel_monitor_default_interval_seconds;
    if (!Number.isInteger(n) || Number(n) < 60 || Number(n) > 86400)
        invalid('Interval must be 60–86400 seconds');
    next.channel_monitor_default_interval_seconds = n;
} delete next.control_version; const saved = await c.env.DB.prepare(`INSERT INTO channel_monitor_settings(id,config_json,control_version,updated_at_ms) VALUES('global',?,1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,control_version=channel_monitor_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE channel_monitor_settings.control_version=?`).bind(JSON.stringify(next), Date.now(), expected).run(); if (!saved.meta.changes)
    throw new GatewayError(412, 'control_version_conflict', 'Reload monitor settings'); return readChannelMonitorSettings(c.env); });
function normalize(body: Record<string, unknown>, previous: Config = defaults, isTemplate = false): Config {
    const next = { ...previous };
    for (const key of ['name', 'provider', 'endpoint', 'primary_model', 'group_name', 'description'] as const) {
        if (body[key] === undefined)
            continue;
        if (typeof body[key] !== 'string' || body[key].length > 2048 || /[\r\n\0]/.test(body[key]))
            invalid('Invalid ' + key);
        next[key] = body[key].trim();
    }
    if (!next.name || next.name.length > 200)
        invalid('Name is required and limited to 200 characters');
    if (!['openai', 'anthropic', 'gemini', 'grok', 'antigravity', 'kimi', 'zhipu', 'deepseek'].includes(next.provider))
        invalid('Invalid provider');
    for (const [key, allowed] of [['api_mode', ['chat_completions', 'responses']], ['body_override_mode', ['off', 'merge', 'replace']], ['check_mode', ['probe', 'quota', 'quota_probe']]] as const) {
        if (body[key] !== undefined) {
            if (!(allowed as readonly unknown[]).includes(body[key]))
                invalid('Invalid ' + key);
            Object.assign(next, { [key]: body[key] });
        }
    }
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean')
            invalid('Enabled must be boolean');
        next.enabled = body.enabled;
    }
    for (const key of ['interval_seconds', 'jitter_seconds'] as const) {
        if (body[key] === undefined)
            continue;
        const n = body[key];
        if (!Number.isInteger(n) || Number(n) < (key === 'interval_seconds' ? 60 : 0) || Number(n) > 86400)
            invalid('Invalid ' + key);
        next[key] = Number(n);
    }
    if (next.jitter_seconds >= next.interval_seconds)
        invalid('Jitter must be smaller than interval');
    if (body.extra_models !== undefined) {
        if (!Array.isArray(body.extra_models) || body.extra_models.length > 10 || body.extra_models.some(v => typeof v !== 'string' || !v.trim() || v.length > 200))
            invalid('Invalid extra models');
        next.extra_models = [...new Set(body.extra_models as string[])];
    }
    if (body.account_id !== undefined && body.account_id !== null)
        next.account_id = body.account_id === 0 ? null : String(body.account_id);
    if (body.extra_headers !== undefined) {
        if (!body.extra_headers || typeof body.extra_headers !== 'object' || Array.isArray(body.extra_headers) || Object.keys(body.extra_headers).length > 30)
            invalid('Invalid extra headers');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.extra_headers)) {
            if (!/^[\w-]+$/.test(k) || typeof v !== 'string' || v.length > 4096 || /[\r\n\0]/.test(v) || ['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'x-api-key', 'x-goog-api-key'].includes(k.toLowerCase()))
                invalid('Invalid or reserved header ' + k);
            headers[k] = v;
        }
        next.extra_headers = headers;
    }
    if (body.body_override !== undefined) {
        if (body.body_override !== null && (typeof body.body_override !== 'object' || Array.isArray(body.body_override) || JSON.stringify(body.body_override).length > 16000))
            invalid('Invalid body override');
        next.body_override = body.body_override as Record<string, unknown> | null;
    }
    if (!isTemplate) {
        if (next.check_mode === 'quota' && !next.primary_model)
            next.primary_model = 'quota';
        if (next.check_mode !== 'quota') {
            next.endpoint = validateBaseUrl(next.endpoint).toString();
            if (!next.primary_model || next.primary_model.length > 200)
                invalid('Primary model required');
            if (next.provider === 'antigravity')
                invalid('Antigravity only supports account quota checks');
        }
        if (next.check_mode !== 'probe' && !next.account_id)
            invalid('Account is required for quota checks');
    }
    return next;
}
async function checkAccount(env: Env, config: Config) { if (config.check_mode === 'probe')
    return; const acct = await env.DB.prepare('SELECT platform FROM accounts WHERE id=?').bind(config.account_id).first<{
    platform: string;
}>(); if (!acct || acct.platform !== config.provider)
    invalid('Quota account must exist and match provider'); }
async function snapshot(env: Env, body: Record<string, unknown>, previous?: Row) { let templateId = previous?.template_id ?? null; if (body.clear_template === true)
    templateId = null;
else if (body.template_id !== undefined && body.template_id !== null) {
    templateId = Number(body.template_id);
    if (!Number.isSafeInteger(templateId) || templateId <= 0)
        invalid('Invalid template ID');
} const previousConfig = previous ? JSON.parse(previous.config_json) : { ...defaults, interval_seconds: (await readChannelMonitorSettings(env)).channel_monitor_default_interval_seconds }; let patch = { ...body }; if (templateId !== null && templateId !== previous?.template_id) {
    const source = JSON.parse((await template(env, templateId)).config_json) as Config;
    if (source.provider !== (body.provider ?? previousConfig.provider) || source.api_mode !== (body.api_mode ?? previousConfig.api_mode))
        invalid('Template provider and API mode must match');
    patch = { ...patch, extra_headers: source.extra_headers, body_override_mode: source.body_override_mode, body_override: source.body_override };
} const config = normalize(patch, previousConfig); await checkAccount(env, config); return { config, templateId }; }
function historyDTO(h: History) { const { checked_at_ms, quota_json, ...rest } = h; return { ...rest, checked_at: new Date(checked_at_ms).toISOString(), ...(quota_json ? { quota: JSON.parse(quota_json) } : {}) }; }
async function dto(env: Env, r: Row) { const config = JSON.parse(r.config_json) as Config; const rows = await env.DB.prepare('SELECT * FROM channel_monitor_history WHERE monitor_id=? AND checked_at_ms>=? ORDER BY checked_at_ms DESC,id DESC LIMIT 10000').bind(r.id, Date.now() - 7 * 86400000).all<History>(); const primary = rows.results.filter(h => h.model === config.primary_model), latest = primary[0]; return { ...config, id: r.id, api_key_masked: r.ciphertext_b64 ? '••••••••' : '', template_id: r.template_id, created_by: r.created_by, created_at: new Date(r.created_at_ms).toISOString(), updated_at: new Date(r.updated_at_ms).toISOString(), last_checked_at: r.last_checked_at_ms ? new Date(r.last_checked_at_ms).toISOString() : null, primary_status: latest?.status ?? '', primary_latency_ms: latest?.latency_ms ?? null, availability_7d: primary.length ? 100 * primary.filter(h => h.status === 'operational').length / primary.length : 0, extra_models_status: config.extra_models.map(model => { const h = rows.results.find(h => h.model === model); return { model, status: h?.status ?? '', latency_ms: h?.latency_ms ?? null }; }), latest_quota: latest?.quota_json ? JSON.parse(latest.quota_json) : null }; }
export const listChannelMonitors = (c: C) => response(async () => { const page = Math.max(1, Number(c.req.query('page')) || 1), size = Math.max(1, Math.min(100, Number(c.req.query('page_size')) || 20)); const rows = await c.env.DB.prepare('SELECT * FROM channel_monitors ORDER BY id DESC').all<Row>(); const filtered = rows.results.filter(r => { const config = JSON.parse(r.config_json) as Config; return (!c.req.query('provider') || config.provider === c.req.query('provider')) && (!c.req.query('enabled') || config.enabled === (c.req.query('enabled') === 'true')) && (!c.req.query('search') || config.name.toLowerCase().includes(c.req.query('search')!.toLowerCase())); }); return { items: await Promise.all(filtered.slice((page - 1) * size, page * size).map(r => dto(c.env, r))), total: filtered.length, page, page_size: size, pages: Math.ceil(filtered.length / size) }; });
export const getChannelMonitor = (c: C) => response(async () => dto(c.env, await row(c.env, id(c))));
export const createChannelMonitor = (c: C) => response(async () => { const body = await readJsonObject(c.req.raw, 32768), { config, templateId } = await snapshot(c.env, body), key = body.api_key; if (config.check_mode !== 'quota' && (typeof key !== 'string' || !key))
    invalid('API key required'); if (typeof key === 'string' && (key.length > 4096 || /[\r\n\0]/.test(key)))
    invalid('Invalid API key'); const encrypted = await encryptCredential({ api_key: typeof key === 'string' ? key : '' }, c.env.CREDENTIALS_MASTER_KEY!, AAD); const actor = await authenticateAdminSession(c.req.raw, c.env), now = Date.now(); const inserted = await c.env.DB.prepare('INSERT INTO channel_monitors(config_json,nonce_b64,ciphertext_b64,template_id,created_by,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?) RETURNING id').bind(JSON.stringify(config), encrypted.nonce_b64, encrypted.ciphertext_b64, templateId, actor.user_id, now, now).first<{
    id: number;
}>(); return dto(c.env, await row(c.env, inserted!.id)); });
export const updateChannelMonitor = (c: C) => response(async () => { const previous = await row(c.env, id(c)), body = await readJsonObject(c.req.raw, 32768), { config, templateId } = await snapshot(c.env, body, previous); let encrypted = { nonce_b64: previous.nonce_b64, ciphertext_b64: previous.ciphertext_b64 }; if (body.api_key !== undefined && body.api_key !== '') {
    if (typeof body.api_key !== 'string' || body.api_key.length > 4096 || /[\r\n\0]/.test(body.api_key))
        invalid('Invalid API key');
    encrypted = await encryptCredential({ api_key: body.api_key }, c.env.CREDENTIALS_MASTER_KEY!, AAD);
} await c.env.DB.prepare('UPDATE channel_monitors SET config_json=?,nonce_b64=?,ciphertext_b64=?,template_id=?,updated_at_ms=?,next_check_at_ms=0 WHERE id=?').bind(JSON.stringify(config), encrypted.nonce_b64, encrypted.ciphertext_b64, templateId, Date.now(), previous.id).run(); return dto(c.env, await row(c.env, previous.id)); });
export const deleteChannelMonitor = (c: C) => response(async () => { await row(c.env, id(c)); await c.env.DB.prepare('DELETE FROM channel_monitors WHERE id=?').bind(id(c)).run(); return { deleted: true }; });
export const duplicateChannelMonitor = (c: C) => response(async () => { const source = await row(c.env, id(c)), actor = await authenticateAdminSession(c.req.raw, c.env), key = c.req.header('idempotency-key'); if (!key || key.length > 200)
    invalid('Idempotency-Key is required'); const scope = JSON.stringify([source.id, actor.user_id, key]); const config = JSON.parse(source.config_json); config.name = config.name.slice(0, 193) + ' (copy)'; config.enabled = false; const now = Date.now(); await c.env.DB.prepare('INSERT INTO channel_monitors(config_json,nonce_b64,ciphertext_b64,template_id,created_by,created_at_ms,updated_at_ms,duplicate_scope) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(duplicate_scope) DO NOTHING').bind(JSON.stringify(config), source.nonce_b64, source.ciphertext_b64, source.template_id, actor.user_id, now, now, scope).run(); const saved = await c.env.DB.prepare('SELECT * FROM channel_monitors WHERE duplicate_scope=?').bind(scope).first<Row>(); return dto(c.env, saved!); });
export const channelMonitorHistory = (c: C) => response(async () => { await row(c.env, id(c)); const model = c.req.query('model'), limit = Math.max(1, Math.min(1000, Number(c.req.query('limit')) || 100)); const rows = await c.env.DB.prepare(`SELECT * FROM channel_monitor_history WHERE monitor_id=? ${model ? 'AND model=?' : ''} ORDER BY checked_at_ms DESC,id DESC LIMIT ?`).bind(id(c), ...(model ? [model] : []), limit).all<History>(); return { items: rows.results.map(historyDTO) }; });
async function quotaCheck(env: Env, config: Config, now: number) { const account = await env.DB.prepare('SELECT enabled,ui_config_json FROM accounts WHERE id=?').bind(config.account_id).first<{
    enabled: number;
    ui_config_json: string;
}>(); if (!account || account.enabled !== 1)
    return { source: 'gateway_usage', success: false, error: 'Account is disabled or unavailable', fetched_at: new Date(now).toISOString() }; const extra = JSON.parse(account.ui_config_json).extra ?? {}, tiers = []; for (const dimension of ['daily', 'weekly', 'total'] as const) {
    const limit = Number(extra[dimension === 'total' ? 'quota_limit' : `quota_${dimension}_limit`]);
    if (!Number.isFinite(limit) || limit <= 0)
        continue;
    const cost = await env.DB.prepare('SELECT COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,standard_cost_micros,amount_micros)),0) AS used FROM usage_projection WHERE account_id=? AND occurred_at_ms BETWEEN ? AND ?').bind(config.account_id, quotaWindowStart(now, dimension, extra), now).first<{
        used: number;
    }>();
    tiers.push({ window: dimension, label: 'Gateway usage', used: (cost?.used ?? 0) / 1000000, limit, used_percent: (cost?.used ?? 0) / 1000000 / limit * 100 });
} return { source: 'gateway_usage', success: tiers.length > 0, tiers, ...(tiers.length ? {} : { error: 'No Gateway quota limits configured; provider official quota is unavailable' }), fetched_at: new Date(now).toISOString() }; }
async function probe(env: Env, r: Row, config: Config, model: string, signal?: AbortSignal, proxyId?: unknown) { const started = Date.now(); try {
    const platform: ProviderPlatform = config.provider === 'anthropic' ? 'anthropic' : config.provider === 'gemini' ? 'gemini' : 'openai';
    const credential = await decryptCredential(r.nonce_b64, r.ciphertext_b64, env.CREDENTIALS_MASTER_KEY!, AAD);
    if (!credential.api_key)
        throw new Error('key');
    let body = minimalProbeBody(platform, config.api_mode, model);
    if (config.body_override_mode === 'merge') {
        // Match the original channel monitor's provider-specific merge denylist.
        // Templates may tune generation but must not redirect the model or replace
        // the check input while its result is attributed to the configured model.
        const protectedKeys = new Set(platform === 'gemini' ? ['contents']
            : platform === 'anthropic' ? ['model', 'messages']
            : config.provider === 'openai' && config.api_mode === 'responses'
                ? ['model', 'instructions', 'input', 'stream']
                : ['model', 'messages', 'stream']);
        body = { ...body, ...Object.fromEntries(Object.entries(config.body_override ?? {})
            .filter(([key]) => !protectedKeys.has(key))) };
    }
    if (config.body_override_mode === 'replace')
        body = { ...config.body_override };
    body.stream = false;
    const plan = buildProviderRequest({ account: { platform, protocol: platform, auth_scheme: platform === 'anthropic' ? 'x-api-key' : platform === 'gemini' ? 'x-goog-api-key' : 'bearer', base_url: config.endpoint, provider_config: {} }, credential, operation: platform === 'anthropic' ? 'messages' : platform === 'gemini' ? 'generate_content' : config.api_mode, model, body });
    for (const [key, value] of Object.entries(config.extra_headers))
        plan.headers.set(key, value);
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    const upstream = await accountFetcher(env,proxyId)(plan.url, { method: plan.method, headers: plan.headers, body: JSON.stringify(plan.body), redirect: 'manual', signal: abort });
    let ok = false;
    if (upstream.ok)
        ok = validProviderResponse(platform, config.api_mode, await readBoundedProviderJson(upstream));
    else
        await upstream.body?.cancel();
    return { model, status: ok ? 'operational' : 'failed', latency_ms: Date.now() - started, ping_latency_ms: null, message: ok ? '' : upstream.ok ? 'upstream_invalid_response' : `upstream_http_${upstream.status}`, checked_at: new Date(started).toISOString() };
}
catch {
    return { model, status: 'error', latency_ms: Date.now() - started, ping_latency_ms: null, message: signal?.aborted ? 'request_cancelled' : 'probe_transport_or_configuration_failed', checked_at: new Date(started).toISOString() };
} }
export async function executeChannelMonitor(env: Env, monitorId: number, signal?: AbortSignal) { const settings = await readChannelMonitorSettings(env); if (!settings.channel_monitor_enabled)
    throw new GatewayError(409, 'monitor_disabled', 'Channel monitoring is disabled'); const r = await row(env, monitorId), config = JSON.parse(r.config_json) as Config; if (!config.enabled)
    throw new GatewayError(409, 'monitor_disabled', 'Monitor is disabled'); const now = Date.now(), lease = crypto.randomUUID(); const claim = await env.DB.prepare('UPDATE channel_monitors SET lease_id=?,lease_expires_at_ms=? WHERE id=? AND lease_expires_at_ms<=?').bind(lease, now + 120000, monitorId, now).run(); if (!claim.meta.changes)
    throw new GatewayError(409, 'monitor_running', 'Monitor already running'); try {
    const results: Array<Record<string, unknown>> = [];
    const proxyAccount = config.check_mode==='quota_probe' && config.account_id ? await env.DB.prepare('SELECT ui_config_json FROM accounts WHERE id=?').bind(config.account_id).first<{ui_config_json:string}>() : null;
    const proxyId = accountProxyId(proxyAccount?.ui_config_json);
    const quota = config.check_mode !== 'probe' ? await quotaCheck(env, config, now) : null;
    const models = config.check_mode === 'quota' ? [config.primary_model || 'quota'] : [...new Set([config.primary_model, ...config.extra_models])];
    for (const model of models) {
        if (signal?.aborted)
            break;
        const live = await env.DB.prepare('SELECT config_json,nonce_b64 FROM channel_monitors WHERE id=? AND lease_id=?').bind(monitorId, lease).first<{
            config_json: string;
            nonce_b64: string;
        }>();
        if (!live || live.config_json !== r.config_json || live.nonce_b64 !== r.nonce_b64 || !(await readChannelMonitorSettings(env)).channel_monitor_enabled)
            break;
        const result: Record<string, unknown> = config.check_mode === 'quota' ? { model, status: quota!.success ? 'operational' : 'error', latency_ms: null, ping_latency_ms: null, message: quota!.success ? '' : quota!.error, checked_at: new Date(now).toISOString() } : await probe(env, r, config, model, signal, proxyId);
        if (quota && model === models[0])
            result.quota = quota;
        results.push(result);
        await env.DB.prepare('INSERT INTO channel_monitor_history(monitor_id,model,status,latency_ms,ping_latency_ms,message,quota_json,checked_at_ms) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM channel_monitors WHERE id=? AND lease_id=?)').bind(monitorId, model, result.status, result.latency_ms, null, result.message ?? '', result.quota ? JSON.stringify(result.quota) : null, Date.parse(String(result.checked_at)), monitorId, lease).run();
    }
    return { results };
}
finally {
    const jitter = (Math.random() * 2 - 1) * config.jitter_seconds * 1000;
    await env.DB.prepare('UPDATE channel_monitors SET lease_id=NULL,lease_expires_at_ms=0,last_checked_at_ms=?,next_check_at_ms=? WHERE id=? AND lease_id=?').bind(Date.now(), Date.now() + config.interval_seconds * 1000 + jitter, monitorId, lease).run();
} }
export const runChannelMonitor = (c: C) => response(() => executeChannelMonitor(c.env, id(c), c.req.raw.signal));
export async function runScheduledChannelMonitors(env: Env, now = Date.now()) { const settings = await readChannelMonitorSettings(env); if (!settings.channel_monitor_enabled)
    return; const rows = await env.DB.prepare("SELECT id FROM channel_monitors WHERE json_extract(config_json,'$.enabled')=1 AND next_check_at_ms<=? AND lease_expires_at_ms<=? ORDER BY next_check_at_ms,id LIMIT 1").bind(now, now).all<{
    id: number;
}>(); await Promise.allSettled(rows.results.map(r => executeChannelMonitor(env, r.id))); await env.DB.prepare('DELETE FROM channel_monitor_history WHERE id IN(SELECT id FROM channel_monitor_history WHERE checked_at_ms<? LIMIT 1000)').bind(now - 30 * 86400000).run(); }
async function templateDTO(env: Env, r: Row) { const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_monitors WHERE template_id=?').bind(r.id).first<{
    n: number;
}>(); return { ...JSON.parse(r.config_json), id: r.id, associated_monitors: count?.n ?? 0, created_at: new Date(r.created_at_ms).toISOString(), updated_at: new Date(r.updated_at_ms).toISOString() }; }
export const listChannelMonitorTemplates = (c: C) => response(async () => { const rows = await c.env.DB.prepare('SELECT * FROM channel_monitor_templates ORDER BY id DESC').all<Row>(); return { items: await Promise.all(rows.results.filter(r => { const cfg = JSON.parse(r.config_json); return (!c.req.query('provider') || cfg.provider === c.req.query('provider')) && (!c.req.query('api_mode') || cfg.api_mode === c.req.query('api_mode')); }).map(r => templateDTO(c.env, r))) }; });
export const getChannelMonitorTemplate = (c: C) => response(async () => templateDTO(c.env, await template(c.env, id(c))));
export const createChannelMonitorTemplate = (c: C) => response(async () => { const config = normalize(await readJsonObject(c.req.raw, 32768), defaults, true), now = Date.now(); const saved = await c.env.DB.prepare('INSERT INTO channel_monitor_templates(config_json,created_at_ms,updated_at_ms) VALUES(?,?,?) RETURNING id').bind(JSON.stringify(config), now, now).first<{
    id: number;
}>(); return templateDTO(c.env, await template(c.env, saved!.id)); });
export const updateChannelMonitorTemplate = (c: C) => response(async () => { const previous = await template(c.env, id(c)), config = normalize(await readJsonObject(c.req.raw, 32768), JSON.parse(previous.config_json), true); await c.env.DB.prepare('UPDATE channel_monitor_templates SET config_json=?,updated_at_ms=? WHERE id=?').bind(JSON.stringify(config), Date.now(), previous.id).run(); return templateDTO(c.env, await template(c.env, previous.id)); });
export const deleteChannelMonitorTemplate = (c: C) => response(async () => { await template(c.env, id(c)); await c.env.DB.prepare('DELETE FROM channel_monitor_templates WHERE id=?').bind(id(c)).run(); return { deleted: true }; });
export const associatedChannelMonitors = (c: C) => response(async () => { await template(c.env, id(c)); const rows = await c.env.DB.prepare('SELECT id,config_json FROM channel_monitors WHERE template_id=? ORDER BY id').bind(id(c)).all<Row>(); return { items: rows.results.map(r => { const cfg = JSON.parse(r.config_json); return { id: r.id, name: cfg.name, provider: cfg.provider, api_mode: cfg.api_mode, enabled: cfg.enabled }; }) }; });
export const applyChannelMonitorTemplate = (c: C) => response(async () => { const source = JSON.parse((await template(c.env, id(c))).config_json), body = await readJsonObject(c.req.raw); if (!Array.isArray(body.monitor_ids) || !body.monitor_ids.length || body.monitor_ids.length > 100 || body.monitor_ids.some(v => !Number.isSafeInteger(v) || Number(v) <= 0))
    invalid('Select 1–100 monitor IDs'); const ids = [...new Set(body.monitor_ids as number[])], rows = await Promise.all(ids.map(n => row(c.env, n))); if (rows.some(r => r.template_id !== id(c)))
    invalid('All monitors must belong to this template'); if (rows.some(r => { const cfg = JSON.parse(r.config_json); return cfg.provider !== source.provider || cfg.api_mode !== source.api_mode; }))
    invalid('Template API mode differs from associated monitor'); await c.env.DB.batch(rows.map(r => { const config = JSON.parse(r.config_json); return c.env.DB.prepare('UPDATE channel_monitors SET config_json=?,updated_at_ms=? WHERE id=? AND template_id=?').bind(JSON.stringify({ ...config, extra_headers: source.extra_headers, body_override_mode: source.body_override_mode, body_override: source.body_override }), Date.now(), r.id, id(c)); })); return { affected: rows.length }; });
export const userChannelMonitors = (c: C) => response(async () => { await authenticateUserRequest(c.req.raw, c.env); const settings = await readChannelMonitorSettings(c.env); if (!settings.channel_monitor_enabled || settings.channel_monitor_mode !== 'v1')
    return { items: [] }; const rows = await c.env.DB.prepare("SELECT * FROM channel_monitors WHERE json_extract(config_json,'$.enabled')=1 ORDER BY id").all<Row>(); return { items: await Promise.all(rows.results.map(async (r) => { const monitor = await dto(c.env, r); const history = await c.env.DB.prepare('SELECT * FROM channel_monitor_history WHERE monitor_id=? AND model=? ORDER BY checked_at_ms DESC,id DESC LIMIT 60').bind(r.id, monitor.primary_model).all<History>(); return { id: r.id, name: monitor.name, provider: monitor.provider, group_name: monitor.group_name, primary_model: monitor.primary_model, primary_status: monitor.primary_status, primary_latency_ms: monitor.primary_latency_ms, primary_ping_latency_ms: null, availability_7d: monitor.availability_7d, extra_models: monitor.extra_models_status, timeline: history.results.map(h => ({ status: h.status, latency_ms: h.latency_ms, ping_latency_ms: h.ping_latency_ms, checked_at: new Date(h.checked_at_ms).toISOString() })), ...(settings.channel_monitor_show_quota ? { latest_quota: monitor.latest_quota } : {}) }; })) }; });
export const userChannelMonitorStatus = (c: C) => response(async () => { await authenticateUserRequest(c.req.raw, c.env); const settings = await readChannelMonitorSettings(c.env), r = await row(c.env, id(c)), cfg = JSON.parse(r.config_json) as Config; if (!settings.channel_monitor_enabled || settings.channel_monitor_mode !== 'v1' || !cfg.enabled)
    throw new GatewayError(404, 'monitor_not_found', 'Monitor not found'); const now = Date.now(), history = await c.env.DB.prepare('SELECT * FROM channel_monitor_history WHERE monitor_id=? AND checked_at_ms>=? ORDER BY checked_at_ms DESC,id DESC').bind(r.id, now - 30 * 86400000).all<History>(); return { id: r.id, name: cfg.name, provider: cfg.provider, group_name: cfg.group_name, models: [...new Set([cfg.primary_model, ...cfg.extra_models])].map(model => { const rows = history.results.filter(h => h.model === model); const availability = (days: number) => { const set = rows.filter(h => h.checked_at_ms >= now - days * 86400000); return set.length ? 100 * set.filter(h => h.status === 'operational').length / set.length : 0; }; const week = rows.filter(h => h.checked_at_ms >= now - 7 * 86400000 && h.latency_ms !== null); return { model, latest_status: rows[0]?.status ?? '', latest_latency_ms: rows[0]?.latency_ms ?? null, availability_7d: availability(7), availability_15d: availability(15), availability_30d: availability(30), avg_latency_7d_ms: week.length ? week.reduce((sum, h) => sum + h.latency_ms!, 0) / week.length : null }; }) }; });

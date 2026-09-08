import type { Context } from 'hono';
import type { Env } from '../env';
import { authenticateUserRequest } from '../auth/handler';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { readChannelMonitorSettings } from './channel-monitors';
import { controlSuccess, controlError, readJsonObject } from './http';
type C = Context<{
    Bindings: Env;
}>;
type Thresholds = {
    minimum_sample: number;
    warning_error_rate: number;
    critical_error_rate: number;
    target_ttft_ms: number;
    warning_ttft_ms: number;
    critical_ttft_ms: number;
    warning_cache_rate: number;
    critical_cache_rate: number;
    error_weight: number;
    ttft_weight: number;
    cache_weight: number;
};
type Config = {
    version: number;
    enabled: boolean;
    refresh_interval_seconds: 60 | 300;
    platforms: Array<{
        platform: string;
        enabled: boolean;
        models: string[];
    }>;
    group_ids: string[];
    health_thresholds: Thresholds;
    ignored_error_categories: string[];
};
type Observation = {
    id: string;
    occurred_at_ms: number;
    completed_at_ms: number | null;
    lifecycle: string;
    user_id: string | null;
    email: string | null;
    group_id: string | null;
    group_name: string | null;
    platform: string;
    requested_model: string;
    duration_ms: number | null;
    ttft_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    error_type: string;
    error_phase: string;
    status_code: number | null;
    upstream_status_code: number | null;
};
const DEFAULTS: Config = { version: 0, enabled: true, refresh_interval_seconds: 60, platforms: [], group_ids: [], health_thresholds: { minimum_sample: 5, warning_error_rate: 0.05, critical_error_rate: 0.2, target_ttft_ms: 1000, warning_ttft_ms: 3000, critical_ttft_ms: 10000, warning_cache_rate: 0.1, critical_cache_rate: 0, error_weight: 0.5, ttft_weight: 0.5, cache_weight: 0 }, ignored_error_categories: [] };
async function respond(action: () => Promise<unknown>) { try {
    return controlSuccess(await action());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
async function publicResponse(c: C, action: () => Promise<unknown>) { return respond(async () => { const result = await action(); if (c.req.path.includes('/admin/'))
    return result; const settings = await readChannelMonitorSettings(c.env); const redact = (value: unknown): unknown => { if (Array.isArray(value))
    return value.map(redact); if (value === null || typeof value !== 'object')
    return value; const record = value as Record<string, unknown>, out: Record<string, unknown> = {}; for (const [key, item] of Object.entries(record)) {
    if (['success_requests', 'error_requests', 'request_count', 'token_count', 'cache_rate_numerator', 'cache_rate_denominator', 'sample_count', 'count'].includes(key) || (settings.channel_monitor_hide_throughput && ['rpm', 'tpm'].includes(key)))
        out[key] = 0;
    else if (key === 'config') {
        const cfg = item as Config;
        out.config = { ...cfg, group_ids: [], ignored_error_categories: [], platforms: cfg.platforms.map(p => ({ ...p, models: [] })) };
    }
    else
        out[key] = redact(item);
} return out; }; return redact(result); }); }
function bad(message: string): never { throw new GatewayError(400, 'invalid_monitor_config', message); }
async function config(env: Env): Promise<Config> { const row = await env.DB.prepare("SELECT config_json,version FROM channel_monitor_v2_config WHERE id='global'").first<{
    config_json: string;
    version: number;
}>(); return row ? { ...DEFAULTS, ...JSON.parse(row.config_json), version: row.version } : structuredClone(DEFAULTS); }
async function guard(env: Env, reads = false) { const settings = await readChannelMonitorSettings(env); if (!settings.channel_monitor_enabled || (reads && settings.channel_monitor_mode !== 'v2'))
    throw new GatewayError(404, 'monitor_disabled', 'This channel monitor view is disabled'); }
export const getChannelMonitorV2Config = (c: C) => respond(() => config(c.env));
export const updateChannelMonitorV2Config = (c: C) => respond(async () => { const body = await readJsonObject(c.req.raw, 32768), current = await config(c.env); if (body.version === undefined)
    throw new GatewayError(428, 'control_version_required', 'Monitor configuration version is required'); if (body.version !== current.version)
    throw new GatewayError(412, 'control_version_conflict', 'Reload monitor configuration'); const next = { ...current }; if (typeof body.enabled !== 'boolean' || ![60, 300].includes(Number(body.refresh_interval_seconds)))
    bad('Invalid enabled/refresh interval'); next.enabled = body.enabled; next.refresh_interval_seconds = Number(body.refresh_interval_seconds) as 60 | 300; if (!Array.isArray(body.platforms) || body.platforms.length > 30)
    bad('Invalid platforms'); next.platforms = body.platforms.map(p => { if (!p || typeof p !== 'object' || typeof p.platform !== 'string' || p.platform.length > 64 || typeof p.enabled !== 'boolean' || !Array.isArray(p.models) || p.models.length > 200 || p.models.some((m: unknown) => typeof m !== 'string' || m.length > 200))
    bad('Invalid platform model policy'); return { platform: p.platform, enabled: p.enabled, models: p.models }; }); if (!Array.isArray(body.group_ids) || body.group_ids.length > 200 || body.group_ids.some(v => !['string', 'number'].includes(typeof v) || String(v).length > 100))
    bad('Invalid groups'); next.group_ids = body.group_ids.map(String); if (!body.health_thresholds || typeof body.health_thresholds !== 'object')
    bad('Health thresholds required'); next.health_thresholds = { ...current.health_thresholds }; for (const key of Object.keys(next.health_thresholds) as Array<keyof Thresholds>) {
    const value = (body.health_thresholds as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400000)
        bad('Invalid health threshold ' + key);
    if ((key.includes('rate') || key.includes('weight')) && value > 1)
        bad('Rates and weights must be 0–1');
    next.health_thresholds[key] = value;
} const h = next.health_thresholds; if (h.warning_error_rate > h.critical_error_rate || h.target_ttft_ms > h.warning_ttft_ms || h.warning_ttft_ms > h.critical_ttft_ms || h.critical_cache_rate > h.warning_cache_rate)
    bad('Health thresholds must be ordered'); if (!Number.isInteger(h.minimum_sample) || h.minimum_sample < 1)
    bad('Minimum sample must be positive integer'); if (body.ignored_error_categories !== undefined) {
    if (!Array.isArray(body.ignored_error_categories) || body.ignored_error_categories.length > 30 || body.ignored_error_categories.some(v => typeof v !== 'string' || v.length > 80))
        bad('Invalid ignored categories');
    next.ignored_error_categories = body.ignored_error_categories as string[];
} const saved = await c.env.DB.prepare(`INSERT INTO channel_monitor_v2_config(id,config_json,version,updated_at_ms) VALUES('global',?,1,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,version=channel_monitor_v2_config.version+1,updated_at_ms=excluded.updated_at_ms WHERE channel_monitor_v2_config.version=?`).bind(JSON.stringify(next), Date.now(), current.version).run(); if (!saved.meta.changes)
    throw new GatewayError(412, 'control_version_conflict', 'Reload monitor configuration'); return config(c.env); });
function category(row: Observation) { const code = row.error_type.toLowerCase(); if (row.lifecycle === 'cancelled')
    return 'client_cancelled'; if (/content|moderation|policy/.test(code))
    return 'content_policy'; if (/context/.test(code))
    return 'context_limit'; if (/model/.test(code))
    return 'model_unsupported'; if (/group/.test(code))
    return 'group_access'; if (/quota|balance|budget/.test(code))
    return 'quota_or_balance'; if (/pool|account_unavailable/.test(code))
    return 'account_pool_unavailable'; if (/timeout/.test(code))
    return 'timeout'; if (/stream|transport|connection/.test(code))
    return 'transport_or_stream'; if (row.status_code === 429)
    return 'rate_or_capacity'; if (row.status_code === 401)
    return 'authentication'; if (row.status_code === 403)
    return 'upstream_forbidden'; if (row.status_code === 404)
    return 'not_found'; if (row.upstream_status_code && row.upstream_status_code >= 500)
    return 'upstream_5xx'; if (row.status_code === 400)
    return 'invalid_request'; if ((row.status_code ?? 0) >= 500)
    return 'internal'; return 'other'; }
function latency(values: number[]) { values.sort((a, b) => a - b); return { sample_count: values.length, p50_ms: values.length ? values[Math.ceil(values.length * .5) - 1] : null, p90_ms: values.length ? values[Math.ceil(values.length * .9) - 1] : null, p95_ms: values.length ? values[Math.ceil(values.length * .95) - 1] : null, avg_ms: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }; }
function metrics(rows: Observation[], minutes: number, cfg: Config, hideThroughput = false) { const successes = rows.filter(r => r.lifecycle === 'completed' && (r.status_code ?? 200) < 400), errors = rows.filter(r => r.lifecycle !== 'started' && !(r.lifecycle === 'completed' && (r.status_code ?? 200) < 400) && !cfg.ignored_error_categories.includes(category(r))); const tokenCount = rows.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0), cache = rows.reduce((n, r) => n + r.cache_read_tokens, 0), input = rows.reduce((n, r) => n + r.input_tokens, 0); return { success_requests: successes.length, error_requests: errors.length, request_count: rows.length, token_count: hideThroughput ? 0 : tokenCount, rpm: hideThroughput ? 0 : rows.length / minutes, tpm: hideThroughput ? 0 : tokenCount / minutes, error_rate: successes.length + errors.length ? errors.length / (successes.length + errors.length) : 0, cache_rate: input ? cache / input : 0, cache_rate_numerator: cache, cache_rate_denominator: input, ttft: latency(rows.map(r => r.ttft_ms).filter((v): v is number => v !== null)), duration: latency(rows.map(r => r.duration_ms).filter((v): v is number => v !== null)) }; }
function health(metric: ReturnType<typeof metrics>, cfg: Config) {
    const h = cfg.health_thresholds, enough = metric.success_requests + metric.error_requests >= h.minimum_sample;
    const error = !enough ? 'unknown' : metric.error_rate >= h.critical_error_rate ? 'critical' : metric.error_rate >= h.warning_error_rate ? 'warning' : 'healthy';
    const ttft = metric.ttft.sample_count < h.minimum_sample ? 'unknown' : metric.ttft.p95_ms! >= h.critical_ttft_ms ? 'critical' : metric.ttft.p95_ms! >= h.warning_ttft_ms ? 'warning' : 'healthy';
    const cache = !enough || metric.cache_rate_denominator === 0 ? 'unknown' : metric.cache_rate <= h.critical_cache_rate ? 'critical' : metric.cache_rate < h.warning_cache_rate ? 'warning' : 'healthy';
    const errorScore = error === 'unknown' ? null : Math.max(0, 100 * (1 - metric.error_rate / Math.max(h.critical_error_rate, .000001)));
    const ttftScore = ttft === 'unknown' ? null : Math.max(0, Math.min(100, 100 * (1 - (metric.ttft.p95_ms! - h.target_ttft_ms) / Math.max(h.critical_ttft_ms - h.target_ttft_ms, 1))));
    const cacheScore = cache === 'unknown' ? null : Math.min(100, 100 * metric.cache_rate / Math.max(h.warning_cache_rate, .000001));
    const components = [[errorScore, h.error_weight], [ttftScore, h.ttft_weight], [cacheScore, h.cache_weight]].filter(([score, weight]) => score !== null && weight! > 0) as number[][];
    const weight = components.reduce((sum, p) => sum + p[1], 0), score = weight ? components.reduce((sum, p) => sum + p[0] * p[1], 0) / weight : null;
    const states = [[error, h.error_weight], [ttft, h.ttft_weight], [cache, h.cache_weight]].filter(([, weight]) => Number(weight) > 0).map(([state]) => state);
    const overall = states.includes('critical') ? 'critical' : states.includes('warning') ? 'warning' : states.includes('healthy') ? 'healthy' : 'unknown';
    return { overall, error_rate: error, ttft, cache, minimum_sample: h.minimum_sample, thresholds: h, score, error_rate_score: errorScore, ttft_score: ttftScore, cache_score: cacheScore };
}
async function load(c: C) { await guard(c.env, true); const admin = c.req.path.includes('/admin/'), user = admin ? null : await authenticateUserRequest(c.req.raw, c.env), cfg = await config(c.env); if (!cfg.enabled)
    throw new GatewayError(404, 'monitor_disabled', 'Passive monitoring is disabled'); const ranges: Record<string, number> = { '90m': 90 * 60000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }, range = c.req.query('range') ?? '24h'; if (!ranges[range])
    bad('Invalid monitor range'); const end = Date.now(), start = end - ranges[range], conditions = ['o.occurred_at_ms>=?', 'o.occurred_at_ms<=?'], values: unknown[] = [start, end]; for (const [key, column] of [['platform', 'o.platform'], ['group_id', 'o.group_id'], ['model', 'o.requested_model']] as const) {
    const requested = c.req.queries(key) ?? [];
    if (requested.length > 100 || requested.some(v => v.length > 200))
        bad('Too many filters');
    if (requested.length) {
        conditions.push(`${column} IN(${requested.map(() => '?').join(',')})`);
        values.push(...requested);
    }
} if (cfg.group_ids.length) {
    conditions.push(`o.group_id IN(${cfg.group_ids.map(() => '?').join(',')})`);
    values.push(...cfg.group_ids);
} const records = await c.env.DB.prepare(`SELECT o.*,u.email,g.name AS group_name FROM request_observations o LEFT JOIN users u ON u.id=o.user_id LEFT JOIN "groups" g ON g.id=o.group_id WHERE ${conditions.join(' AND ')} ORDER BY o.occurred_at_ms DESC,o.id DESC LIMIT 10001`).bind(...values).all<Observation>(); const truncated = records.results.length > 10000; const rows = records.results.slice(0, 10000).filter(r => { const policy = cfg.platforms.find(p => p.platform === r.platform); return !policy || (policy.enabled && (!policy.models.length || policy.models.includes(r.requested_model))); }); const settings = await readChannelMonitorSettings(c.env); const seconds = range === '90m' ? 60 : range === '24h' ? 300 : 3600; const coverage = { requested_start: new Date(start).toISOString(), requested_end: new Date(end).toISOString(), coverage_start: new Date(truncated ? (records.results[9999]?.occurred_at_ms ?? start) : start).toISOString(), data_through: new Date(end).toISOString(), computed_at: new Date(end).toISOString(), aggregation_lag_seconds: 0, coverage_complete: !truncated, bucket_seconds: seconds }; return { rows, cfg, coverage, minutes: ranges[range] / 60000, admin, user, hide: !admin && settings.channel_monitor_hide_throughput, seconds, start, end }; }
function grouped(rows: Observation[], key: (r: Observation) => string) { const groups = new Map<string, Observation[]>(); for (const r of rows) {
    const name = key(r);
    const set = groups.get(name);
    if (set)
        set.push(r);
    else
        groups.set(name, [r]);
} return [...groups.entries()]; }
export const channelMonitorV2Dimensions = (c: C) => publicResponse(c, async () => { const { rows } = await load(c); return { platforms: grouped(rows, r => r.platform).map(([value, set]) => ({ value, label: value, request_count: set.length })), groups: grouped(rows.filter(r => r.group_id), r => r.group_id!).map(([id, set]) => ({ id, name: set[0].group_name ?? id, platform: set[0].platform, request_count: set.length })), models: grouped(rows, r => r.requested_model).map(([value, set]) => ({ value, label: value, platform: set[0].platform, request_count: set.length })) }; });
export const channelMonitorV2Snapshot = (c: C) => publicResponse(c, async () => { const loaded = await load(c), { rows, cfg, minutes, hide, seconds } = loaded, metric = metrics(rows, minutes, cfg, hide); return { config: cfg, coverage: loaded.coverage, metrics: metric, health: health(metric, cfg), trend: grouped(rows, r => String(Math.floor(r.occurred_at_ms / (seconds * 1000)) * seconds * 1000)).sort(([a], [b]) => Number(a) - Number(b)).map(([start, set]) => { const m = metrics(set, seconds / 60, cfg, hide); return { bucket_start: new Date(Number(start)).toISOString(), metrics: m, health: health(m, cfg) }; }) }; });
export const channelMonitorV2Models = (c: C) => publicResponse(c, async () => { const { rows, cfg, minutes, hide, coverage } = await load(c); return { coverage, items: grouped(rows, r => JSON.stringify([r.platform, r.requested_model])).map(([, set]) => { const m = metrics(set, minutes, cfg, hide); return { platform: set[0].platform, model: set[0].requested_model, metrics: m, health: health(m, cfg) }; }) }; });
export const channelMonitorV2Matrix = (c: C) => publicResponse(c, async () => { const { rows, cfg, minutes, hide, coverage, seconds } = await load(c), by = c.req.query('group_by') ?? 'platform'; if (!['platform', 'platform_group', 'platform_model', 'platform_group_model'].includes(by))
    bad('Invalid grouping'); const withGroup = by.includes('group'), withModel = by.includes('model'); return { coverage, group_by: by, items: grouped(rows, r => JSON.stringify([r.platform, withGroup ? r.group_id : null, withModel ? r.requested_model : null])).map(([, set]) => { const m = metrics(set, minutes, cfg, hide); return { platform: set[0].platform, ...(withGroup ? { group_id: set[0].group_id, group_name: set[0].group_name } : {}), ...(withModel ? { model: set[0].requested_model } : {}), metrics: m, health: health(m, cfg), buckets: grouped(set, r => String(Math.floor(r.occurred_at_ms / (seconds * 1000)) * seconds * 1000)).sort(([a], [b]) => Number(a) - Number(b)).map(([time, bucket]) => { const bm = metrics(bucket, seconds / 60, cfg, hide); return { bucket_start: new Date(Number(time)).toISOString(), metrics: bm, health: health(bm, cfg) }; }) }; }) }; });
export const channelMonitorV2Errors = (c: C) => publicResponse(c, async () => { const { rows, cfg, coverage, admin } = await load(c); return { coverage, items: grouped(rows.filter(r => r.lifecycle === 'failed' || r.lifecycle === 'cancelled' || (r.status_code ?? 0) >= 400), category).map(([category, set]) => ({ category, count: set.length, rate: rows.length ? set.length / rows.length : 0, ignored: cfg.ignored_error_categories.includes(category), ...(admin ? { details: grouped(set, r => JSON.stringify([r.platform, r.requested_model, r.error_type, r.status_code])).map(([, items]) => ({ platform: items[0].platform, model: items[0].requested_model, error_type: items[0].error_type, status_code: items[0].status_code, upstream_status_code: items[0].upstream_status_code, count: items.length })) } : {}) })) }; });
export const channelMonitorV2Users = (c: C) => publicResponse(c, async () => { const { rows, cfg, coverage, admin, user, minutes, hide } = await load(c); return { coverage, items: grouped(rows, r => r.user_id ?? 'anonymous').sort(([, a], [, b]) => b.length - a.length).slice(0, 100).map(([id, set], index) => ({ ...(admin ? { user_id: id, email: set[0].email ?? '', username: set[0].email ?? '' } : {}), rank: index + 1, display_label: admin ? (set[0].email ?? 'Unknown user') : id === user?.id ? 'You' : `User ${index + 1}`, is_self: id === user?.id, can_drilldown: admin, metrics: metrics(set, minutes, cfg, hide) })) }; });

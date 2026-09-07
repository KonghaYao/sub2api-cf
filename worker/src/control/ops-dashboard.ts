import { runObservabilityRetention } from '../observability/retention';
import type { Context } from 'hono';
import type { Env } from '../env';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { poolStateName } from '../gateway/state-client';
import type { GatewayEndpoint } from '../gateway/types';
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion } from './http';
import { readOpsFeatures } from './ops-feature-settings';
type C = Context<{
    Bindings: Env;
}>;
type Row = {
    id: string;
    occurred_at_ms: number;
    lifecycle: string;
    platform: string;
    group_id: string | null;
    group_name: string | null;
    requested_model: string;
    status_code: number | null;
    upstream_status_code: number | null;
    duration_ms: number | null;
    ttft_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    error_type: string;
    request_path: string;
    is_business_limited: number;
};
export const opsAdvancedDefaults = { data_retention: { cleanup_enabled: true, cleanup_schedule: '0 3 * * *', error_log_retention_days: 30, minute_metrics_retention_days: 7, hourly_metrics_retention_days: 30 }, aggregation: { aggregation_enabled: true }, openai_account_quota_auto_pause: { default_threshold_5h: 0, default_threshold_7d: 0 }, ignore_count_tokens_errors: false, ignore_context_canceled: false, ignore_no_available_accounts: false, ignore_invalid_api_key_errors: false, ignore_insufficient_balance_errors: false, display_openai_token_stats: false, display_alert_events: false, auto_refresh_enabled: false, auto_refresh_interval_seconds: 30 };
const thresholdDefaults = { sla_percent_min: 99.5, ttft_p99_ms_max: 500, request_error_rate_percent_max: 5, upstream_error_rate_percent_max: 5 };
async function reply(action: () => Promise<unknown>) { try {
    return controlSuccess(await action());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
async function stored<T>(env: Env, id: string, defaults: T): Promise<T & {
    control_version: number;
}> { const row = await env.DB.prepare('SELECT config_json,control_version FROM ops_dashboard_settings WHERE id=?').bind(id).first<{
    config_json: string;
    control_version: number;
}>(); return { ...structuredClone(defaults), ...(row ? JSON.parse(row.config_json) : {}), control_version: row?.control_version ?? 0 }; }
export async function readOpsAdvanced(env: Env) { return stored(env, 'advanced', opsAdvancedDefaults); }
async function save(c: C, id: string, body: Record<string, unknown>, config: unknown) { const expected = requireExpectedControlVersion(c.req.raw, { ...body, expected_control_version: body.expected_control_version ?? body.control_version }); const saved = await c.env.DB.prepare(`INSERT INTO ops_dashboard_settings(id,config_json,control_version,updated_at_ms) SELECT ?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ops_dashboard_settings WHERE id=?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,control_version=ops_dashboard_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE ops_dashboard_settings.control_version=?`).bind(id, JSON.stringify(config), Date.now(), expected, id, expected).run(); if (!saved.meta.changes)
    throw new GatewayError(412, 'control_version_conflict', 'Operations settings changed; reload before saving'); return expected + 1; }
function invalid(message: string): never { throw new GatewayError(400, 'invalid_ops_settings', message); }
export const getOpsAdvancedSettings = (c: C) => reply(() => readOpsAdvanced(c.env));
export const updateOpsAdvancedSettings = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw, 16384), next = { ...await readOpsAdvanced(c.env) }; for (const key of ['ignore_count_tokens_errors', 'ignore_context_canceled', 'ignore_no_available_accounts', 'ignore_invalid_api_key_errors', 'ignore_insufficient_balance_errors', 'display_openai_token_stats', 'display_alert_events', 'auto_refresh_enabled'] as const) {
    if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean')
            invalid('Invalid ' + key);
        next[key] = body[key];
    }
} if (body.auto_refresh_interval_seconds !== undefined) {
    const value = body.auto_refresh_interval_seconds;
    if (!Number.isSafeInteger(value) || Number(value) < 5 || Number(value) > 300)
        invalid('Auto refresh interval must be 5–300 seconds');
    next.auto_refresh_interval_seconds = Number(value);
} for (const nested of ['aggregation', 'data_retention', 'openai_account_quota_auto_pause'] as const) {
    if (body[nested] === undefined)
        continue;
    const input = body[nested];
    if (!input || typeof input !== 'object' || Array.isArray(input))
        invalid('Invalid ' + nested);
    const base = { ...next[nested] } as Record<string, unknown>;
    for (const [key, value] of Object.entries(input)) {
        if (!(key in base) || typeof value !== typeof base[key])
            invalid('Invalid ' + nested + '.' + key);
        if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || (nested === 'openai_account_quota_auto_pause' ? value > 1 : !Number.isInteger(value) || value > 3650)))
            invalid('Invalid retention or quota threshold');
        if (typeof value === 'string' && (value.length > 100 || value.trim().split(/\s+/).length !== 5))
            invalid('Invalid cleanup schedule');
        base[key] = value;
    }
    Object.assign(next, { [nested]: base });
} if (next.openai_account_quota_auto_pause.default_threshold_5h > 0 || next.openai_account_quota_auto_pause.default_threshold_7d > 0)
    throw new GatewayError(503, 'official_quota_unavailable', 'Official OpenAI 5h/7d quota snapshots are not configured; rate-limit headers are not subscription quota'); cronMatches(next.data_retention.cleanup_schedule, Date.now()); const version = await save(c, 'advanced', body, next); return { ...next, control_version: version }; });
export const getOpsMetricThresholds = (c: C) => reply(() => stored(c.env, 'thresholds', thresholdDefaults));
export const updateOpsMetricThresholds = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw), next = { ...await stored(c.env, 'thresholds', thresholdDefaults) } as Record<string, unknown>; for (const key of Object.keys(thresholdDefaults)) {
    if (body[key] === undefined)
        continue;
    const value = body[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'ttft_p99_ms_max' ? 86400000 : 100)))
        invalid('Invalid metric threshold');
    next[key] = value;
} const version = await save(c, 'thresholds', body, next); return { ...next, control_version: version }; });
async function guard(env: Env, realtime = false) { const feature = await readOpsFeatures(env); if (!feature.ops_monitoring_enabled)
    throw new GatewayError(404, 'ops_monitoring_disabled', 'Ops monitoring is disabled'); return { feature, realtimeEnabled: !realtime || feature.ops_realtime_monitoring_enabled }; }
function percentile(values: number[]) { values.sort((a, b) => a - b); const p = (ratio: number) => values.length ? values[Math.ceil(values.length * ratio) - 1] : null; return { p50_ms: p(.5), p90_ms: p(.9), p95_ms: p(.95), p99_ms: p(.99), avg_ms: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, max_ms: values.at(-1) ?? null }; }
function groups<T>(rows: T[], key: (row: T) => string) { const map = new Map<string, T[]>(); for (const row of rows) {
    const id = key(row);
    const set = map.get(id);
    if (set)
        set.push(row);
    else
        map.set(id, [row]);
} return [...map.entries()]; }
function ignored(row: Row, advanced: typeof opsAdvancedDefaults) { return (advanced.ignore_count_tokens_errors && row.request_path.endsWith('/count_tokens')) || (advanced.ignore_context_canceled && row.lifecycle === 'cancelled') || (advanced.ignore_no_available_accounts && /account.*unavailable|pool_exhausted|no_available/.test(row.error_type)) || (advanced.ignore_invalid_api_key_errors && /invalid_api_key|api_key_required/.test(row.error_type)) || (advanced.ignore_insufficient_balance_errors && /insufficient_balance/.test(row.error_type)); }
function window(c: C) { const duration: Record<string, number> = { '1min': 60000, '5min': 300000, '15min': 900000, '30min': 1800000, '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000, '60s': 60000, '1m': 60000, '2m': 120000, '5m': 300000, '7d': 7 * 86400000, '30m': 1800000, '1h': 3600000, '6h': 21600000, '24h': 86400000, '1d': 86400000, '15d': 15 * 86400000, '30d': 30 * 86400000 }; const range = c.req.query('time_range') ?? c.req.query('window') ?? '1h'; if (!duration[range])
    invalid('Invalid time range'); const end = c.req.query('end_time') ? Date.parse(c.req.query('end_time')!) : Date.now(), start = c.req.query('start_time') ? Date.parse(c.req.query('start_time')!) : end - duration[range]; if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 30 * 86400000 || end > Date.now() + 60000)
    invalid('Invalid operations time window'); return { start, end, range }; }
async function aggregate(c: C) { const { feature } = await guard(c.env), advanced = await readOpsAdvanced(c.env), requested = window(c), mode = c.req.query('mode') ?? feature.ops_query_mode_default; if (!['raw', 'auto', 'preagg'].includes(mode))
    invalid('Invalid query mode'); const cached = mode !== 'raw' && advanced.aggregation.aggregation_enabled, interval = feature.ops_metrics_interval_seconds * 1000, end = cached && !c.req.query('end_time') ? Math.ceil(requested.end / interval) * interval : requested.end, start = end - (requested.end - requested.start); const platform = c.req.query('platform') ?? '', groupId = c.req.query('group_id') ?? ''; if (platform.length > 64 || groupId.length > 128)
    invalid('Invalid filter'); const cacheKey = JSON.stringify([start, end, platform, groupId, advanced.control_version, interval]); if (cached) {
    const hit = await c.env.DB.prepare('SELECT result_json FROM ops_dashboard_cache WHERE cache_key=? AND expires_at_ms>?').bind(cacheKey, Date.now()).first<{
        result_json: string;
    }>();
    if (hit)
        return { ...JSON.parse(hit.result_json), query_source: 'cached_aggregate' };
} const where = ['o.occurred_at_ms>=?', 'o.occurred_at_ms<=?'], values: unknown[] = [start, Math.min(end, Date.now())]; if (platform) {
    where.push('o.platform=?');
    values.push(platform);
} if (groupId) {
    where.push('o.group_id=?');
    values.push(groupId);
} const result = await c.env.DB.prepare(`SELECT o.*,g.name AS group_name FROM request_observations o LEFT JOIN "groups" g ON g.id=o.group_id WHERE ${where.join(' AND ')} ORDER BY o.occurred_at_ms DESC,o.id DESC LIMIT 10001`).bind(...values).all<Row>(); const rows = result.results.slice(0, 10000), seconds = (end - start) / 1000, bucket = Math.max(feature.ops_metrics_interval_seconds, Math.ceil(seconds / 240)), bucketRows = groups(rows, r => String(Math.floor(r.occurred_at_ms / (bucket * 1000)) * bucket * 1000)).sort(([a], [b]) => Number(a) - Number(b)); const tokens = (set: Row[]) => set.reduce((sum, r) => sum + r.input_tokens + r.output_tokens, 0), errors = rows.filter(r => r.lifecycle === 'failed' || r.lifecycle === 'cancelled' || (r.status_code ?? 0) >= 400), success = rows.filter(r => r.lifecycle === 'completed' && (r.status_code ?? 200) < 400); const slaErrors = errors.filter(r => !r.is_business_limited && !ignored(r, advanced)); const errorValues = (set: Row[]) => { const errs = set.filter(r => r.lifecycle === 'failed' || r.lifecycle === 'cancelled' || (r.status_code ?? 0) >= 400); return { error_count_total: errs.length, business_limited_count: errs.filter(r => r.is_business_limited).length, error_count_sla: errs.filter(r => !r.is_business_limited && !ignored(r, advanced)).length, upstream_error_count_excl_429_529: errs.filter(r => (r.upstream_status_code ?? 0) >= 400 && ![429, 529].includes(r.upstream_status_code!)).length, upstream_429_count: errs.filter(r => r.upstream_status_code === 429).length, upstream_529_count: errs.filter(r => r.upstream_status_code === 529).length }; }; const throughput = { bucket: bucket + 's', points: bucketRows.map(([at, set]) => ({ bucket_start: new Date(Number(at)).toISOString(), request_count: set.length, token_consumed: tokens(set), qps: set.length / bucket, tps: tokens(set) / bucket })), by_platform: groups(rows, r => r.platform).map(([platform, set]) => ({ platform, request_count: set.length, token_consumed: tokens(set) })), top_groups: groups(rows.filter(r => r.group_id), r => r.group_id!).map(([group_id, set]) => ({ group_id, group_name: set[0].group_name ?? group_id, request_count: set.length, token_consumed: tokens(set) })).sort((a, b) => b.request_count - a.request_count).slice(0, 10) }; const last = rows.filter(r => r.occurred_at_ms >= Math.min(end, Date.now()) - bucket * 1000); const common = { start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), platform, group_id: groupId || null }; const errorsSummary = errorValues(rows), overview = { ...common, success_count: success.length, ...errorsSummary, request_count_total: rows.length, request_count_sla: success.length + slaErrors.length, token_consumed: tokens(rows), sla: success.length + slaErrors.length ? success.length / (success.length + slaErrors.length) : 0, error_rate: success.length + slaErrors.length ? slaErrors.length / (success.length + slaErrors.length) : 0, upstream_error_rate: success.length + slaErrors.length ? errorsSummary.upstream_error_count_excl_429_529 / (success.length + slaErrors.length) : 0, qps: { current: last.length / bucket, peak: Math.max(0, ...throughput.points.map(p => p.qps)), avg: rows.length / seconds }, tps: { current: tokens(last) / bucket, peak: Math.max(0, ...throughput.points.map(p => p.tps)), avg: tokens(rows) / seconds }, duration: percentile(rows.map(r => r.duration_ms).filter((n): n is number => n !== null)), ttft: percentile(rows.map(r => r.ttft_ms).filter((n): n is number => n !== null)), system_metrics: null, job_heartbeats: [] }; const boundaries = [100, 300, 1000, 3000, 10000, 30000, Infinity], histogram = { ...common, total_requests: rows.filter(r => r.duration_ms !== null).length, buckets: boundaries.map((upper, i) => ({ range: upper === Infinity ? '>30s' : `${i ? boundaries[i - 1] : 0}-${upper}ms`, count: rows.filter(r => r.duration_ms !== null && r.duration_ms >= (i ? boundaries[i - 1] : 0) && r.duration_ms < upper).length })) }; const errorTrend = { bucket: bucket + 's', points: bucketRows.map(([at, set]) => ({ bucket_start: new Date(Number(at)).toISOString(), ...errorValues(set) })) }, distribution = { total: errors.length, items: groups(errors, r => String(r.status_code ?? 500)).map(([status, set]) => ({ status_code: Number(status), total: set.length, sla: set.filter(r => !r.is_business_limited && !ignored(r, advanced)).length, business_limited: set.filter(r => r.is_business_limited).length })) }; const output = { generated_at: new Date().toISOString(), overview, throughput_trend: throughput, error_trend: errorTrend, histogram, error_distribution: distribution, coverage: { complete: result.results.length <= 10000, sampled_requests: rows.length, max_samples: 10000 }, query_source: 'raw_observations' }; if (cached) {
    await c.env.DB.prepare('INSERT INTO ops_dashboard_cache(cache_key,result_json,created_at_ms,expires_at_ms) VALUES(?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,created_at_ms=excluded.created_at_ms,expires_at_ms=excluded.expires_at_ms').bind(cacheKey, JSON.stringify(output), Date.now(), Date.now() + interval).run();
} return output; }
export const getOpsDashboardSnapshot = (c: C) => reply(() => aggregate(c));
export const getOpsDashboardOverview = (c: C) => reply(async () => { const all = await aggregate(c); return { ...all.overview, coverage: all.coverage, query_source: all.query_source }; });
export const getOpsThroughputTrend = (c: C) => reply(async () => { const all = await aggregate(c); return { ...all.throughput_trend, coverage: all.coverage, query_source: all.query_source }; });
export const getOpsLatencyHistogram = (c: C) => reply(async () => { const all = await aggregate(c); return { ...all.histogram, coverage: all.coverage, query_source: all.query_source }; });
export const getOpsErrorTrend = (c: C) => reply(async () => { const all = await aggregate(c); return { ...all.error_trend, coverage: all.coverage, query_source: all.query_source }; });
export const getOpsErrorDistribution = (c: C) => reply(async () => { const all = await aggregate(c); return { ...all.error_distribution, coverage: all.coverage, query_source: all.query_source }; });
export const getOpsRealtimeTraffic = (c: C) => reply(async () => { const flags = await guard(c.env, true); if (!flags.realtimeEnabled)
    return { enabled: false, summary: null, timestamp: new Date().toISOString() }; const all = await aggregate(c); return { enabled: true, summary: { window: c.req.query('window') ?? '1h', start_time: all.overview.start_time, end_time: all.overview.end_time, platform: all.overview.platform, group_id: all.overview.group_id, qps: all.overview.qps, tps: all.overview.tps }, timestamp: all.generated_at, coverage: all.coverage }; });
type PoolSnapshot = {
    accounts: Array<{
        account_id: string;
        enabled: boolean;
        max_concurrency: number;
        active_leases: number;
        cooldown_until_ms: number;
    }>;
    waiting: Array<{
        account_id: string | null;
        request_id: string;
    }>;
};
async function poolSnapshots(c: C) { await guard(c.env, true); const platform = c.req.query('platform') ?? '', groupId = c.req.query('group_id') ?? ''; const where = ['1=1'], values: unknown[] = []; if (platform) {
    where.push('g.platform=?');
    values.push(platform);
} if (groupId) {
    where.push('r.group_id=?');
    values.push(groupId);
} const registry = await c.env.DB.prepare(`SELECT r.*,g.name AS group_name,g.platform FROM pool_state_registry r JOIN "groups" g ON g.id=r.group_id WHERE ${where.join(' AND ')} ORDER BY r.last_synced_at_ms DESC LIMIT 21`).bind(...values).all<{
    group_id: string;
    group_name: string;
    platform: string;
    model_id: string;
    endpoint: GatewayEndpoint;
}>(); const snapshots = await Promise.all(registry.results.slice(0, 20).map(async (r) => { try {
    const response = await c.env.POOL_STATE.get(c.env.POOL_STATE.idFromName(poolStateName(r.group_id, r.model_id, r.endpoint))).fetch('https://state.internal/snapshot', { signal: AbortSignal.timeout(5000) });
    if (!response.ok)
        return { ...r, snapshot: null };
    const snapshot = await response.json() as PoolSnapshot;
    return { ...r, snapshot };
}
catch {
    return { ...r, snapshot: null };
} })); const accounts = await c.env.DB.prepare('SELECT id,name,platform,enabled,max_concurrency,health_status FROM accounts ORDER BY id LIMIT 1001').all<{
    id: string;
    name: string;
    platform: string;
    enabled: number;
    max_concurrency: number;
    health_status: string;
}>(); return { snapshots, accounts: accounts.results.slice(0, 1000), complete: registry.results.length <= 20 && accounts.results.length <= 1000 && snapshots.every(r => r.snapshot !== null) }; }
export const getOpsConcurrency = (c: C) => reply(async () => { const flags = await guard(c.env, true); if (!flags.realtimeEnabled)
    return { enabled: false, platform: {}, group: {}, account: {} }; const loaded = await poolSnapshots(c), account: Record<string, any> = {}, group: Record<string, any> = {}, platform: Record<string, any> = {}; for (const entry of loaded.snapshots) {
    if (!entry.snapshot)
        continue;
    for (const state of entry.snapshot.accounts) {
        const metadata = loaded.accounts.find(a => a.id === state.account_id);
        if (!metadata)
            continue;
        const key = entry.group_id + ':' + metadata.id;
        const current = account[key] ?? { account_id: metadata.id, account_name: metadata.name, platform: metadata.platform, group_id: entry.group_id, group_name: entry.group_name, current_in_use: 0, max_capacity: metadata.enabled ? metadata.max_concurrency : 0, waiting_in_queue: 0, load_percentage: 0 };
        current.current_in_use += state.active_leases;
        current.waiting_in_queue += entry.snapshot.waiting.filter(w => w.account_id === metadata.id).length;
        current.load_percentage = current.max_capacity ? current.current_in_use / current.max_capacity * 100 : 0;
        account[key] = current;
    }
} for (const value of Object.values(account)) {
    const g = group[value.group_id] ?? { group_id: value.group_id, group_name: value.group_name, platform: value.platform, current_in_use: 0, max_capacity: 0, waiting_in_queue: 0, load_percentage: 0 };
    g.current_in_use += value.current_in_use;
    g.max_capacity += value.max_capacity;
    g.waiting_in_queue += value.waiting_in_queue;
    g.load_percentage = g.max_capacity ? g.current_in_use / g.max_capacity * 100 : 0;
    group[value.group_id] = g;
    const p = platform[value.platform] ?? { platform: value.platform, current_in_use: 0, max_capacity: 0, waiting_in_queue: 0, load_percentage: 0 };
    p.current_in_use += value.current_in_use;
    p.waiting_in_queue += value.waiting_in_queue;
    platform[value.platform] = p;
} for (const entry of loaded.snapshots) {
    const count = entry.snapshot?.waiting.filter(w => w.account_id === null).length ?? 0;
    if (!count)
        continue;
    const g = group[entry.group_id] ?? { group_id: entry.group_id, group_name: entry.group_name, platform: entry.platform, current_in_use: 0, max_capacity: 0, waiting_in_queue: 0, load_percentage: 0 };
    g.waiting_in_queue += count;
    group[entry.group_id] = g;
    const p = platform[entry.platform] ?? { platform: entry.platform, current_in_use: 0, max_capacity: 0, waiting_in_queue: 0, load_percentage: 0 };
    p.waiting_in_queue += count;
    platform[entry.platform] = p;
} for (const p of Object.values(platform)) {
    const ids = new Set(Object.values(account).filter(a => a.platform === p.platform).map(a => a.account_id));
    p.max_capacity = loaded.accounts.filter(a => ids.has(a.id) && a.enabled).reduce((n, a) => n + a.max_concurrency, 0);
    p.load_percentage = p.max_capacity ? p.current_in_use / p.max_capacity * 100 : 0;
} return { enabled: loaded.complete, platform, group, account, timestamp: new Date().toISOString(), coverage: { complete: loaded.complete, max_pools: 20 }, source: 'durable_object_leases' }; });
export const getOpsUserConcurrency = (c: C) => reply(async () => { const flags = await guard(c.env, true); if (!flags.realtimeEnabled)
    return { enabled: false, user: {} }; const rows = await c.env.DB.prepare("SELECT id,email,display_name,concurrency FROM users WHERE status='active' ORDER BY updated_at_ms DESC,id LIMIT 21").all<{
    id: string;
    email: string;
    display_name: string;
    concurrency: number;
}>(); const pools = await poolSnapshots(c); const waitingIds = new Set(pools.snapshots.flatMap(p => p.snapshot?.waiting.map(w => w.request_id) ?? [])); let complete = rows.results.length <= 20 && pools.complete; const entries = await Promise.all(rows.results.slice(0, 20).map(async (user) => { try {
    if (!c.env.API_KEY_LIMIT_STATE)
        throw new Error('missing');
    const response = await c.env.API_KEY_LIMIT_STATE.get(c.env.API_KEY_LIMIT_STATE.idFromName('user:' + user.id)).fetch('https://state.internal/snapshot', { signal: AbortSignal.timeout(5000) });
    if (!response.ok)
        throw new Error('unavailable');
    const snapshot = await response.json() as {
        active_concurrency: number;
        leases: Array<{
            request_id: string;
        }>;
    };
    return [user.id, { user_id: user.id, user_email: user.email, username: user.display_name, current_in_use: snapshot.active_concurrency, max_capacity: user.concurrency, load_percentage: user.concurrency ? snapshot.active_concurrency / user.concurrency * 100 : 0, waiting_in_queue: (snapshot.leases ?? []).filter(lease => waitingIds.has(lease.request_id)).length }];
}
catch {
    complete = false;
    return null;
} })); return { enabled: complete, user: Object.fromEntries(entries.filter(v => v !== null) as Array<[
        string,
        unknown
    ]>), timestamp: new Date().toISOString(), coverage: { complete, max_users: 20 }, source: 'durable_object_admission' }; });
export const getOpsAccountAvailability = (c: C) => reply(async () => { const flags = await guard(c.env, true); if (!flags.realtimeEnabled)
    return { enabled: false, platform: {}, group: {}, account: {} }; const loaded = await poolSnapshots(c), account: Record<string, any> = {}, platform: Record<string, any> = {}, group: Record<string, any> = {}; for (const entry of loaded.snapshots) {
    if (!entry.snapshot)
        continue;
    for (const state of entry.snapshot.accounts) {
        const metadata = loaded.accounts.find(a => a.id === state.account_id);
        if (!metadata)
            continue;
        const cooldown = state.cooldown_until_ms > Date.now(), hasError = metadata.health_status === 'unhealthy';
        const item = { account_id: metadata.id, account_name: metadata.name, platform: metadata.platform, group_id: entry.group_id, group_name: entry.group_name, status: !metadata.enabled ? 'disabled' : cooldown ? 'rate_limited' : hasError ? 'error' : 'available', is_available: metadata.enabled === 1 && !cooldown && !hasError, is_rate_limited: cooldown, rate_limit_reset_at: cooldown ? new Date(state.cooldown_until_ms).toISOString() : undefined, rate_limit_remaining_sec: cooldown ? Math.ceil((state.cooldown_until_ms - Date.now()) / 1000) : 0, is_overloaded: state.active_leases >= metadata.max_concurrency, has_error: hasError };
        const key = entry.group_id + ':' + metadata.id;
        const previous = account[key];
        if (!previous || cooldown || hasError)
            account[key] = item;
    }
} const summary = (items: any[]) => ({ total_accounts: items.length, available_count: items.filter(a => a.is_available).length, rate_limit_count: items.filter(a => a.is_rate_limited).length, error_count: items.filter(a => a.has_error).length }); for (const [id, set] of groups(Object.values(account), r => r.group_id))
    group[id] = { group_id: id, group_name: set[0].group_name, platform: set[0].platform, ...summary(set) }; for (const [id, set] of groups(Object.values(account), r => r.platform)) {
    const unique = [...new Map(set.map(a => [a.account_id, a])).values()];
    platform[id] = { platform: id, ...summary(unique) };
} return { enabled: loaded.complete, platform, group, account, timestamp: new Date().toISOString(), coverage: { complete: loaded.complete }, source: 'durable_object_pool_state' }; });
export const getOpsOpenAITokenStats = (c: C) => reply(async () => { const { feature } = await guard(c.env); const time = window(c); const rows = await c.env.DB.prepare("SELECT requested_model AS model,COUNT(*) AS request_count,SUM(output_tokens) AS total_output_tokens,AVG(duration_ms) AS avg_duration_ms,AVG(ttft_ms) AS avg_first_token_ms,COUNT(ttft_ms) AS requests_with_first_token,AVG(CASE WHEN duration_ms>0 THEN output_tokens*1000.0/duration_ms END) AS avg_tokens_per_sec FROM request_observations WHERE platform='openai' AND occurred_at_ms BETWEEN ? AND ? AND (?='' OR group_id=?) GROUP BY requested_model ORDER BY total_output_tokens DESC LIMIT 100").bind(time.start, time.end, c.req.query('group_id') ?? '', c.req.query('group_id') ?? '').all(); return { time_range: time.range, start_time: new Date(time.start).toISOString(), end_time: new Date(time.end).toISOString(), platform: 'openai', items: rows.results, total: rows.results.length }; });
export async function cleanupOpsDashboardCache(env: Env, now = Date.now()) { await env.DB.prepare('DELETE FROM ops_dashboard_cache WHERE cache_key IN(SELECT cache_key FROM ops_dashboard_cache WHERE expires_at_ms<? LIMIT 100)').bind(now).run(); }
export function cronMatches(expression: string, now: number): boolean {
    const fields = expression.trim().split(/\s+/), date = new Date(now), values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()], bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    if (fields.length !== 5)
        invalid('Cleanup schedule needs five cron fields (UTC)');
    const matches = fields.map((field, index) => { let matched = false; for (const part of field.split(',')) {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
        if (!match)
            invalid('Invalid cleanup cron expression');
        const [min, max] = bounds[index], step = match[2] ? Number(match[2]) : 1, range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
        if (range.length === 1)
            range.push(range[0]);
        if (!Number.isInteger(step) || step < 1 || range[0] < min || range[1] > max || range[0] > range[1])
            invalid('Invalid cleanup cron range');
        for (let value = range[0]; value <= range[1]; value += step)
            if ((index === 4 ? value % 7 : value) === values[index])
                matched = true;
    } return matched; });
    const day = fields[2] !== '*' && fields[4] !== '*' ? (matches[2] || matches[4]) : matches[2] && matches[4];
    return matches[0] && matches[1] && matches[3] && day;
}
export async function runOpsRetention(env: Env, now = Date.now()) {
    const advanced = await readOpsAdvanced(env), retention = advanced.data_retention;
    if (!retention.cleanup_enabled || !cronMatches(retention.cleanup_schedule, now))
        return { skipped: true };
    const minuteCutoff = now - retention.minute_metrics_retention_days * 86400000, hourCutoff = now - retention.hourly_metrics_retention_days * 86400000;
    await env.DB.prepare(`DELETE FROM ops_dashboard_cache WHERE cache_key IN(SELECT cache_key FROM ops_dashboard_cache WHERE
 (CAST(json_extract(result_json,'$.throughput_trend.bucket') AS INTEGER)<=300 AND ?>0 AND created_at_ms<?) OR
 (CAST(json_extract(result_json,'$.throughput_trend.bucket') AS INTEGER)>300 AND ?>0 AND created_at_ms<?) LIMIT 100)`).bind(retention.minute_metrics_retention_days, minuteCutoff, retention.hourly_metrics_retention_days, hourCutoff).run();
    if (retention.error_log_retention_days > 0)
        return runObservabilityRetention(env, { beforeMs: now - retention.error_log_retention_days * 86400000, limit: 10 });
    return { skipped: false };
}

import type { Context } from 'hono';
import type { Env } from '../env';
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion } from './http';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { redactDiagnosticText } from '../observability/redaction';
type C = Context<{
    Bindings: Env;
}>;
type Json = Record<string, any>;
const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export const opsLoggingDefaults = { level: 'info', enable_sampling: false, sampling_initial: 100, sampling_thereafter: 100, caller: false, stacktrace_level: 'none', retention_days: 30 };
async function reply(fn: () => Promise<unknown>) { try {
    return controlSuccess(await fn());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
function invalid(message: string): never { throw new GatewayError(400, 'invalid_ops_logging', message); }
async function read(env: Env) { const row = await env.DB.prepare("SELECT * FROM ops_logging_config WHERE id='global'").first<Json>(); return { ...opsLoggingDefaults, ...(row ? JSON.parse(row.config_json) : {}), control_version: row?.control_version ?? 0, source: 'worker_gateway_diagnostics', updated_at: row ? new Date(row.updated_at_ms).toISOString() : undefined }; }
export const getOpsRuntimeLogging = (c: C) => reply(() => read(c.env));
async function write(c: C, body: Json, reset = false) {
    const expected = requireExpectedControlVersion(c.req.raw, { ...body, expected_control_version: body.expected_control_version ?? body.control_version }), next = reset ? structuredClone(opsLoggingDefaults) : { ...await read(c.env), ...body };
    if (!(next.level in levels))
        invalid('Invalid log level');
    for (const key of ['enable_sampling', 'caller'])
        if (typeof next[key] !== 'boolean')
            invalid('Invalid ' + key);
    for (const [key, min, max] of [['sampling_initial', 0, 10000], ['sampling_thereafter', 1, 10000], ['retention_days', 1, 3650]] as const)
        if (!Number.isSafeInteger(next[key]) || next[key] < min || next[key] > max)
            invalid('Invalid ' + key);
    if (!['none', 'error', 'fatal'].includes(next.stacktrace_level))
        invalid('Invalid stacktrace level');
    const stored = Object.fromEntries(Object.keys(opsLoggingDefaults).map(key => [key, next[key]]));
    const result = await c.env.DB.prepare(`INSERT INTO ops_logging_config(id,config_json,control_version,updated_at_ms) SELECT 'global',?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ops_logging_config WHERE id='global') ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,control_version=ops_logging_config.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE ops_logging_config.control_version=?`).bind(JSON.stringify(stored), Date.now(), expected, expected).run();
    if (!result.meta.changes)
        throw new GatewayError(412, 'control_version_conflict', 'Logging configuration changed; reload first');
    return read(c.env);
}
export const updateOpsRuntimeLogging = (c: C) => reply(async () => write(c, await readJsonObject(c.req.raw)));
export const resetOpsRuntimeLogging = (c: C) => reply(async () => write(c, await readJsonObject(c.req.raw), true));
function filters(input: Json) {
    const where = ['1=1'], values: unknown[] = [];
    const ranges: Json = { '5m': 300000, '30m': 1800000, '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    if (input.time_range) {
        if (!ranges[input.time_range])
            invalid('Invalid time range');
        where.push('created_at_ms>=?');
        values.push(Date.now() - ranges[input.time_range]);
    }
    for (const [key, op] of [['start_time', '>='], ['end_time', '<=']])
        if (input[key]) {
            const date = Date.parse(input[key]);
            if (!Number.isFinite(date))
                invalid('Invalid log date');
            where.push('created_at_ms' + op + '?');
            values.push(date);
        }
    for (const key of ['level', 'component', 'request_id', 'client_request_id', 'user_id', 'api_key_id', 'account_id', 'platform'])
        if (input[key] != null && input[key] !== '') {
            where.push(key + '=?');
            values.push(String(input[key]));
        }
    if (input.model) {
        where.push('model=?');
        values.push(String(input.model));
    }
    if (input.host && input.host !== 'cloudflare-worker')
        where.push('0=1');
    if (input.q) {
        where.push("message LIKE ? ESCAPE '\\'");
        values.push('%' + String(input.q).replace(/[\\%_]/g, '\\$&') + '%');
    }
    return { where: where.join(' AND '), values };
}
export const listOpsSystemLogs = (c: C) => reply(async () => {
    const input = c.req.query(), page = Number(input.page ?? 1), size = Number(input.page_size ?? 50);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(size) || size < 1 || size > 200)
        invalid('Invalid pagination');
    const query = filters(input), rows = await c.env.DB.prepare('SELECT * FROM ops_system_logs WHERE ' + query.where + ' ORDER BY created_at_ms DESC,id DESC LIMIT ? OFFSET ?').bind(...query.values, size, (page - 1) * size).all<Json>(), count = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM ops_system_logs WHERE ' + query.where).bind(...query.values).first<{
        total: number;
    }>();
    return { items: rows.results.map(row => ({ id: row.id, created_at: new Date(row.created_at_ms).toISOString(), host: 'cloudflare-worker', level: row.level, component: row.component, message: row.message, request_id: row.request_id, client_request_id: row.client_request_id, user_id: row.user_id, api_key_id: row.api_key_id, account_id: row.account_id, platform: row.platform, model: row.model, extra: JSON.parse(row.extra_json) })), total: count?.total ?? 0, page, page_size: size, pages: Math.ceil((count?.total ?? 0) / size), source: 'worker_gateway_diagnostics' };
});
export const cleanupOpsSystemLogs = (c: C) => reply(async () => { const query = filters(await readJsonObject(c.req.raw)); const result = await c.env.DB.prepare('DELETE FROM ops_system_logs WHERE id IN(SELECT id FROM ops_system_logs WHERE ' + query.where + ' LIMIT 10000)').bind(...query.values).run(); return { deleted: result.meta.changes ?? 0 }; });
export const getOpsSystemLogHealth = (c: C) => reply(async () => {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS received,SUM(CASE WHEN decision='written' THEN 1 ELSE 0 END) AS written,SUM(CASE WHEN decision IN('sampled','level_filtered') THEN 1 ELSE 0 END) AS dropped FROM ops_log_receipts").first<Json>();
    const delay = await c.env.DB.prepare('SELECT AVG(MAX(0,r.received_at_ms-l.created_at_ms)) AS delay FROM ops_log_receipts r JOIN ops_system_logs l ON l.observation_id=r.observation_id').first<Json>();
    return { queue_depth: null, queue_capacity: null, dropped_count: Number(row?.dropped ?? 0), write_failed_count: null, written_count: Number(row?.written ?? 0), avg_write_delay_ms: delay?.delay ?? null, source: 'worker_gateway_diagnostics', coverage: { queue_depth: 'unavailable_from_worker_queue_binding', failures: 'queue_retry_managed' } };
});
export async function enqueueOpsSystemLog(env: Env, observationId: string) {
    // Only self-authored source locations enter the message; never exception/request/provider text.
    const frames = (new Error('Operations log capture').stack ?? '').split('\n').slice(1, 6).map(line => line.trim()).filter(line => /^at [\w.$<> ():/\\-]+:\d+:\d+\)?$/.test(line));
    await env.EVENTS_QUEUE.send({ schema_version: 1, event_id: 'ops-log:' + observationId, event_type: 'ops.system-log.v1', occurred_at_ms: Date.now(), aggregate_type: 'observation', aggregate_id: observationId, payload: { observation_id: observationId, frames } });
}
export async function consumeOpsSystemLog(value: unknown, env: Env): Promise<boolean> {
    if (!value || typeof value !== 'object' || (value as Json).event_type !== 'ops.system-log.v1')
        return false;
    const event = value as Json, message = event.payload ?? {};
    if (event.schema_version !== 1 || typeof message.observation_id !== 'string' || message.observation_id.length > 128)
        throw new Error('Invalid operations log message');
    const existing = await env.DB.prepare('SELECT observation_id FROM ops_log_receipts WHERE observation_id=?').bind(message.observation_id).first();
    if (existing)
        return true;
    const settings = await read(env), row = await env.DB.prepare("SELECT * FROM request_observations WHERE id=? AND lifecycle<>'started'").bind(message.observation_id).first<Json>();
    if (!row)
        return true;
    const level = row.status_code >= 500 ? 'error' : row.status_code >= 400 || row.lifecycle === 'cancelled' ? 'warn' : 'info';
    let decision = levels[level] >= levels[settings.level] ? 'written' : 'level_filtered';
    if (decision === 'written' && settings.enable_sampling) {
        const bucket = `${Math.floor(row.completed_at_ms / 1000)}:gateway:${level}:${row.error_type}`;
        const sample = await env.DB.prepare('INSERT INTO ops_log_sampling(bucket_key,count,updated_at_ms) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET count=ops_log_sampling.count+1,updated_at_ms=excluded.updated_at_ms RETURNING count').bind(bucket, Date.now()).first<{
            count: number;
        }>();
        const count = sample?.count ?? 1;
        if (count > settings.sampling_initial && (count - settings.sampling_initial) % settings.sampling_thereafter !== 0)
            decision = 'sampled';
    }
    const statements: D1PreparedStatement[] = [];
    if (decision === 'written') {
        const extra = { lifecycle: row.lifecycle, status_code: row.status_code, upstream_status_code: row.upstream_status_code, duration_ms: row.duration_ms, error_type: row.error_type, ...(settings.caller ? { caller: 'observability/recorder.ts:recordRequestOutcome' } : {}), ...(settings.stacktrace_level === 'error' && level === 'error' && Array.isArray(message.frames) ? { stacktrace: message.frames.filter((line: unknown) => typeof line === 'string' && /^at [\w.$<> ():/\\-]+:\d+:\d+\)?$/.test(line)).slice(0, 5).join('\n') } : {}) };
        statements.push(env.DB.prepare(`INSERT INTO ops_system_logs(observation_id,created_at_ms,level,component,message,request_id,client_request_id,user_id,api_key_id,account_id,platform,model,extra_json) VALUES(?,?,?,'gateway',?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id) DO NOTHING`).bind(row.id, row.completed_at_ms, level, redactDiagnosticText(row.error_message || `${row.method} ${row.request_path}: ${row.status_code}`).slice(0, 1000), row.request_id, row.client_request_id, row.user_id, row.api_key_id, row.account_id, row.platform, row.requested_model, JSON.stringify(extra)));
    }
    statements.push(env.DB.prepare('INSERT INTO ops_log_receipts(observation_id,decision,received_at_ms) VALUES(?,?,?) ON CONFLICT(observation_id) DO NOTHING').bind(row.id, decision, Date.now()));
    await env.DB.batch(statements);
    return true;
}
export async function runOpsSystemLogRetention(env: Env, now = Date.now()) {
    const settings = await read(env), cutoff = now - settings.retention_days * 86400000;
    await env.DB.batch([env.DB.prepare('DELETE FROM ops_system_logs WHERE id IN(SELECT id FROM ops_system_logs WHERE created_at_ms<? LIMIT 100)').bind(cutoff), env.DB.prepare('DELETE FROM ops_log_sampling WHERE bucket_key IN(SELECT bucket_key FROM ops_log_sampling WHERE updated_at_ms<? LIMIT 100)').bind(now - 86400000), env.DB.prepare('DELETE FROM ops_log_receipts WHERE observation_id IN(SELECT observation_id FROM ops_log_receipts WHERE received_at_ms<? LIMIT 100)').bind(cutoff)]);
}

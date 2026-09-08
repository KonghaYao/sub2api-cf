import type { Context } from 'hono';
import type { Env } from '../env';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { deliverPlatformEmail, emailDeliveryFailure, isEmailAddress } from '../email/delivery';
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion, deterministicUuid } from './http';
import { poolStateName } from '../gateway/state-client';
import type { GatewayEndpoint } from '../gateway/types';
import { readOpsFeatures } from './ops-feature-settings';
import { cronMatches, readOpsAdvanced } from './ops-dashboard';
type C = Context<{
    Bindings: Env;
}>;
type Json = Record<string, any>;
const severityRank: Record<string, number> = { info: 0, warning: 1, critical: 2, P0: 3, P1: 2, P2: 1, P3: 0 };
export const opsAlertRuntimeDefaults = {
    evaluation_interval_seconds: 60,
    distributed_lock: { enabled: true, key: 'ops-alert-evaluation', ttl_seconds: 120 },
    silencing: { enabled: false, global_until_rfc3339: '', global_reason: '', entries: [] as Json[] },
};
export const opsEmailDefaults = {
    alert: { enabled: false, recipients: [] as string[], min_severity: '' as string, rate_limit_per_hour: 20, batching_window_seconds: 60, include_resolved_alerts: false },
    report: { enabled: false, recipients: [] as string[], daily_summary_enabled: false, daily_summary_schedule: '0 9 * * *', weekly_summary_enabled: false, weekly_summary_schedule: '0 9 * * 1', error_digest_enabled: false, error_digest_schedule: '0 * * * *', error_digest_min_count: 10, account_health_enabled: false, account_health_schedule: '0 9 * * *', account_health_error_rate_threshold: 10 },
};
function invalid(message: string): never { throw new GatewayError(400, 'invalid_ops_alert', message); }
async function reply(action: () => Promise<unknown>) { try {
    return controlSuccess(await action());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
function obj(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Expected an object'); return value as Json; }
function integer(value: unknown, min: number, max: number, name: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    invalid(`${name} must be ${min}–${max}`); return Number(value); }
function text(value: unknown, max: number, name: string): string { if (typeof value !== 'string' || value.length > max)
    invalid('Invalid ' + name); return value; }
function boolean(value: unknown, name: string): boolean { if (typeof value !== 'boolean')
    invalid('Invalid ' + name); return value; }
async function config<T extends Json>(env: Env, id: string, defaults: T): Promise<T & {
    control_version: number;
}> {
    const row = await env.DB.prepare('SELECT config_json,control_version FROM ops_alert_config WHERE id=?').bind(id).first<{
        config_json: string;
        control_version: number;
    }>();
    return { ...structuredClone(defaults), ...(row ? JSON.parse(row.config_json) : {}), control_version: row?.control_version ?? 0 };
}
async function save(c: C, id: string, body: Json, next: Json) {
    const expected = requireExpectedControlVersion(c.req.raw, { ...body, expected_control_version: body.expected_control_version ?? body.control_version });
    delete next.control_version;
    const result = await c.env.DB.prepare(`INSERT INTO ops_alert_config(id,config_json,control_version,updated_at_ms) SELECT ?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM ops_alert_config WHERE id=?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,control_version=ops_alert_config.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE ops_alert_config.control_version=?`).bind(id, JSON.stringify(next), Date.now(), expected, id, expected).run();
    if (!result.meta.changes)
        throw new GatewayError(412, 'control_version_conflict', 'Alert settings changed; reload before saving');
    return { ...next, control_version: expected + 1 };
}
async function thresholds(env: Env) {
    const row = await env.DB.prepare("SELECT config_json,control_version FROM ops_dashboard_settings WHERE id='thresholds'").first<{
        config_json: string;
        control_version: number;
    }>();
    return { sla_percent_min: 99.5, ttft_p99_ms_max: 500, request_error_rate_percent_max: 5, upstream_error_rate_percent_max: 5, ...(row ? JSON.parse(row.config_json) : {}), control_version: row?.control_version ?? 0 };
}
export const getOpsAlertRuntime = (c: C) => reply(async () => ({ ...await config(c.env, 'runtime', opsAlertRuntimeDefaults), thresholds: await thresholds(c.env), evaluation_min_interval_seconds: 60, evaluation_max_interval_seconds: 3600 }));
export const updateOpsAlertRuntime = (c: C) => reply(async () => {
    const body = await readJsonObject(c.req.raw, 32768), next: Json = await config(c.env, 'runtime', opsAlertRuntimeDefaults);
    if (body.evaluation_interval_seconds !== undefined)
        next.evaluation_interval_seconds = integer(body.evaluation_interval_seconds, 60, 3600, 'Evaluation interval (one-minute Worker schedule)');
    if (body.distributed_lock !== undefined) {
        const value = obj(body.distributed_lock);
        next.distributed_lock = { enabled: boolean(value.enabled, 'lock enabled'), key: text(value.key, 128, 'lock key'), ttl_seconds: integer(value.ttl_seconds, 60, 900, 'Lock TTL') };
        if (!next.distributed_lock.key.trim())
            invalid('Lock key is required');
    }
    if (body.silencing !== undefined) {
        const value = obj(body.silencing), until = text(value.global_until_rfc3339, 64, 'silence until');
        if (until && !Number.isFinite(Date.parse(until)))
            invalid('Invalid silence expiry');
        const entries = value.entries ?? [];
        if (!Array.isArray(entries) || entries.length > 100)
            invalid('At most 100 silences are allowed');
        next.silencing = { enabled: boolean(value.enabled, 'silencing enabled'), global_until_rfc3339: until, global_reason: text(value.global_reason, 2000, 'silence reason'), entries: entries.map((entry: unknown) => { const row = obj(entry); const expires = text(row.until_rfc3339, 64, 'silence expiry'); if (!Number.isFinite(Date.parse(expires)))
                invalid('Invalid silence expiry'); const severities = row.severities ?? []; if (!Array.isArray(severities) || severities.some((s: unknown) => typeof s !== 'string' || !(s in severityRank)))
                invalid('Invalid silence severities'); return { ...(row.rule_id === undefined ? {} : { rule_id: integer(row.rule_id, 1, Number.MAX_SAFE_INTEGER, 'rule id') }), severities, until_rfc3339: expires, reason: text(row.reason ?? '', 2000, 'reason') }; }) };
    }
    // Thresholds have their own CAS endpoint; this response embeds its canonical read model.
    return { ...await save(c, 'runtime', body, next), thresholds: await thresholds(c.env), evaluation_min_interval_seconds: 60, evaluation_max_interval_seconds: 3600 };
});
export const getOpsEmailConfig = (c: C) => reply(() => config(c.env, 'email', opsEmailDefaults));
export const updateOpsEmailConfig = (c: C) => reply(async () => {
    const body = await readJsonObject(c.req.raw, 16384), next: Json = await config(c.env, 'email', opsEmailDefaults);
    for (const category of ['alert', 'report']) {
        if (body[category] === undefined)
            continue;
        const input = obj(body[category]), result = { ...next[category] };
        for (const [key, value] of Object.entries(input)) {
            if (!(key in result))
                invalid('Unknown email setting: ' + key);
            if (key === 'recipients') {
                if (!Array.isArray(value) || value.length > 20 || value.some(v => typeof v !== 'string' || !isEmailAddress(v)))
                    invalid('Use up to 20 valid recipient addresses');
                result[key] = [...new Set(value.map(v => String(v).trim().toLowerCase()))];
            }
            else if (typeof result[key] === 'boolean')
                result[key] = boolean(value, key);
            else if (key.endsWith('_schedule')) {
                result[key] = text(value, 100, key);
                cronMatches(result[key], Date.now());
            }
            else if (key === 'min_severity') {
                if (typeof value !== 'string' || (value !== '' && !(value in severityRank)))
                    invalid('Invalid minimum severity');
                result[key] = value;
            }
            else
                result[key] = integer(value, key === 'rate_limit_per_hour' ? 1 : 0, key === 'batching_window_seconds' ? 3600 : key === 'account_health_error_rate_threshold' ? 100 : 10000, key);
        }
        if (result.enabled && !result.recipients.length)
            invalid('Enabled email notifications need recipients');
        next[category] = result;
    }
    return save(c, 'email', body, next);
});
const supportedMetrics = new Set(['success_rate', 'error_rate', 'upstream_error_rate', 'account_error_count', 'account_error_ratio', 'concurrency_queue_depth', 'group_available_accounts', 'group_available_ratio', 'overload_account_count']);
function ruleDto(row: Json) { return { ...JSON.parse(row.config_json), id: row.id, control_version: row.control_version, created_at: new Date(row.created_at_ms).toISOString(), updated_at: new Date(row.updated_at_ms).toISOString(), last_triggered_at: row.last_triggered_at_ms ? new Date(row.last_triggered_at_ms).toISOString() : null, last_evaluation_error: row.last_error }; }
function parseRule(body: Json): Json {
    const name = text(body.name, 200, 'rule name').trim();
    if (!name)
        invalid('Rule name is required');
    if (!supportedMetrics.has(body.metric_type))
        throw new GatewayError(422, 'metric_source_unavailable', 'This metric has no complete Worker source; choose request success/error rates or account health metrics');
    if (!['>', '>=', '<', '<=', '==', '!='].includes(body.operator))
        invalid('Invalid comparison operator');
    if (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold) || body.threshold < 0 || (body.metric_type.endsWith('rate') || body.metric_type.endsWith('ratio') ? body.threshold > 100 : body.threshold > 1000000))
        invalid('Invalid metric threshold (rates use percent)');
    if (!(body.severity in severityRank))
        invalid('Invalid severity');
    const filters = obj(body.filters ?? {});
    if (body.metric_type.startsWith('group_') && !filters.group_id)
        invalid('Group metrics require a group ID');
    for (const key of Object.keys(filters))
        if (!['platform', 'group_id'].includes(key))
            invalid('Unsupported filter: ' + key);
    for (const key of ['platform', 'group_id'])
        if (filters[key] != null && (typeof filters[key] !== 'string' && typeof filters[key] !== 'number' || String(filters[key]).length > 128))
            invalid('Invalid filter');
    return { name, description: text(body.description ?? '', 2000, 'description'), enabled: boolean(body.enabled, 'enabled'), metric_type: body.metric_type, operator: body.operator, threshold: body.threshold, window_minutes: integer(body.window_minutes, 1, 1440, 'Window minutes'), sustained_minutes: integer(body.sustained_minutes, 0, 1440, 'Sustained minutes'), severity: body.severity, cooldown_minutes: integer(body.cooldown_minutes, 0, 10080, 'Cooldown minutes'), notify_email: boolean(body.notify_email, 'notify email'), filters };
}
export const listOpsAlertRules = (c: C) => reply(async () => (await c.env.DB.prepare('SELECT * FROM ops_alert_rules ORDER BY id LIMIT 100').all<Json>()).results.map(ruleDto));
export const createOpsAlertRule = (c: C) => reply(async () => {
    const next = parseRule(await readJsonObject(c.req.raw)), now = Date.now();
    const row = await c.env.DB.prepare('INSERT INTO ops_alert_rules(config_json,created_at_ms,updated_at_ms) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM ops_alert_rules)<100 RETURNING *').bind(JSON.stringify(next), now, now).first<Json>();
    if (!row)
        throw new GatewayError(409, 'alert_rule_limit', 'At most 100 alert rules are supported');
    return ruleDto(row);
});
export const updateOpsAlertRule = (c: C) => reply(async () => {
    const body = await readJsonObject(c.req.raw), current = await c.env.DB.prepare('SELECT * FROM ops_alert_rules WHERE id=?').bind(c.req.param('id')).first<Json>();
    if (!current)
        throw new GatewayError(404, 'alert_rule_not_found', 'Alert rule not found');
    const expected = requireExpectedControlVersion(c.req.raw, { ...body, expected_control_version: body.expected_control_version ?? body.control_version }), next = parseRule({ ...JSON.parse(current.config_json), ...body });
    const row = await c.env.DB.prepare('UPDATE ops_alert_rules SET config_json=?,control_version=control_version+1,updated_at_ms=?,breach_since_ms=NULL,last_evaluated_at_ms=0 WHERE id=? AND control_version=? RETURNING *').bind(JSON.stringify(next), Date.now(), current.id, expected).first<Json>();
    if (!row)
        throw new GatewayError(412, 'control_version_conflict', 'Alert rule changed');
    return ruleDto(row);
});
export const deleteOpsAlertRule = (c: C) => reply(async () => {
    await c.env.DB.batch([c.env.DB.prepare("UPDATE ops_alert_events SET status='manual_resolved',resolved_at_ms=? WHERE rule_id=? AND status='firing'").bind(Date.now(), c.req.param('id')), c.env.DB.prepare('DELETE FROM ops_alert_rules WHERE id=?').bind(c.req.param('id'))]);
    return { deleted: true };
});
function eventDto(row: Json) { return { id: row.id, rule_id: row.rule_id, severity: row.severity, status: row.status, title: row.title, description: row.description, metric_value: row.metric_value, threshold_value: row.threshold_value, dimensions: JSON.parse(row.dimensions_json), fired_at: new Date(row.fired_at_ms).toISOString(), created_at: new Date(row.fired_at_ms).toISOString(), resolved_at: row.resolved_at_ms ? new Date(row.resolved_at_ms).toISOString() : null, email_sent: !!row.email_sent }; }
export const listOpsAlertEvents = (c: C) => reply(async () => {
    const where = ['1=1'], values: unknown[] = [];
    for (const key of ['status', 'severity'])
        if (c.req.query(key)) {
            where.push(key + '=?');
            values.push(c.req.query(key));
        }
    for (const key of ['platform', 'group_id'])
        if (c.req.query(key)) {
            where.push(`CAST(json_extract(dimensions_json,'$.${key}') AS TEXT)=?`);
            values.push(c.req.query(key));
        }
    if (c.req.query('email_sent') !== undefined) {
        where.push('email_sent=?');
        values.push(c.req.query('email_sent') === 'true' ? 1 : 0);
    }
    const ranges: Json = { '5m': 300000, '30m': 1800000, '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    if (c.req.query('time_range')) {
        const duration = ranges[c.req.query('time_range')!];
        if (!duration)
            invalid('Invalid time range');
        where.push('fired_at_ms>=?');
        values.push(Date.now() - duration);
    }
    for (const [param, op] of [['start_time', '>='], ['end_time', '<=']] as const)
        if (c.req.query(param)) {
            const value = Date.parse(c.req.query(param)!);
            if (!Number.isFinite(value))
                invalid('Invalid event date');
            where.push('fired_at_ms' + op + '?');
            values.push(value);
        }
    if (c.req.query('before_fired_at')) {
        const at = Date.parse(c.req.query('before_fired_at')!);
        if (!Number.isFinite(at))
            invalid('Invalid event cursor');
        where.push('(fired_at_ms<? OR (fired_at_ms=? AND id<?))');
        values.push(at, at, Number(c.req.query('before_id') ?? Number.MAX_SAFE_INTEGER));
    }
    const limit = integer(Number(c.req.query('limit') ?? 50), 1, 200, 'limit');
    return (await c.env.DB.prepare('SELECT * FROM ops_alert_events WHERE ' + where.join(' AND ') + ' ORDER BY fired_at_ms DESC,id DESC LIMIT ?').bind(...values, limit).all<Json>()).results.map(eventDto);
});
export const getOpsAlertEvent = (c: C) => reply(async () => { const row = await c.env.DB.prepare('SELECT * FROM ops_alert_events WHERE id=?').bind(c.req.param('id')).first<Json>(); if (!row)
    throw new GatewayError(404, 'alert_event_not_found', 'Alert event not found'); return eventDto(row); });
export const updateOpsAlertEventStatus = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw); if (!['resolved', 'manual_resolved'].includes(String(body.status)))
    invalid('Invalid resolved status'); await c.env.DB.prepare("UPDATE ops_alert_events SET status=?,resolved_at_ms=? WHERE id=? AND status='firing'").bind(body.status, Date.now(), c.req.param('id')).run(); return { resolved: true }; });
export const createOpsAlertSilence = (c: C) => reply(async () => {
    const body = await readJsonObject(c.req.raw), until = Date.parse(String(body.until));
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 30 * 86400000)
        invalid('Silence expiry must be within 30 days');
    if (body.region)
        invalid('Worker observations do not provide a reliable region dimension');
    const ruleId = integer(body.rule_id, 1, Number.MAX_SAFE_INTEGER, 'rule id');
    const rule = await c.env.DB.prepare('SELECT id FROM ops_alert_rules WHERE id=?').bind(ruleId).first();
    if (!rule)
        throw new GatewayError(404, 'alert_rule_not_found', 'Alert rule not found');
    await c.env.DB.prepare('INSERT INTO ops_alert_silences(rule_id,platform,group_id,until_ms,reason) VALUES(?,?,?,?,?)').bind(ruleId, text(body.platform ?? '', 64, 'platform'), String(body.group_id ?? ''), until, text(body.reason ?? '', 2000, 'reason')).run();
    return { silenced: true };
});
function compare(value: number, operator: string, threshold: number) { switch (operator) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    default: return value !== threshold;
} }
function runtimeSilenced(runtime: Json, rule: Json, now: number) { const s = runtime.silencing; if (!s.enabled)
    return false; if (Date.parse(s.global_until_rfc3339) > now)
    return true; return s.entries.some((e: Json) => Date.parse(e.until_rfc3339) > now && (e.rule_id === undefined || e.rule_id === rule.id) && (!e.severities?.length || e.severities.includes(rule.severity))); }
async function observationSummary(env: Env, since: number, now: number, filters: Json = {}) {
    const advanced = await readOpsAdvanced(env);
    const ignored = `( (?=1 AND request_path LIKE '%/count_tokens') OR (?=1 AND lifecycle='cancelled') OR (?=1 AND (error_type LIKE '%account%unavailable%' OR error_type IN('pool_exhausted','no_available_accounts'))) OR (?=1 AND error_type IN('invalid_api_key','api_key_required')) OR (?=1 AND error_type LIKE '%insufficient_balance%') )`;
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN lifecycle='completed' AND COALESCE(status_code,200)<400 THEN 1 ELSE 0 END) AS success,SUM(CASE WHEN (lifecycle IN('failed','cancelled') OR status_code>=400) AND is_business_limited=0 AND NOT ${ignored} THEN 1 ELSE 0 END) AS errors,SUM(CASE WHEN upstream_status_code>=400 AND upstream_status_code NOT IN(429,529) THEN 1 ELSE 0 END) AS upstream,SUM(input_tokens+output_tokens) AS tokens FROM request_observations WHERE occurred_at_ms BETWEEN ? AND ? AND (?='' OR platform=?) AND (?='' OR group_id=?)`).bind(Number(advanced.ignore_count_tokens_errors), Number(advanced.ignore_context_canceled), Number(advanced.ignore_no_available_accounts), Number(advanced.ignore_invalid_api_key_errors), Number(advanced.ignore_insufficient_balance_errors), since, now, String(filters.platform ?? ''), String(filters.platform ?? ''), String(filters.group_id ?? ''), String(filters.group_id ?? '')).first<Json>();
    return { total: Number(row?.total ?? 0), success: Number(row?.success ?? 0), errors: Number(row?.errors ?? 0), upstream: Number(row?.upstream ?? 0), tokens: Number(row?.tokens ?? 0) };
}
async function metric(env: Env, rule: Json, now: number): Promise<number | null> {
    if (['concurrency_queue_depth', 'group_available_accounts', 'group_available_ratio', 'overload_account_count'].includes(rule.metric_type)) {
        const f = rule.filters ?? {}, registry = await env.DB.prepare(`SELECT r.* FROM pool_state_registry r JOIN "groups" g ON g.id=r.group_id WHERE (?='' OR g.platform=?) AND (?='' OR r.group_id=?) LIMIT 21`).bind(String(f.platform ?? ''), String(f.platform ?? ''), String(f.group_id ?? ''), String(f.group_id ?? '')).all<{
            group_id: string;
            model_id: string;
            endpoint: GatewayEndpoint;
        }>();
        if (!registry.results.length || registry.results.length > 20)
            return null;
        const snapshots = await Promise.all(registry.results.map(async (entry) => { try {
            const response = await env.POOL_STATE.get(env.POOL_STATE.idFromName(poolStateName(entry.group_id, entry.model_id, entry.endpoint))).fetch('https://state.internal/snapshot', { signal: AbortSignal.timeout(5000) });
            return response.ok ? await response.json() as Json : null;
        }
        catch {
            return null;
        } }));
        if (snapshots.some(s => !s || !Array.isArray(s.accounts) || !Array.isArray(s.waiting)))
            return null;
        const waiting = new Set<string>(), accounts = new Map<string, Json>();
        for (const snapshot of snapshots) {
            for (const entry of snapshot!.waiting)
                waiting.add(entry.request_id);
            for (const entry of snapshot!.accounts) {
                const current = accounts.get(entry.account_id) ?? { ...entry, active_leases: 0 };
                current.active_leases += entry.active_leases;
                current.enabled &&= entry.enabled;
                current.cooldown_until_ms = Math.max(current.cooldown_until_ms, entry.cooldown_until_ms);
                accounts.set(entry.account_id, current);
            }
        }
        if (rule.metric_type === 'concurrency_queue_depth')
            return waiting.size;
        const entries = [...accounts.values()];
        if (!entries.length)
            return null;
        if (rule.metric_type === 'overload_account_count')
            return entries.filter(a => a.enabled && a.active_leases >= a.max_concurrency).length;
        const available = entries.filter(a => a.enabled && a.cooldown_until_ms <= now).length;
        return rule.metric_type === 'group_available_accounts' ? available : available * 100 / entries.length;
    }
    if (rule.metric_type.startsWith('account_')) {
        const f = rule.filters ?? {}, row = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN health_status='unhealthy' THEN 1 ELSE 0 END) AS errors FROM accounts a WHERE enabled=1 AND (?='' OR platform=?) AND (?='' OR EXISTS(SELECT 1 FROM account_groups ag WHERE ag.account_id=a.id AND ag.group_id=?))`).bind(String(f.platform ?? ''), String(f.platform ?? ''), String(f.group_id ?? ''), String(f.group_id ?? '')).first<Json>();
        if (!row?.total)
            return null;
        return rule.metric_type === 'account_error_count' ? Number(row.errors ?? 0) : Number(row.errors ?? 0) * 100 / row.total;
    }
    const summary = await observationSummary(env, now - rule.window_minutes * 60000, now, rule.filters);
    const total = summary.success + summary.errors;
    if (!total)
        return null;
    return 100 * (rule.metric_type === 'success_rate' ? summary.success : rule.metric_type === 'error_rate' ? summary.errors : summary.upstream) / total;
}
async function enqueue(env: Env, id: string, eventId: number | null, category: string, recipients: string[], payload: Json, due: number, now: number) {
    const entries = await Promise.all(recipients.map(async (recipient) => ({ id: await deterministicUuid('ops-alert-email', `${id}:${recipient}`), recipient })));
    await env.DB.prepare(`INSERT INTO ops_alert_outbox(id,event_id,category,recipient,payload_json,due_at_ms,created_at_ms) SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.recipient'),?,?,? FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING`).bind(eventId, category, JSON.stringify(payload), due, now, JSON.stringify(entries)).run();
}
async function notifyEvent(env: Env, email: Json, event: Json, rule: Json, now: number) {
    if (rule.notify_email && email.alert.enabled && severityRank[rule.severity] >= (severityRank[email.alert.min_severity] ?? 0) && (event.status === 'firing' || email.alert.include_resolved_alerts)) {
        await enqueue(env, `event:${event.id}:${event.status}`, event.id, 'alert', email.alert.recipients, { title: `${event.status}: ${rule.name}`, text: `${rule.name}\n${rule.description}\n${rule.metric_type}: ${event.metric_value} ${rule.operator} ${rule.threshold}\nStatus: ${event.status}`, status: event.status, severity: rule.severity, rule_id: rule.id }, now + email.alert.batching_window_seconds * 1000, now);
    }
    await env.DB.prepare('UPDATE ops_alert_events SET notification_state=? WHERE id=? AND status=?').bind(event.status, event.id, event.status).run();
}
/** Separate maintenance message; one due rule, four report definitions and one delivery per run. */
export async function runOpsAlerts(env: Env, now = Date.now(), scheduledAt = now) {
    if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0 || scheduledAt > now + 60000) throw new Error("Invalid alert schedule timestamp");
    if (!(await readOpsFeatures(env)).ops_monitoring_enabled)
        return { skipped: true };
    const runtime = await config(env, 'runtime', opsAlertRuntimeDefaults), email = await config(env, 'email', opsEmailDefaults), owner = crypto.randomUUID();
    // This fixed safety lease also protects outbox delivery when optional evaluation locking is disabled.
    const lease = await env.DB.prepare(`INSERT INTO ops_alert_lease(id,owner,expires_at_ms) VALUES('worker-alert-safety',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at_ms=excluded.expires_at_ms WHERE ops_alert_lease.expires_at_ms<=? RETURNING id`).bind(owner, now + Math.max(120, runtime.distributed_lock.ttl_seconds) * 1000, now).first();
    if (!lease)
        return { skipped: true };
    const lockKey = runtime.distributed_lock.enabled ? 'evaluation:' + runtime.distributed_lock.key : null;
    let evaluationAllowed = true;
    if (lockKey)
        evaluationAllowed = !!await env.DB.prepare(`INSERT INTO ops_alert_lease(id,owner,expires_at_ms) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at_ms=excluded.expires_at_ms WHERE ops_alert_lease.expires_at_ms<=? RETURNING id`).bind(lockKey, owner, now + runtime.distributed_lock.ttl_seconds * 1000, now).first();
    try {
        const recover = (await env.DB.prepare('SELECT e.*,r.config_json FROM ops_alert_events e JOIN ops_alert_rules r ON r.id=e.rule_id WHERE e.notification_state<>e.status ORDER BY e.id LIMIT 2').all<Json>()).results;
        for (const event of recover)
            await notifyEvent(env, email, event, { ...JSON.parse(event.config_json), id: event.rule_id }, now);
        const rules = evaluationAllowed ? (await env.DB.prepare('SELECT * FROM ops_alert_rules WHERE last_evaluated_at_ms<=? ORDER BY last_evaluated_at_ms,id LIMIT 1').bind(now - runtime.evaluation_interval_seconds * 1000).all<Json>()).results : [];
        for (const row of rules) {
            const rule = { ...JSON.parse(row.config_json), id: row.id }, value = rule.enabled ? await metric(env, rule, now) : null;
            const breached = value !== null && compare(value, rule.operator, rule.threshold), since = breached ? row.breach_since_ms ?? now : null;
            const updated = await env.DB.prepare('UPDATE ops_alert_rules SET last_evaluated_at_ms=?,breach_since_ms=?,last_value=?,last_error=? WHERE id=? AND control_version=?').bind(now, since, value, rule.enabled && value === null ? 'no_metric_samples' : '', row.id, row.control_version).run();
            if (!updated.meta.changes)
                continue;
            if (value === null && rule.enabled)
                continue;
            const existing = await env.DB.prepare("SELECT * FROM ops_alert_events WHERE rule_id=? AND status='firing'").bind(row.id).first<Json>();
            if (!breached && existing) {
                const updated = await env.DB.prepare("UPDATE ops_alert_events SET status='resolved',resolved_at_ms=? WHERE id=? AND status='firing' RETURNING *").bind(now, existing.id).first<Json>();
                if (updated)
                    await notifyEvent(env, email, updated, rule, now);
            }
            else if (breached && !existing && now - since >= rule.sustained_minutes * 60000 && (!row.last_triggered_at_ms || now - row.last_triggered_at_ms >= rule.cooldown_minutes * 60000)) {
                const silenced = runtimeSilenced(runtime, rule, now) || await env.DB.prepare("SELECT id FROM ops_alert_silences WHERE rule_id=? AND until_ms>? AND (platform='' OR platform=?) AND (group_id='' OR group_id=?) LIMIT 1").bind(rule.id, now, String(rule.filters?.platform ?? ''), String(rule.filters?.group_id ?? '')).first();
                if (silenced)
                    continue;
                // CAS rechecks the rule after asynchronous metric collection; disabled/edited rules cannot fire from stale data.
                const event = await env.DB.prepare(`INSERT INTO ops_alert_events(rule_id,severity,status,title,description,metric_value,threshold_value,dimensions_json,fired_at_ms) SELECT ?,?,'firing',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ops_alert_rules WHERE id=? AND control_version=?) ON CONFLICT DO NOTHING RETURNING *`).bind(rule.id, rule.severity, rule.name, rule.description, value, rule.threshold, JSON.stringify(rule.filters), now, rule.id, row.control_version).first<Json>();
                if (event) {
                    await env.DB.prepare('UPDATE ops_alert_rules SET last_triggered_at_ms=? WHERE id=?').bind(now, rule.id).run();
                    await notifyEvent(env, email, event, rule, now);
                }
            }
        }
        await enqueueReports(env, email, now, scheduledAt);
        if ((await readOpsFeatures(env)).ops_monitoring_enabled)
            await deliverPending(env, await config(env, 'email', opsEmailDefaults), await config(env, 'runtime', opsAlertRuntimeDefaults), now);
        const more = evaluationAllowed && !!await env.DB.prepare('SELECT id FROM ops_alert_rules WHERE last_evaluated_at_ms<=? LIMIT 1').bind(now - runtime.evaluation_interval_seconds * 1000).first();
        return { evaluated: rules.length, has_more_due_rules: more };
    }
    finally {
        await env.DB.prepare('DELETE FROM ops_alert_lease WHERE owner=?').bind(owner).run();
    }
}
async function enqueueReports(env: Env, email: Json, now: number, scheduledAt: number) {
    const report = email.report;
    if (!report.enabled)
        return;
    for (const kind of ['daily_summary', 'weekly_summary', 'error_digest', 'account_health']) {
        if (!report[kind + '_enabled'] || !cronMatches(report[kind + '_schedule'], scheduledAt))
            continue;
        const summary = await observationSummary(env, scheduledAt - (kind === 'weekly_summary' ? 7 : kind === 'error_digest' ? 1 / 24 : 1) * 86400000, scheduledAt);
        if (kind === 'error_digest' && summary.errors < report.error_digest_min_count)
            continue;
        let body = JSON.stringify(summary);
        if (kind === 'account_health') {
            const rows = await env.DB.prepare(`SELECT account_id,COUNT(*) AS requests,SUM(CASE WHEN lifecycle IN('failed','cancelled') OR status_code>=400 THEN 1 ELSE 0 END)*100.0/COUNT(*) AS error_rate FROM request_observations WHERE occurred_at_ms BETWEEN ? AND ? AND account_id IS NOT NULL GROUP BY account_id HAVING error_rate>=? ORDER BY error_rate DESC LIMIT 100`).bind(scheduledAt - 86400000, scheduledAt, report.account_health_error_rate_threshold).all();
            body = JSON.stringify(rows.results);
        }
        await enqueue(env, `report:${kind}:${Math.floor(scheduledAt / 60000)}`, null, 'report', report.recipients, { title: `Sub2API ${kind}`, text: body, kind }, now, now);
    }
}
function escapeHTML(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
async function deliverPending(env: Env, email: Json, runtime: Json, now: number) {
    const pending = await env.DB.prepare('SELECT recipient,category,delivery_batch_id FROM ops_alert_outbox WHERE sent_at_ms IS NULL AND due_at_ms<=? ORDER BY due_at_ms,id LIMIT 1').bind(now).first<Json>();
    if (!pending)
        return;
    const rows = (await env.DB.prepare(`SELECT o.*,r.config_json AS rule_json,e.status AS event_status,
    EXISTS(SELECT 1 FROM ops_alert_silences s WHERE s.rule_id=e.rule_id AND s.until_ms>? AND (s.platform='' OR s.platform=COALESCE(json_extract(r.config_json,'$.filters.platform'),'')) AND (s.group_id='' OR s.group_id=COALESCE(CAST(json_extract(r.config_json,'$.filters.group_id') AS TEXT),''))) AS silenced
    FROM ops_alert_outbox o LEFT JOIN ops_alert_events e ON e.id=o.event_id LEFT JOIN ops_alert_rules r ON r.id=e.rule_id
    WHERE o.sent_at_ms IS NULL AND o.due_at_ms<=? AND o.recipient=? AND o.category=? AND ((? IS NULL AND o.delivery_batch_id IS NULL) OR o.delivery_batch_id=?) ORDER BY o.due_at_ms,o.id LIMIT 20`).bind(now, now, pending.recipient, pending.category, pending.delivery_batch_id, pending.delivery_batch_id).all<Json>()).results;
    const policy = email[pending.category], allowed: Json[] = [], cancelled: string[] = [];
    for (const row of rows) {
        const payload = JSON.parse(row.payload_json), rule = row.rule_json ? { ...JSON.parse(row.rule_json), id: payload.rule_id } : null;
        const accept = policy.enabled && policy.recipients.includes(row.recipient) && (row.category === 'report' ? !!policy[payload.kind + '_enabled'] : !!rule && rule.enabled && rule.notify_email && !row.silenced && !runtimeSilenced(runtime, rule, now) && row.event_status === payload.status && (payload.status === 'firing' || policy.include_resolved_alerts) && severityRank[payload.severity] >= (severityRank[policy.min_severity] ?? 0));
        if (accept)
            allowed.push({ ...row, payload });
        else
            cancelled.push(row.id);
    }
    if (cancelled.length)
        await env.DB.prepare("UPDATE ops_alert_outbox SET sent_at_ms=?,last_error='cancelled_by_current_policy' WHERE id IN(SELECT value FROM json_each(?))").bind(now, JSON.stringify(cancelled)).run();
    if (!allowed.length)
        return;
    const ids = JSON.stringify(allowed.map(row => row.id));
    if (pending.category === 'alert') {
        const sent = await env.DB.prepare("SELECT COUNT(DISTINCT delivery_batch_id) AS count FROM ops_alert_outbox WHERE category='alert' AND sent_at_ms>? AND last_error=''").bind(now - 3600000).first<{
            count: number;
        }>();
        if ((sent?.count ?? 0) >= policy.rate_limit_per_hour) {
            await env.DB.prepare('UPDATE ops_alert_outbox SET due_at_ms=? WHERE id IN(SELECT value FROM json_each(?))').bind(now + 60000, ids).run();
            return;
        }
    }
    const batchId = pending.delivery_batch_id ?? await deterministicUuid('ops-email-batch', allowed.map(row => row.id).sort().join(':')), title = allowed.length === 1 ? allowed[0].payload.title : `Sub2API: ${allowed.length} ${pending.category} notifications`, body = allowed.map(row => row.payload.title + '\n' + row.payload.text).join('\n\n'), html = `<pre>${escapeHTML(body)}</pre>`;
    await env.DB.prepare('UPDATE ops_alert_outbox SET delivery_batch_id=? WHERE id IN(SELECT value FROM json_each(?))').bind(batchId, ids).run();
    try {
        await deliverPlatformEmail({ eventId: batchId, recipient: pending.recipient, subject: title, text: body, html, compatibilityPayload: { purpose: 'ops_notification', event_id: batchId, recipient: pending.recipient, subject: title, text: body, html } }, env);
        await env.DB.prepare("UPDATE ops_alert_outbox SET sent_at_ms=?,attempts=attempts+1,last_error='',delivery_batch_id=? WHERE id IN(SELECT value FROM json_each(?))").bind(now, batchId, ids).run();
        const events = allowed.flatMap(row => row.event_id ? [row.event_id] : []);
        if (events.length)
            await env.DB.prepare('UPDATE ops_alert_events SET email_sent=1 WHERE id IN(SELECT value FROM json_each(?))').bind(JSON.stringify(events)).run();
    }
    catch (error) {
        const failure = emailDeliveryFailure(error), attempts = Math.max(...allowed.map(row => row.attempts));
        await env.DB.prepare('UPDATE ops_alert_outbox SET attempts=attempts+1,last_error=?,due_at_ms=?,sent_at_ms=? WHERE id IN(SELECT value FROM json_each(?))').bind(failure.code, now + Math.min(3600000, 60000 * 2 ** Math.min(attempts, 6)), failure.retryable ? null : now, ids).run();
    }
}

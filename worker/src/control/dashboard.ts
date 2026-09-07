import type { Context } from 'hono';
import type { Env } from '../env';
import { adminUsageClauses } from '../observability/handlers';
import { authenticateAdminSession } from './admin-auth';
import { controlError, controlSuccess, queryInteger, readJsonObject, requireResourceId } from './http';
import { addCalendarDays, calendarDayBoundaries, parseTimezone, zonedDayStart } from '../gateway/info';
import { asGatewayError, GatewayError } from '../gateway/errors';
type Bindings = {
    Bindings: Env;
};
type Kind = 'snapshot-v2' | 'stats' | 'trend' | 'groups' | 'users-trend' | 'users-ranking' | 'api-keys-trend' | 'user-breakdown';
const DAY = 86400000;
const startedAt = Date.now();
const aggregate = `COUNT(*) requests, COALESCE(SUM(u.input_tokens),0) input_tokens,
  COALESCE(SUM(u.output_tokens),0) output_tokens, COALESCE(SUM(u.cache_read_tokens),0) cache_read_tokens,
  COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens),0) total_tokens,
  COALESCE(SUM(COALESCE(u.standard_cost_micros,u.amount_micros)),0)/1000000.0 cost,
  COALESCE(SUM(u.amount_micros),0)/1000000.0 actual_cost,
  COALESCE(SUM(COALESCE(u.account_cost_micros,u.account_stats_cost_micros,u.amount_micros)),0)/1000000.0 account_cost`;
export function adminDashboard(kind: Kind) {
    return async (context: Context<Bindings>): Promise<Response> => {
        try {
            await authenticateAdminSession(context.req.raw, context.env);
            const filter = adminUsageClauses(context);
            const modelExpressions: Record<string, string> = {
                requested: "COALESCE(NULLIF(u.requested_model,''),u.model)",
                upstream: "COALESCE(NULLIF(u.upstream_model,''),NULLIF(u.requested_model,''),u.model)",
                mapping: "(COALESCE(NULLIF(u.requested_model,''),u.model) || ' -> ' || COALESCE(NULLIF(u.upstream_model,''),NULLIF(u.requested_model,''),u.model))",
            };
            const source = context.req.query('model_source') || 'requested';
            if (!Object.hasOwn(modelExpressions, source))
                throw new GatewayError(400, 'invalid_model_source', 'model_source must be requested, upstream, or mapping');
            const modelExpression = modelExpressions[source]!;
            if (context.req.query('model'))
                filter.clauses = filter.clauses.map(clause => clause === 'COALESCE(u.requested_model,u.model) = ?' ? `${modelExpression} = ?` : clause);
            const endpoint = context.req.query('endpoint');
            if (endpoint) {
                const type = context.req.query('endpoint_type') ?? 'inbound';
                if (!['inbound', 'upstream'].includes(type))
                    throw new GatewayError(400, 'unsupported_endpoint_type', 'Only inbound and upstream endpoint evidence is retained in billing projection');
                filter.clauses.push(`u.${type}_endpoint = ?`);
                filter.values.push(endpoint);
            }
            const timezone = parseTimezone(context.req.query('timezone'));
            const endDate = context.req.query('end_date') ?? dateLabel(Date.now(), 'day', timezone);
            const startDate = context.req.query('start_date') ?? addCalendarDays(endDate, -30);
            if (!context.req.query('start_date')) {
                filter.clauses.push('u.occurred_at_ms >= ?');
                filter.values.push(zonedDayStart(startDate, timezone));
            }
            if (!context.req.query('end_date')) {
                filter.clauses.push('u.occurred_at_ms < ?');
                filter.values.push(zonedDayStart(addCalendarDays(endDate, 1), timezone));
            }
            if (Date.parse(endDate) - Date.parse(startDate) > 366 * DAY)
                throw new GatewayError(400, 'invalid_date_range', 'Dashboard range must not exceed 366 days');
            const where = filter.clauses.length ? filter.clauses.join(' AND ') : '1=1';
            const granularity = context.req.query('granularity') ?? 'day';
            if (!['day', 'hour'].includes(granularity))
                throw new GatewayError(400, 'invalid_granularity', 'granularity must be day or hour');
            const interval = granularity === 'hour' ? 3600000 : DAY;
            const bucket = bucketExpression(context, timezone, interval);
            const limit = queryInteger(context.req.query('limit') ?? context.req.query('users_trend_limit'), 'limit', 10, 1, 100);
            const metadata = { start_date: startDate, end_date: endDate, granularity };
            const rows = async (select: string, join = '', suffix = '') => (await context.env.DB.prepare(`SELECT ${select}, ${aggregate} FROM usage_projection u ${join} WHERE ${where} ${suffix}`).bind(...filter.values).all<any>()).results.map(row => ({ ...row, cache_creation_tokens: 0 }));
            const trend = async () => (await rows(`${bucket} bucket`, '', `GROUP BY bucket ORDER BY bucket`)).map(row => ({ ...row, date: dateLabel(row.bucket, granularity, timezone) }));
            const models = () => rows(`${modelExpression} model`, '', `GROUP BY ${modelExpression} ORDER BY total_tokens DESC LIMIT 500`);
            const groups = () => rows(`u.group_id, COALESCE(g.name,'') group_name`, 'LEFT JOIN "groups" g ON g.id=u.group_id', 'GROUP BY u.group_id,g.name ORDER BY actual_cost DESC LIMIT 100');
            const identityTrend = async (key: boolean) => {
                const column = key ? 'api_key_id' : 'user_id';
                const names = key ? "COALESCE(i.name,'') key_name" : "COALESCE(i.email,'') email, COALESCE(i.display_name,'') username";
                const result = await context.env.DB.prepare(`WITH selected AS (
          SELECT u.${column} id FROM usage_projection u WHERE ${where} AND u.${column} IS NOT NULL
          GROUP BY u.${column} ORDER BY SUM(u.amount_micros) DESC,u.${column} LIMIT ?
        ) SELECT ${bucket} bucket,u.${column},${names},${aggregate}
          FROM usage_projection u LEFT JOIN ${key ? 'api_keys' : 'users'} i ON i.id=u.${column}
          WHERE ${where} AND u.${column} IN (SELECT id FROM selected)
          GROUP BY bucket,u.${column} ORDER BY bucket,u.${column}`).bind(...filter.values, limit, ...filter.values).all<any>();
                return result.results.map(row => ({ ...row, tokens: row.total_tokens, date: dateLabel(row.bucket, granularity, timezone) }));
            };
            if (kind === 'stats')
                return controlSuccess(await stats(context));
            if (kind === 'trend')
                return controlSuccess({ ...metadata, trend: await trend() });
            if (kind === 'groups')
                return controlSuccess({ ...metadata, groups: await groups() });
            if (kind === 'users-trend' || kind === 'api-keys-trend')
                return controlSuccess({ ...metadata, trend: await identityTrend(kind === 'api-keys-trend') });
            if (kind === 'users-ranking' || kind === 'user-breakdown') {
                const allowed = ['total_tokens', 'input_tokens', 'output_tokens', 'cache_tokens', 'requests', 'cost', 'actual_cost'];
                const sort = context.req.query('sort_by') ?? 'actual_cost';
                const ranking = (await rows(`u.user_id,COALESCE(i.email,'') email,COALESCE(i.display_name,'') username,SUM(u.cache_read_tokens) cache_tokens`, 'LEFT JOIN users i ON i.id=u.user_id', `GROUP BY u.user_id ORDER BY ${allowed.includes(sort) ? sort : 'actual_cost'} DESC,u.user_id LIMIT ${limit}`)).map(row => ({ ...row, tokens: row.total_tokens }));
                if (kind === 'user-breakdown')
                    return controlSuccess({ ...metadata, users: ranking });
                const totals = await rows('1 marker');
                return controlSuccess({ ...metadata, ranking, total_actual_cost: totals[0].actual_cost, total_requests: totals[0].requests, total_tokens: totals[0].total_tokens });
            }
            const result: Record<string, unknown> = { ...metadata, generated_at: new Date().toISOString() };
            const tasks: Promise<void>[] = [];
            for (const [flag, name, load] of [
                ['include_stats', 'stats', () => stats(context)], ['include_trend', 'trend', trend],
                ['include_model_stats', 'models', models], ['include_group_stats', 'groups', groups],
                ['include_users_trend', 'users_trend', () => identityTrend(false)],
            ] as const) {
                const value = context.req.query(flag);
                if (value !== undefined && !['true', 'false'].includes(value))
                    throw new GatewayError(400, `invalid_${flag}`, `${flag} must be true or false`);
                if (value !== 'false')
                    tasks.push(load().then(data => { result[name] = data; }));
            }
            await Promise.all(tasks);
            return controlSuccess(result);
        }
        catch (error) {
            return controlError(asGatewayError(error));
        }
    };
}
function dateLabel(bucket: number, granularity: string, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(bucket);
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return `${part('year')}-${part('month')}-${part('day')}` + (granularity === 'hour' ? ` ${part('hour')}:00` : '');
}
function bucketExpression(context: Context<Bindings>, timezone: string, interval: number) {
    if (timezone === 'UTC')
        return `CAST(u.occurred_at_ms / ${interval} AS INTEGER) * ${interval}`;
    const end = context.req.query('end_date') ?? dateLabel(Date.now(), 'day', timezone);
    const start = context.req.query('start_date') ?? addCalendarDays(end, -30);
    const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
    if (days < 1 || days > 367)
        throw new GatewayError(400, 'invalid_date_range', 'Dashboard range must not exceed 366 days');
    // Calendar boundaries, rather than fixed UTC offsets, preserve DST day lengths.
    const cases: string[] = [];
    for (let index = 0; index < days; index++) {
        const day = addCalendarDays(start, index), from = zonedDayStart(day, timezone), to = zonedDayStart(addCalendarDays(day, 1), timezone);
        const value = interval === DAY ? String(from) : `${from} + CAST((u.occurred_at_ms-${from})/${interval} AS INTEGER)*${interval}`;
        cases.push(`WHEN u.occurred_at_ms>=${from} AND u.occurred_at_ms<${to} THEN ${value}`);
    }
    return `(CASE ${cases.join(' ')} ELSE CAST(u.occurred_at_ms/${interval} AS INTEGER)*${interval} END)`;
}
async function stats(context: Context<Bindings>) {
    const now = Date.now(), today = calendarDayBoundaries(now, parseTimezone(context.req.query('timezone'))).today, hour = Math.floor(now / 3600000) * 3600000;
    const db = context.env.DB;
    const results = await db.batch([
        db.prepare(`SELECT COUNT(*) total_users,COUNT(CASE WHEN created_at_ms>=? THEN 1 END) today_new_users FROM users`).bind(today),
        db.prepare(`SELECT COUNT(*) total_api_keys,COUNT(CASE WHEN enabled=1 AND (expires_at_ms IS NULL OR expires_at_ms>?) THEN 1 END) active_api_keys FROM api_keys WHERE revoked_at_ms IS NULL`).bind(now),
        db.prepare(`SELECT COUNT(*) total_accounts,COUNT(CASE WHEN enabled=1 AND health_status<>'unhealthy' THEN 1 END) normal_accounts,COUNT(CASE WHEN health_status='unhealthy' THEN 1 END) error_accounts FROM accounts`),
        db.prepare(`SELECT ${aggregate},COALESCE(AVG(u.duration_ms),0) average_duration_ms FROM usage_projection u`),
        db.prepare(`SELECT ${aggregate},COUNT(DISTINCT u.user_id) active_users,COUNT(DISTINCT CASE WHEN u.occurred_at_ms>=? THEN u.user_id END) hourly_active_users FROM usage_projection u WHERE u.occurred_at_ms>=?`).bind(hour, today),
        db.prepare(`SELECT ${aggregate} FROM usage_projection u WHERE u.occurred_at_ms>=?`).bind(now - 300000),
    ]);
    const [users, keys, accounts, total, daily, recent] = results.map(result => (result.results[0] ?? {}) as any);
    const usage = (row: any, prefix: string) => ({
        [`${prefix}_requests`]: row.requests, [`${prefix}_input_tokens`]: row.input_tokens, [`${prefix}_output_tokens`]: row.output_tokens,
        [`${prefix}_cache_creation_tokens`]: 0, [`${prefix}_cache_read_tokens`]: row.cache_read_tokens,
        [`${prefix}_tokens`]: row.total_tokens, [`${prefix}_cost`]: row.cost, [`${prefix}_actual_cost`]: row.actual_cost, [`${prefix}_account_cost`]: row.account_cost,
    });
    return { ...users, ...keys, ...accounts, ...usage(total, 'total'), ...usage(daily, 'today'), active_users: daily.active_users, hourly_active_users: daily.hourly_active_users,
        // Pool cooldowns are transient Durable Object state; no D1 projection exists for these counters.
        ratelimit_accounts: null, overload_accounts: null, unavailable_metrics: ['ratelimit_accounts', 'overload_accounts'], average_duration_ms: total.average_duration_ms,
        uptime: Math.floor((now - startedAt) / 1000), rpm: recent.requests / 5, tpm: recent.total_tokens / 5, stats_updated_at: new Date(now).toISOString(), stats_stale: false };
}
export function adminDashboardBatch(kind: 'users' | 'api-keys') {
    return async (context: Context<Bindings>): Promise<Response> => {
        try {
            await authenticateAdminSession(context.req.raw, context.env);
            const body = await readJsonObject(context.req.raw), column = kind === 'users' ? 'user_id' : 'api_key_id';
            const ids = body[kind === 'users' ? 'user_ids' : 'api_key_ids'];
            if (!Array.isArray(ids) || ids.length > 100)
                throw new GatewayError(400, 'invalid_ids', 'At most 100 IDs are required');
            const clean = ids.map(id => {
                if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id)))
                    throw new GatewayError(400, 'invalid_ids', 'IDs must be strings or integers');
                return requireResourceId(String(id), column);
            });
            if (!clean.length)
                return controlSuccess({ stats: {} });
            const today = calendarDayBoundaries(Date.now(), parseTimezone(context.req.query('timezone'))).today;
            const rows = await context.env.DB.prepare(`SELECT ${column},SUM(amount_micros)/1000000.0 total_actual_cost,SUM(CASE WHEN occurred_at_ms>=? THEN amount_micros ELSE 0 END)/1000000.0 today_actual_cost FROM usage_projection WHERE ${column} IN (SELECT value FROM json_each(?)) GROUP BY ${column}`).bind(today, JSON.stringify(clean)).all<any>();
            const values: Record<string, unknown> = Object.fromEntries(clean.map(id => [id, { [column]: id, today_actual_cost: 0, total_actual_cost: 0 }]));
            for (const row of rows.results)
                values[row[column]] = row;
            if (kind === 'users') {
                const platforms = await context.env.DB.prepare(`
                    SELECT u.user_id,COALESCE(NULLIF(u.platform,''),g.platform) platform,
                      SUM(u.amount_micros)/1000000.0 total_actual_cost,
                      SUM(CASE WHEN u.occurred_at_ms>=? THEN u.amount_micros ELSE 0 END)/1000000.0 today_actual_cost
                    FROM usage_projection u LEFT JOIN "groups" g ON g.id=u.group_id
                    WHERE u.user_id IN (SELECT value FROM json_each(?))
                      AND COALESCE(NULLIF(u.platform,''),g.platform,'')<>''
                    GROUP BY u.user_id,COALESCE(NULLIF(u.platform,''),g.platform)
                    ORDER BY total_actual_cost DESC,platform
                `).bind(today, JSON.stringify(clean)).all<any>();
                for (const id of clean)
                    (values[id] as Record<string, unknown>).by_platform = [];
                for (const row of platforms.results) {
                    const { user_id, ...platform } = row;
                    ((values[user_id] as Record<string, unknown>).by_platform as unknown[]).push(platform);
                }
            }
            return controlSuccess({ stats: values });
        }
        catch (error) {
            return controlError(asGatewayError(error));
        }
    };
}

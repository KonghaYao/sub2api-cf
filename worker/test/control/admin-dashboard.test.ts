import { describe, expect, it, vi } from 'vitest';
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens';
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1';
const PEPPER = 'observability-handler-pepper-32-bytes';
async function fixture() {
    const { raw, d1 } = createSqliteD1();
    applyMigrations(raw);
    const now = Date.now();
    raw.prepare(`INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', ?, ?),
            ('alice', 'alice@example.test', 'Alice', 'user', ?, ?),
            ('bob', 'bob@example.test', 'Bob', 'user', ?, ?)`).run(now, now, now, now, now, now);
    const auth: Record<string, string> = {};
    for (const user of ['admin', 'alice', 'bob']) {
        const access = createOpaqueToken('access');
        const refresh = createOpaqueToken('refresh');
        raw.prepare(`INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(`session-${user}`, `family-${user}`, user, await tokenDigest(access, PEPPER, 'access'), await tokenDigest(refresh, PEPPER, 'refresh'), now, now + 60000, now + 600000);
        auth[user] = `Bearer ${access}`;
    }
    const objects = new Map<string, string>();
    const bucket = {
        put: vi.fn(async (key: string, value: string) => { objects.set(key, value); }),
        get: vi.fn(async (key: string) => {
            const value = objects.get(key);
            return value === undefined ? null : { text: async () => value };
        }),
        delete: vi.fn(async (key: string) => { objects.delete(key); }),
        list: vi.fn(),
    };
    const namespace = {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ fetch: async () => Response.json({}) }),
    } as unknown as DurableObjectNamespace;
    const env = {
        APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER, DB: d1,
        OBJECTS: bucket, EVENTS_QUEUE: { send: vi.fn() }, CONFIG_KV: {} as KVNamespace,
        ASSETS: {} as Fetcher, USER_STATE: namespace, POOL_STATE: namespace,
    } as unknown as Env;
    return { raw, env, auth, objects };
}
describe('admin dashboard real routes', () => {
    it('loads snapshot, user trend and spending ranking from billing projection', async () => {
        const test = await fixture();
        const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
        for (const [id, user, amount, standard] of [['a', 'alice', 1000000, 2000000], ['b', 'bob', 3000000, 5000000]] as const) {
            test.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,model,input_tokens,output_tokens,cache_read_tokens,amount_micros,standard_cost_micros,occurred_at_ms,projected_at_ms) VALUES (?,?,?,'composer-2.5',100,50,25,?,?,?,?)`).run(id, id, user, amount, standard, now, now);
        }
        const app = createApp();
        const request = async (path: string) => {
            const response = await app.request('/api/v1/admin/dashboard/' + path, { headers: { authorization: test.auth.admin! } }, test.env);
            expect(response.status, await response.clone().text()).toBe(200);
            return (await response.json() as any).data;
        };
        const snapshot = await request(`snapshot-v2?start_date=${date}&end_date=${date}&upstream_model_mismatch=false&granularity=hour&include_stats=true&include_trend=true&include_model_stats=true&include_group_stats=false&include_users_trend=false`);
        expect(snapshot.stats).toMatchObject({ total_users: 3, total_requests: 2, total_tokens: 350, total_cost: 7, total_actual_cost: 4, today_requests: 2, active_users: 2 });
        expect(snapshot.trend).toHaveLength(1);
        expect(snapshot.trend[0]).toMatchObject({ requests: 2, total_tokens: 350, cost: 7, actual_cost: 4 });
        expect(snapshot.models[0]).toMatchObject({ model: 'composer-2.5', requests: 2, cost: 7, actual_cost: 4 });
        expect(snapshot).not.toHaveProperty('groups');
        const trend = await request(`users-trend?start_date=${date}&end_date=${date}&limit=1`);
        expect(trend.trend).toHaveLength(1);
        expect(trend.trend[0]).toMatchObject({ user_id: 'bob', email: 'bob@example.test', tokens: 175, actual_cost: 3 });
        const ranking = await request(`users-ranking?start_date=${date}&end_date=${date}&limit=1`);
        expect(ranking).toMatchObject({ total_requests: 2, total_tokens: 350, total_actual_cost: 4 });
        expect(ranking.ranking).toHaveLength(1);
        expect(ranking.ranking[0]).toMatchObject({ user_id: 'bob', actual_cost: 3 });
    });
    it('keeps timezone buckets, revoked-key counts, and dimension filters accurate', async () => {
        const test = await fixture();
        const at = Date.parse('2026-09-06T17:30:00Z');
        test.raw.prepare(`INSERT INTO api_keys(id,user_id,key_hash,name,revoked_at_ms,created_at_ms,updated_at_ms) VALUES ('revoked','alice',?,'old',?,?,?)`).run('a'.repeat(64), at, at, at);
        test.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,model,upstream_model,inbound_endpoint,amount_micros,occurred_at_ms,projected_at_ms) VALUES ('timezone','timezone','alice','requested','upstream','chat_completions',250000,?,?)`).run(at, at);
        const app = createApp(), headers = { authorization: test.auth.admin! };
        const response = await app.request('/api/v1/admin/dashboard/snapshot-v2?start_date=2026-09-07&end_date=2026-09-07&timezone=Asia%2FShanghai&include_users_trend=false', { headers }, test.env);
        expect(response.status, await response.clone().text()).toBe(200);
        const data = (await response.json() as any).data;
        expect(data.trend[0]).toMatchObject({ date: '2026-09-07', requests: 1, actual_cost: .25 });
        expect(data.stats).toMatchObject({ total_api_keys: 0, active_api_keys: 0 });
        const filtered = await app.request('/api/v1/admin/dashboard/user-breakdown?start_date=2026-09-07&end_date=2026-09-07&timezone=Asia%2FShanghai&model_source=upstream&model=upstream&endpoint=chat_completions', { headers }, test.env);
        expect((await filtered.json() as any).data.users[0]).toMatchObject({ user_id: 'alice', requests: 1, actual_cost: .25 });
    });
    it('reports per-platform batch spending without exceeding D1 bind limits', async () => {
        const test = await fixture(), now = Date.now();
        test.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,model,platform,amount_micros,occurred_at_ms,projected_at_ms) VALUES ('platform','platform','alice','model','openai',500000,?,?)`).run(now, now);
        const original = test.env.DB.prepare.bind(test.env.DB);
        test.env.DB.prepare = ((sql: string) => {
            const statement = original(sql), bind = statement.bind.bind(statement);
            statement.bind = (...args: unknown[]) => { expect(args.length).toBeLessThanOrEqual(100); return bind(...args); };
            return statement;
        }) as typeof test.env.DB.prepare;
        const response = await createApp().request('/api/v1/admin/dashboard/users-usage', { method: 'POST', headers: { authorization: test.auth.admin!, 'content-type': 'application/json' }, body: JSON.stringify({ user_ids: ['alice', ...Array.from({ length: 99 }, (_, i) => `missing-${i}`)] }) }, test.env);
        const data = (await response.json() as any).data;
        expect(data.stats.alice.by_platform).toEqual([{ platform: 'openai', total_actual_cost: .5, today_actual_cost: .5 }]);
    });
    it('protects every new route and handles empty data and invalid batch IDs', async () => {
        const test = await fixture(), app = createApp();
        for (const path of ['stats', 'trend', 'groups', 'users-trend', 'users-ranking', 'api-keys-trend', 'user-breakdown', 'snapshot-v2']) {
            const denied = await app.request('/api/v1/admin/dashboard/' + path, { headers: { authorization: test.auth.alice! } }, test.env);
            expect(denied.status).toBe(403);
            const response = await app.request('/api/v1/admin/dashboard/' + path, { headers: { authorization: test.auth.admin! } }, test.env);
            expect(response.status, await response.clone().text()).toBe(200);
        }
        const response = await app.request('/api/v1/admin/dashboard/users-usage', { method: 'POST', headers: { authorization: test.auth.admin!, 'content-type': 'application/json' }, body: JSON.stringify({ user_ids: ['alice'] }) }, test.env);
        expect((await response.json() as any).data.stats.alice).toMatchObject({ user_id: 'alice', total_actual_cost: 0, today_actual_cost: 0 });
        const invalid = await app.request('/api/v1/admin/dashboard/api-keys-usage', { method: 'POST', headers: { authorization: test.auth.admin!, 'content-type': 'application/json' }, body: JSON.stringify({ api_key_ids: [{}] }) }, test.env);
        expect(invalid.status).toBe(400);
    });
});

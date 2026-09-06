import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { getAdminGroupUsageSummary } from '../../src/control/group-usage'
import { calendarDayBoundaries } from '../../src/gateway/info'
import { createApp } from '../../src/app'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

afterEach(() => vi.restoreAllMocks())

describe('group usage summary on D1', () => {
  it.each([
    ['Asia/Shanghai', '2026-09-06T14:00:00Z', '2026-09-05T16:00:00Z', '2026-09-04T16:00:00Z'],
    ['America/New_York', '2026-03-09T12:00:00Z', '2026-03-09T04:00:00Z', '2026-03-08T05:00:00Z'],
  ])('uses server calendar boundaries and actual charges in %s', async (timezone, now, todayIso, yesterdayIso) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now))
    const today = Date.parse(todayIso), yesterday = Date.parse(yesterdayIso)
    expect(calendarDayBoundaries(Date.now(), timezone)).toEqual({ today, yesterday })
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms) VALUES ('user', 'group-usage@test.invalid', 1, 1);
      INSERT INTO "groups" (id, name, platform, enabled, created_at_ms, updated_at_ms)
      VALUES ('group-active', 'Active', 'openai', 1, 1, 1), ('group-empty', 'Empty', 'openai', 0, 1, 1);
    `)
    const insert = raw.prepare(`INSERT INTO usage_projection
      (event_id, request_id, user_id, model, group_id, amount_micros, occurred_at_ms, projected_at_ms)
      VALUES (?, ?, 'user', 'model', ?, ?, ?, ?)`)
    for (const [index, [timestamp, cost]] of [[yesterday - 1, 4000000], [yesterday, 2000000], [today - 1, 3000000], [today, 1250000]].entries()) {
      insert.run(`event-${index}`, `request-${index}`, 'group-active', cost, timestamp, Date.now())
    }
    insert.run('ungrouped', 'ungrouped', null, 99000000, today, Date.now())
    const app = new Hono<{ Bindings: Env }>()
    app.get('/usage', getAdminGroupUsageSummary)
    const response = await app.request('/usage?timezone=Pacific/Honolulu', {}, { DB: d1, GROUP_USAGE_TIMEZONE: timezone } as Env)
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 0, data: [
      { group_id: 'group-active', today_cost: 1.25, yesterday_cost: 5, total_cost: 10.25 },
      { group_id: 'group-empty', today_cost: 0, yesterday_cost: 0, total_cost: 0 },
    ] })
    const plan = raw.prepare('EXPLAIN QUERY PLAN SELECT SUM(amount_micros) FROM usage_projection WHERE group_id = ?').all('group-active')
    expect(JSON.stringify(plan)).toContain('COVERING INDEX idx_usage_projection_group_cost_time')
  })

  it('rejects unauthenticated access through production routing', async () => {
    const response = await createApp().request('/api/v1/admin/groups/usage-summary', {}, {} as Env)
    expect(response.status).toBe(401)
  })
})

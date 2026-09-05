import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  accrueAdminAffiliateRebate,
  accrueAffiliateRebate,
  accrueAffiliateRebateForPaymentOrder,
  batchUpdateAdminAffiliateRates,
  clawbackAffiliateRebateForRefund,
  clearAdminAffiliateUser,
  ensureAffiliateProfile,
  getAdminAffiliateUserOverview,
  getUserAffiliate,
  listAdminAffiliateInvites,
  listAdminAffiliateRebates,
  listAdminAffiliateTransfers,
  listAdminAffiliateUsers,
  lookupAdminAffiliateUsers,
  recoverPendingAffiliateRebates,
  transferUserAffiliateQuota,
  updateAdminAffiliateUser,
} from '../../src/commercial/affiliate'
import type { Env } from '../../src/env'
import { recoverPendingRefundClawbacks } from '../../src/payment/refunds'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'affiliate-http-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'affiliate-http-master-value-at-least-32-bytes'
const DAY_MS = 86_400_000

describe('affiliate HTTP contract', () => {
  it('applies freeze, duration, and per-invitee cap using immutable rebate records', async () => {
    const test = await fixture()
    const app = routes()
    test.raw.prepare(
      `UPDATE commercial_config
          SET affiliate_rebate_rate_ppm = 200000,
              affiliate_rebate_freeze_hours = 1,
              affiliate_rebate_duration_days = 30,
              affiliate_rebate_per_invitee_cap_micros = 3000000
        WHERE id = 'global'`,
    ).run()
    await bindReferral(test, Date.now())

    const first = await accrue(app, test, 'order-1', 10_000_000)
    expect(first.status).toBe(201)
    await expect(first.json()).resolves.toMatchObject({
      data: { applied: true, rebate_micros: 2_000_000, status: 'frozen' },
    })
    const capped = await accrue(app, test, 'order-2', 10_000_000)
    await expect(capped.json()).resolves.toMatchObject({
      data: { applied: true, rebate_micros: 1_000_000, status: 'frozen' },
    })
    const exhausted = await accrue(app, test, 'order-3', 10_000_000)
    await expect(exhausted.json()).resolves.toMatchObject({ data: { applied: false, rebate_micros: 0 } })

    const detail = await app.request('/user/aff', { headers: test.inviterHeaders }, test.env)
    await expect(detail.json()).resolves.toMatchObject({
      data: { aff_quota: 0, aff_frozen_quota: 3, aff_history_quota: 3, aff_count: 1 },
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_ledger WHERE entry_type = 'rebate_frozen'`,
    ).get()).toEqual({ total: 2 })

    // Attribution is immutable: use a separate old referral for the duration check.
    await addUser(test, 'old-invitee', 'old@example.test')
    await ensureAffiliateProfile(test.env, 'old-invitee')
    const oldAt = Date.now() - 31 * DAY_MS
    test.raw.prepare(
      `UPDATE affiliate_profiles SET created_at_ms = ?, updated_at_ms = ? WHERE user_id = 'inviter'`,
    ).run(oldAt, oldAt)
    test.raw.prepare(
      `INSERT INTO affiliate_referrals (
         invitee_user_id, inviter_user_id, affiliate_code_prefix, attributed_at_ms
       ) VALUES ('old-invitee', 'inviter', 'AFFOLD', ?)`,
    ).run(oldAt)
    const expired = await accrue(app, test, 'order-old', 10_000_000, 'old-invitee')
    await expect(expired.json()).resolves.toMatchObject({ data: { applied: false, rebate_micros: 0 } })
  })

  it('projects a completed payment once and recovers a missed post-commit accrual', async () => {
    const test = await fixture()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'completed-affiliate-order')

    const direct = await accrueAffiliateRebateForPaymentOrder(test.env, 'completed-affiliate-order')
    expect(direct).toMatchObject({ applied: true, idempotent: false, rebate_micros: 2_000_000 })
    const replay = await accrueAffiliateRebateForPaymentOrder(test.env, 'completed-affiliate-order')
    expect(replay).toMatchObject({ applied: true, idempotent: true, rebate_micros: 2_000_000 })

    seedCompletedPaymentOrder(test, 'recovered-affiliate-order')
    expect(await recoverPendingAffiliateRebates(test.env)).toBe(1)
    expect(await recoverPendingAffiliateRebates(test.env)).toBe(0)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_rebates`,
    ).get()).toEqual({ total: 2 })
  })

  it('audits and exactly replays manual accrual while rejecting source reuse', async () => {
    const test = await fixture()
    const app = routes()
    await bindReferral(test, Date.now())
    const request = {
      method: 'POST',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-manual-accrue-0001',
      },
      body: JSON.stringify({
        source_order_id: 'manual-order-1',
        invitee_user_id: 'invitee',
        order_amount_micros: 5_000_000,
        pay_amount_micros: 5_000_000,
        out_trade_no: 'manual-trade-1',
        payment_type: 'manual',
        order_status: 'completed',
      }),
    } as const
    const created = await app.request('/admin/accrue', request, test.env)
    expect(created.status).toBe(201)
    const createdBody = await created.json()
    const replay = await app.request('/admin/accrue', request, test.env)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(createdBody)

    const changedReplay = await app.request('/admin/accrue', {
      ...request,
      body: JSON.stringify({
        source_order_id: 'manual-order-1',
        invitee_user_id: 'invitee',
        order_amount_micros: 6_000_000,
        pay_amount_micros: 6_000_000,
      }),
    }, test.env)
    expect(changedReplay.status).toBe(409)
    await expect(changedReplay.json()).resolves.toMatchObject({ error: { code: 'idempotency_conflict' } })

    const reusedSource = await app.request('/admin/accrue', {
      ...request,
      headers: { ...request.headers, 'idempotency-key': 'affiliate-manual-accrue-0002' },
    }, test.env)
    expect(reusedSource.status).toBe(409)
    await expect(reusedSource.json()).resolves.toMatchObject({ error: { code: 'affiliate_source_conflict' } })

    expect(test.raw.prepare(
      `SELECT actor_user_id, actor_session_id, action, resource_type, resource_id,
              length(idempotency_key_hash) AS key_hash_length
         FROM commercial_admin_audit_events WHERE action = 'affiliate_user.manual_accrue'`,
    ).get()).toEqual({
      actor_user_id: 'admin',
      actor_session_id: 'admin-session',
      action: 'affiliate_user.manual_accrue',
      resource_type: 'affiliate_user',
      resource_id: 'inviter',
      key_hash_length: 64,
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_rebates WHERE source_order_id = 'manual-order-1'`,
    ).get()).toEqual({ total: 1 })
  })

  it('replays a transfer after the DO applied it but its first response was lost', async () => {
    const state = new RecoveringUserState()
    const test = await fixture(state)
    const app = routes()
    test.raw.prepare(
      `UPDATE commercial_config
          SET affiliate_rebate_rate_ppm = 200000,
              affiliate_rebate_freeze_hours = 0,
              affiliate_rebate_per_invitee_cap_micros = 0
        WHERE id = 'global'`,
    ).run()
    await bindReferral(test, Date.now())
    await accrue(app, test, 'order-transfer', 10_000_000)

    const request = {
      method: 'POST',
      headers: { ...test.inviterHeaders, 'idempotency-key': 'affiliate-transfer-retry-0001' },
    } as const
    const first = await app.request('/user/aff/transfer', request, test.env)
    expect(first.status).toBe(503)
    expect(test.raw.prepare(
      `SELECT status, amount_micros FROM affiliate_transfer_operations`,
    ).get()).toEqual({ status: 'processing', amount_micros: 2_000_000 })
    expect(test.raw.prepare(
      `SELECT available_micros FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0 })

    const replay = await app.request('/user/aff/transfer', request, test.env)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      data: { transferred_quota: 2, transferred_micros: 2_000_000, balance: 2 },
    })
    expect(state.adjustApplications).toBe(1)
    expect(test.raw.prepare(
      `SELECT status, balance_after_micros FROM affiliate_transfer_operations`,
    ).get()).toEqual({ status: 'completed', balance_after_micros: 2_000_000 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_ledger WHERE entry_type = 'transfer_completed'`,
    ).get()).toEqual({ total: 1 })
  })

  it('voids a frozen rebate exactly once when its order is fully refunded', async () => {
    const test = await fixture(new RecoveringUserState(false))
    test.raw.prepare(
      `UPDATE commercial_config SET affiliate_rebate_freeze_hours = 1 WHERE id = 'global'`,
    ).run()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'order-frozen-refund')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-frozen-refund')
    seedSettledRefund(test, 'order-frozen-refund', 'refund-frozen-full', 10_000_000)

    const applied = await clawbackAffiliateRebateForRefund(test.env, 'refund-frozen-full')
    const replay = await clawbackAffiliateRebateForRefund(test.env, 'refund-frozen-full')
    expect(applied).toMatchObject({ applied: true, idempotent: false, adjustment_micros: 2_000_000 })
    expect(replay).toMatchObject({ applied: true, idempotent: true, adjustment_micros: 2_000_000 })
    expect(test.raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, frozen_micros: 0, history_micros: 0 })
    expect(test.raw.prepare(
      `SELECT status, adjustment_kind, adjustment_micros, quota_clawback_micros,
              balance_clawback_micros FROM affiliate_rebate_adjustments`,
    ).all()).toEqual([{
      status: 'completed', adjustment_kind: 'full_void', adjustment_micros: 2_000_000,
      quota_clawback_micros: 2_000_000, balance_clawback_micros: 0,
    }])
    expect(() => test.raw.prepare(
      `UPDATE affiliate_rebates
          SET status = 'available', control_version = control_version + 1, updated_at_ms = ?
        WHERE source_order_id = 'order-frozen-refund'`,
    ).run(Date.now() + 3_600_001)).not.toThrow()
    expect(test.raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, frozen_micros: 0, history_micros: 0 })
    expect(() => test.raw.prepare(
      `UPDATE affiliate_rebate_adjustments SET adjustment_micros = 1 WHERE refund_id = ?`,
    ).run('refund-frozen-full')).toThrow(/affiliate_rebate_adjustment_immutable/)
    expect(() => test.raw.prepare(
      `DELETE FROM affiliate_rebate_adjustments WHERE refund_id = ?`,
    ).run('refund-frozen-full')).toThrow(/affiliate_rebate_adjustment_immutable/)
  })

  it('claws back a partial refund once under concurrent replay', async () => {
    const test = await fixture(new RecoveringUserState(false))
    test.raw.prepare(
      `UPDATE commercial_config
          SET affiliate_rebate_per_invitee_cap_micros = 2000000
        WHERE id = 'global'`,
    ).run()
    const app = routes()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'order-partial-refund')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-partial-refund')
    seedSettledRefund(test, 'order-partial-refund', 'refund-partial', 5_000_000)

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      clawbackAffiliateRebateForRefund(test.env, 'refund-partial')))
    expect(results.filter((result) => !result.idempotent)).toHaveLength(1)
    expect(results.every((result) => result.adjustment_micros === 1_000_000)).toBe(true)
    expect(test.raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 1_000_000, frozen_micros: 0, history_micros: 1_000_000 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_rebate_adjustments`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_ledger
        WHERE entry_type IN ('rebate_clawback_reserved', 'rebate_clawback_completed')`,
    ).get()).toEqual({ total: 2 })

    const owner = await app.request('/user/aff', { headers: test.inviterHeaders }, test.env)
    await expect(owner.json()).resolves.toMatchObject({
      data: {
        invitees: [{
          user_id: 'invitee',
          total_rebate: 1,
          total_rebate_micros: 1_000_000,
          gross_rebate_micros: 2_000_000,
          adjustment_micros: 1_000_000,
          adjustment_status: 'completed',
        }],
      },
    })
    const adminInvites = await app.request('/admin/invites', { headers: test.adminHeaders }, test.env)
    await expect(adminInvites.json()).resolves.toMatchObject({
      data: { items: [{
        invitee_id: 'invitee',
        total_rebate_micros: 1_000_000,
        gross_rebate_micros: 2_000_000,
        adjustment_micros: 1_000_000,
        adjustment_status: 'completed',
      }] },
    })
    const adminRebates = await app.request('/admin/rebates', { headers: test.adminHeaders }, test.env)
    await expect(adminRebates.json()).resolves.toMatchObject({
      data: { items: [{
        order_id: 'order-partial-refund',
        rebate_micros: 1_000_000,
        gross_rebate_micros: 2_000_000,
        adjustment_micros: 1_000_000,
        adjustment_status: 'completed',
      }] },
    })
    const replacement = await accrue(app, test, 'order-after-partial-refund', 10_000_000)
    await expect(replacement.json()).resolves.toMatchObject({
      data: { applied: true, rebate_micros: 1_000_000 },
    })
  })

  it('recovers a full refund after transferred rebate balance was applied but its response was lost', async () => {
    const state = new RecoveringUserState(false)
    const test = await fixture(state)
    const app = routes()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'order-transferred-refund')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-transferred-refund')
    const transfer = await app.request('/user/aff/transfer', {
      method: 'POST',
      headers: { ...test.inviterHeaders, 'idempotency-key': 'transfer-before-refund-0001' },
    }, test.env)
    expect(transfer.status).toBe(200)
    expect(state.balanceMicros).toBe(2_000_000)
    seedSettledRefund(test, 'order-transferred-refund', 'refund-transferred-full', 10_000_000)

    state.loseNextAdjustResponse = true
    await expect(clawbackAffiliateRebateForRefund(test.env, 'refund-transferred-full')).rejects.toMatchObject({
      status: 503,
    })
    expect(test.raw.prepare(
      `SELECT status, quota_clawback_micros, balance_clawback_micros
         FROM affiliate_rebate_adjustments`,
    ).get()).toEqual({ status: 'processing', quota_clawback_micros: 0, balance_clawback_micros: 2_000_000 })

    await expect(recoverPendingRefundClawbacks(test.env)).resolves.toBe(1)
    const replay = await clawbackAffiliateRebateForRefund(test.env, 'refund-transferred-full')
    expect(replay).toMatchObject({ applied: true, idempotent: true, balance_clawback_micros: 2_000_000 })
    expect(state.balanceMicros).toBe(0)
    expect(state.adjustApplications).toBe(2)
    expect(test.raw.prepare(
      `SELECT status, balance_after_micros FROM affiliate_rebate_adjustments`,
    ).get()).toEqual({ status: 'completed', balance_after_micros: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM payment_events
        WHERE event_type = 'AFFILIATE_REBATE_CLAWBACK_SUCCEEDED'`,
    ).get()).toEqual({ total: 1 })
  })

  it('settles transferred-rebate debt from later commissions before exposing new quota', async () => {
    const state = new RecoveringUserState(false)
    const test = await fixture(state)
    const app = routes()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'order-debt-origin')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-debt-origin')
    const transfer = await app.request('/user/aff/transfer', {
      method: 'POST',
      headers: { ...test.inviterHeaders, 'idempotency-key': 'transfer-before-debt-0001' },
    }, test.env)
    expect(transfer.status).toBe(200)
    state.reservedMicros = 1_000_000
    seedSettledRefund(test, 'order-debt-origin', 'refund-debt-origin', 10_000_000)

    await expect(clawbackAffiliateRebateForRefund(test.env, 'refund-debt-origin'))
      .resolves.toMatchObject({
        status: 'completed', balance_recovered_micros: 1_000_000,
        debt_incurred_micros: 1_000_000,
      })
    expect(test.raw.prepare(
      `SELECT available_micros, history_micros, debt_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, history_micros: 0, debt_micros: 1_000_000 })

    await accrue(app, test, 'order-debt-partial-repay', 2_500_000)
    expect(test.raw.prepare(
      `SELECT available_micros, history_micros, debt_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, history_micros: 500_000, debt_micros: 500_000 })
    await accrue(app, test, 'order-debt-final-repay', 5_000_000)
    expect(test.raw.prepare(
      `SELECT available_micros, history_micros, debt_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 500_000, history_micros: 1_500_000, debt_micros: 0 })
    expect(test.raw.prepare(
      `SELECT amount_micros, debt_after_micros FROM affiliate_debt_repayments
        ORDER BY created_at_ms, id`,
    ).all()).toEqual([
      { amount_micros: 500_000, debt_after_micros: 500_000 },
      { amount_micros: 500_000, debt_after_micros: 0 },
    ])

    const owner = await app.request('/user/aff', { headers: test.inviterHeaders }, test.env)
    await expect(owner.json()).resolves.toMatchObject({
      data: { aff_debt_micros: 0, aff_quota_micros: 500_000 },
    })
    const overview = await app.request('/admin/users/inviter/overview', {
      headers: test.adminHeaders,
    }, test.env)
    await expect(overview.json()).resolves.toMatchObject({ data: { debt_micros: 0 } })
  })

  it('claws back released quota before reopening debt when a repayment rebate is refunded', async () => {
    const state = new RecoveringUserState(false)
    const test = await fixture(state)
    const app = routes()
    await bindReferral(test, Date.now())
    seedCompletedPaymentOrder(test, 'order-debt-sequence-origin')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-debt-sequence-origin')
    const transfer = await app.request('/user/aff/transfer', {
      method: 'POST',
      headers: { ...test.inviterHeaders, 'idempotency-key': 'transfer-debt-sequence-0001' },
    }, test.env)
    expect(transfer.status).toBe(200)
    state.reservedMicros = state.balanceMicros
    seedSettledRefund(test, 'order-debt-sequence-origin', 'refund-debt-sequence-origin', 5_000_000)
    await clawbackAffiliateRebateForRefund(test.env, 'refund-debt-sequence-origin')

    seedCompletedPaymentOrder(test, 'order-debt-repayment-refunded')
    await accrueAffiliateRebateForPaymentOrder(test.env, 'order-debt-repayment-refunded')
    expect(test.raw.prepare(
      `SELECT available_micros, debt_micros FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 1_000_000, debt_micros: 0 })

    seedSettledRefund(test, 'order-debt-repayment-refunded', 'refund-repayment-first', 2_500_000)
    await clawbackAffiliateRebateForRefund(test.env, 'refund-repayment-first')
    expect(test.raw.prepare(
      `SELECT available_micros, debt_micros FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 500_000, debt_micros: 0 })

    seedSettledRefund(test, 'order-debt-repayment-refunded', 'refund-repayment-second', 7_500_000)
    await clawbackAffiliateRebateForRefund(test.env, 'refund-repayment-second')
    expect(test.raw.prepare(
      `SELECT available_micros, history_micros, debt_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, history_micros: 1_500_000, debt_micros: 500_000 })
    expect(test.raw.prepare(
      `SELECT adjustment_micros, quota_clawback_micros, balance_clawback_micros,
              debt_reopened_micros, debt_incurred_micros
         FROM affiliate_rebate_adjustments WHERE refund_id = 'refund-repayment-second'`,
    ).get()).toEqual({
      adjustment_micros: 1_000_000,
      quota_clawback_micros: 500_000,
      balance_clawback_micros: 0,
      debt_reopened_micros: 500_000,
      debt_incurred_micros: 0,
    })
  })

  it('isolates user summaries while admin records require an administrator', async () => {
    const test = await fixture()
    const app = routes()
    await bindReferral(test, Date.now())
    await accrue(app, test, 'order-admin', 5_000_000)

    const outsider = await app.request('/user/aff', { headers: test.outsiderHeaders }, test.env)
    expect(outsider.status).toBe(200)
    const outsiderBody = await outsider.json() as any
    expect(outsiderBody.data).toMatchObject({ user_id: 'outsider', inviter_id: null, aff_count: 0 })
    expect(JSON.stringify(outsiderBody)).not.toContain('inviter@example.test')

    const forbidden = await app.request('/admin/invites', { headers: test.inviterHeaders }, test.env)
    expect(forbidden.status).toBe(403)
    const invites = await app.request('/admin/invites', { headers: test.adminHeaders }, test.env)
    await expect(invites.json()).resolves.toMatchObject({
      data: { total: 1, items: [{ inviter_id: 'inviter', invitee_id: 'invitee' }] },
    })
    const rebates = await app.request('/admin/rebates', { headers: test.adminHeaders }, test.env)
    await expect(rebates.json()).resolves.toMatchObject({ data: { total: 1 } })
    const overview = await app.request('/admin/users/inviter/overview', {
      headers: test.adminHeaders,
    }, test.env)
    await expect(overview.json()).resolves.toMatchObject({
      data: { user_id: 'inviter', invited_count: 1, rebated_invitee_count: 1 },
    })
    const transfers = await app.request('/admin/transfers', { headers: test.adminHeaders }, test.env)
    await expect(transfers.json()).resolves.toMatchObject({ data: { total: 0, items: [] } })
  })

  it('filters and sorts admin records using strict timezone-aware query contracts', async () => {
    const test = await fixture()
    const app = routes()
    const localDayStart = Date.UTC(2030, 8, 4, 16, 0, 0)
    await addUser(test, 'invitee-a', 'a@example.test')
    await addUser(test, 'invitee-b', 'b@example.test')
    await addUser(test, 'invitee-outside', 'outside@example.test')
    for (const [id, at] of [
      ['invitee-outside', localDayStart - 1],
      ['invitee-b', localDayStart + 1],
      ['invitee-a', localDayStart + 2],
    ] as const) {
      test.raw.prepare(
        `INSERT INTO affiliate_referrals (
           invitee_user_id, inviter_user_id, affiliate_code_prefix, attributed_at_ms
         ) VALUES (?, 'inviter', 'AFFTEST', ?)`,
      ).run(id, at)
    }
    await accrueAffiliateRebate(test.env, {
      source_order_id: 'dated-rebate-b', invitee_user_id: 'invitee-b',
      order_amount_micros: 10_000_000, pay_amount_micros: 10_000_000,
    }, localDayStart + 10)
    await accrueAffiliateRebate(test.env, {
      source_order_id: 'dated-rebate-a', invitee_user_id: 'invitee-a',
      order_amount_micros: 5_000_000, pay_amount_micros: 5_000_000,
    }, localDayStart + 20)
    await accrueAffiliateRebate(test.env, {
      source_order_id: 'dated-rebate-outside', invitee_user_id: 'invitee-outside',
      order_amount_micros: 20_000_000, pay_amount_micros: 20_000_000,
    }, localDayStart - 1)
    for (const [id, amount, at] of [
      ['transfer-outside', 3_000_000, localDayStart - 1],
      ['transfer-b', 2_000_000, localDayStart + 30],
      ['transfer-a', 1_000_000, localDayStart + 40],
    ] as const) {
      test.raw.prepare(
        `INSERT INTO affiliate_transfer_operations (
           id, user_id, idempotency_key_hash, request_hash, status, amount_micros,
           balance_after_micros, state_version, created_at_ms, completed_at_ms, updated_at_ms
         ) VALUES (?, 'inviter', ?, ?, 'completed', ?, 0, 1, ?, ?, ?)`,
      ).run(id, id.padEnd(64, 'a'), id.padEnd(64, 'b'), amount, at, at, at)
    }

    const suffix = 'start_at=2030-09-05&end_at=2030-09-05&timezone=Asia%2FShanghai'
    const invites = await app.request(
      `/admin/invites?${suffix}&sort_by=invitee&sort_order=asc`,
      { headers: test.adminHeaders }, test.env,
    )
    expect(invites.status).toBe(200)
    expect(((await invites.json()) as any).data.items.map((row: any) => row.invitee_id))
      .toEqual(['invitee-a', 'invitee-b'])

    const rebates = await app.request(
      `/admin/rebates?${suffix}&sort_by=pay_amount&sort_order=asc`,
      { headers: test.adminHeaders }, test.env,
    )
    expect(rebates.status).toBe(200)
    expect(((await rebates.json()) as any).data.items.map((row: any) => row.order_id))
      .toEqual(['dated-rebate-a', 'dated-rebate-b'])

    const transfers = await app.request(
      `/admin/transfers?${suffix}&sort_by=amount&sort_order=asc`,
      { headers: test.adminHeaders }, test.env,
    )
    expect(transfers.status).toBe(200)
    expect(((await transfers.json()) as any).data.items.map((row: any) => row.ledger_id))
      .toEqual(['transfer-a', 'transfer-b'])

    for (const path of [
      '/admin/invites?sort_by=sql_expression',
      '/admin/rebates?sort_order=sideways',
      '/admin/transfers?start_at=2030-09-05&timezone=Mars%2FOlympus',
    ]) {
      const invalid = await app.request(path, { headers: test.adminHeaders }, test.env)
      expect(invalid.status).toBe(400)
    }
  })

  it('manages custom affiliate codes and rates through administrator-only endpoints', async () => {
    const test = await fixture()
    const app = routes()
    const forbidden = await app.request('/admin/users/inviter', {
      method: 'PUT', headers: { ...test.inviterHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ aff_code: 'CUSTOM_ONE' }),
    }, test.env)
    expect(forbidden.status).toBe(403)

    const updated = await app.request('/admin/users/inviter', {
      method: 'PUT', headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-update-existing-0001',
        'if-match': '"0"',
      },
      body: JSON.stringify({ aff_code: ' custom_one ', aff_rebate_rate_percent: 12.5 }),
    }, test.env)
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({ data: { user_id: 'inviter', control_version: 1 } })
    const listed = await app.request('/admin/users', { headers: test.adminHeaders }, test.env)
    await expect(listed.json()).resolves.toMatchObject({
      data: { total: 1, items: [{
        user_id: 'inviter', aff_code: 'CUSTOM_ONE', aff_rebate_rate_percent: 12.5, control_version: 1,
      }] },
    })
    const lookup = await app.request('/admin/users/lookup?q=inviter', {
      headers: test.adminHeaders,
    }, test.env)
    await expect(lookup.json()).resolves.toMatchObject({ data: [{ id: 'inviter', control_version: 1 }] })

    const batch = await app.request('/admin/users/batch-rate', {
      method: 'POST', headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-batch-existing-0001',
      },
      body: JSON.stringify({
        user_ids: ['inviter', 'outsider'],
        expected_control_versions: { inviter: 1, outsider: 0 },
        aff_rebate_rate_percent: 25,
      }),
    }, test.env)
    await expect(batch.json()).resolves.toMatchObject({
      data: { affected: 2, control_versions: { inviter: 2, outsider: 1 } },
    })
    const cleared = await app.request('/admin/users/inviter', {
      method: 'DELETE', headers: {
        ...test.adminHeaders,
        'idempotency-key': 'affiliate-clear-existing-0001',
        'if-match': '2',
      },
    }, test.env)
    expect(cleared.status).toBe(200)
    await expect(cleared.json()).resolves.toMatchObject({ data: { user_id: 'inviter', control_version: 3 } })
    const profile = test.raw.prepare(
      `SELECT code_custom, rebate_rate_ppm FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()
    expect(profile).toEqual({ code_custom: 0, rebate_rate_ppm: null })
  })

  it('requires preconditions, replays exactly once, and accepts UUID user ids', async () => {
    const test = await fixture()
    const app = routes()
    const userId = '550e8400-e29b-41d4-a716-446655440000'
    await addUser(test, userId, 'uuid@example.test')
    await ensureAffiliateProfile(test.env, userId)

    const noIdempotency = await app.request(`/admin/users/${userId}`, {
      method: 'PUT',
      headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': '0' },
      body: JSON.stringify({ aff_rebate_rate_percent: 12.5 }),
    }, test.env)
    expect(noIdempotency.status).toBe(400)
    await expect(noIdempotency.json()).resolves.toMatchObject({ error: { code: 'invalid_idempotency_key' } })

    const noVersion = await app.request(`/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-uuid-update-0001',
      },
      body: JSON.stringify({ aff_rebate_rate_percent: 12.5 }),
    }, test.env)
    expect(noVersion.status).toBe(428)
    await expect(noVersion.json()).resolves.toMatchObject({ error: { code: 'control_version_required' } })

    const request = {
      method: 'PUT',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-uuid-update-0001',
        'if-match': 'W/"0"',
      },
      body: JSON.stringify({ aff_code: ' uuid_custom ', aff_rebate_rate_percent: 12.5 }),
    } as const
    const updated = await app.request(`/admin/users/${userId}`, request, test.env)
    expect(updated.status).toBe(200)
    const firstBody = await updated.json()
    expect(firstBody).toMatchObject({ data: { user_id: userId, control_version: 1 } })

    const replay = await app.request(`/admin/users/${userId}`, request, test.env)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(firstBody)

    const changedReplay = await app.request(`/admin/users/${userId}`, {
      ...request,
      body: JSON.stringify({ aff_code: 'OTHER_CODE', aff_rebate_rate_percent: 12.5 }),
    }, test.env)
    expect(changedReplay.status).toBe(409)
    await expect(changedReplay.json()).resolves.toMatchObject({ error: { code: 'idempotency_conflict' } })

    const stale = await app.request(`/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-uuid-update-stale-0001',
        'if-match': '0',
      },
      body: JSON.stringify({ aff_rebate_rate_percent: 99 }),
    }, test.env)
    expect(stale.status).toBe(412)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'control_version_conflict' } })

    expect(test.raw.prepare(
      `SELECT code_custom, rebate_rate_ppm, control_version FROM affiliate_profiles WHERE user_id = ?`,
    ).get(userId)).toEqual({ code_custom: 1, rebate_rate_ppm: 125000, control_version: 1 })
    expect(test.raw.prepare(
      `SELECT actor_user_id, actor_session_id, action, resource_type, resource_id,
              resource_version, length(idempotency_key_hash) AS key_hash_length,
              changed_fields_json
         FROM commercial_admin_audit_events WHERE resource_id = ?`,
    ).get(userId)).toEqual({
      actor_user_id: 'admin',
      actor_session_id: 'admin-session',
      action: 'affiliate_user.update',
      resource_type: 'affiliate_user',
      resource_id: userId,
      resource_version: 1,
      key_hash_length: 64,
      changed_fields_json: '["aff_code","aff_rebate_rate_percent"]',
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency WHERE resource_id = ?`,
    ).get(userId)).toEqual({ total: 1 })
  })

  it('allows only one concurrent update for one control version without ghost writes', async () => {
    const test = await fixture()
    const app = routes()
    const update = (key: string, rate: number) => app.request('/admin/users/inviter', {
      method: 'PUT',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': key,
        'if-match': '0',
      },
      body: JSON.stringify({ aff_rebate_rate_percent: rate }),
    }, test.env)

    const responses = await Promise.all([
      update('affiliate-race-writer-one', 11),
      update('affiliate-race-writer-two', 22),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412])
    const row = test.raw.prepare(
      `SELECT rebate_rate_ppm, control_version FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get() as { rebate_rate_ppm: number; control_version: number }
    expect([110000, 220000]).toContain(row.rebate_rate_ppm)
    expect(row.control_version).toBe(1)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events WHERE resource_id = 'inviter'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'commercial.affiliate-user.update.v1'`,
    ).get()).toEqual({ total: 1 })
  })

  it('atomically applies and replays batch rates with per-user control versions', async () => {
    const test = await fixture()
    const app = routes()
    const noVersions = await app.request('/admin/users/batch-rate', {
      method: 'POST',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-batch-no-versions',
      },
      body: JSON.stringify({ user_ids: ['inviter', 'outsider'], aff_rebate_rate_percent: 15 }),
    }, test.env)
    expect(noVersions.status).toBe(428)
    await expect(noVersions.json()).resolves.toMatchObject({ error: { code: 'control_version_required' } })

    const request = {
      method: 'POST',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-batch-rates-0001',
      },
      body: JSON.stringify({
        user_ids: ['inviter', 'outsider'],
        expected_control_versions: { inviter: 0, outsider: 0 },
        aff_rebate_rate_percent: 15,
      }),
    } as const
    const applied = await app.request('/admin/users/batch-rate', request, test.env)
    expect(applied.status).toBe(200)
    const appliedBody = await applied.json()
    expect(appliedBody).toMatchObject({
      data: { affected: 2, control_versions: { inviter: 1, outsider: 1 } },
    })
    const replay = await app.request('/admin/users/batch-rate', request, test.env)
    expect(await replay.json()).toEqual(appliedBody)

    const stale = await app.request('/admin/users/batch-rate', {
      method: 'POST',
      headers: {
        ...test.adminHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'affiliate-batch-rates-stale',
      },
      body: JSON.stringify({
        user_ids: ['inviter', 'outsider'],
        expected_control_versions: { inviter: 1, outsider: 0 },
        aff_rebate_rate_percent: 75,
      }),
    }, test.env)
    expect(stale.status).toBe(412)
    expect(test.raw.prepare(
      `SELECT user_id, rebate_rate_ppm, control_version FROM affiliate_profiles
        WHERE user_id IN ('inviter', 'outsider') ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'inviter', rebate_rate_ppm: 150000, control_version: 1 },
      { user_id: 'outsider', rebate_rate_ppm: 150000, control_version: 1 },
    ])
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'affiliate_user.batch_rate.update'`,
    ).get()).toEqual({ total: 2 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM control_idempotency
        WHERE scope = 'commercial.affiliate-user.batch-rate.v1'`,
    ).get()).toEqual({ total: 1 })
  })

  it('clears affiliate overrides once and returns the latest control version', async () => {
    const test = await fixture()
    const app = routes()
    const request = {
      method: 'DELETE',
      headers: {
        ...test.adminHeaders,
        'idempotency-key': 'affiliate-clear-replay-0001',
        'if-match': '0',
      },
    } as const
    const cleared = await app.request('/admin/users/inviter', request, test.env)
    expect(cleared.status).toBe(200)
    const firstBody = await cleared.json()
    expect(firstBody).toMatchObject({ data: { user_id: 'inviter', control_version: 1 } })
    const replay = await app.request('/admin/users/inviter', request, test.env)
    expect(await replay.json()).toEqual(firstBody)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM commercial_admin_audit_events
        WHERE action = 'affiliate_user.clear' AND resource_id = 'inviter'`,
    ).get()).toEqual({ total: 1 })
  })
})

function routes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/user/aff', getUserAffiliate)
  app.post('/user/aff/transfer', transferUserAffiliateQuota)
  app.post('/admin/accrue', accrueAdminAffiliateRebate)
  app.get('/admin/invites', listAdminAffiliateInvites)
  app.get('/admin/rebates', listAdminAffiliateRebates)
  app.get('/admin/transfers', listAdminAffiliateTransfers)
  app.get('/admin/users/:user_id/overview', getAdminAffiliateUserOverview)
  app.get('/admin/users/lookup', lookupAdminAffiliateUsers)
  app.post('/admin/users/batch-rate', batchUpdateAdminAffiliateRates)
  app.get('/admin/users', listAdminAffiliateUsers)
  app.put('/admin/users/:user_id', updateAdminAffiliateUser)
  app.delete('/admin/users/:user_id', clearAdminAffiliateUser)
  return app
}

async function fixture(state = new RecoveringUserState(false)) {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  for (const [id, email, role] of [
    ['admin', 'admin@example.test', 'admin'],
    ['inviter', 'inviter@example.test', 'user'],
    ['invitee', 'invitee@example.test', 'user'],
    ['outsider', 'outsider@example.test', 'user'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, id, role, now, now)
  }
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: { get: async () => ({ affiliate_enabled: true }) } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: state.namespace(), POOL_STATE: {} as DurableObjectNamespace,
  } satisfies Env
  for (const id of ['admin', 'inviter', 'invitee', 'outsider']) await ensureAffiliateProfile(env, id)
  const tokens: Record<string, string> = {}
  for (const id of ['admin', 'inviter', 'invitee', 'outsider']) {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `${id}-session`, `${id}-family`, id,
      await tokenDigest(access, PEPPER, 'access'), await tokenDigest(refresh, PEPPER, 'refresh'),
      now, now + DAY_MS, now + 30 * DAY_MS,
    )
    tokens[id] = access
  }
  return {
    raw, env,
    adminHeaders: { authorization: `Bearer ${tokens.admin}` },
    inviterHeaders: { authorization: `Bearer ${tokens.inviter}` },
    outsiderHeaders: { authorization: `Bearer ${tokens.outsider}` },
  }
}

async function bindReferral(test: Awaited<ReturnType<typeof fixture>>, attributedAt: number): Promise<void> {
  test.raw.prepare(
    `INSERT INTO affiliate_referrals (
       invitee_user_id, inviter_user_id, affiliate_code_prefix, attributed_at_ms
     ) VALUES ('invitee', 'inviter', 'AFFTEST', ?)`,
  ).run(attributedAt)
}

function seedCompletedPaymentOrder(
  test: Awaited<ReturnType<typeof fixture>>,
  orderId: string,
): void {
  const now = Date.now()
  test.raw.prepare(
    `INSERT OR IGNORE INTO payment_provider_instances (
       id, provider_key, provider_type, display_name,
       config_ciphertext, config_nonce, config_key_id, created_at_ms, updated_at_ms
     ) VALUES ('affiliate-stripe', 'stripe-primary', 'stripe', 'Stripe',
               'ciphertext', 'nonce', 'key-v1', ?, ?)`,
  ).run(now, now)
  test.raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, order_type, status,
       amount_micros, pay_amount_micros, paid_amount_micros, currency,
       expires_at_ms, paid_at_ms, completed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, 'invitee', 'affiliate-stripe', 'stripe-primary', ?, ?, ?,
               'balance', 'COMPLETED', 10000000, 10000000, 10000000, 'USD',
               ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    `trade-${orderId}`,
    orderId.padEnd(64, 'a').slice(0, 64),
    orderId.padEnd(64, 'b').slice(0, 64),
    now + DAY_MS,
    now,
    now,
    now,
    now,
  )
}

function seedSettledRefund(
  test: Awaited<ReturnType<typeof fixture>>,
  orderId: string,
  refundId: string,
  amountMicros: number,
): void {
  const now = Date.now()
  const status = amountMicros === 10_000_000 ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  test.raw.prepare(
    `UPDATE payment_orders
        SET status = ?, refunded_amount_micros = ?, refund_requested_at_ms = ?, refund_completed_at_ms = ?,
            version = version + 1, updated_at_ms = ?
      WHERE id = ?`,
  ).run(status, amountMicros, now, now, now, orderId)
  test.raw.prepare(
    `INSERT INTO payment_refunds (
       id, order_id, request_key_hash, provider_key, provider_refund_id,
       amount_micros, settled_amount_micros, currency, status, reason,
       created_at_ms, updated_at_ms, completed_at_ms
     ) VALUES (?, ?, ?, 'stripe-primary', ?, ?, ?, 'USD', 'refunded',
               'affiliate clawback test', ?, ?, ?)`,
  ).run(refundId, orderId, refundId.padEnd(64, 'f').slice(0, 64),
    `provider-${refundId}`, amountMicros, amountMicros, now, now, now)
}

async function addUser(test: Awaited<ReturnType<typeof fixture>>, id: string, email: string): Promise<void> {
  const now = Date.now()
  test.raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, email, id, now, now)
}

async function accrue(
  app: Hono<{ Bindings: Env }>,
  test: Awaited<ReturnType<typeof fixture>>,
  orderId: string,
  payMicros: number,
  invitee = 'invitee',
): Promise<Response> {
  return await app.request('/admin/accrue', {
    method: 'POST',
    headers: {
      ...test.adminHeaders,
      'content-type': 'application/json',
      'idempotency-key': `affiliate-admin-accrue-${orderId}`,
    },
    body: JSON.stringify({
      source_order_id: orderId,
      invitee_user_id: invitee,
      order_amount_micros: payMicros,
      pay_amount_micros: payMicros,
      out_trade_no: `trade-${orderId}`,
      payment_type: 'stripe',
      order_status: 'completed',
    }),
  }, test.env)
}

class RecoveringUserState {
  balanceMicros = 0
  reservedMicros = 0
  stateVersion = 0
  configured = false
  adjustApplications = 0
  private readonly mutations = new Map<string, number>()

  constructor(public loseNextAdjustResponse = true) {}

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get: () => ({ fetch: (request: Request) => this.fetch(request) }) as DurableObjectStub,
    } as unknown as DurableObjectNamespace
  }

  private async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/snapshot') return this.state(false)
    const body = await request.json() as any
    if (path === '/configure') {
      if (this.configured) {
        return Response.json({ schema_version: 1, error: { code: 'user_already_configured' } }, { status: 409 })
      }
      this.configured = true
      this.balanceMicros = body.balance_micros
      this.stateVersion = body.initial_state_version
      return this.state(false)
    }
    if (path === '/balance/adjust') {
      const existing = this.mutations.get(body.mutation_id)
      if (existing === undefined) {
        if (this.balanceMicros + body.amount_delta_micros < this.reservedMicros) {
          return Response.json({
            error: { code: 'balance_below_reservations', message: 'active reservations consume this balance' },
          }, { status: 409 })
        }
        this.balanceMicros += body.amount_delta_micros
        this.stateVersion += 1
        this.mutations.set(body.mutation_id, body.amount_delta_micros)
        this.adjustApplications += 1
        if (this.loseNextAdjustResponse) {
          this.loseNextAdjustResponse = false
          return Response.json({ error: { code: 'response_lost', message: 'response lost' } }, { status: 503 })
        }
      } else if (existing !== body.amount_delta_micros) {
        return Response.json({ error: { code: 'mutation_conflict' } }, { status: 409 })
      }
      return this.state(existing !== undefined)
    }
    return new Response('not found', { status: 404 })
  }

  private state(idempotent: boolean): Response {
    return Response.json({
      schema_version: 1,
      idempotent,
      state_version: this.stateVersion,
      profile: {
        user_id: 'inviter', enabled: true, balance_micros: this.balanceMicros,
        reserved_micros: this.reservedMicros, settled_micros: 0,
      },
      available_micros: this.balanceMicros - this.reservedMicros,
    })
  }
}

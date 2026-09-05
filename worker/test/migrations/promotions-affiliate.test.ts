import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('promotions and affiliate migration', () => {
  it('records the affiliate debt migration in the schema ledger', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    expect(raw.prepare(
      `SELECT version, name FROM schema_migrations WHERE version = 35`,
    ).get()).toEqual({ version: 35, name: 'affiliate_refund_debt' })
  })

  it('upgrades completed and processing affiliate adjustments from schema 34 safely', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 34)
    const now = Date.now()
    seedUser(raw, 'upgrade-inviter', 'upgrade-inviter@example.test', now)
    seedUser(raw, 'upgrade-first', 'upgrade-first@example.test', now)
    seedUser(raw, 'upgrade-second', 'upgrade-second@example.test', now)
    seedProfile(raw, 'upgrade-inviter', '1'.repeat(64), now)
    seedRefundableRebate(raw, 'completed', 'upgrade-inviter', 'upgrade-first', now)
    seedRefundableRebate(raw, 'processing', 'upgrade-inviter', 'upgrade-second', now + 1)
    seedLegacyAdjustment(raw, 'completed', now + 2)
    seedLegacyAdjustment(raw, 'processing', now + 3)
    raw.prepare(
      `UPDATE affiliate_rebate_adjustments
          SET status = 'completed', balance_after_micros = 98000000,
              state_version = 2, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = 'adjustment-completed'`,
    ).run(now + 4, now + 4)

    applyMigrations(raw)

    expect(raw.prepare(
      `SELECT status, balance_recovery_target_micros, balance_recovered_micros,
              debt_incurred_micros, debt_reopened_micros
         FROM affiliate_rebate_adjustments ORDER BY id`,
    ).all()).toEqual([
      {
        status: 'completed', balance_recovery_target_micros: 2_000_000,
        balance_recovered_micros: 2_000_000, debt_incurred_micros: 0,
        debt_reopened_micros: 0,
      },
      {
        status: 'processing', balance_recovery_target_micros: 2_000_000,
        balance_recovered_micros: 0, debt_incurred_micros: 0,
        debt_reopened_micros: 0,
      },
    ])
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    expect(raw.prepare(
      `SELECT "table", "from", "to" FROM pragma_foreign_key_list('affiliate_rebate_adjustments')
       ORDER BY "from"`,
    ).all()).toEqual([
      { table: 'affiliate_rebates', from: 'rebate_id', to: 'id' },
      { table: 'payment_refunds', from: 'refund_id', to: 'id' },
    ])

    raw.prepare(
      `UPDATE affiliate_rebate_adjustments
          SET status = 'completed', debt_incurred_micros = 2000000,
              completed_at_ms = ?, updated_at_ms = ?
        WHERE id = 'adjustment-processing'`,
    ).run(now + 5, now + 5)
    expect(raw.prepare(
      `SELECT debt_micros FROM affiliate_profiles WHERE user_id = 'upgrade-inviter'`,
    ).get()).toEqual({ debt_micros: 2_000_000 })

    seedRefundableRebate(raw, 'post-upgrade', 'upgrade-inviter', 'upgrade-first', now + 6)
    expect(raw.prepare(
      `SELECT amount_micros, debt_after_micros FROM affiliate_debt_repayments
        WHERE source_rebate_id = 'rebate-post-upgrade'`,
    ).get()).toEqual({ amount_micros: 2_000_000, debt_after_micros: 0 })
    raw.prepare(
      `INSERT INTO affiliate_rebate_adjustments (
         id, rebate_id, refund_id, adjustment_kind, quota_bucket,
         refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
         quota_clawback_micros, balance_clawback_micros, debt_reopened_micros,
         balance_recovery_target_micros, created_at_ms, updated_at_ms
       ) VALUES ('adjustment-post-upgrade', 'rebate-post-upgrade', 'refund-post-upgrade',
         'full_void', 'none', 10000000, 10000000, 2000000, 0, 0, 2000000,
         0, ?, ?)`,
    ).run(now + 7, now + 7)
    raw.prepare(
      `UPDATE affiliate_rebate_adjustments
          SET status = 'completed', completed_at_ms = ?, updated_at_ms = ?
        WHERE id = 'adjustment-post-upgrade'`,
    ).run(now + 8, now + 8)
    expect(raw.prepare(
      `SELECT debt_micros, history_micros FROM affiliate_profiles
        WHERE user_id = 'upgrade-inviter'`,
    ).get()).toEqual({ debt_micros: 2_000_000, history_micros: 0 })
    expect(() => raw.prepare(
      `UPDATE affiliate_rebate_adjustments SET adjustment_micros = 1
        WHERE id = 'adjustment-post-upgrade'`,
    ).run()).toThrow(/affiliate_rebate_adjustment_immutable/)
    expect(() => raw.prepare(
      `DELETE FROM payment_refunds WHERE id = 'refund-post-upgrade'`,
    ).run()).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('enforces hashed codes, atomic capacity, immutable attribution, and immutable ledgers', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    const now = Date.now()
    seedUser(raw, 'inviter', 'inviter@example.test', now)
    seedUser(raw, 'first', 'first@example.test', now)
    seedUser(raw, 'second', 'second@example.test', now)
    seedProfile(raw, 'inviter', 'a'.repeat(64), now)
    seedProfile(raw, 'first', 'b'.repeat(64), now)
    seedProfile(raw, 'second', 'c'.repeat(64), now)

    raw.prepare(
      `INSERT INTO promotion_codes (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, bonus_micros, max_uses, created_at_ms, updated_at_ms
       ) VALUES ('promo', ?, 'WELCOME', 1, 'AAAAAAAAAAAAAAAA',
         'BBBBBBBBBBBBBBBB', 5000000, 1, ?, ?)`,
    ).run('d'.repeat(64), now, now)
    raw.prepare(
      `INSERT INTO invitation_codes (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, max_uses, created_at_ms, updated_at_ms
       ) VALUES ('invite', ?, 'INVITE', 1, 'AAAAAAAAAAAAAAAA',
         'BBBBBBBBBBBBBBBB', 1, ?, ?)`,
    ).run('e'.repeat(64), now, now)

    raw.prepare(
      `INSERT INTO commercial_registration_claims (
         user_id, promotion_code_id, promotion_bonus_micros,
         invitation_code_id, inviter_user_id, affiliate_code_prefix, claimed_at_ms
       ) VALUES ('first', 'promo', 5000000, 'invite', 'inviter', 'AFF123', ?)`,
    ).run(now)
    expect(raw.prepare(
      `SELECT used_count FROM promotion_codes WHERE id = 'promo'`,
    ).get()).toEqual({ used_count: 1 })
    expect(raw.prepare(
      `SELECT used_count FROM invitation_codes WHERE id = 'invite'`,
    ).get()).toEqual({ used_count: 1 })
    expect(() => raw.prepare(
      `INSERT INTO commercial_registration_claims (
         user_id, promotion_code_id, promotion_bonus_micros,
         invitation_code_id, claimed_at_ms
       ) VALUES ('second', 'promo', 5000000, 'invite', ?)`,
    ).run(now)).toThrow(/promotion_code_unavailable|invitation_code_unavailable/)

    raw.prepare(
      `INSERT INTO affiliate_referrals (
         invitee_user_id, inviter_user_id, affiliate_code_prefix, attributed_at_ms
       ) VALUES ('first', 'inviter', 'AFF123', ?)`,
    ).run(now)
    expect(() => raw.prepare(
      `UPDATE affiliate_referrals SET inviter_user_id = 'second' WHERE invitee_user_id = 'first'`,
    ).run()).toThrow(/affiliate_attribution_immutable/)

    raw.prepare(
      `INSERT INTO affiliate_rebates (
         id, source_order_id, inviter_user_id, invitee_user_id,
         order_amount_micros, pay_amount_micros, rebate_micros,
         status, eligible_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('rebate', 'order', 'inviter', 'first',
         10000000, 10000000, 2000000, 'frozen', ?, ?, ?)`,
    ).run(now + 1000, now, now)
    expect(raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 0, frozen_micros: 2_000_000, history_micros: 2_000_000 })
    raw.prepare(
      `UPDATE affiliate_rebates SET status = 'available', control_version = 1,
              updated_at_ms = ? WHERE id = 'rebate'`,
    ).run(now + 1001)
    expect(raw.prepare(
      `SELECT available_micros, frozen_micros, history_micros
         FROM affiliate_profiles WHERE user_id = 'inviter'`,
    ).get()).toEqual({ available_micros: 2_000_000, frozen_micros: 0, history_micros: 2_000_000 })
    expect(() => raw.prepare(
      `UPDATE affiliate_ledger SET amount_delta_micros = 0 WHERE id = 'rebate:thaw'`,
    ).run()).toThrow(/affiliate_ledger_immutable/)

    expect(raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'affiliate_rebate_adjustments'`,
    ).get()).toEqual({ name: 'affiliate_rebate_adjustments' })
  })
})

function seedUser(raw: any, id: string, email: string, now: number): void {
  raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, email, id, now, now)
}

function seedProfile(raw: any, userId: string, hash: string, now: number): void {
  raw.prepare(
    `INSERT INTO affiliate_profiles (
       user_id, code_hash, code_prefix, code_key_version, code_nonce_b64,
       code_ciphertext_b64, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'AFF123', 1, 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', ?, ?)`,
  ).run(userId, hash, now, now)
}

function seedRefundableRebate(
  raw: any,
  suffix: string,
  inviterId: string,
  inviteeId: string,
  now: number,
): void {
  raw.prepare(
    `INSERT OR IGNORE INTO payment_provider_instances (
       id, provider_key, provider_type, display_name,
       config_ciphertext, config_nonce, config_key_id, created_at_ms, updated_at_ms
     ) VALUES ('upgrade-stripe', 'upgrade-stripe-key', 'stripe', 'Stripe',
               'ciphertext', 'nonce', 'key-v1', ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, order_type, status,
       amount_micros, pay_amount_micros, paid_amount_micros, refunded_amount_micros,
       currency, expires_at_ms, paid_at_ms, completed_at_ms,
       refund_requested_at_ms, refund_completed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'upgrade-stripe', 'upgrade-stripe-key', ?, ?, ?,
               'balance', 'REFUNDED', 10000000, 10000000, 10000000, 10000000,
               'USD', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `order-${suffix}`, inviteeId, `trade-${suffix}`,
    suffix.padEnd(64, 'a').slice(0, 64), suffix.padEnd(64, 'b').slice(0, 64),
    now + 86_400_000, now, now, now, now, now, now,
  )
  raw.prepare(
    `INSERT INTO affiliate_rebates (
       id, source_order_id, inviter_user_id, invitee_user_id,
       order_amount_micros, pay_amount_micros, rebate_micros,
       status, eligible_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, 10000000, 10000000, 2000000,
               'available', ?, ?, ?)`,
  ).run(`rebate-${suffix}`, `order-${suffix}`, inviterId, inviteeId, now, now, now)
  raw.prepare(
    `INSERT INTO payment_refunds (
       id, order_id, request_key_hash, provider_key, provider_refund_id,
       amount_micros, settled_amount_micros, currency, status, reason,
       created_at_ms, updated_at_ms, completed_at_ms
     ) VALUES (?, ?, ?, 'upgrade-stripe-key', ?, 10000000, 10000000,
               'USD', 'refunded', 'migration upgrade test', ?, ?, ?)`,
  ).run(
    `refund-${suffix}`, `order-${suffix}`, suffix.padEnd(64, 'c').slice(0, 64),
    `provider-refund-${suffix}`, now, now, now,
  )
}

function seedLegacyAdjustment(raw: any, suffix: string, now: number): void {
  raw.prepare(
    `INSERT INTO affiliate_rebate_adjustments (
       id, rebate_id, refund_id, adjustment_kind, quota_bucket,
       refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
       quota_clawback_micros, balance_clawback_micros,
       status, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'full_void', 'none', 10000000, 10000000,
               2000000, 0, 2000000, 'processing', ?, ?)`,
  ).run(`adjustment-${suffix}`, `rebate-${suffix}`, `refund-${suffix}`, now, now)
}

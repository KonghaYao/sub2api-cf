import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('promotions and affiliate migration', () => {
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

import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('email/password binding migration', () => {
  it('adds session-bound challenges with canonical-inbox uniqueness', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 36)
    applyMigrations(raw, 37)

    expect(raw.prepare(
      `SELECT version, name FROM schema_migrations WHERE version = 37`,
    ).get()).toEqual({ version: 37, name: 'email_password_binding' })
    expect(raw.prepare(
      `SELECT hidden FROM pragma_table_xinfo('users') WHERE name = 'canonical_email_inbox'`,
    ).get()).toEqual({ hidden: 2 })

    const now = Date.now()
    for (const id of ['first', 'second']) {
      raw.prepare(
        `INSERT INTO users (
           id, email, display_name, role, status, created_at_ms, updated_at_ms, auth_version
         ) VALUES (?, ?, ?, 'user', 'active', ?, ?, 1)`,
      ).run(id, `${id}@example.com`, id, now, now)
      raw.prepare(
        `INSERT INTO user_sessions (
           id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
           created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, '')`,
      ).run(
        `${id}-session`,
        `${id}-family`,
        id,
        id.repeat(64).slice(0, 64),
        `${id}refresh`.repeat(64).slice(0, 64),
        now,
        now + 1_000,
        now + 2_000,
      )
    }

    raw.prepare(
      `INSERT INTO email_binding_challenges (
         id, user_id, session_id, auth_version, email_hash, token_hash, generation,
         delivery_event_id, delivery_event_hash, requested_ip_hash,
         created_at_ms, expires_at_ms, updated_at_ms
       ) VALUES ('challenge', 'first', 'first-session', 1, ?, ?, 1, 'event', ?, ?, ?, ?, ?)`,
    ).run('b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), now, now + 1_000, now)
    expect(raw.prepare(
      `SELECT user_id, session_id, auth_version, purpose, status
         FROM email_binding_challenges WHERE id = 'challenge'`,
    ).get()).toEqual({
      user_id: 'first',
      session_id: 'first-session',
      auth_version: 1,
      purpose: 'email_binding',
      status: 'pending',
    })
    raw.prepare(`DELETE FROM user_sessions WHERE id = 'first-session'`).run()
    expect(raw.prepare(
      `SELECT COUNT(*) AS total FROM email_binding_challenges`,
    ).get()).toEqual({ total: 0 })
  })

  it('backfills canonical inbox uniqueness for every existing and future user row', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 37)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('canonical-first', 'some.one+first@gmail.com', 'first', ?, ?)`,
    ).run(now, now)

    expect(() => raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('canonical-second', 'someone+second@googlemail.com.', 'second', ?, ?)`,
    ).run(now, now)).toThrow(/UNIQUE constraint failed/)

    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('plus-first', 'ordinary+tag@example.com', 'plus-first', ?, ?)`,
    ).run(now, now)
    expect(() => raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES ('plus-second', 'ordinary@example.com.', 'plus-second', ?, ?)`,
    ).run(now, now)).toThrow(/UNIQUE constraint failed/)
  })

  it('fails closed when pre-0037 rows already contain conflicting canonical inboxes', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 36)
    const now = Date.now()
    for (const [id, email] of [
      ['legacy-first', 'pre.existing+one@gmail.com'],
      ['legacy-second', 'preexisting+two@googlemail.com'],
    ] as const) {
      raw.prepare(
        `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, email, id, now, now)
    }

    expect(() => applyMigrations(raw, 37)).toThrow(/UNIQUE constraint failed/)
  })
})

import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('commerce migration rolling-deploy compatibility', () => {
  it('backfills existing key access and preserves access for old-Worker writes after migration', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 10)
    raw.exec(`
      INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'user-1@example.com', 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES
        ('group-1', 'one', 'openai', 1, 1),
        ('group-2', 'two', 'openai', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms, group_id, key_prefix
      ) VALUES (
        'key-before', 'user-1', '${'a'.repeat(64)}', 'before', 2, 2, 'group-1', 'sk-before'
      );
    `)

    applyMigrations(raw, 11)

    expect(raw.prepare(
      'SELECT user_id, group_id FROM user_group_permissions WHERE user_id = ? AND group_id = ?',
    ).get('user-1', 'group-1')).toEqual({ user_id: 'user-1', group_id: 'group-1' })

    // These statements deliberately use only columns understood by the old Worker.
    raw.prepare(`
      INSERT INTO api_keys (
        id, user_id, key_hash, name, created_at_ms, updated_at_ms, group_id, key_prefix
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('key-during-deploy', 'user-1', 'b'.repeat(64), 'during', 3, 3, 'group-2', 'sk-during')
    expect(raw.prepare(
      'SELECT user_id, group_id FROM user_group_permissions WHERE user_id = ? AND group_id = ?',
    ).get('user-1', 'group-2')).toEqual({ user_id: 'user-1', group_id: 'group-2' })

    raw.prepare('DELETE FROM user_group_permissions WHERE user_id = ? AND group_id = ?')
      .run('user-1', 'group-2')
    raw.prepare('UPDATE api_keys SET group_id = ?, updated_at_ms = ? WHERE id = ?')
      .run('group-2', 4, 'key-before')
    expect(raw.prepare(
      'SELECT user_id, group_id FROM user_group_permissions WHERE user_id = ? AND group_id = ?',
    ).get('user-1', 'group-2')).toEqual({ user_id: 'user-1', group_id: 'group-2' })
    raw.close()
  })
})

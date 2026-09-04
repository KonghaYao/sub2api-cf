import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function insertUser(
  database: any,
  id: string,
  role: 'admin' | 'user' = 'admin',
  status: 'active' | 'disabled' = 'active',
): void {
  const now = Date.now()
  database.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.com`, id, role, status, now, now)
}

describe('admin RBAC migration', () => {
  it('backfills every active legacy administrator with an immutable super-admin role', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 16)
    insertUser(raw, 'active-admin')
    insertUser(raw, 'disabled-admin', 'admin', 'disabled')
    insertUser(raw, 'ordinary-user', 'user')

    applyMigrations(raw, 18)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 18').get()).toEqual({
      name: 'admin_rbac',
    })
    expect(raw.prepare(
      `SELECT user_id, role_id, active, control_version
         FROM admin_user_roles ORDER BY user_id`,
    ).all()).toEqual([{
      user_id: 'active-admin',
      role_id: 'super_admin',
      active: 1,
      control_version: 1,
    }])
    expect(raw.prepare('SELECT COUNT(*) AS count FROM admin_permissions').get()).toEqual({ count: 13 })
    expect(raw.prepare(
      `SELECT permission_key FROM admin_role_permissions
        WHERE role_id = 'read_only' ORDER BY permission_key`,
    ).all()).toEqual([
      { permission_key: 'admin.audit.read' },
      { permission_key: 'admin.catalog.read' },
      { permission_key: 'admin.commerce.read' },
      { permission_key: 'admin.operations.read' },
      { permission_key: 'admin.rbac.read' },
      { permission_key: 'admin.settings.read' },
      { permission_key: 'admin.users.read' },
    ])
    raw.close()
  })

  it('keeps built-in roles and their permission matrices immutable', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 18)

    expect(() => raw.prepare(
      `UPDATE admin_roles SET active = 0 WHERE id = 'super_admin'`,
    ).run()).toThrow(/system_admin_role_immutable/)
    expect(() => raw.prepare(
      `DELETE FROM admin_roles WHERE id = 'read_only'`,
    ).run()).toThrow(/system_admin_role_immutable/)
    expect(() => raw.prepare(
      `DELETE FROM admin_role_permissions
        WHERE role_id = 'admin' AND permission_key = 'admin.users.write'`,
    ).run()).toThrow(/system_admin_role_permissions_immutable/)
    expect(() => raw.prepare(
      `INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
       VALUES ('read_only', 'admin.users.write', ?)`,
    ).run(Date.now())).toThrow(/system_admin_role_permissions_immutable/)
    raw.close()
  })

  it('protects the final active super administrator at both assignment and user boundaries', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 18)
    insertUser(raw, 'admin-one')

    expect(() => raw.prepare(
      `UPDATE admin_user_roles
          SET active = 0, control_version = 2,
              revoked_at_ms = ?, revoked_by_user_id = ?
        WHERE user_id = 'admin-one' AND role_id = 'super_admin'`,
    ).run(Date.now(), 'admin-one')).toThrow(/last_super_admin/)
    expect(() => raw.prepare(
      `UPDATE users SET status = 'disabled' WHERE id = 'admin-one'`,
    ).run()).toThrow(/last_(super_)?admin/)
    expect(() => raw.prepare(
      `DELETE FROM users WHERE id = 'admin-one'`,
    ).run()).toThrow(/last_(super_)?admin/)

    insertUser(raw, 'admin-two')
    raw.prepare(
      `INSERT INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES ('admin-two', 'super_admin', 1, 1, 'admin-one', ?)`,
    ).run(Date.now())
    expect(raw.prepare(
      `UPDATE admin_user_roles
          SET active = 0, control_version = 2,
              revoked_at_ms = ?, revoked_by_user_id = ?
        WHERE user_id = 'admin-one' AND role_id = 'super_admin'`,
    ).run(Date.now(), 'admin-two').changes).toBe(1)
    raw.close()
  })

  it('automatically grants the first post-migration bootstrap administrator recovery access', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 18)

    insertUser(raw, 'bootstrap-admin')

    expect(raw.prepare(
      `SELECT role_id, active FROM admin_user_roles WHERE user_id = 'bootstrap-admin'`,
    ).get()).toEqual({ role_id: 'super_admin', active: 1 })
    raw.close()
  })
})

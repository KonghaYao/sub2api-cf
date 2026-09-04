PRAGMA foreign_keys = ON;

CREATE TABLE admin_permissions (
  permission_key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE admin_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  system_key TEXT UNIQUE CHECK (
    system_key IS NULL OR system_key IN ('super_admin', 'admin', 'read_only')
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX idx_admin_roles_active_name
  ON admin_roles(active, name, id);

CREATE TABLE admin_role_permissions (
  role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES admin_permissions(permission_key) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (role_id, permission_key)
) STRICT;

CREATE INDEX idx_admin_role_permissions_permission
  ON admin_role_permissions(permission_key, role_id);

CREATE TABLE admin_user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  control_version INTEGER NOT NULL DEFAULT 1 CHECK (control_version > 0),
  assigned_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at_ms INTEGER NOT NULL CHECK (assigned_at_ms >= 0),
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at_ms INTEGER CHECK (
    revoked_at_ms IS NULL OR revoked_at_ms >= assigned_at_ms
  ),
  PRIMARY KEY (user_id, role_id),
  CHECK (
    (active = 1 AND revoked_by_user_id IS NULL AND revoked_at_ms IS NULL)
    OR
    (active = 0 AND revoked_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_admin_user_roles_user_active
  ON admin_user_roles(user_id, active, role_id);

CREATE INDEX idx_admin_user_roles_role_active
  ON admin_user_roles(role_id, active, user_id);

CREATE TABLE admin_rbac_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'admin_role.create',
    'admin_role.update',
    'admin_role.delete',
    'admin_user_role.assign',
    'admin_user_role.revoke'
  )),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('admin_role', 'admin_user_role')),
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL CHECK (resource_version >= 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_admin_rbac_audit_actor_time
  ON admin_rbac_audit_events(actor_user_id, occurred_at_ms DESC, id);

CREATE INDEX idx_admin_rbac_audit_resource_time
  ON admin_rbac_audit_events(resource_type, resource_id, occurred_at_ms DESC, id);

CREATE TRIGGER prevent_admin_rbac_audit_update
BEFORE UPDATE ON admin_rbac_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_rbac_audit_immutable');
END;

CREATE TRIGGER prevent_admin_rbac_audit_delete
BEFORE DELETE ON admin_rbac_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_rbac_audit_immutable');
END;

INSERT INTO admin_permissions (permission_key, description, created_at_ms)
VALUES
  ('admin.settings.read', 'View system settings', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.settings.write', 'Change system settings and secrets', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.users.read', 'View users and their access resources', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.users.write', 'Create, update, and fund users and their API keys', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.catalog.read', 'View groups, models, prices, and upstream accounts', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.catalog.write', 'Change groups, models, prices, and upstream accounts', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.commerce.read', 'View plans, subscriptions, redemptions, and payments', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.commerce.write', 'Change plans, subscriptions, redemptions, and payments', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.operations.read', 'View operational state and failure details', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.operations.write', 'Retry, cancel, or recover operational work', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.audit.read', 'View security and administrative audit events', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.rbac.read', 'View administrative roles and assignments', CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('admin.rbac.write', 'Create roles and change administrative assignments', CAST(unixepoch('subsec') * 1000 AS INTEGER));

INSERT INTO admin_roles (
  id, name, description, system_key, active, control_version, created_at_ms, updated_at_ms
)
VALUES
  (
    'super_admin', 'Super administrator',
    'Built-in break-glass role with every administrative permission.',
    'super_admin', 1, 0,
    CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  ),
  (
    'admin', 'Administrator',
    'Built-in operational administrator without role-assignment authority.',
    'admin', 1, 0,
    CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  ),
  (
    'read_only', 'Read-only administrator',
    'Built-in role for viewing administrative state without mutation authority.',
    'read_only', 1, 0,
    CAST(unixepoch('subsec') * 1000 AS INTEGER),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  );

INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
SELECT 'super_admin', permission_key, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM admin_permissions;

INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
SELECT 'admin', permission_key, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM admin_permissions
 WHERE permission_key <> 'admin.rbac.write';

INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
SELECT 'read_only', permission_key, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM admin_permissions
 WHERE permission_key LIKE '%.read';

-- Every already-active legacy administrator keeps full access after this migration.
INSERT INTO admin_user_roles (
  user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
)
SELECT id, 'super_admin', 1, 1, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM users
 WHERE role = 'admin' AND status = 'active';

CREATE TRIGGER prevent_system_admin_role_update
BEFORE UPDATE ON admin_roles
FOR EACH ROW
WHEN OLD.system_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'system_admin_role_immutable');
END;

CREATE TRIGGER prevent_system_admin_role_delete
BEFORE DELETE ON admin_roles
FOR EACH ROW
WHEN OLD.system_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'system_admin_role_immutable');
END;

CREATE TRIGGER prevent_system_admin_role_permission_insert
BEFORE INSERT ON admin_role_permissions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM admin_roles WHERE id = NEW.role_id AND system_key IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'system_admin_role_permissions_immutable');
END;

CREATE TRIGGER prevent_system_admin_role_permission_update
BEFORE UPDATE ON admin_role_permissions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM admin_roles WHERE id = OLD.role_id AND system_key IS NOT NULL
)
OR EXISTS (
  SELECT 1 FROM admin_roles WHERE id = NEW.role_id AND system_key IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'system_admin_role_permissions_immutable');
END;

CREATE TRIGGER prevent_system_admin_role_permission_delete
BEFORE DELETE ON admin_role_permissions
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM admin_roles WHERE id = OLD.role_id AND system_key IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'system_admin_role_permissions_immutable');
END;

CREATE TRIGGER prevent_last_super_admin_assignment_update
BEFORE UPDATE OF user_id, role_id, active ON admin_user_roles
FOR EACH ROW
WHEN OLD.active = 1
 AND EXISTS (
   SELECT 1 FROM admin_roles WHERE id = OLD.role_id AND system_key = 'super_admin'
 )
 AND (NEW.active <> 1 OR NEW.user_id <> OLD.user_id OR NEW.role_id <> OLD.role_id)
 AND EXISTS (
   SELECT 1 FROM users
    WHERE id = OLD.user_id AND role = 'admin' AND status = 'active'
 )
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS other_assignment
     JOIN admin_roles AS other_role ON other_role.id = other_assignment.role_id
     JOIN users AS other_user ON other_user.id = other_assignment.user_id
    WHERE other_assignment.active = 1
      AND other_role.system_key = 'super_admin'
      AND other_user.role = 'admin'
      AND other_user.status = 'active'
      AND NOT (
        other_assignment.user_id = OLD.user_id
        AND other_assignment.role_id = OLD.role_id
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'last_super_admin');
END;

CREATE TRIGGER prevent_last_super_admin_assignment_delete
BEFORE DELETE ON admin_user_roles
FOR EACH ROW
WHEN OLD.active = 1
 AND EXISTS (
   SELECT 1 FROM admin_roles WHERE id = OLD.role_id AND system_key = 'super_admin'
 )
 AND EXISTS (
   SELECT 1 FROM users
    WHERE id = OLD.user_id AND role = 'admin' AND status = 'active'
 )
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS other_assignment
     JOIN admin_roles AS other_role ON other_role.id = other_assignment.role_id
     JOIN users AS other_user ON other_user.id = other_assignment.user_id
    WHERE other_assignment.active = 1
      AND other_role.system_key = 'super_admin'
      AND other_user.role = 'admin'
      AND other_user.status = 'active'
      AND NOT (
        other_assignment.user_id = OLD.user_id
        AND other_assignment.role_id = OLD.role_id
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'last_super_admin');
END;

CREATE TRIGGER prevent_last_super_admin_user_update
BEFORE UPDATE OF role, status ON users
FOR EACH ROW
WHEN OLD.role = 'admin'
 AND OLD.status = 'active'
 AND (NEW.role <> 'admin' OR NEW.status <> 'active')
 AND EXISTS (
   SELECT 1
     FROM admin_user_roles AS assignment
     JOIN admin_roles AS role ON role.id = assignment.role_id
    WHERE assignment.user_id = OLD.id
      AND assignment.active = 1
      AND role.system_key = 'super_admin'
 )
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS other_assignment
     JOIN admin_roles AS other_role ON other_role.id = other_assignment.role_id
     JOIN users AS other_user ON other_user.id = other_assignment.user_id
    WHERE other_assignment.active = 1
      AND other_role.system_key = 'super_admin'
      AND other_user.role = 'admin'
      AND other_user.status = 'active'
      AND other_user.id <> OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'last_super_admin');
END;

CREATE TRIGGER prevent_last_super_admin_user_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.role = 'admin'
 AND OLD.status = 'active'
 AND EXISTS (
   SELECT 1
     FROM admin_user_roles AS assignment
     JOIN admin_roles AS role ON role.id = assignment.role_id
    WHERE assignment.user_id = OLD.id
      AND assignment.active = 1
      AND role.system_key = 'super_admin'
 )
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS other_assignment
     JOIN admin_roles AS other_role ON other_role.id = other_assignment.role_id
     JOIN users AS other_user ON other_user.id = other_assignment.user_id
    WHERE other_assignment.active = 1
      AND other_role.system_key = 'super_admin'
      AND other_user.role = 'admin'
      AND other_user.status = 'active'
      AND other_user.id <> OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'last_super_admin');
END;

-- A fresh installation bootstrapped after this migration must also retain a recovery path.
CREATE TRIGGER assign_first_super_admin_after_insert
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'admin'
 AND NEW.status = 'active'
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS assignment
     JOIN admin_roles AS role ON role.id = assignment.role_id
     JOIN users AS user ON user.id = assignment.user_id
    WHERE assignment.active = 1
      AND role.system_key = 'super_admin'
      AND user.role = 'admin'
      AND user.status = 'active'
 )
BEGIN
  INSERT INTO admin_user_roles (
    user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
  ) VALUES (
    NEW.id, 'super_admin', 1, 1, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  );
END;

CREATE TRIGGER assign_first_super_admin_after_update
AFTER UPDATE OF role, status ON users
FOR EACH ROW
WHEN NEW.role = 'admin'
 AND NEW.status = 'active'
 AND (OLD.role <> 'admin' OR OLD.status <> 'active')
 AND NOT EXISTS (
   SELECT 1
     FROM admin_user_roles AS assignment
     JOIN admin_roles AS role ON role.id = assignment.role_id
     JOIN users AS user ON user.id = assignment.user_id
    WHERE assignment.active = 1
      AND role.system_key = 'super_admin'
      AND user.role = 'admin'
      AND user.status = 'active'
 )
BEGIN
  INSERT INTO admin_user_roles (
    user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
  ) VALUES (
    NEW.id, 'super_admin', 1, 1, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER)
  )
  ON CONFLICT(user_id, role_id) DO UPDATE SET
    active = 1,
    control_version = admin_user_roles.control_version + 1,
    assigned_by_user_id = NULL,
    assigned_at_ms = excluded.assigned_at_ms,
    revoked_by_user_id = NULL,
    revoked_at_ms = NULL;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (18, 'admin_rbac', CAST(unixepoch('subsec') * 1000 AS INTEGER));

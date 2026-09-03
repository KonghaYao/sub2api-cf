CREATE TRIGGER prevent_last_active_admin_update
BEFORE UPDATE OF role, status ON users
FOR EACH ROW
WHEN OLD.role = 'admin'
 AND OLD.status = 'active'
 AND (NEW.role <> 'admin' OR NEW.status <> 'active')
 AND NOT EXISTS (
   SELECT 1
     FROM users AS other
    WHERE other.id <> OLD.id
      AND other.role = 'admin'
      AND other.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;

CREATE TRIGGER prevent_last_active_admin_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.role = 'admin'
 AND OLD.status = 'active'
 AND NOT EXISTS (
   SELECT 1
     FROM users AS other
    WHERE other.id <> OLD.id
      AND other.role = 'admin'
      AND other.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (6, 'admin_invariants', CAST(unixepoch('subsec') * 1000 AS INTEGER));

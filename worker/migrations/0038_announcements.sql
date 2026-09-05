PRAGMA foreign_keys = ON;

-- Announcements are intentionally bounded while active so the user feed can be
-- evaluated in one indexed D1 read without a long-running Worker cursor.
CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  notify_mode TEXT NOT NULL CHECK (notify_mode IN ('silent', 'popup')),
  targeting_json TEXT NOT NULL DEFAULT '{"any_of":[]}' CHECK (json_valid(targeting_json)),
  starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= 0),
  ends_at_ms INTEGER CHECK (ends_at_ms IS NULL OR ends_at_ms >= 0),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  control_version INTEGER NOT NULL DEFAULT 1 CHECK (control_version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (starts_at_ms IS NULL OR ends_at_ms IS NULL OR starts_at_ms < ends_at_ms)
) STRICT;

CREATE INDEX idx_announcements_active_window
  ON announcements(status, starts_at_ms, ends_at_ms, created_at_ms DESC, id DESC);

CREATE INDEX idx_announcements_admin_created
  ON announcements(created_at_ms DESC, id DESC);

CREATE INDEX idx_announcements_admin_title
  ON announcements(title COLLATE NOCASE, id);

CREATE INDEX idx_users_announcement_email
  ON users(email COLLATE NOCASE, id);

CREATE INDEX idx_users_announcement_display_name
  ON users(display_name COLLATE NOCASE, id);

CREATE INDEX idx_users_announcement_balance
  ON users(balance_micros, id);

CREATE INDEX idx_users_announcement_created
  ON users(created_at_ms, id);

CREATE TABLE announcement_reads (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at_ms INTEGER NOT NULL CHECK (read_at_ms >= 0),
  PRIMARY KEY (announcement_id, user_id)
) STRICT;

CREATE INDEX idx_announcement_reads_user_time
  ON announcement_reads(user_id, read_at_ms DESC, announcement_id);

CREATE TABLE announcement_admin_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'announcement.create', 'announcement.update', 'announcement.delete'
  )),
  announcement_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_announcement_audit_time
  ON announcement_admin_audit_events(occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_announcement_audit_update
BEFORE UPDATE ON announcement_admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'announcement_audit_immutable');
END;

CREATE TRIGGER prevent_announcement_audit_delete
BEFORE DELETE ON announcement_admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'announcement_audit_immutable');
END;

CREATE TRIGGER limit_active_announcement_insert
BEFORE INSERT ON announcements
WHEN NEW.status = 'active'
 AND (SELECT COUNT(*) FROM announcements WHERE status = 'active') >= 500
BEGIN
  SELECT RAISE(ABORT, 'active_announcement_limit');
END;

CREATE TRIGGER limit_active_announcement_update
BEFORE UPDATE OF status ON announcements
WHEN NEW.status = 'active' AND OLD.status <> 'active'
 AND (SELECT COUNT(*) FROM announcements WHERE status = 'active') >= 500
BEGIN
  SELECT RAISE(ABORT, 'active_announcement_limit');
END;

-- Page-number compatibility is retained for the existing admin UI, so bound
-- the underlying collection and the maximum accepted page in the Worker.
CREATE TRIGGER limit_total_announcement_insert
BEFORE INSERT ON announcements
WHEN (SELECT COUNT(*) FROM announcements) >= 10000
BEGIN
  SELECT RAISE(ABORT, 'total_announcement_limit');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (38, 'announcements', CAST(unixepoch('subsec') * 1000 AS INTEGER));

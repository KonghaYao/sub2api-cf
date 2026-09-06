ALTER TABLE example ADD COLUMN description TEXT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (10, 'tenth', 10);

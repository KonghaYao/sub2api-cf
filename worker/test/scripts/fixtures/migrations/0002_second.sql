ALTER TABLE example ADD COLUMN name TEXT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (2, 'second', 2);

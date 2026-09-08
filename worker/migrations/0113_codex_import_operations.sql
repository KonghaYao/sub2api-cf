CREATE TABLE codex_import_operations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);
CREATE TABLE codex_import_items (
  operation_id TEXT NOT NULL REFERENCES codex_import_operations(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created','updated')),
  account_id TEXT NOT NULL,
  PRIMARY KEY(operation_id,item_index)
);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(113,'codex_import_operations',CAST(unixepoch('subsec')*1000 AS INTEGER));

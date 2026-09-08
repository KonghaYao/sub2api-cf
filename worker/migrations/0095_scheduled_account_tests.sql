CREATE TABLE scheduled_test_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL DEFAULT '',
  cron_expression TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  max_results INTEGER NOT NULL DEFAULT 50 CHECK(max_results>0),
  auto_recover INTEGER NOT NULL DEFAULT 0 CHECK(auto_recover IN (0,1)),
  last_run_at_ms INTEGER,
  next_run_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX scheduled_test_plans_due ON scheduled_test_plans(enabled,next_run_at_ms);
CREATE INDEX scheduled_test_plans_account ON scheduled_test_plans(account_id,id);
CREATE TABLE scheduled_test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES scheduled_test_plans(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  response_text TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX scheduled_test_results_plan ON scheduled_test_results(plan_id,id DESC);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(95,'scheduled_account_tests',CAST(unixepoch('subsec')*1000 AS INTEGER));

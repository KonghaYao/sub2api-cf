// Original Account.IsSchedulable: account expiration is Unix seconds and is
// independent from the OAuth credential's expiration. Evaluate against database
// time on every selection/credential read, including reads after route caching.
export function accountNotExpiredSql(): string {
  return `(COALESCE(json_extract(a.ui_config_json, '$.auto_pause_on_expired'), 1) = 0
    OR COALESCE(CAST(json_extract(a.ui_config_json, '$.expires_at') AS REAL), 0) <= 0
    OR CAST(json_extract(a.ui_config_json, '$.expires_at') AS REAL) > unixepoch('subsec'))`
}

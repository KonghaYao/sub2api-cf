/** Read database time even after route caching; expired cooldowns recover naturally. */
export function accountNotRateLimitedSql(): string {
  return `(COALESCE(unixepoch(json_extract(a.ui_config_json, '$.rate_limit_reset_at'), 'subsec'), 0) <= unixepoch('subsec'))`
}

/** Account-wide temporary failures and overload are independent of rate limits. */
export function accountNotTemporarilyBlockedSql(): string {
  return `(COALESCE(unixepoch(json_extract(a.ui_config_json, '$.temp_unschedulable_until'), 'subsec'), 0) <= unixepoch('subsec')
    AND COALESCE(unixepoch(json_extract(a.ui_config_json, '$.overload_until'), 'subsec'), 0) <= unixepoch('subsec'))`
}

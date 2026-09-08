import { accountNotExpiredSql } from '../gateway/account-expiry'
import { accountNotRateLimitedSql, accountNotTemporarilyBlockedSql } from '../gateway/account-rate-limit'

/** Group membership counts, independent of per-model capability configuration. */
export function groupAccountCountColumnsSql(): string {
  const membership = `FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
    WHERE ag.group_id = "groups".id`
  const eligible = `a.enabled = 1 AND a.health_status <> 'unhealthy'
    AND COALESCE(json_extract(a.ui_config_json, '$.schedulable'), 1) = 1
    AND ${accountNotExpiredSql()}`
  const outsideCooldown = `${accountNotRateLimitedSql()} AND ${accountNotTemporarilyBlockedSql()}`
  // Indexed correlated aggregates stay inside the list/detail query, avoiding
  // extra D1 round trips per group and counting each membership exactly once.
  return `(SELECT COUNT(*) ${membership}) AS account_count,
    (SELECT COUNT(*) ${membership} AND ${eligible} AND ${outsideCooldown}) AS active_account_count,
    (SELECT COUNT(*) ${membership} AND ${eligible} AND NOT (${outsideCooldown})) AS rate_limited_account_count`
}

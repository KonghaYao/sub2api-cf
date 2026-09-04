/**
 * SQL predicate for the groups a user may currently access.
 *
 * Callers control the table alias and user expression; both must be trusted SQL
 * fragments. With the default user expression it has four positional
 * bindings (user, user, window start, window end); a column expression such
 * as `u.id` leaves only the two timestamp bindings.
 */
export function groupAccessPredicate(
  groupAlias: string,
  userExpression = '?',
): string {
  return `(
    (${groupAlias}.group_type = 'standard' AND ${groupAlias}.is_exclusive = 0)
    OR EXISTS (
      SELECT 1 FROM user_group_permissions permission
       WHERE permission.user_id = ${userExpression}
         AND permission.group_id = ${groupAlias}.id
    )
    OR EXISTS (
      SELECT 1 FROM user_subscriptions subscription
       WHERE subscription.user_id = ${userExpression}
         AND subscription.group_id = ${groupAlias}.id
         AND subscription.status = 'active'
         AND subscription.starts_at_ms <= ?
         AND subscription.expires_at_ms > ?
    )
  )`
}

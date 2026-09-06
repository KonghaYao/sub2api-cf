function column(cid, name, type, notNull, defaultValue = null, primaryKey = 0) {
  return Object.freeze({ cid, name, type, not_null: notNull, default_value: defaultValue, primary_key: primaryKey })
}

export const SUBSCRIPTION_STATE_BACKUP_V1_SCHEMA = Object.freeze([
  Object.freeze({ name: 'subscription_profile', columns: Object.freeze([
    column(0, 'singleton', 'INTEGER', 0, null, 1),
    column(1, 'subscription_id', 'TEXT', 1), column(2, 'user_id', 'TEXT', 1),
    column(3, 'group_id', 'TEXT', 1), column(4, 'starts_at_ms', 'INTEGER', 1),
    column(5, 'expires_at_ms', 'INTEGER', 1), column(6, 'daily_quota_micros', 'INTEGER', 0),
    column(7, 'weekly_quota_micros', 'INTEGER', 0), column(8, 'monthly_quota_micros', 'INTEGER', 0),
    column(9, 'enabled', 'INTEGER', 1, '1'), column(10, 'daily_anchor_ms', 'INTEGER', 1, '0'),
    column(11, 'weekly_anchor_ms', 'INTEGER', 1), column(12, 'monthly_anchor_ms', 'INTEGER', 1),
    column(13, 'term_generation', 'INTEGER', 1, '1'), column(14, 'control_version', 'INTEGER', 1),
    column(15, 'quota_reset_epoch', 'INTEGER', 1, '0'),
    column(16, 'quota_reset_generation', 'INTEGER', 1, '0'), column(17, 'updated_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_windows', columns: Object.freeze([
    column(0, 'kind', 'TEXT', 1, null, 1), column(1, 'start_ms', 'INTEGER', 1, null, 2),
    column(2, 'end_ms', 'INTEGER', 1), column(3, 'used_micros', 'INTEGER', 1, '0'),
    column(4, 'updated_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_requests', columns: Object.freeze([
    column(0, 'request_id', 'TEXT', 1, null, 1), column(1, 'status', 'TEXT', 1),
    column(2, 'committed', 'INTEGER', 1, '0'), column(3, 'reserved_micros', 'INTEGER', 1),
    column(4, 'settled_micros', 'INTEGER', 0), column(5, 'reservation_expires_at_ms', 'INTEGER', 0),
    column(6, 'reservation_ttl_ms', 'INTEGER', 0), column(7, 'renewal_sequence', 'INTEGER', 1, '0'),
    column(8, 'last_renewal_ttl_ms', 'INTEGER', 0), column(9, 'daily_window_start_ms', 'INTEGER', 0),
    column(10, 'weekly_window_start_ms', 'INTEGER', 0), column(11, 'monthly_window_start_ms', 'INTEGER', 0),
    column(12, 'term_generation', 'INTEGER', 1, '0'), column(13, 'quota_reset_epoch', 'INTEGER', 1, '0'),
    column(14, 'authorized_at_ms', 'INTEGER', 1), column(15, 'updated_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_term_windows', columns: Object.freeze([
    column(0, 'term_generation', 'INTEGER', 1, null, 1),
    column(1, 'quota_reset_epoch', 'INTEGER', 1, null, 2), column(2, 'kind', 'TEXT', 1, null, 3),
    column(3, 'start_ms', 'INTEGER', 1, null, 4), column(4, 'end_ms', 'INTEGER', 1),
    column(5, 'used_micros', 'INTEGER', 1, '0'), column(6, 'updated_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_schema_migrations', columns: Object.freeze([
    column(0, 'version', 'INTEGER', 0, null, 1), column(1, 'applied_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_outbox', columns: Object.freeze([
    column(0, 'event_id', 'TEXT', 1, null, 1), column(1, 'dedupe_key', 'TEXT', 1),
    column(2, 'payload_json', 'TEXT', 1), column(3, 'attempts', 'INTEGER', 1, '0'),
    column(4, 'available_at_ms', 'INTEGER', 1), column(5, 'published_at_ms', 'INTEGER', 0),
    column(6, 'created_at_ms', 'INTEGER', 1),
  ]) }),
  Object.freeze({ name: 'subscription_mutations', columns: Object.freeze([
    column(0, 'mutation_id', 'TEXT', 1, null, 1), column(1, 'operation', 'TEXT', 1),
    column(2, 'payload_json', 'TEXT', 1), column(3, 'control_version', 'INTEGER', 1),
    column(4, 'created_at_ms', 'INTEGER', 1),
  ]) }),
])

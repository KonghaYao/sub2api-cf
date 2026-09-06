function column(cid, name, type, notNull, defaultValue = null, primaryKey = 0) {
  return Object.freeze({
    cid,
    name,
    type,
    not_null: notNull,
    default_value: defaultValue,
    primary_key: primaryKey,
  })
}

export const USER_STATE_BACKUP_V1_SCHEMA = Object.freeze([
  Object.freeze({
    name: 'user_profile',
    columns: Object.freeze([
      column(0, 'singleton', 'INTEGER', 0, null, 1),
      column(1, 'schema_version', 'INTEGER', 1),
      column(2, 'user_id', 'TEXT', 1),
      column(3, 'enabled', 'INTEGER', 1),
      column(4, 'balance_micros', 'INTEGER', 1),
      column(5, 'reserved_micros', 'INTEGER', 1),
      column(6, 'settled_micros', 'INTEGER', 1),
      column(7, 'spend_debt_micros', 'INTEGER', 1, '0'),
      column(8, 'updated_at_ms', 'INTEGER', 1),
    ]),
  }),
  Object.freeze({
    name: 'user_state_metadata',
    columns: Object.freeze([
      column(0, 'singleton', 'INTEGER', 0, null, 1),
      column(1, 'state_version', 'INTEGER', 1),
    ]),
  }),
  Object.freeze({
    name: 'user_ledger',
    columns: Object.freeze([
      column(0, 'mutation_key', 'TEXT', 1, null, 1),
      column(1, 'state_version', 'INTEGER', 0),
      column(2, 'schema_version', 'INTEGER', 1),
      column(3, 'mutation_id', 'TEXT', 1),
      column(4, 'entry_type', 'TEXT', 1),
      column(5, 'user_id', 'TEXT', 1),
      column(6, 'request_id', 'TEXT', 0),
      column(7, 'amount_delta_micros', 'INTEGER', 1),
      column(8, 'balance_after_micros', 'INTEGER', 1),
      column(9, 'enabled_after', 'INTEGER', 0),
      column(10, 'created_at_ms', 'INTEGER', 1),
    ]),
  }),
  Object.freeze({
    name: 'user_requests',
    columns: Object.freeze([
      column(0, 'request_id', 'TEXT', 1, null, 1),
      column(1, 'schema_version', 'INTEGER', 1),
      column(2, 'status', 'TEXT', 1),
      column(3, 'reserved_micros', 'INTEGER', 1),
      column(4, 'settled_micros', 'INTEGER', 0),
      column(5, 'committed', 'INTEGER', 1, '0'),
      column(6, 'funded_micros', 'INTEGER', 1, '0'),
      column(7, 'expired', 'INTEGER', 1, '0'),
      column(8, 'reservation_expires_at_ms', 'INTEGER', 0),
      column(9, 'reservation_ttl_ms', 'INTEGER', 0),
      column(10, 'renewal_sequence', 'INTEGER', 1, '0'),
      column(11, 'last_renewal_ttl_ms', 'INTEGER', 0),
      column(12, 'authorized_at_ms', 'INTEGER', 1),
      column(13, 'updated_at_ms', 'INTEGER', 1),
    ]),
  }),
  Object.freeze({
    name: 'user_ledger_tombstones',
    columns: Object.freeze([
      column(0, 'state_version', 'INTEGER', 0, null, 1),
      column(1, 'ledger_sequence', 'INTEGER', 1),
      column(2, 'mutation_key', 'TEXT', 1),
      column(3, 'mutation_id', 'TEXT', 1),
      column(4, 'user_id', 'TEXT', 1),
      column(5, 'balance_after_micros', 'INTEGER', 1),
      column(6, 'enabled_after', 'INTEGER', 1),
      column(7, 'created_at_ms', 'INTEGER', 1),
      column(8, 'tombstoned_at_ms', 'INTEGER', 1),
    ]),
  }),
  Object.freeze({
    name: 'user_outbox',
    columns: Object.freeze([
      column(0, 'event_id', 'TEXT', 1, null, 1),
      column(1, 'request_id', 'TEXT', 1),
      column(2, 'payload_json', 'TEXT', 1),
      column(3, 'attempts', 'INTEGER', 1, '0'),
      column(4, 'available_at_ms', 'INTEGER', 1),
      column(5, 'published_at_ms', 'INTEGER', 0),
      column(6, 'created_at_ms', 'INTEGER', 1),
    ]),
  }),
])

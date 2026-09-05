import {
  json,
  requireBoolean,
  requireSafeInteger,
  requireString,
  StateApiError,
} from './http'

export type PlatformQuotaWindowKind = 'daily' | 'weekly' | 'monthly'
type PlatformQuotaReservationStatus = 'reserved' | 'settled' | 'cancelled' | 'expired'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const MAX_RESERVATION_TTL_MS = DAY_MS
const TOMBSTONE_RETENTION_MS = 7 * DAY_MS
const PLATFORM_QUOTA_PLATFORMS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'antigravity',
  'grok',
])

interface PlatformQuotaProfileRow {
  platform: string
  enabled: number
  control_version: number
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number
  weekly_window_start_ms: number
  monthly_window_start_ms: number
  daily_reset_epoch: number
  weekly_reset_epoch: number
  monthly_reset_epoch: number
  created_at_ms: number
  updated_at_ms: number
}

interface PlatformQuotaConfigureInput {
  user_id: string
  platform: string
  enabled: boolean
  control_version: number
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  daily_reset_epoch: number
  weekly_reset_epoch: number
  monthly_reset_epoch: number
}

interface PlatformQuotaReservationRow {
  request_id: string
  user_id: string
  platform: string
  control_version: number
  daily_reset_epoch: number
  weekly_reset_epoch: number
  monthly_reset_epoch: number
  daily_window_start_ms: number
  weekly_window_start_ms: number
  monthly_window_start_ms: number
  status: PlatformQuotaReservationStatus
  reserved_micros: number
  committed: number
  settled_micros: number | null
  reservation_expires_at_ms: number
  reservation_ttl_ms: number
  renewal_sequence: number
  last_renewal_ttl_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

export class PlatformQuotaLimitError extends StateApiError {
  constructor(
    readonly window: PlatformQuotaWindowKind,
    readonly retryAfterSeconds: number,
  ) {
    super(
      429,
      `user_platform_${window}_quota_exceeded`,
      `${capitalize(window)} usage quota is exhausted for this platform`,
    )
  }
}

/**
 * User-sharded platform-quota authority embedded in API_KEY_LIMIT_STATE.
 *
 * All methods run inside the parent Durable Object's synchronous SQLite
 * transaction boundary. D1 remains the configuration source and eventual
 * projection; this state is the live admission authority.
 */
export class PlatformQuotaState {
  constructor(private readonly storage: DurableObjectStorage) {
    this.initializeSchema()
  }

  handle(pathname: string, body: Record<string, unknown>, now = Date.now()): Response {
    if (pathname === '/platform-quota/configure') return this.configure(body, now)
    if (pathname === '/platform-quota/reserve') return this.reserve(body, now)
    if (pathname === '/platform-quota/ensure') return this.ensure(body, now)
    if (pathname === '/platform-quota/renew') return this.renew(body, now)
    if (pathname === '/platform-quota/settle') return this.settle(body, now)
    if (pathname === '/platform-quota/cancel') return this.cancel(body, now)
    throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
  }

  snapshot(now = Date.now()): Record<string, unknown> {
    this.expireReservations(now)
    const profiles = Array.from(this.storage.sql.exec(
      `${profileSelect()} ORDER BY platform ASC`,
    )) as unknown as PlatformQuotaProfileRow[]
    for (const profile of profiles) this.ensureCurrentWindows(profile, now)
    return {
      profiles: profiles.map((profile) => this.readProfile(profile.platform)),
      reservations: Array.from(this.storage.sql.exec(
        `${reservationSelect()} ORDER BY created_at_ms ASC, request_id ASC`,
      )),
    }
  }

  expireReservations(now = Date.now()): number {
    const row = firstRow<{ count: number }>(this.storage.sql.exec(
      `SELECT COUNT(*) AS count FROM platform_quota_reservations
        WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
      now,
    ))
    const count = validCount(row?.count)
    if (count > 0) {
      this.storage.sql.exec(
        `UPDATE platform_quota_reservations
            SET status = 'expired', updated_at_ms = ?
          WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
        now,
        now,
      )
    }
    return count
  }

  cleanup(now = Date.now()): void {
    this.storage.sql.exec(
      `DELETE FROM platform_quota_reservations
        WHERE status <> 'reserved' AND committed = 0 AND updated_at_ms < ?`,
      now - TOMBSTONE_RETENTION_MS,
    )
  }

  nextReservationExpiry(): number | null {
    const row = firstRow<{ expires_at_ms: number | null }>(this.storage.sql.exec(
      `SELECT MIN(reservation_expires_at_ms) AS expires_at_ms
         FROM platform_quota_reservations WHERE status = 'reserved' AND committed = 0`,
    ))
    return Number.isSafeInteger(row?.expires_at_ms) ? row!.expires_at_ms : null
  }

  private configure(body: Record<string, unknown>, now: number): Response {
    const input = parseConfigure(body, now)
    this.assertOwner(input.user_id, true)
    this.expireReservations(now)
    const existing = this.readProfile(input.platform)
    if (existing !== null) {
      this.ensureCurrentWindows(existing, now)
      const current = this.readProfile(input.platform)!
      if (input.control_version < current.control_version) {
        return json({ schema_version: 1, idempotent: true, stale: true, profile: current })
      }
      if (input.control_version === current.control_version) {
        if (!samePolicy(current, input)) {
          throw new StateApiError(
            409,
            'platform_quota_configuration_conflict',
            'control_version was already used with different platform quota values',
          )
        }
        return json({ schema_version: 1, idempotent: true, profile: current })
      }
      for (const kind of windowKinds()) {
        if (input[`${kind}_reset_epoch`] < current[`${kind}_reset_epoch`]) {
          throw new StateApiError(
            409,
            'platform_quota_reset_epoch_regressed',
            'A newer control version cannot move a platform quota reset epoch backwards',
          )
        }
      }
      const next = importedProfile(input, now)
      const values: unknown[] = [
        input.enabled ? 1 : 0,
        input.control_version,
        input.daily_limit_micros,
        input.weekly_limit_micros,
        input.monthly_limit_micros,
      ]
      for (const kind of windowKinds()) {
        const resets = input[`${kind}_reset_epoch`] > current[`${kind}_reset_epoch`]
        values.push(
          resets ? next[`${kind}_used_micros`] : current[`${kind}_used_micros`],
          resets ? next[`${kind}_window_start_ms`] : current[`${kind}_window_start_ms`],
          input[`${kind}_reset_epoch`],
        )
      }
      this.storage.sql.exec(
        `UPDATE platform_quota_profiles
            SET enabled = ?, control_version = ?,
                daily_limit_micros = ?, weekly_limit_micros = ?, monthly_limit_micros = ?,
                daily_used_micros = ?, daily_window_start_ms = ?, daily_reset_epoch = ?,
                weekly_used_micros = ?, weekly_window_start_ms = ?, weekly_reset_epoch = ?,
                monthly_used_micros = ?, monthly_window_start_ms = ?, monthly_reset_epoch = ?,
                updated_at_ms = ?
          WHERE platform = ?`,
        ...values,
        now,
        input.platform,
      )
      return json({ schema_version: 1, idempotent: false, profile: this.readProfile(input.platform) })
    }

    const profile = importedProfile(input, now)
    this.storage.sql.exec(
      `INSERT INTO platform_quota_profiles (
         platform, enabled, control_version,
         daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
         daily_used_micros, weekly_used_micros, monthly_used_micros,
         daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
         daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      profile.platform,
      profile.enabled,
      profile.control_version,
      profile.daily_limit_micros,
      profile.weekly_limit_micros,
      profile.monthly_limit_micros,
      profile.daily_used_micros,
      profile.weekly_used_micros,
      profile.monthly_used_micros,
      profile.daily_window_start_ms,
      profile.weekly_window_start_ms,
      profile.monthly_window_start_ms,
      profile.daily_reset_epoch,
      profile.weekly_reset_epoch,
      profile.monthly_reset_epoch,
      now,
      now,
    )
    return json({ schema_version: 1, idempotent: false, profile: this.readProfile(input.platform) })
  }

  private reserve(body: Record<string, unknown>, now: number): Response {
    const requestId = requireString(body, 'request_id', 256)
    const userId = requireString(body, 'user_id', 128)
    const platform = requirePlatform(body.platform)
    const controlVersion = requireSafeInteger(body, 'control_version')
    const amount = requireSafeInteger(body, 'amount_micros')
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', {
      minimum: 1,
      maximum: MAX_RESERVATION_TTL_MS,
    })
    this.assertOwner(userId, false)
    this.expireReservations(now)
    const replay = this.readReservation(requestId)
    if (replay !== null) {
      if (
        replay.user_id !== userId || replay.platform !== platform ||
        replay.control_version !== controlVersion || replay.reserved_micros !== amount ||
        replay.reservation_ttl_ms !== ttl
      ) {
        throw new StateApiError(
          409,
          'platform_quota_reservation_conflict',
          'request_id was already reserved with different platform quota values',
        )
      }
      if (replay.status !== 'reserved') {
        throw new StateApiError(
          409,
          'platform_quota_invalid_transition',
          `Cannot reserve a ${replay.status} platform quota request`,
        )
      }
      return json({ schema_version: 1, reserved: true, idempotent: true, reservation: replay })
    }

    let profile = this.requireProfile(platform)
    this.ensureCurrentWindows(profile, now)
    profile = this.requireProfile(platform)
    if (profile.enabled !== 1) {
      throw new StateApiError(409, 'platform_quota_not_enabled', 'Platform quota is not enabled')
    }
    if (profile.control_version !== controlVersion) {
      throw new StateApiError(
        409,
        'platform_quota_control_version_conflict',
        'Reservation control_version does not match current platform quota',
      )
    }
    for (const kind of windowKinds()) {
      const used = profile[`${kind}_used_micros`]
      const reserved = this.activeReserved(profile, kind)
      const limit = profile[`${kind}_limit_micros`]
      if (limitExceeded(limit, used, reserved, amount)) {
        throw new PlatformQuotaLimitError(
          kind,
          retryAfter(now, profile[`${kind}_window_start_ms`], kind),
        )
      }
    }
    this.storage.sql.exec(
      `INSERT INTO platform_quota_reservations (
         request_id, user_id, platform, control_version,
         daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
         daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
         status, reserved_micros, settled_micros,
         reservation_expires_at_ms, reservation_ttl_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, ?, ?, ?, ?)`,
      requestId,
      userId,
      platform,
      controlVersion,
      profile.daily_reset_epoch,
      profile.weekly_reset_epoch,
      profile.monthly_reset_epoch,
      profile.daily_window_start_ms,
      profile.weekly_window_start_ms,
      profile.monthly_window_start_ms,
      amount,
      checkedSum(now, ttl),
      ttl,
      now,
      now,
    )
    return json({
      schema_version: 1,
      reserved: true,
      idempotent: false,
      reservation: this.readReservation(requestId),
    })
  }

  private settle(body: Record<string, unknown>, now: number): Response {
    const requestId = requireString(body, 'request_id', 256)
    const userId = requireString(body, 'user_id', 128)
    const platform = requirePlatform(body.platform)
    const amount = requireSafeInteger(body, 'amount_micros')
    this.assertOwner(userId, false)
    this.expireReservations(now)
    const reservation = this.readReservation(requestId)
    if (reservation === null) {
      throw new StateApiError(404, 'platform_quota_reservation_not_found', 'Platform quota reservation was not found')
    }
    if (reservation.user_id !== userId || reservation.platform !== platform) {
      throw new StateApiError(409, 'platform_quota_identity_conflict', 'Platform quota reservation belongs to another identity')
    }
    if (reservation.status === 'settled') {
      if (reservation.settled_micros !== amount) {
        throw new StateApiError(
          409,
          'platform_quota_settlement_conflict',
          'request_id was already settled with a different amount',
        )
      }
      return json({
        schema_version: 1,
        idempotent: true,
        reservation,
        usage: this.usageSnapshot(userId, platform, now),
      })
    }
    if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
      throw new StateApiError(
        409,
        'platform_quota_invalid_transition',
        `Cannot settle a ${reservation.status} platform quota reservation`,
      )
    }
    if (reservation.committed === 1 && amount !== reservation.reserved_micros) {
      throw new StateApiError(
        409,
        'platform_quota_settlement_conflict',
        'Committed platform quota reservation must settle its exact target amount',
      )
    }
    if (amount > reservation.reserved_micros) {
      throw new StateApiError(
        409,
        'platform_quota_settlement_exceeds_reservation',
        'Settled amount cannot exceed the reserved amount',
      )
    }
    let profile = this.requireProfile(platform)
    this.ensureCurrentWindows(profile, now)
    profile = this.requireProfile(platform)
    for (const kind of windowKinds()) {
      if (
        reservation[`${kind}_reset_epoch`] === profile[`${kind}_reset_epoch`] &&
        reservation[`${kind}_window_start_ms`] === profile[`${kind}_window_start_ms`]
      ) {
        this.storage.sql.exec(
          `UPDATE platform_quota_profiles
              SET ${kind}_used_micros = ?, updated_at_ms = ? WHERE platform = ?`,
          checkedSum(profile[`${kind}_used_micros`], amount),
          now,
          platform,
        )
      }
    }
    this.storage.sql.exec(
      `UPDATE platform_quota_reservations
          SET status = 'settled', settled_micros = ?, updated_at_ms = ?
        WHERE request_id = ? AND status IN ('reserved', 'expired')`,
      amount,
      now,
      requestId,
    )
    return json({
      schema_version: 1,
      idempotent: false,
      reservation: this.readReservation(requestId),
      usage: this.usageSnapshot(userId, platform, now),
    })
  }

  private ensure(body: Record<string, unknown>, now: number): Response {
    const requestId = requireString(body, 'request_id', 256)
    const userId = requireString(body, 'user_id', 128)
    const platform = requirePlatform(body.platform)
    const targetAmount = requireSafeInteger(body, 'target_amount_micros')
    this.assertOwner(userId, false)
    this.expireReservations(now)
    const reservation = this.readReservation(requestId)
    if (reservation === null) {
      throw new StateApiError(404, 'platform_quota_reservation_not_found', 'Platform quota reservation was not found')
    }
    if (reservation.user_id !== userId || reservation.platform !== platform) {
      throw new StateApiError(409, 'platform_quota_identity_conflict', 'Platform quota reservation belongs to another identity')
    }
    if (reservation.status === 'settled') {
      if (reservation.settled_micros !== targetAmount) {
        throw new StateApiError(
          409,
          'platform_quota_ensure_conflict',
          'Settled platform quota amount does not match the committed target',
        )
      }
      return json({
        schema_version: 1,
        idempotent: true,
        reservation,
        usage: this.usageSnapshot(userId, platform, now),
      })
    }
    if (reservation.committed === 1) {
      if (reservation.reserved_micros !== targetAmount) {
        throw new StateApiError(
          409,
          'platform_quota_ensure_conflict',
          'Platform quota reservation was already committed with a different amount',
        )
      }
      return json({
        schema_version: 1,
        idempotent: true,
        reservation,
        usage: this.usageSnapshot(userId, platform, now),
      })
    }
    if (targetAmount < reservation.reserved_micros) {
      throw new StateApiError(
        409,
        'platform_quota_ensure_below_reservation',
        'Committed amount cannot be less than the original reservation',
      )
    }
    if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
      throw new StateApiError(
        409,
        'platform_quota_invalid_transition',
        `Cannot commit a ${reservation.status} platform quota reservation`,
      )
    }
    this.storage.sql.exec(
      `UPDATE platform_quota_reservations
          SET reserved_micros = ?, committed = 1, updated_at_ms = ?
        WHERE request_id = ?`,
      targetAmount,
      now,
      requestId,
    )
    return json({
      schema_version: 1,
      idempotent: false,
      reservation: this.readReservation(requestId),
      usage: this.usageSnapshot(userId, platform, now),
    })
  }

  private renew(body: Record<string, unknown>, now: number): Response {
    const requestId = requireString(body, 'request_id', 256)
    const userId = requireString(body, 'user_id', 128)
    const platform = requirePlatform(body.platform)
    const renewalSequence = requireSafeInteger(body, 'renewal_sequence', { minimum: 1 })
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', {
      minimum: 1,
      maximum: MAX_RESERVATION_TTL_MS,
    })
    this.assertOwner(userId, false)
    this.expireReservations(now)
    const reservation = this.readReservation(requestId)
    if (reservation === null || reservation.user_id !== userId || reservation.platform !== platform) {
      throw new StateApiError(404, 'platform_quota_reservation_not_found', 'Platform quota reservation was not found')
    }
    if (reservation.status !== 'reserved') {
      throw new StateApiError(409, 'platform_quota_invalid_transition', 'Platform quota reservation is no longer active')
    }
    if (renewalSequence < reservation.renewal_sequence) {
      return json({ schema_version: 1, idempotent: true, reservation })
    }
    if (renewalSequence === reservation.renewal_sequence) {
      if (reservation.last_renewal_ttl_ms !== ttl) {
        throw new StateApiError(409, 'platform_quota_renewal_conflict', 'Renewal sequence was replayed with different input')
      }
      return json({ schema_version: 1, idempotent: true, reservation })
    }
    if (renewalSequence !== reservation.renewal_sequence + 1) {
      throw new StateApiError(409, 'platform_quota_renewal_out_of_order', 'Renewal sequence must increase by one')
    }
    this.storage.sql.exec(
      `UPDATE platform_quota_reservations
          SET reservation_expires_at_ms = ?, renewal_sequence = ?,
              last_renewal_ttl_ms = ?, updated_at_ms = ?
        WHERE request_id = ? AND status = 'reserved'`,
      checkedSum(now, ttl),
      renewalSequence,
      ttl,
      now,
      requestId,
    )
    return json({ schema_version: 1, idempotent: false, reservation: this.readReservation(requestId) })
  }

  private cancel(body: Record<string, unknown>, now: number): Response {
    const requestId = requireString(body, 'request_id', 256)
    const userId = requireString(body, 'user_id', 128)
    const platform = requirePlatform(body.platform)
    this.assertOwner(userId, false)
    this.expireReservations(now)
    const reservation = this.readReservation(requestId)
    if (reservation === null) {
      return json({ schema_version: 1, idempotent: true, reservation: null })
    }
    if (reservation.user_id !== userId || reservation.platform !== platform) {
      throw new StateApiError(409, 'platform_quota_identity_conflict', 'Platform quota reservation belongs to another identity')
    }
    if (reservation.status === 'settled' || reservation.committed === 1) {
      throw new StateApiError(
        409,
        'platform_quota_invalid_transition',
        'Cannot cancel a settled or committed platform quota reservation',
      )
    }
    if (reservation.status !== 'reserved') {
      return json({ schema_version: 1, idempotent: true, reservation })
    }
    this.storage.sql.exec(
      `UPDATE platform_quota_reservations SET status = 'cancelled', updated_at_ms = ?
        WHERE request_id = ? AND status = 'reserved'`,
      now,
      requestId,
    )
    return json({
      schema_version: 1,
      idempotent: false,
      reservation: this.readReservation(requestId),
    })
  }

  private assertOwner(userId: string, create: boolean): void {
    const owner = firstRow<{ user_id: string }>(this.storage.sql.exec(
      'SELECT user_id FROM platform_quota_owner WHERE singleton = 1',
    ))
    if (owner === undefined) {
      if (!create) throw new StateApiError(409, 'platform_quota_not_configured', 'Platform quota owner is not configured')
      this.storage.sql.exec(
        'INSERT INTO platform_quota_owner (singleton, user_id) VALUES (1, ?)',
        userId,
      )
      return
    }
    if (owner.user_id !== userId) {
      throw new StateApiError(409, 'platform_quota_owner_conflict', 'Platform quota shard belongs to another user')
    }
  }

  private readProfile(platform: string): PlatformQuotaProfileRow | null {
    return (firstRow<PlatformQuotaProfileRow>(this.storage.sql.exec(
      `${profileSelect()} WHERE platform = ?`,
      platform,
    )) ?? null)
  }

  private requireProfile(platform: string): PlatformQuotaProfileRow {
    const profile = this.readProfile(platform)
    if (profile === null) {
      throw new StateApiError(409, 'platform_quota_not_configured', 'Platform quota must be configured before reservation')
    }
    return profile
  }

  private readReservation(requestId: string): PlatformQuotaReservationRow | null {
    return (firstRow<PlatformQuotaReservationRow>(this.storage.sql.exec(
      `${reservationSelect()} WHERE request_id = ?`,
      requestId,
    )) ?? null)
  }

  private ensureCurrentWindows(profile: PlatformQuotaProfileRow, now: number): void {
    const starts = {
      daily: utcDayStart(now),
      weekly: utcWeekStart(now),
      monthly: profile.monthly_window_start_ms,
    }
    if (now - starts.monthly >= MONTH_MS) starts.monthly = now
    const resetKinds = windowKinds().filter((kind) => starts[kind] !== profile[`${kind}_window_start_ms`])
    if (resetKinds.length === 0) return
    const assignments: string[] = []
    const values: unknown[] = []
    for (const kind of resetKinds) {
      assignments.push(`${kind}_used_micros = 0`, `${kind}_window_start_ms = ?`)
      values.push(starts[kind])
    }
    this.storage.sql.exec(
      `UPDATE platform_quota_profiles SET ${assignments.join(', ')}, updated_at_ms = ? WHERE platform = ?`,
      ...values,
      now,
      profile.platform,
    )
  }

  private activeReserved(profile: PlatformQuotaProfileRow, kind: PlatformQuotaWindowKind): number {
    const row = firstRow<{ amount: number }>(this.storage.sql.exec(
      `SELECT COALESCE(SUM(reserved_micros), 0) AS amount
         FROM platform_quota_reservations
        WHERE platform = ?
          AND (status = 'reserved' OR (status = 'expired' AND committed = 1))
          AND ${kind}_reset_epoch = ? AND ${kind}_window_start_ms = ?`,
      profile.platform,
      profile[`${kind}_reset_epoch`],
      profile[`${kind}_window_start_ms`],
    ))
    return validCount(row?.amount)
  }

  private usageSnapshot(userId: string, platform: string, now: number): Record<string, unknown> {
    let profile = this.requireProfile(platform)
    this.ensureCurrentWindows(profile, now)
    profile = this.requireProfile(platform)
    const window = (kind: PlatformQuotaWindowKind) => ({
      reset_epoch: profile[`${kind}_reset_epoch`],
      window_start_ms: profile[`${kind}_window_start_ms`],
      settled_micros: profile[`${kind}_used_micros`],
      active_reserved_micros: this.activeReserved(profile, kind),
      updated_at_ms: profile.updated_at_ms,
    })
    return {
      user_id: userId,
      platform,
      control_version: profile.control_version,
      daily: window('daily'),
      weekly: window('weekly'),
      monthly: window('monthly'),
    }
  }

  private initializeSchema(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS platform_quota_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        user_id TEXT NOT NULL
      ) STRICT
    `)
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS platform_quota_profiles (
        platform TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        daily_limit_micros INTEGER CHECK (daily_limit_micros IS NULL OR daily_limit_micros >= 0),
        weekly_limit_micros INTEGER CHECK (weekly_limit_micros IS NULL OR weekly_limit_micros >= 0),
        monthly_limit_micros INTEGER CHECK (monthly_limit_micros IS NULL OR monthly_limit_micros >= 0),
        daily_used_micros INTEGER NOT NULL CHECK (daily_used_micros >= 0),
        weekly_used_micros INTEGER NOT NULL CHECK (weekly_used_micros >= 0),
        monthly_used_micros INTEGER NOT NULL CHECK (monthly_used_micros >= 0),
        daily_window_start_ms INTEGER NOT NULL CHECK (daily_window_start_ms >= 0),
        weekly_window_start_ms INTEGER NOT NULL CHECK (weekly_window_start_ms >= 0),
        monthly_window_start_ms INTEGER NOT NULL CHECK (monthly_window_start_ms >= 0),
        daily_reset_epoch INTEGER NOT NULL CHECK (daily_reset_epoch >= 0),
        weekly_reset_epoch INTEGER NOT NULL CHECK (weekly_reset_epoch >= 0),
        monthly_reset_epoch INTEGER NOT NULL CHECK (monthly_reset_epoch >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS platform_quota_reservations (
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL REFERENCES platform_quota_profiles(platform) ON DELETE CASCADE,
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        daily_reset_epoch INTEGER NOT NULL CHECK (daily_reset_epoch >= 0),
        weekly_reset_epoch INTEGER NOT NULL CHECK (weekly_reset_epoch >= 0),
        monthly_reset_epoch INTEGER NOT NULL CHECK (monthly_reset_epoch >= 0),
        daily_window_start_ms INTEGER NOT NULL CHECK (daily_window_start_ms >= 0),
        weekly_window_start_ms INTEGER NOT NULL CHECK (weekly_window_start_ms >= 0),
        monthly_window_start_ms INTEGER NOT NULL CHECK (monthly_window_start_ms >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'cancelled', 'expired')),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
        settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
        reservation_expires_at_ms INTEGER NOT NULL CHECK (reservation_expires_at_ms >= 0),
        reservation_ttl_ms INTEGER NOT NULL CHECK (reservation_ttl_ms > 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    this.ensureColumn(
      'committed',
      'INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))',
    )
    this.ensureColumn(
      'renewal_sequence',
      'INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0)',
    )
    this.ensureColumn(
      'last_renewal_ttl_ms',
      'INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0)',
    )
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_platform_quota_reservations_active
         ON platform_quota_reservations(platform, status, reservation_expires_at_ms)`,
    )
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_platform_quota_reservations_cleanup
         ON platform_quota_reservations(status, updated_at_ms)`,
    )
  }

  private ensureColumn(column: string, definition: string): void {
    const columns = Array.from(this.storage.sql.exec(
      'PRAGMA table_info(platform_quota_reservations)',
    )) as Array<{ name?: unknown }>
    if (columns.some((entry) => entry.name === column)) return
    this.storage.sql.exec(`ALTER TABLE platform_quota_reservations ADD COLUMN ${column} ${definition}`)
  }
}

function parseConfigure(body: Record<string, unknown>, now: number): PlatformQuotaConfigureInput {
  const input: PlatformQuotaConfigureInput = {
    user_id: requireString(body, 'user_id', 128),
    platform: requirePlatform(body.platform),
    enabled: requireBoolean(body, 'enabled'),
    control_version: requireSafeInteger(body, 'control_version'),
    daily_limit_micros: nullableSafeInteger(body, 'daily_limit_micros'),
    weekly_limit_micros: nullableSafeInteger(body, 'weekly_limit_micros'),
    monthly_limit_micros: nullableSafeInteger(body, 'monthly_limit_micros'),
    daily_used_micros: requireSafeInteger(body, 'daily_used_micros'),
    weekly_used_micros: requireSafeInteger(body, 'weekly_used_micros'),
    monthly_used_micros: requireSafeInteger(body, 'monthly_used_micros'),
    daily_window_start_ms: nullableSafeInteger(body, 'daily_window_start_ms'),
    weekly_window_start_ms: nullableSafeInteger(body, 'weekly_window_start_ms'),
    monthly_window_start_ms: nullableSafeInteger(body, 'monthly_window_start_ms'),
    daily_reset_epoch: requireSafeInteger(body, 'daily_reset_epoch'),
    weekly_reset_epoch: requireSafeInteger(body, 'weekly_reset_epoch'),
    monthly_reset_epoch: requireSafeInteger(body, 'monthly_reset_epoch'),
  }
  for (const kind of windowKinds()) {
    const start = input[`${kind}_window_start_ms`]
    if (start !== null && start > now) {
      throw new StateApiError(400, `invalid_${kind}_window_start_ms`, `${kind}_window_start_ms cannot be in the future`)
    }
  }
  return input
}

function importedProfile(input: PlatformQuotaConfigureInput, now: number): PlatformQuotaProfileRow {
  const dailyStart = utcDayStart(now)
  const weeklyStart = utcWeekStart(now)
  const monthlyActive = input.monthly_window_start_ms !== null &&
    now >= input.monthly_window_start_ms && now - input.monthly_window_start_ms < MONTH_MS
  return {
    platform: input.platform,
    enabled: input.enabled ? 1 : 0,
    control_version: input.control_version,
    daily_limit_micros: input.daily_limit_micros,
    weekly_limit_micros: input.weekly_limit_micros,
    monthly_limit_micros: input.monthly_limit_micros,
    daily_used_micros: input.daily_window_start_ms === dailyStart ? input.daily_used_micros : 0,
    weekly_used_micros: input.weekly_window_start_ms === weeklyStart ? input.weekly_used_micros : 0,
    monthly_used_micros: monthlyActive ? input.monthly_used_micros : 0,
    daily_window_start_ms: dailyStart,
    weekly_window_start_ms: weeklyStart,
    monthly_window_start_ms: monthlyActive ? input.monthly_window_start_ms! : now,
    daily_reset_epoch: input.daily_reset_epoch,
    weekly_reset_epoch: input.weekly_reset_epoch,
    monthly_reset_epoch: input.monthly_reset_epoch,
    created_at_ms: now,
    updated_at_ms: now,
  }
}

function samePolicy(profile: PlatformQuotaProfileRow, input: PlatformQuotaConfigureInput): boolean {
  return profile.enabled === (input.enabled ? 1 : 0) &&
    profile.daily_limit_micros === input.daily_limit_micros &&
    profile.weekly_limit_micros === input.weekly_limit_micros &&
    profile.monthly_limit_micros === input.monthly_limit_micros &&
    profile.daily_reset_epoch === input.daily_reset_epoch &&
    profile.weekly_reset_epoch === input.weekly_reset_epoch &&
    profile.monthly_reset_epoch === input.monthly_reset_epoch
}

function profileSelect(): string {
  return `SELECT platform, enabled, control_version,
    daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
    daily_used_micros, weekly_used_micros, monthly_used_micros,
    daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
    daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
    created_at_ms, updated_at_ms FROM platform_quota_profiles`
}

function reservationSelect(): string {
  return `SELECT request_id, user_id, platform, control_version,
    daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
    daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
    status, reserved_micros, committed, settled_micros,
    reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
    last_renewal_ttl_ms, created_at_ms, updated_at_ms
    FROM platform_quota_reservations`
}

function requirePlatform(value: unknown): string {
  if (typeof value !== 'string' || !PLATFORM_QUOTA_PLATFORMS.has(value)) {
    throw new StateApiError(400, 'invalid_platform', 'platform is not quota-enabled')
  }
  return value
}

function nullableSafeInteger(body: Record<string, unknown>, field: string): number | null {
  if (body[field] === null) return null
  return requireSafeInteger(body, field)
}

function windowKinds(): readonly PlatformQuotaWindowKind[] {
  return ['daily', 'weekly', 'monthly']
}

function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

function utcWeekStart(now: number): number {
  const day = Math.floor(now / DAY_MS)
  const daysSinceMonday = ((day + 3) % 7 + 7) % 7
  return (day - daysSinceMonday) * DAY_MS
}

function limitExceeded(limit: number | null, used: number, reserved: number, amount: number): boolean {
  if (limit === null) return false
  const projected = checkedSum(used, reserved, amount)
  return projected > limit || (amount === 0 && projected >= limit)
}

function retryAfter(now: number, start: number, kind: PlatformQuotaWindowKind): number {
  const end = start + (kind === 'daily' ? DAY_MS : kind === 'weekly' ? WEEK_MS : MONTH_MS)
  return Math.max(1, Math.ceil((end - now) / 1_000))
}

function checkedSum(...values: number[]): number {
  let sum = 0
  for (const value of values) {
    sum += value
    if (!Number.isSafeInteger(sum) || sum < 0) {
      throw new StateApiError(409, 'platform_quota_amount_overflow', 'Platform quota amount exceeds safe integer range')
    }
  }
  return sum
}

function validCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StateApiError(500, 'invalid_persisted_state', 'Persisted platform quota state is invalid')
  }
  return value as number
}

function firstRow<T>(rows: Iterable<unknown>): T | undefined {
  return Array.from(rows)[0] as T | undefined
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

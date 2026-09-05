import {
  errorResponse,
  json,
  readJsonObject,
  requireSafeInteger,
  requireSchemaVersion,
  requireString,
  StateApiError,
} from './http'
import { PlatformQuotaLimitError, PlatformQuotaState } from './platform-quota-state'

type LeaseStatus = 'active' | 'released' | 'expired'
type MonetaryReservationStatus = 'reserved' | 'settled' | 'cancelled' | 'expired'
type MonetaryWindowKind = '5h' | '1d' | '7d'

interface AdmissionLeaseRow {
  request_id: string
  api_key_id: string
  group_id: string
  status: LeaseStatus
  expires_at_ms: number
  renewal_sequence: number
  last_renewal_ttl_ms: number | null
  admitted_at_ms: number
  created_at_ms: number
  updated_at_ms: number
}

interface MonetaryProfileRow {
  api_key_id: string
  control_version: number
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
  total_limit_micros: number
  limit_5h_micros: number
  limit_1d_micros: number
  limit_7d_micros: number
  total_settled_micros: number
  created_at_ms: number
  updated_at_ms: number
}

interface MonetaryWindowRow {
  api_key_id: string
  kind: MonetaryWindowKind
  window_started_at_ms: number
  settled_micros: number
  updated_at_ms: number
}

interface MonetaryReservationRow {
  request_id: string
  api_key_id: string
  control_version: number
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
  status: MonetaryReservationStatus
  reserved_micros: number
  committed: number
  settled_micros: number | null
  tracks_total: number
  tracks_windows: number
  reservation_expires_at_ms: number
  reservation_ttl_ms: number
  renewal_sequence: number
  last_renewal_ttl_ms: number | null
  created_at_ms: number
  updated_at_ms: number
}

interface MonetaryConfigureInput {
  api_key_id: string
  control_version: number
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
  total_limit_micros: number
  limit_5h_micros: number
  limit_1d_micros: number
  limit_7d_micros: number
  total_used_micros: number
  usage_5h_micros: number
  usage_1d_micros: number
  usage_7d_micros: number
  window_5h_start_ms: number | null
  window_1d_start_ms: number | null
  window_7d_start_ms: number | null
}

class AdmissionLimitError extends StateApiError {
  constructor(
    code: 'user_rpm_limit_exceeded' | 'group_rpm_limit_exceeded' | 'user_concurrency_limit_exceeded',
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(429, code, message)
  }
}

class MonetaryLimitError extends StateApiError {
  constructor(
    code:
      | 'api_key_quota_exceeded'
      | 'api_key_rate_limit_5h_exceeded'
      | 'api_key_rate_limit_1d_exceeded'
      | 'api_key_rate_limit_7d_exceeded',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(429, code, message)
  }
}

const MINUTE_MS = 60_000
const WINDOW_RETENTION_MS = 2 * MINUTE_MS
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000
const MIN_LEASE_TTL_MS = 1_000
const MAX_LEASE_TTL_MS = 15 * 60_000
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const MONETARY_WINDOW_MS: Record<MonetaryWindowKind, number> = {
  '5h': 5 * HOUR_MS,
  '1d': DAY_MS,
  '7d': 7 * DAY_MS,
}
const MAX_MONETARY_RESERVATION_TTL_MS = DAY_MS

/**
 * Authoritative ingress admission for one user. The namespace is deliberately
 * partitioned by user rather than API key so multiple keys cannot oversell the
 * original user-wide concurrency and RPM ceilings. Every lease still carries
 * its API key identity for per-key observability and replay safety.
 */
export class ApiKeyLimitDO {
  private platformQuotas!: PlatformQuotaState

  constructor(private readonly state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => {
      this.initializeSchema()
      this.platformQuotas = new PlatformQuotaState(this.state.storage)
      const now = Date.now()
      this.state.storage.transactionSync(() => {
        this.cleanup(now)
        this.reclaimExpiredLeases(now)
        this.expireMonetaryReservations(now)
        this.platformQuotas.expireReservations(now)
      })
      await this.scheduleAlarm()
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health') return this.health()
      if (request.method === 'GET' && url.pathname === '/snapshot') return await this.snapshot()
      if (request.method !== 'POST') {
        throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
      }
      const body = await readJsonObject(request)
      requireSchemaVersion(body)
      if (url.pathname === '/admit') return await this.admit(body)
      if (url.pathname === '/renew') return await this.renew(body)
      if (url.pathname === '/release') return await this.release(body)
      if (url.pathname === '/reclaim') return await this.reclaim()
      if (url.pathname === '/monetary/configure') return await this.configureMonetary(body)
      if (url.pathname === '/monetary/reserve') return await this.reserveMonetary(body)
      if (url.pathname === '/monetary/ensure') return await this.ensureMonetary(body)
      if (url.pathname === '/monetary/renew') return await this.renewMonetary(body)
      if (url.pathname === '/monetary/settle') return await this.settleMonetary(body)
      if (url.pathname === '/monetary/cancel') return await this.cancelMonetary(body)
      if (url.pathname.startsWith('/platform-quota/')) {
        const response = this.state.storage.transactionSync(() =>
          this.platformQuotas.handle(url.pathname, body))
        await this.scheduleAlarm()
        return response
      }
      throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
    } catch (error) {
      if (error instanceof AdmissionLimitError) {
        return new Response(JSON.stringify({
          schema_version: 1,
          admitted: false,
          retry_after_seconds: error.retryAfterSeconds,
          error: { code: error.code, message: error.message },
        }), {
          status: error.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(error.retryAfterSeconds),
          },
        })
      }
      if (error instanceof MonetaryLimitError) {
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8',
        }
        if (error.retryAfterSeconds !== undefined) {
          headers['retry-after'] = String(error.retryAfterSeconds)
        }
        return new Response(JSON.stringify({
          schema_version: 1,
          reserved: false,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retry_after_seconds: error.retryAfterSeconds }),
          error: { code: error.code, message: error.message },
        }), { status: error.status, headers })
      }
      if (error instanceof PlatformQuotaLimitError) {
        return new Response(JSON.stringify({
          schema_version: 1,
          reserved: false,
          retry_after_seconds: error.retryAfterSeconds,
          error: { code: error.code, message: error.message },
        }), {
          status: error.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(error.retryAfterSeconds),
          },
        })
      }
      return errorResponse(error)
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.reclaimExpiredLeases(now)
      this.expireMonetaryReservations(now)
      this.platformQuotas.expireReservations(now)
    })
    await this.scheduleAlarm()
  }

  private health(): Response {
    const result = Array.from(this.state.storage.sql.exec('SELECT 1 AS healthy'))[0]
    return json({
      schema_version: 1,
      ok: result?.healthy === 1,
      service: 'api-key-limit-do',
      storage: 'sqlite',
    })
  }

  private async snapshot(): Promise<Response> {
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.reclaimExpiredLeases(now)
      this.expireMonetaryReservations(now)
      const leases = Array.from(this.state.storage.sql.exec(
        `SELECT request_id, api_key_id, group_id, status, expires_at_ms,
                renewal_sequence, admitted_at_ms, created_at_ms, updated_at_ms
           FROM admission_leases
          ORDER BY created_at_ms ASC, request_id ASC`,
      )) as unknown as AdmissionLeaseRow[]
      const windows = Array.from(this.state.storage.sql.exec(
        `SELECT scope, scope_id, window_started_at_ms, request_count, updated_at_ms
           FROM rpm_windows
          ORDER BY window_started_at_ms ASC, scope ASC, scope_id ASC`,
      ))
      const monetaryProfiles = Array.from(this.state.storage.sql.exec(
        `SELECT api_key_id, control_version, quota_reset_epoch, rate_limit_reset_epoch,
                total_limit_micros, limit_5h_micros,
                limit_1d_micros, limit_7d_micros, total_settled_micros,
                created_at_ms, updated_at_ms
           FROM api_key_monetary_profiles ORDER BY api_key_id ASC`,
      ))
      const monetaryWindows = Array.from(this.state.storage.sql.exec(
        `SELECT api_key_id, kind, window_started_at_ms, settled_micros, updated_at_ms
           FROM api_key_monetary_windows ORDER BY api_key_id ASC, kind ASC`,
      ))
      const monetaryReservations = Array.from(this.state.storage.sql.exec(
        `SELECT request_id, api_key_id, control_version, quota_reset_epoch,
                rate_limit_reset_epoch, status, reserved_micros,
                committed, settled_micros, tracks_total, tracks_windows,
                reservation_expires_at_ms, reservation_ttl_ms, created_at_ms, updated_at_ms
           FROM api_key_monetary_reservations
          ORDER BY created_at_ms ASC, request_id ASC`,
      ))
      const platformQuotas = this.platformQuotas.snapshot(now)
      return json({
        schema_version: 1,
        active_concurrency: leases.filter((lease) => lease.status === 'active').length,
        leases,
        windows,
        monetary: {
          profiles: monetaryProfiles,
          windows: monetaryWindows,
          reservations: monetaryReservations,
        },
        platform_quotas: platformQuotas,
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async admit(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const groupId = requireString(body, 'group_id', 128)
    const userRpmLimit = requireSafeInteger(body, 'user_rpm_limit')
    const groupRpmLimit = requireSafeInteger(body, 'group_rpm_limit')
    const concurrencyLimit = requireSafeInteger(body, 'concurrency_limit')
    const leaseTtlMs = requireSafeInteger(body, 'lease_ttl_ms', {
      minimum: MIN_LEASE_TTL_MS,
      maximum: MAX_LEASE_TTL_MS,
    })
    const now = Date.now()
    const windowStartedAt = Math.floor(now / MINUTE_MS) * MINUTE_MS

    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.reclaimExpiredLeases(now)
      const existing = this.readLease(requestId)
      if (existing !== null) {
        if (existing.api_key_id !== apiKeyId || existing.group_id !== groupId) {
          throw new StateApiError(409, 'admission_identity_conflict', 'Admission identity does not match its replay')
        }
        if (existing.status !== 'active') {
          throw new StateApiError(
            409,
            existing.status === 'released' ? 'admission_already_released' : 'admission_expired',
            existing.status === 'released'
              ? 'Admission was already released'
              : 'Admission lease has expired',
          )
        }
        return json({
          schema_version: 1,
          admitted: true,
          idempotent: true,
          active_concurrency: this.activeConcurrency(),
          lease: existing,
        })
      }

      const groupCount = this.windowCount('group', groupId, windowStartedAt)
      if (groupRpmLimit > 0 && groupCount >= groupRpmLimit) {
        throw new AdmissionLimitError(
          'group_rpm_limit_exceeded',
          'Group requests-per-minute limit exceeded',
          retryAfterForWindow(now, windowStartedAt),
        )
      }
      const userCount = this.windowCount('user', '', windowStartedAt)
      if (userRpmLimit > 0 && userCount >= userRpmLimit) {
        throw new AdmissionLimitError(
          'user_rpm_limit_exceeded',
          'User requests-per-minute limit exceeded',
          retryAfterForWindow(now, windowStartedAt),
        )
      }

      const activeConcurrency = this.activeConcurrency()
      if (concurrencyLimit > 0 && activeConcurrency >= concurrencyLimit) {
        throw new AdmissionLimitError(
          'user_concurrency_limit_exceeded',
          'User concurrency limit exceeded',
          this.concurrencyRetryAfter(now),
        )
      }

      const expiresAtMs = now + leaseTtlMs
      this.state.storage.sql.exec(
        `INSERT INTO admission_leases (
           request_id, api_key_id, group_id, status, expires_at_ms,
           renewal_sequence, last_renewal_ttl_ms, admitted_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'active', ?, 0, NULL, ?, ?, ?)`,
        requestId,
        apiKeyId,
        groupId,
        expiresAtMs,
        now,
        now,
        now,
      )
      if (groupRpmLimit > 0) this.incrementWindow('group', groupId, windowStartedAt, now)
      if (userRpmLimit > 0) this.incrementWindow('user', '', windowStartedAt, now)
      const lease = this.readLease(requestId)!
      return json({
        schema_version: 1,
        admitted: true,
        idempotent: false,
        active_concurrency: activeConcurrency + 1,
        lease,
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async renew(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const renewalSequence = requireSafeInteger(body, 'renewal_sequence', { minimum: 1 })
    const leaseTtlMs = requireSafeInteger(body, 'lease_ttl_ms', {
      minimum: MIN_LEASE_TTL_MS,
      maximum: MAX_LEASE_TTL_MS,
    })
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.reclaimExpiredLeases(now)
      const lease = this.readLease(requestId)
      if (lease === null) throw new StateApiError(404, 'admission_not_found', 'Admission was not found')
      if (lease.status !== 'active') {
        throw new StateApiError(409, 'admission_not_active', 'Admission is no longer active')
      }
      if (renewalSequence === lease.renewal_sequence) {
        if (lease.last_renewal_ttl_ms !== leaseTtlMs) {
          throw new StateApiError(409, 'renewal_conflict', 'Renewal sequence was replayed with different input')
        }
        return json({ schema_version: 1, idempotent: true, lease })
      }
      if (renewalSequence !== lease.renewal_sequence + 1) {
        throw new StateApiError(409, 'renewal_out_of_order', 'Renewal sequence must increase by one')
      }
      this.state.storage.sql.exec(
        `UPDATE admission_leases
            SET expires_at_ms = ?, renewal_sequence = ?, last_renewal_ttl_ms = ?, updated_at_ms = ?
          WHERE request_id = ? AND status = 'active'`,
        now + leaseTtlMs,
        renewalSequence,
        leaseTtlMs,
        now,
        requestId,
      )
      return json({ schema_version: 1, idempotent: false, lease: this.readLease(requestId) })
    })
    await this.scheduleAlarm()
    return response
  }

  private async release(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.reclaimExpiredLeases(now)
      const lease = this.readLease(requestId)
      if (lease === null) {
        return json({ schema_version: 1, idempotent: true, lease: null })
      }
      if (lease.status !== 'active') {
        return json({ schema_version: 1, idempotent: true, lease })
      }
      this.state.storage.sql.exec(
        `UPDATE admission_leases
            SET status = 'released', updated_at_ms = ?
          WHERE request_id = ? AND status = 'active'`,
        now,
        requestId,
      )
      return json({
        schema_version: 1,
        idempotent: false,
        active_concurrency: Math.max(0, this.activeConcurrency()),
        lease: this.readLease(requestId),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async reclaim(): Promise<Response> {
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      const reclaimed = this.reclaimExpiredLeases(now)
      const monetaryReclaimed = this.expireMonetaryReservations(now)
      const platformQuotaReclaimed = this.platformQuotas.expireReservations(now)
      return json({
        schema_version: 1,
        reclaimed,
        monetary_reclaimed: monetaryReclaimed,
        platform_quota_reclaimed: platformQuotaReclaimed,
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async configureMonetary(body: Record<string, unknown>): Promise<Response> {
    const input = parseMonetaryConfigure(body)
    const now = Date.now()
    for (const kind of ['5h', '1d', '7d'] as const) {
      if (input[`window_${kind}_start_ms`] !== null && input[`window_${kind}_start_ms`]! > now) {
        throw new StateApiError(
          400,
          `invalid_window_${kind}_start_ms`,
          `window_${kind}_start_ms cannot be in the future`,
        )
      }
    }
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const existing = this.readMonetaryProfile(input.api_key_id)
      if (existing !== null) {
        if (input.control_version < existing.control_version) {
          return json({ schema_version: 1, idempotent: true, stale: true, profile: existing })
        }
        if (input.control_version === existing.control_version) {
          if (!sameMonetaryPolicy(existing, input)) {
            throw new StateApiError(
              409,
              'api_key_monetary_configuration_conflict',
              'control_version was already used with different API key limits',
            )
          }
          return json({ schema_version: 1, idempotent: true, profile: existing })
        }
        if (
          input.quota_reset_epoch < existing.quota_reset_epoch ||
          input.rate_limit_reset_epoch < existing.rate_limit_reset_epoch
        ) {
          throw new StateApiError(
            409,
            'api_key_monetary_reset_epoch_regressed',
            'A newer control version cannot move an API key reset epoch backwards',
          )
        }
        const resetsTotal = input.quota_reset_epoch > existing.quota_reset_epoch
        const resetsWindows = input.rate_limit_reset_epoch > existing.rate_limit_reset_epoch
        this.state.storage.sql.exec(
          `UPDATE api_key_monetary_profiles
              SET control_version = ?, quota_reset_epoch = ?, rate_limit_reset_epoch = ?,
                  total_limit_micros = ?, limit_5h_micros = ?,
                  limit_1d_micros = ?, limit_7d_micros = ?, total_settled_micros = ?,
                  updated_at_ms = ?
            WHERE api_key_id = ?`,
          input.control_version,
          input.quota_reset_epoch,
          input.rate_limit_reset_epoch,
          input.total_limit_micros,
          input.limit_5h_micros,
          input.limit_1d_micros,
          input.limit_7d_micros,
          resetsTotal ? input.total_used_micros : existing.total_settled_micros,
          now,
          input.api_key_id,
        )
        if (resetsWindows) {
          this.state.storage.sql.exec(
            'DELETE FROM api_key_monetary_windows WHERE api_key_id = ?',
            input.api_key_id,
          )
          this.importMonetaryWindows(input, now)
        }
        return json({
          schema_version: 1,
          idempotent: false,
          profile: this.readMonetaryProfile(input.api_key_id),
        })
      }
      this.state.storage.sql.exec(
        `INSERT INTO api_key_monetary_profiles (
           api_key_id, control_version, quota_reset_epoch, rate_limit_reset_epoch,
           total_limit_micros, limit_5h_micros,
           limit_1d_micros, limit_7d_micros, total_settled_micros,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.api_key_id,
        input.control_version,
        input.quota_reset_epoch,
        input.rate_limit_reset_epoch,
        input.total_limit_micros,
        input.limit_5h_micros,
        input.limit_1d_micros,
        input.limit_7d_micros,
        input.total_used_micros,
        now,
        now,
      )
      this.importMonetaryWindows(input, now)
      return json({
        schema_version: 1,
        idempotent: false,
        profile: this.readMonetaryProfile(input.api_key_id),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async reserveMonetary(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const controlVersion = requireSafeInteger(body, 'control_version')
    const amount = requireSafeInteger(body, 'amount_micros')
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', {
      minimum: 1,
      maximum: MAX_MONETARY_RESERVATION_TTL_MS,
    })
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const existing = this.readMonetaryReservation(requestId)
      if (existing !== null) {
        if (
          existing.api_key_id !== apiKeyId ||
          existing.control_version !== controlVersion ||
          existing.reserved_micros !== amount ||
          existing.reservation_ttl_ms !== ttl
        ) {
          throw new StateApiError(
            409,
            'api_key_monetary_reservation_conflict',
            'request_id was already reserved with different values',
          )
        }
        if (existing.status !== 'reserved') {
          throw new StateApiError(
            409,
            'api_key_monetary_invalid_transition',
            `Cannot reserve a ${existing.status} monetary request`,
          )
        }
        return json({ schema_version: 1, reserved: true, idempotent: true, reservation: existing })
      }
      const profile = this.requireMonetaryProfile(apiKeyId)
      if (controlVersion !== profile.control_version) {
        throw new StateApiError(
          409,
          'api_key_monetary_control_version_conflict',
          'Reservation control_version does not match current API key limits',
        )
      }

      const totalFutureReserved = checkedSum(
        this.activeMonetaryReserved(apiKeyId, 'quota_reset_epoch', profile.quota_reset_epoch),
        amount,
      )
      if (
        monetaryLimitExceeded(
          profile.total_limit_micros,
          profile.total_settled_micros,
          totalFutureReserved,
          amount,
        )
      ) {
        throw new MonetaryLimitError('api_key_quota_exceeded', 'API key total quota is exhausted')
      }
      const windowFutureReserved = checkedSum(
        this.activeMonetaryReserved(apiKeyId, 'rate_limit_reset_epoch', profile.rate_limit_reset_epoch),
        amount,
      )
      for (const kind of ['5h', '1d', '7d'] as const) {
        const window = this.ensureMonetaryWindow(apiKeyId, kind, now)
        const limit = monetaryWindowLimit(profile, kind)
        if (
          monetaryLimitExceeded(limit, window.settled_micros, windowFutureReserved, amount)
        ) {
          throw new MonetaryLimitError(
            `api_key_rate_limit_${kind}_exceeded`,
            `API key ${kind} amount limit is exhausted`,
            retryAfterForDurationWindow(now, window.window_started_at_ms, MONETARY_WINDOW_MS[kind]),
          )
        }
      }
      this.state.storage.sql.exec(
        `INSERT INTO api_key_monetary_reservations (
           request_id, api_key_id, control_version, quota_reset_epoch,
           rate_limit_reset_epoch, status, reserved_micros,
           settled_micros, tracks_total, tracks_windows,
           reservation_expires_at_ms, reservation_ttl_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, 1, 1, ?, ?, ?, ?)`,
        requestId,
        apiKeyId,
        controlVersion,
        profile.quota_reset_epoch,
        profile.rate_limit_reset_epoch,
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
        reservation: this.readMonetaryReservation(requestId),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async renewMonetary(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const renewalSequence = requireSafeInteger(body, 'renewal_sequence', { minimum: 1 })
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', {
      minimum: 1,
      maximum: MAX_MONETARY_RESERVATION_TTL_MS,
    })
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const reservation = this.readMonetaryReservation(requestId)
      if (reservation === null || reservation.api_key_id !== apiKeyId) {
        throw new StateApiError(404, 'api_key_monetary_reservation_not_found', 'Monetary reservation was not found')
      }
      if (reservation.status !== 'reserved') {
        throw new StateApiError(409, 'api_key_monetary_invalid_transition', 'Monetary reservation is no longer active')
      }
      if (renewalSequence === reservation.renewal_sequence) {
        if (reservation.last_renewal_ttl_ms !== ttl) {
          throw new StateApiError(409, 'api_key_monetary_renewal_conflict', 'Renewal sequence was replayed with different input')
        }
        return json({ schema_version: 1, idempotent: true, reservation })
      }
      if (renewalSequence !== reservation.renewal_sequence + 1) {
        throw new StateApiError(409, 'api_key_monetary_renewal_out_of_order', 'Renewal sequence must increase by one')
      }
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_reservations
            SET reservation_expires_at_ms = ?, renewal_sequence = ?,
                last_renewal_ttl_ms = ?, updated_at_ms = ?
          WHERE request_id = ? AND status = 'reserved'`,
        checkedSum(now, ttl),
        renewalSequence,
        ttl,
        now,
        requestId,
      )
      return json({ schema_version: 1, idempotent: false, reservation: this.readMonetaryReservation(requestId) })
    })
    await this.scheduleAlarm()
    return response
  }

  private async ensureMonetary(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const targetAmount = requireSafeInteger(body, 'target_amount_micros')
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const reservation = this.readMonetaryReservation(requestId)
      if (reservation === null) {
        throw new StateApiError(404, 'api_key_monetary_reservation_not_found', 'Monetary reservation was not found')
      }
      if (reservation.api_key_id !== apiKeyId) {
        throw new StateApiError(
          409,
          'api_key_monetary_identity_conflict',
          'Monetary reservation belongs to another API key',
        )
      }
      if (reservation.status === 'settled') {
        if (reservation.settled_micros !== targetAmount) {
          throw new StateApiError(
            409,
            'api_key_monetary_ensure_conflict',
            'Settled monetary amount does not match the committed target',
          )
        }
        return json({
          schema_version: 1,
          idempotent: true,
          reservation,
          usage: this.monetaryUsageSnapshot(apiKeyId),
        })
      }
      if (reservation.committed === 1) {
        if (reservation.reserved_micros !== targetAmount) {
          throw new StateApiError(
            409,
            'api_key_monetary_ensure_conflict',
            'Monetary reservation was already committed with a different amount',
          )
        }
        return json({
          schema_version: 1,
          idempotent: true,
          reservation,
          usage: this.monetaryUsageSnapshot(apiKeyId),
        })
      }
      if (targetAmount < reservation.reserved_micros) {
        throw new StateApiError(
          409,
          'api_key_monetary_ensure_below_reservation',
          'Committed amount cannot be less than the original reservation',
        )
      }
      if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
        throw new StateApiError(
          409,
          'api_key_monetary_invalid_transition',
          `Cannot commit a ${reservation.status} monetary reservation`,
        )
      }
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_reservations
            SET reserved_micros = ?, committed = 1, updated_at_ms = ?
          WHERE request_id = ?`,
        targetAmount,
        now,
        requestId,
      )
      return json({
        schema_version: 1,
        idempotent: false,
        reservation: this.readMonetaryReservation(requestId),
        usage: this.monetaryUsageSnapshot(apiKeyId),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async settleMonetary(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const amount = requireSafeInteger(body, 'amount_micros')
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const reservation = this.readMonetaryReservation(requestId)
      if (reservation === null) {
        throw new StateApiError(404, 'api_key_monetary_reservation_not_found', 'Monetary reservation was not found')
      }
      if (reservation.api_key_id !== apiKeyId) {
        throw new StateApiError(
          409,
          'api_key_monetary_identity_conflict',
          'Monetary reservation belongs to another API key',
        )
      }
      if (reservation.status === 'settled') {
        if (reservation.settled_micros !== amount) {
          throw new StateApiError(
            409,
            'api_key_monetary_settlement_conflict',
            'request_id was already settled with a different amount',
          )
        }
        return json({
          schema_version: 1,
          idempotent: true,
          reservation,
          usage: this.monetaryUsageSnapshot(apiKeyId),
        })
      }
      if (reservation.status !== 'reserved' && reservation.status !== 'expired') {
        throw new StateApiError(
          409,
          'api_key_monetary_invalid_transition',
          `Cannot settle a ${reservation.status} monetary reservation`,
        )
      }
      if (reservation.committed === 1 && amount !== reservation.reserved_micros) {
        throw new StateApiError(
          409,
          'api_key_monetary_settlement_conflict',
          'Committed monetary reservation must settle its exact target amount',
        )
      }
      if (amount > reservation.reserved_micros) {
        throw new StateApiError(
          409,
          'api_key_monetary_settlement_exceeds_reservation',
          'Settled amount cannot exceed the reserved amount',
        )
      }
      const profile = this.requireMonetaryProfile(apiKeyId)
      const totalSettled = reservation.quota_reset_epoch === profile.quota_reset_epoch
        ? checkedSum(profile.total_settled_micros, amount)
        : profile.total_settled_micros
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_profiles
            SET total_settled_micros = ?, updated_at_ms = ?
          WHERE api_key_id = ?`,
        totalSettled,
        now,
        apiKeyId,
      )
      if (reservation.rate_limit_reset_epoch === profile.rate_limit_reset_epoch) {
        for (const kind of ['5h', '1d', '7d'] as const) {
          const window = this.ensureMonetaryWindow(apiKeyId, kind, now)
          this.state.storage.sql.exec(
            `UPDATE api_key_monetary_windows
                SET settled_micros = ?, updated_at_ms = ?
              WHERE api_key_id = ? AND kind = ?`,
            checkedSum(window.settled_micros, amount),
            now,
            apiKeyId,
            kind,
          )
        }
      }
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_reservations
            SET status = 'settled', settled_micros = ?, updated_at_ms = ?
          WHERE request_id = ? AND status IN ('reserved', 'expired')`,
        amount,
        now,
        requestId,
      )
      return json({
        schema_version: 1,
        idempotent: false,
        reservation: this.readMonetaryReservation(requestId),
        usage: this.monetaryUsageSnapshot(apiKeyId),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private async cancelMonetary(body: Record<string, unknown>): Promise<Response> {
    const requestId = requireString(body, 'request_id', 256)
    const apiKeyId = requireString(body, 'api_key_id', 128)
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.expireMonetaryReservations(now)
      const reservation = this.readMonetaryReservation(requestId)
      if (reservation === null) {
        return json({ schema_version: 1, idempotent: true, reservation: null })
      }
      if (reservation.api_key_id !== apiKeyId) {
        throw new StateApiError(
          409,
          'api_key_monetary_identity_conflict',
          'Monetary reservation belongs to another API key',
        )
      }
      if (reservation.status === 'settled' || reservation.committed === 1) {
        throw new StateApiError(
          409,
          'api_key_monetary_invalid_transition',
          'Cannot cancel a settled or committed monetary reservation',
        )
      }
      if (reservation.status !== 'reserved') {
        return json({
          schema_version: 1,
          idempotent: true,
          reservation,
          usage: this.monetaryUsageSnapshot(apiKeyId),
        })
      }
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_reservations
            SET status = 'cancelled', updated_at_ms = ?
          WHERE request_id = ? AND status = 'reserved'`,
        now,
        requestId,
      )
      return json({
        schema_version: 1,
        idempotent: false,
        reservation: this.readMonetaryReservation(requestId),
        usage: this.monetaryUsageSnapshot(apiKeyId),
      })
    })
    await this.scheduleAlarm()
    return response
  }

  private initializeSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS admission_leases (
        request_id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0),
        admitted_at_ms INTEGER NOT NULL CHECK (admitted_at_ms >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rpm_windows (
        scope TEXT NOT NULL CHECK (scope IN ('user', 'group')),
        scope_id TEXT NOT NULL,
        window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (scope, scope_id, window_started_at_ms)
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_key_monetary_profiles (
        api_key_id TEXT PRIMARY KEY,
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0),
        rate_limit_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_reset_epoch >= 0),
        total_limit_micros INTEGER NOT NULL CHECK (total_limit_micros >= 0),
        limit_5h_micros INTEGER NOT NULL CHECK (limit_5h_micros >= 0),
        limit_1d_micros INTEGER NOT NULL CHECK (limit_1d_micros >= 0),
        limit_7d_micros INTEGER NOT NULL CHECK (limit_7d_micros >= 0),
        total_settled_micros INTEGER NOT NULL CHECK (total_settled_micros >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_key_monetary_windows (
        api_key_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('5h', '1d', '7d')),
        window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
        settled_micros INTEGER NOT NULL CHECK (settled_micros >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (api_key_id, kind),
        FOREIGN KEY (api_key_id) REFERENCES api_key_monetary_profiles(api_key_id) ON DELETE CASCADE
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS api_key_monetary_reservations (
        request_id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL,
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0),
        rate_limit_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_reset_epoch >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'cancelled', 'expired')),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
        settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
        tracks_total INTEGER NOT NULL CHECK (tracks_total IN (0, 1)),
        tracks_windows INTEGER NOT NULL CHECK (tracks_windows IN (0, 1)),
        reservation_expires_at_ms INTEGER NOT NULL CHECK (reservation_expires_at_ms >= 0),
        reservation_ttl_ms INTEGER NOT NULL CHECK (reservation_ttl_ms > 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        FOREIGN KEY (api_key_id) REFERENCES api_key_monetary_profiles(api_key_id) ON DELETE CASCADE
      ) STRICT
    `)
    this.ensureColumn(
      'api_key_monetary_profiles',
      'quota_reset_epoch',
      'INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0)',
    )
    this.ensureColumn(
      'api_key_monetary_profiles',
      'rate_limit_reset_epoch',
      'INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_reset_epoch >= 0)',
    )
    this.ensureColumn(
      'api_key_monetary_reservations',
      'quota_reset_epoch',
      'INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0)',
    )
    this.ensureColumn(
      'api_key_monetary_reservations',
      'rate_limit_reset_epoch',
      'INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_reset_epoch >= 0)',
    )
    this.ensureColumn(
      'api_key_monetary_reservations',
      'committed',
      'INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))',
    )
    this.ensureColumn(
      'api_key_monetary_reservations',
      'renewal_sequence',
      'INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0)',
    )
    this.ensureColumn(
      'api_key_monetary_reservations',
      'last_renewal_ttl_ms',
      'INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_admission_leases_active_expiry ON admission_leases(status, expires_at_ms)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_admission_leases_key_status ON admission_leases(api_key_id, status)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_admission_leases_tombstone_cleanup ON admission_leases(status, updated_at_ms)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_rpm_windows_cleanup ON rpm_windows(window_started_at_ms)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_api_key_monetary_reservations_active ON api_key_monetary_reservations(api_key_id, status, reservation_expires_at_ms)',
    )
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_api_key_monetary_reservations_cleanup ON api_key_monetary_reservations(status, updated_at_ms)',
    )
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = Array.from(this.state.storage.sql.exec(`PRAGMA table_info(${table})`)) as Array<{
      name?: unknown
    }>
    if (columns.some((entry) => entry.name === column)) return
    this.state.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private readLease(requestId: string): AdmissionLeaseRow | null {
    return (Array.from(this.state.storage.sql.exec(
      `SELECT request_id, api_key_id, group_id, status, expires_at_ms,
              renewal_sequence, last_renewal_ttl_ms, admitted_at_ms, created_at_ms, updated_at_ms
         FROM admission_leases
        WHERE request_id = ?`,
      requestId,
    ))[0] as unknown as AdmissionLeaseRow | undefined) ?? null
  }

  private readMonetaryProfile(apiKeyId: string): MonetaryProfileRow | null {
    return (Array.from(this.state.storage.sql.exec(
      `SELECT api_key_id, control_version, quota_reset_epoch, rate_limit_reset_epoch,
              total_limit_micros, limit_5h_micros,
              limit_1d_micros, limit_7d_micros, total_settled_micros,
              created_at_ms, updated_at_ms
         FROM api_key_monetary_profiles
        WHERE api_key_id = ?`,
      apiKeyId,
    ))[0] as unknown as MonetaryProfileRow | undefined) ?? null
  }

  private requireMonetaryProfile(apiKeyId: string): MonetaryProfileRow {
    const profile = this.readMonetaryProfile(apiKeyId)
    if (profile === null) {
      throw new StateApiError(
        409,
        'api_key_monetary_not_configured',
        'API key monetary limits must be configured before reservation',
      )
    }
    return profile
  }

  private readMonetaryReservation(requestId: string): MonetaryReservationRow | null {
    return (Array.from(this.state.storage.sql.exec(
      `SELECT request_id, api_key_id, control_version, quota_reset_epoch,
              rate_limit_reset_epoch, status, reserved_micros,
              committed, settled_micros, tracks_total, tracks_windows,
              reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
              last_renewal_ttl_ms,
              created_at_ms, updated_at_ms
         FROM api_key_monetary_reservations
        WHERE request_id = ?`,
      requestId,
    ))[0] as unknown as MonetaryReservationRow | undefined) ?? null
  }

  private activeMonetaryReserved(
    apiKeyId: string,
    epochColumn?: 'quota_reset_epoch' | 'rate_limit_reset_epoch',
    epoch?: number,
  ): number {
    const row = Array.from(this.state.storage.sql.exec(
      `SELECT COALESCE(SUM(reserved_micros), 0) AS amount
         FROM api_key_monetary_reservations
        WHERE api_key_id = ?
          AND (status = 'reserved' OR (status = 'expired' AND committed = 1))
          ${epochColumn === undefined ? '' : `AND ${epochColumn} = ?`}`,
      apiKeyId,
      ...(epochColumn === undefined ? [] : [epoch]),
    ))[0] as { amount?: unknown } | undefined
    if (!Number.isSafeInteger(row?.amount) || (row!.amount as number) < 0) {
      throw new StateApiError(500, 'invalid_persisted_state', 'Persisted monetary reservations are invalid')
    }
    return row!.amount as number
  }

  private readMonetaryWindow(
    apiKeyId: string,
    kind: MonetaryWindowKind,
  ): MonetaryWindowRow | null {
    return (Array.from(this.state.storage.sql.exec(
      `SELECT api_key_id, kind, window_started_at_ms, settled_micros, updated_at_ms
         FROM api_key_monetary_windows
        WHERE api_key_id = ? AND kind = ?`,
      apiKeyId,
      kind,
    ))[0] as unknown as MonetaryWindowRow | undefined) ?? null
  }

  private ensureMonetaryWindow(
    apiKeyId: string,
    kind: MonetaryWindowKind,
    now: number,
  ): MonetaryWindowRow {
    const existing = this.readMonetaryWindow(apiKeyId, kind)
    if (
      existing === null ||
      now - existing.window_started_at_ms >= MONETARY_WINDOW_MS[kind]
    ) {
      this.state.storage.sql.exec(
        `INSERT INTO api_key_monetary_windows (
           api_key_id, kind, window_started_at_ms, settled_micros, updated_at_ms
         ) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(api_key_id, kind) DO UPDATE SET
           window_started_at_ms = excluded.window_started_at_ms,
           settled_micros = 0,
           updated_at_ms = excluded.updated_at_ms`,
        apiKeyId,
        kind,
        now,
        now,
      )
    }
    return this.readMonetaryWindow(apiKeyId, kind)!
  }

  private importMonetaryWindows(input: MonetaryConfigureInput, now: number): void {
    for (const kind of ['5h', '1d', '7d'] as const) {
      const start = input[`window_${kind}_start_ms`]
      const used = input[`usage_${kind}_micros`]
      if (start === null || now < start || now - start >= MONETARY_WINDOW_MS[kind]) continue
      this.state.storage.sql.exec(
        `INSERT INTO api_key_monetary_windows (
           api_key_id, kind, window_started_at_ms, settled_micros, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
        input.api_key_id,
        kind,
        start,
        used,
        now,
      )
    }
  }

  private monetaryUsageSnapshot(apiKeyId: string): Record<string, unknown> {
    const profile = this.requireMonetaryProfile(apiKeyId)
    const now = Date.now()
    return {
      api_key_id: apiKeyId,
      quota_reset_epoch: profile.quota_reset_epoch,
      rate_limit_reset_epoch: profile.rate_limit_reset_epoch,
      total_settled_micros: profile.total_settled_micros,
      active_reserved_micros: this.activeMonetaryReserved(apiKeyId),
      // A settled replay can arrive after cleanup removed an elapsed window.
      // Re-materialize all three dimensions so recovery always receives a
      // complete authoritative snapshot rather than an unparsable null.
      windows: (['5h', '1d', '7d'] as const).map((kind) =>
        this.ensureMonetaryWindow(apiKeyId, kind, now)),
    }
  }

  private activeConcurrency(): number {
    const row = Array.from(this.state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM admission_leases WHERE status = 'active'",
    ))[0] as { count?: unknown } | undefined
    if (!Number.isSafeInteger(row?.count) || (row!.count as number) < 0) {
      throw new StateApiError(500, 'invalid_persisted_state', 'Persisted concurrency is invalid')
    }
    return row!.count as number
  }

  private concurrencyRetryAfter(now: number): number {
    const row = Array.from(this.state.storage.sql.exec(
      "SELECT MIN(expires_at_ms) AS expires_at_ms FROM admission_leases WHERE status = 'active'",
    ))[0] as { expires_at_ms?: unknown } | undefined
    return Number.isSafeInteger(row?.expires_at_ms)
      ? Math.max(1, Math.ceil(((row!.expires_at_ms as number) - now) / 1_000))
      : 1
  }

  private windowCount(scope: 'user' | 'group', scopeId: string, windowStartedAt: number): number {
    const row = Array.from(this.state.storage.sql.exec(
      `SELECT request_count FROM rpm_windows
        WHERE scope = ? AND scope_id = ? AND window_started_at_ms = ?`,
      scope,
      scopeId,
      windowStartedAt,
    ))[0] as { request_count?: unknown } | undefined
    if (row === undefined) return 0
    if (!Number.isSafeInteger(row.request_count) || (row.request_count as number) < 0) {
      throw new StateApiError(500, 'invalid_persisted_state', 'Persisted RPM usage is invalid')
    }
    return row.request_count as number
  }

  private incrementWindow(
    scope: 'user' | 'group',
    scopeId: string,
    windowStartedAt: number,
    now: number,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO rpm_windows (scope, scope_id, window_started_at_ms, request_count, updated_at_ms)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(scope, scope_id, window_started_at_ms) DO UPDATE
         SET request_count = request_count + 1, updated_at_ms = excluded.updated_at_ms`,
      scope,
      scopeId,
      windowStartedAt,
      now,
    )
  }

  private reclaimExpiredLeases(now: number): number {
    const before = this.state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM admission_leases WHERE status = 'active' AND expires_at_ms <= ?",
      now,
    )
    const row = Array.from(before)[0] as { count?: unknown } | undefined
    const count = Number.isSafeInteger(row?.count) ? row!.count as number : 0
    if (count > 0) {
      this.state.storage.sql.exec(
        `UPDATE admission_leases
            SET status = 'expired', updated_at_ms = ?
          WHERE status = 'active' AND expires_at_ms <= ?`,
        now,
        now,
      )
    }
    return count
  }

  private expireMonetaryReservations(now: number): number {
    const row = Array.from(this.state.storage.sql.exec(
      `SELECT COUNT(*) AS count
         FROM api_key_monetary_reservations
        WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
      now,
    ))[0] as { count?: unknown } | undefined
    const count = Number.isSafeInteger(row?.count) ? row!.count as number : 0
    if (count > 0) {
      this.state.storage.sql.exec(
        `UPDATE api_key_monetary_reservations
            SET status = 'expired', updated_at_ms = ?
          WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
        now,
        now,
      )
    }
    return count
  }

  private cleanup(now: number): void {
    this.state.storage.sql.exec(
      'DELETE FROM rpm_windows WHERE window_started_at_ms < ?',
      Math.floor(now / MINUTE_MS) * MINUTE_MS - WINDOW_RETENTION_MS,
    )
    this.state.storage.sql.exec(
      "DELETE FROM admission_leases WHERE status <> 'active' AND updated_at_ms < ?",
      now - TOMBSTONE_RETENTION_MS,
    )
    this.state.storage.sql.exec(
      `DELETE FROM api_key_monetary_reservations
        WHERE status <> 'reserved' AND committed = 0 AND updated_at_ms < ?`,
      now - TOMBSTONE_RETENTION_MS,
    )
    this.state.storage.sql.exec(
      `DELETE FROM api_key_monetary_windows
        WHERE (kind = '5h' AND window_started_at_ms <= ?)
           OR (kind = '1d' AND window_started_at_ms <= ?)
           OR (kind = '7d' AND window_started_at_ms <= ?)`,
      now - MONETARY_WINDOW_MS['5h'],
      now - MONETARY_WINDOW_MS['1d'],
      now - MONETARY_WINDOW_MS['7d'],
    )
    this.platformQuotas.cleanup(now)
  }

  private async scheduleAlarm(): Promise<void> {
    const admission = Array.from(this.state.storage.sql.exec(
      "SELECT MIN(expires_at_ms) AS expires_at_ms FROM admission_leases WHERE status = 'active'",
    ))[0] as { expires_at_ms?: unknown } | undefined
    const monetary = Array.from(this.state.storage.sql.exec(
      `SELECT MIN(reservation_expires_at_ms) AS expires_at_ms
         FROM api_key_monetary_reservations WHERE status = 'reserved' AND committed = 0`,
    ))[0] as { expires_at_ms?: unknown } | undefined
    const expirations = [
      admission?.expires_at_ms,
      monetary?.expires_at_ms,
      this.platformQuotas.nextReservationExpiry(),
    ]
      .filter((value): value is number => Number.isSafeInteger(value))
    if (expirations.length > 0) {
      await this.state.storage.setAlarm(Math.max(Date.now(), Math.min(...expirations)))
      return
    }
    await this.state.storage.deleteAlarm()
  }
}

function retryAfterForWindow(now: number, windowStartedAt: number): number {
  return Math.max(1, Math.ceil((windowStartedAt + MINUTE_MS - now) / 1_000))
}

function parseMonetaryConfigure(body: Record<string, unknown>): MonetaryConfigureInput {
  return {
    api_key_id: requireString(body, 'api_key_id', 128),
    control_version: requireSafeInteger(body, 'control_version'),
    quota_reset_epoch: requireSafeInteger(body, 'quota_reset_epoch'),
    rate_limit_reset_epoch: requireSafeInteger(body, 'rate_limit_reset_epoch'),
    total_limit_micros: requireSafeInteger(body, 'total_limit_micros'),
    limit_5h_micros: requireSafeInteger(body, 'limit_5h_micros'),
    limit_1d_micros: requireSafeInteger(body, 'limit_1d_micros'),
    limit_7d_micros: requireSafeInteger(body, 'limit_7d_micros'),
    total_used_micros: requireSafeInteger(body, 'total_used_micros'),
    usage_5h_micros: requireSafeInteger(body, 'usage_5h_micros'),
    usage_1d_micros: requireSafeInteger(body, 'usage_1d_micros'),
    usage_7d_micros: requireSafeInteger(body, 'usage_7d_micros'),
    window_5h_start_ms: requireNullableSafeInteger(body, 'window_5h_start_ms'),
    window_1d_start_ms: requireNullableSafeInteger(body, 'window_1d_start_ms'),
    window_7d_start_ms: requireNullableSafeInteger(body, 'window_7d_start_ms'),
  }
}

function requireNullableSafeInteger(body: Record<string, unknown>, field: string): number | null {
  if (body[field] === null) return null
  return requireSafeInteger(body, field)
}

function sameMonetaryPolicy(profile: MonetaryProfileRow, input: MonetaryConfigureInput): boolean {
  return profile.quota_reset_epoch === input.quota_reset_epoch &&
    profile.rate_limit_reset_epoch === input.rate_limit_reset_epoch &&
    profile.total_limit_micros === input.total_limit_micros &&
    profile.limit_5h_micros === input.limit_5h_micros &&
    profile.limit_1d_micros === input.limit_1d_micros &&
    profile.limit_7d_micros === input.limit_7d_micros
}

function checkedSum(...values: number[]): number {
  let sum = 0
  for (const value of values) {
    sum += value
    if (!Number.isSafeInteger(sum) || sum < 0) {
      throw new StateApiError(409, 'monetary_amount_overflow', 'Monetary amount exceeds safe integer range')
    }
  }
  return sum
}

function monetaryWindowLimit(profile: MonetaryProfileRow, kind: MonetaryWindowKind): number {
  if (kind === '5h') return profile.limit_5h_micros
  if (kind === '1d') return profile.limit_1d_micros
  return profile.limit_7d_micros
}

function monetaryLimitExceeded(
  limit: number,
  settled: number,
  futureReserved: number,
  requested: number,
): boolean {
  if (limit === 0) return false
  const projected = checkedSum(settled, futureReserved)
  return projected > limit || (requested === 0 && projected >= limit)
}

function retryAfterForDurationWindow(now: number, start: number, duration: number): number {
  return Math.max(1, Math.ceil((start + duration - now) / 1_000))
}

import type { Env, PlatformEvent, SubscriptionStateChangedPayload } from '../env'
import { isProviderPlatform } from '../gateway/platform'
import {
  exportSubscriptionStateBackup,
  inspectSubscriptionStateBackup,
  readSubscriptionStateBackupIdentity,
  restoreSubscriptionStateBackup,
} from '../backup/subscription-state-backup'
import {
  errorResponse,
  json,
  readJsonObject,
  requireSafeInteger,
  requireSchemaVersion,
  requireBoolean,
  requireString,
  StateApiError,
} from './http'

const SCHEMA_VERSION = 1
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const MAX_RESERVATION_TTL_MS = DAY_MS
const TOMBSTONE_RETENTION_MS = 7 * DAY_MS

type WindowKind = 'daily' | 'weekly' | 'monthly'
type RequestStatus = 'authorized' | 'reserved' | 'cancelled' | 'settled' | 'expired'

interface SubscriptionProfileRow {
  subscription_id: string
  user_id: string
  group_id: string
  starts_at_ms: number
  expires_at_ms: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  enabled: number
  /** Zero for UTC-day windows, otherwise the fixed activation-aligned daily anchor. */
  daily_anchor_ms: number
  weekly_anchor_ms: number
  monthly_anchor_ms: number
  /** Internal generation for a restarted entitlement term using the same subscription id. */
  term_generation: number
  control_version: number
  quota_reset_epoch: number
  /** Monotonic generation advanced by every administrative quota reset. */
  quota_reset_generation: number
  updated_at_ms: number
}

interface SubscriptionRequestRow {
  request_id: string
  status: RequestStatus
  committed: number
  reserved_micros: number
  settled_micros: number | null
  reservation_expires_at_ms: number | null
  reservation_ttl_ms: number | null
  renewal_sequence: number
  last_renewal_ttl_ms: number | null
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  /** Captured at authorization so a delayed settlement cannot move into a later term. */
  term_generation: number
  /** Captured at authorization so a delayed settlement cannot cross a daily reset. */
  quota_reset_epoch: number
  authorized_at_ms: number
  updated_at_ms: number
}

interface WindowState {
  kind: WindowKind
  start_ms: number
  end_ms: number
  term_generation: number
  /** Daily reset discriminator; periodic windows always use zero. */
  quota_reset_epoch: number
}

interface ConfigureInput extends Omit<
  SubscriptionProfileRow,
  'weekly_anchor_ms' | 'monthly_anchor_ms' | 'term_generation'
> {
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
}

interface ResetQuotaInput {
  mutation_id: string
  subscription_id: string
  control_version: number
  windows: Record<WindowKind, number | null>
}

interface SubscriptionMutationRow {
  mutation_id: string
  operation: 'reset_quota'
  payload_json: string
  control_version: number
  created_at_ms: number
}

interface AuthorizationRow {
  subscription_id: string
  group_enabled: number
  platform: string
}

export class SubscriptionStateDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env?: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.initializeSchema()
      this.state.storage.transactionSync(() => this.expireDueReservations(Date.now()))
      await this.publishPendingOutbox()
      await this.scheduleNextAlarm()
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health') return this.health()
      if (request.method === 'GET' && url.pathname === '/snapshot') return this.snapshot()
      if (request.method === 'GET' && url.pathname === '/backup/verify') {
        return await inspectSubscriptionStateBackup(this.state.storage, readSubscriptionStateBackupIdentity(request))
      }
      if (request.method === 'POST' && url.pathname === '/backup/export') {
        return await exportSubscriptionStateBackup(this.state.storage, readSubscriptionStateBackupIdentity(request))
      }
      if (request.method === 'POST' && url.pathname === '/backup/restore') {
        const response = await restoreSubscriptionStateBackup(
          this.state.storage, request, readSubscriptionStateBackupIdentity(request),
        )
        await this.state.storage.deleteAlarm()
        await this.scheduleNextAlarm()
        return response
      }
      if (request.method !== 'POST') {
        throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
      }
      const body = await readJsonObject(request)
      if (url.pathname === '/configure') return await this.configure(body)
      if (url.pathname === '/configure-reset') return await this.configureReset(body)
      if (url.pathname === '/authorize') return await this.authorize(body)
      if (url.pathname === '/reserve') return await this.reserve(body)
      if (url.pathname === '/ensure') return await this.ensure(body)
      if (url.pathname === '/renew') return await this.renew(body)
      if (url.pathname === '/cancel' || url.pathname === '/release') return await this.cancel(body)
      if (url.pathname === '/settle') return await this.settle(body)
      if (url.pathname === '/reclaim') return await this.reclaim(body)
      throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
    } catch (error) {
      return errorResponse(error)
    }
  }

  async alarm(): Promise<void> {
    this.state.storage.transactionSync(() => {
      this.expireDueReservations(Date.now())
      this.cleanupTombstones(Date.now())
    })
    await this.publishPendingOutbox()
    await this.scheduleNextAlarm()
  }

  private health(): Response {
    const result = firstRow<{ healthy: number }>(this.state.storage.sql.exec('SELECT 1 AS healthy'))
    return json({
      schema_version: SCHEMA_VERSION,
      ok: result?.healthy === 1,
      service: 'subscription-state-do',
      storage: 'sqlite',
    })
  }

  private snapshot(): Response {
    return this.state.storage.transactionSync(() => {
      const now = Date.now()
      this.expireDueReservations(now)
      const profile = this.requireProfile()
      const windows = this.windowsAt(profile, Math.min(now, profile.expires_at_ms - 1))
      return json({
        schema_version: SCHEMA_VERSION,
        profile,
        windows: windows.map((window) => this.windowSnapshot(window)),
        requests: Array.from(this.state.storage.sql.exec(
          `SELECT request_id, status, committed, reserved_micros, settled_micros,
                  reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
                  last_renewal_ttl_ms, daily_window_start_ms, weekly_window_start_ms,
                  monthly_window_start_ms, term_generation, quota_reset_epoch,
                  authorized_at_ms, updated_at_ms
             FROM subscription_requests
            ORDER BY updated_at_ms DESC, request_id DESC LIMIT 100`,
        )),
      })
    })
  }

  private async configure(body: Record<string, unknown>): Promise<Response> {
    const input = parseConfigure(body)
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      return json(this.applyConfiguration(input, now))
    })
    await this.scheduleNextAlarm()
    return response
  }

  private applyConfiguration(
    input: ConfigureInput,
    now: number,
    allowQuotaReset = false,
  ): Record<string, unknown> {
    const existing = this.loadProfile()
    if (existing !== null) {
      if (
        existing.subscription_id !== input.subscription_id ||
        existing.user_id !== input.user_id ||
        existing.group_id !== input.group_id
      ) {
        throw new StateApiError(409, 'subscription_identity_conflict', 'Subscription state belongs to another entitlement')
      }
      if (input.control_version < existing.control_version) {
        return { schema_version: SCHEMA_VERSION, idempotent: true, stale: true, profile: existing }
      }
      if (input.control_version === existing.control_version) {
        if (!sameConfiguration(existing, input)) {
          throw new StateApiError(409, 'subscription_configuration_conflict', 'control_version was already used with different subscription values')
        }
        return { schema_version: SCHEMA_VERSION, idempotent: true, profile: existing }
      }
      if (
        !allowQuotaReset &&
        input.starts_at_ms === existing.starts_at_ms &&
        (
          input.quota_reset_epoch !== existing.quota_reset_epoch ||
          input.quota_reset_generation !== existing.quota_reset_generation
        )
      ) {
        throw new StateApiError(
          409,
          'subscription_quota_reset_requires_atomic_command',
          'Quota reset epoch can only change through an atomic configure-reset command',
        )
      }
      const restartedTerm = input.starts_at_ms !== existing.starts_at_ms
      if (!restartedTerm && input.daily_anchor_ms !== existing.daily_anchor_ms) {
        throw new StateApiError(
          409,
          'subscription_daily_anchor_conflict',
          'Daily quota anchor cannot change within an active entitlement term',
        )
      }
      const termGeneration = restartedTerm
        ? incrementGeneration(existing.term_generation)
        : existing.term_generation
      this.persistProfile(
        input,
        now,
        restartedTerm ? input.daily_anchor_ms : existing.daily_anchor_ms,
        restartedTerm ? initialPeriodicAnchor(input, 'weekly', now) : existing.weekly_anchor_ms,
        restartedTerm ? initialPeriodicAnchor(input, 'monthly', now) : existing.monthly_anchor_ms,
        termGeneration,
        restartedTerm,
      )
      const profile = this.requireProfile()
      if (restartedTerm && profile.enabled === 1) {
        for (const window of this.windowsAt(profile, now)) {
          const sourceStart = input[`${window.kind}_window_start_ms`]
          const sourceUsed = input[`${window.kind}_used_micros`]
          this.replaceWindowUsage(
            window,
            sourceStart === null || sourceStart === window.start_ms ? sourceUsed : 0,
            now,
          )
        }
      }
      return { schema_version: SCHEMA_VERSION, idempotent: false, profile }
    }

    if (!allowQuotaReset && input.quota_reset_generation !== 0) {
      throw new StateApiError(
        409,
        'subscription_quota_reset_requires_atomic_command',
        'An uninitialized subscription with reset history must be configured by its atomic reset intent',
      )
    }
    const weeklyAnchor = initialPeriodicAnchor(input, 'weekly', now)
    const monthlyAnchor = initialPeriodicAnchor(input, 'monthly', now)
    this.persistProfile(input, now, input.daily_anchor_ms, weeklyAnchor, monthlyAnchor, 1, false)
    const profile = this.requireProfile()
    if (profile.enabled === 1) for (const window of this.windowsAt(profile, now)) {
      const sourceStart = input[`${window.kind}_window_start_ms`]
      const sourceUsed = input[`${window.kind}_used_micros`]
      // Legacy rows may carry usage before window anchors were projected. Charging it to
      // the current window is conservative and avoids reopening already-consumed quota.
      const legacyPeriodicAnchor = window.kind !== 'daily' &&
        sourceStart === Math.floor(input.starts_at_ms / DAY_MS) * DAY_MS &&
        window.start_ms === input.starts_at_ms
      this.ensureWindow(
        window,
        sourceStart === null || sourceStart === window.start_ms || legacyPeriodicAnchor
          ? sourceUsed
          : 0,
      )
    }
    return { schema_version: SCHEMA_VERSION, idempotent: false, profile }
  }

  private async configureReset(body: Record<string, unknown>): Promise<Response> {
    const configuration = parseConfigure(requireObject(body, 'configuration'))
    const reset = parseResetQuota(requireObject(body, 'reset'))
    if (
      configuration.subscription_id !== reset.subscription_id ||
      configuration.control_version !== reset.control_version
    ) {
      throw new StateApiError(400, 'reset_configuration_mismatch', 'Configuration and reset must target the same version')
    }
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const existing = this.loadProfile()
      if (existing === null && configuration.quota_reset_generation !== 1) {
        throw new StateApiError(
          409,
          'subscription_quota_reset_generation_conflict',
          'The first atomic reset must establish quota reset generation one',
        )
      }
      if (existing !== null && configuration.control_version > existing.control_version) {
        if (configuration.quota_reset_generation !== incrementGeneration(existing.quota_reset_generation)) {
          throw new StateApiError(
            409,
            'subscription_quota_reset_generation_conflict',
            'Atomic reset configuration must advance the quota reset generation exactly once',
          )
        }
        const expectedEpoch = reset.windows.daily === null
          ? existing.quota_reset_epoch
          : incrementGeneration(existing.quota_reset_epoch)
        if (configuration.quota_reset_epoch !== expectedEpoch) {
          throw new StateApiError(
            409,
            'subscription_quota_reset_epoch_conflict',
            'Atomic reset configuration has an invalid quota reset epoch',
          )
        }
      }
      const configured = this.applyConfiguration(configuration, now, true)
      const resetResult = this.applyQuotaReset(reset, now)
      return json({
        schema_version: SCHEMA_VERSION,
        configuration: configured,
        reset: resetResult,
        profile: this.requireProfile(),
      })
    })
    await this.scheduleNextAlarm()
    return response
  }

  private applyQuotaReset(input: ResetQuotaInput, now: number): Record<string, unknown> {
    const payloadJson = JSON.stringify({
      subscription_id: input.subscription_id,
      control_version: input.control_version,
      windows: input.windows,
    })
    const previous = this.loadMutation(input.mutation_id)
    if (previous !== null) {
      if (previous.operation !== 'reset_quota' || previous.payload_json !== payloadJson) {
        throw new StateApiError(409, 'subscription_mutation_conflict', 'mutation_id was already used with different reset values')
      }
      return {
        schema_version: SCHEMA_VERSION,
        idempotent: true,
        mutation: previous,
        profile: this.requireProfile(),
      }
    }

    let profile = this.requireProfile()
    if (profile.subscription_id !== input.subscription_id) {
      throw new StateApiError(409, 'subscription_identity_conflict', 'Reset does not match subscription state')
    }
    if (profile.control_version !== input.control_version) {
      throw new StateApiError(409, 'subscription_control_version_conflict', 'Reset control_version does not match subscription state')
    }
    assertActive(profile, now)

    for (const kind of ['weekly', 'monthly'] as const) {
      const start = input.windows[kind]
      if (
        start !== null &&
        (start < profile.starts_at_ms || start > now || start >= profile.expires_at_ms)
      ) {
        throw new StateApiError(409, 'subscription_window_conflict', `${kind} reset does not target an active window`)
      }
    }
    this.state.storage.sql.exec(
      `UPDATE subscription_profile
          SET weekly_anchor_ms = COALESCE(?, weekly_anchor_ms),
              monthly_anchor_ms = COALESCE(?, monthly_anchor_ms),
              updated_at_ms = ?
        WHERE singleton = 1`,
      input.windows.weekly,
      input.windows.monthly,
      now,
    )
    profile = this.requireProfile()
    for (const kind of ['daily', 'weekly', 'monthly'] as const) {
      const start = input.windows[kind]
      if (start === null) continue
      const activeDaily = kind === 'daily' ? this.dailyWindowAt(profile, now) : null
      const window = activeDaily ?? windowFor(profile, kind, start)
      this.replaceWindowUsage(window, 0, now)
    }
    this.state.storage.sql.exec(
      `INSERT INTO subscription_mutations (
         mutation_id, operation, payload_json, control_version, created_at_ms
       ) VALUES (?, 'reset_quota', ?, ?, ?)`,
      input.mutation_id,
      payloadJson,
      input.control_version,
      now,
    )
    return {
      schema_version: SCHEMA_VERSION,
      idempotent: false,
      mutation: this.loadMutation(input.mutation_id),
      profile,
    }
  }

  private async authorize(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const subscriptionId = requireString(body, 'subscription_id')
    const userId = requireString(body, 'user_id')
    const groupId = requireString(body, 'group_id')
    const apiKeyId = requireString(body, 'api_key_id')
    const apiKeyAuthVersion = requireSafeInteger(body, 'api_key_auth_version', { minimum: 1 })
    const now = Date.now()
    await this.verifyAuthorization({ subscriptionId, userId, groupId, apiKeyId, apiKeyAuthVersion, now })

    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const profile = this.requireProfile()
      assertActive(profile, now)
      if (
        profile.subscription_id !== subscriptionId ||
        profile.user_id !== userId ||
        profile.group_id !== groupId
      ) {
        throw new StateApiError(409, 'subscription_identity_conflict', 'Authorization does not match subscription state')
      }
      const existing = this.loadRequest(requestId)
      if (existing !== null) {
        return json({ schema_version: SCHEMA_VERSION, idempotent: true, request: existing })
      }
      this.state.storage.sql.exec(
        `INSERT INTO subscription_requests (
           request_id, status, reserved_micros, settled_micros,
           reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
           last_renewal_ttl_ms, daily_window_start_ms, weekly_window_start_ms,
           monthly_window_start_ms, term_generation, quota_reset_epoch,
           authorized_at_ms, updated_at_ms
         ) VALUES (?, 'authorized', 0, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        requestId,
        profile.term_generation,
        profile.quota_reset_epoch,
        now,
        now,
      )
      return json({ schema_version: SCHEMA_VERSION, idempotent: false, request: this.loadRequest(requestId) })
    })
  }

  private async reserve(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const amount = requireSafeInteger(body, 'amount_micros')
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', { minimum: 1, maximum: MAX_RESERVATION_TTL_MS })
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const profile = this.requireProfile()
      assertActive(profile, now)
      const request = this.requireRequest(requestId)
      if (request.status === 'reserved') {
        if (request.reserved_micros === amount && request.reservation_ttl_ms === ttl) {
          return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
        }
        throw new StateApiError(409, 'reservation_conflict', 'Request already has a different reservation')
      }
      if (request.status !== 'authorized') {
        throw new StateApiError(409, 'invalid_transition', `Cannot reserve a ${request.status} request`)
      }
      assertCurrentRequestGeneration(request, profile)
      const windows = this.windowsAt(profile, now)
      for (const window of windows) {
        this.ensureWindow(window, 0)
        const snapshot = this.windowSnapshot(window)
        const limit = quotaFor(profile, window.kind)
        if (limit !== null && snapshot.used_micros + snapshot.reserved_micros + amount > limit) {
          throw new StateApiError(
            429,
            `subscription_${window.kind}_quota_exceeded`,
            `Subscription ${window.kind} quota is exhausted`,
          )
        }
      }
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET status = 'reserved', reserved_micros = ?, reservation_expires_at_ms = ?,
                reservation_ttl_ms = ?, daily_window_start_ms = ?, weekly_window_start_ms = ?,
                monthly_window_start_ms = ?, updated_at_ms = ?
          WHERE request_id = ? AND status = 'authorized'`,
        amount,
        checkedAdd(now, ttl, 'reservation expiry'),
        ttl,
        windows[0]!.start_ms,
        windows[1]!.start_ms,
        windows[2]!.start_ms,
        now,
        requestId,
      )
      return json({
        schema_version: SCHEMA_VERSION,
        idempotent: false,
        request: this.loadRequest(requestId),
        windows: windows.map((window) => this.windowSnapshot(window)),
      })
    })
    await this.scheduleNextAlarm()
    return response
  }

  private async renew(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const sequence = requireSafeInteger(body, 'renewal_sequence', { minimum: 1 })
    const ttl = requireSafeInteger(body, 'reservation_ttl_ms', { minimum: 1, maximum: MAX_RESERVATION_TTL_MS })
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const profile = this.requireProfile()
      assertActive(profile, now)
      const request = this.requireRequest(requestId)
      if (request.status !== 'reserved') {
        throw new StateApiError(409, 'invalid_transition', `Cannot renew a ${request.status} request`)
      }
      assertCurrentRequestGeneration(request, profile)
      if (sequence < request.renewal_sequence) {
        return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
      }
      if (sequence === request.renewal_sequence) {
        if (request.last_renewal_ttl_ms === ttl) {
          return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
        }
        throw new StateApiError(409, 'renewal_conflict', 'Renewal sequence has different parameters')
      }
      if (sequence !== request.renewal_sequence + 1) {
        throw new StateApiError(409, 'renewal_out_of_order', 'Renewal sequence must increase by one')
      }
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET reservation_expires_at_ms = ?, renewal_sequence = ?,
                last_renewal_ttl_ms = ?, updated_at_ms = ?
          WHERE request_id = ? AND status = 'reserved'`,
        checkedAdd(now, ttl, 'reservation expiry'), sequence, ttl, now, requestId,
      )
      return json({ schema_version: SCHEMA_VERSION, idempotent: false, request: this.loadRequest(requestId) })
    })
    await this.scheduleNextAlarm()
    return response
  }

  private async ensure(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const targetAmount = requireSafeInteger(body, 'target_amount_micros')
    const now = Date.now()
    return this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const request = this.requireRequest(requestId)
      if (request.status === 'settled') {
        if (request.settled_micros === targetAmount) {
          return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
        }
        throw new StateApiError(409, 'reservation_commitment_conflict', 'Settled request has a different amount')
      }
      if (request.committed === 1) {
        if (request.reserved_micros === targetAmount) {
          return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
        }
        throw new StateApiError(409, 'reservation_commitment_conflict', 'Request already has a different committed reservation')
      }
      if (request.status !== 'reserved' && request.status !== 'expired') {
        throw new StateApiError(409, 'invalid_transition', `Cannot commit a ${request.status} request`)
      }
      if (targetAmount < request.reserved_micros) {
        throw new StateApiError(409, 'reservation_commitment_decrease', 'Committed target cannot be lower than the reservation')
      }
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET committed = 1, reserved_micros = ?, updated_at_ms = ?
          WHERE request_id = ? AND committed = 0 AND status IN ('reserved', 'expired')`,
        targetAmount,
        now,
        requestId,
      )
      return json({
        schema_version: SCHEMA_VERSION,
        idempotent: false,
        request: this.requireRequest(requestId),
      })
    })
  }

  private async cancel(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const request = this.loadRequest(requestId)
      if (request === null) {
        throw new StateApiError(404, 'request_not_authorized', 'Request is not authorized')
      }
      if (request.committed === 1) {
        throw new StateApiError(409, 'invalid_transition', 'A committed request cannot be cancelled')
      }
      if (request.status === 'cancelled' || request.status === 'expired') {
        return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
      }
      if (request.status === 'settled') {
        throw new StateApiError(409, 'invalid_transition', 'A settled request cannot be cancelled')
      }
      this.state.storage.sql.exec(
        `UPDATE subscription_requests SET status = 'cancelled', updated_at_ms = ? WHERE request_id = ?`,
        now, requestId,
      )
      return json({ schema_version: SCHEMA_VERSION, idempotent: false, request: this.loadRequest(requestId) })
    })
    await this.scheduleNextAlarm()
    return response
  }

  private async settle(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const requestId = requireString(body, 'request_id')
    const amount = requireSafeInteger(body, 'amount_micros')
    const usageEvent = parseOptionalUsageEvent(body.usage_event, requestId, amount)
    const now = Date.now()
    const response = this.state.storage.transactionSync(() => {
      this.expireDueReservations(now)
      const profile = this.requireProfile()
      validateUsageEventBilling(usageEvent, profile)
      const request = this.requireRequest(requestId)
      if (request.status === 'settled') {
        if (request.settled_micros !== amount) {
          throw new StateApiError(409, 'settlement_conflict', 'Request already has a different settlement')
        }
        if (usageEvent !== null) this.appendOutboxEvent(usageEvent, `usage:${requestId}`, now)
        return json({ schema_version: SCHEMA_VERSION, idempotent: true, request })
      }
      if (request.status !== 'reserved' && request.status !== 'expired') {
        throw new StateApiError(409, 'invalid_transition', `Cannot settle a ${request.status} request`)
      }
      if (request.committed === 1 && amount !== request.reserved_micros) {
        throw new StateApiError(409, 'settlement_commitment_conflict', 'Settlement must equal the committed reservation')
      }
      if (amount > request.reserved_micros) {
        throw new StateApiError(409, 'settlement_exceeds_reservation', 'Settlement exceeds the worst-case reservation')
      }
      const starts = {
        daily: request.daily_window_start_ms,
        weekly: request.weekly_window_start_ms,
        monthly: request.monthly_window_start_ms,
      }
      for (const kind of ['daily', 'weekly', 'monthly'] as const) {
        if (starts[kind] === null) {
          throw new StateApiError(500, 'invalid_persisted_state', 'Reserved request has no quota window')
        }
        const window = this.requestWindow(request, kind)
        const existing = this.windowSnapshot(window)
        const nextUsed = checkedAdd(existing.used_micros, amount, `${kind} usage`)
        // The reservation was admitted atomically against the limit that was active at
        // request start. A later administrative quota reduction must not strand settlement.
        this.state.storage.sql.exec(
          `UPDATE subscription_term_windows SET used_micros = ?, updated_at_ms = ?
            WHERE term_generation = ? AND quota_reset_epoch = ?
              AND kind = ? AND start_ms = ?`,
          nextUsed,
          now,
          window.term_generation,
          window.quota_reset_epoch,
          kind,
          window.start_ms,
        )
      }
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET status = 'settled', settled_micros = ?, updated_at_ms = ?
          WHERE request_id = ? AND status IN ('reserved', 'expired')`,
        amount, now, requestId,
      )
      if (usageEvent !== null) this.appendOutboxEvent(usageEvent, `usage:${requestId}`, now)
      this.appendProjectionEvent(profile, request, amount, now)
      return json({
        schema_version: SCHEMA_VERSION,
        idempotent: false,
        request: this.loadRequest(requestId),
        settled_micros: amount,
      })
    })
    await this.publishPendingOutbox()
    await this.scheduleNextAlarm()
    return response
  }

  private async reclaim(body: Record<string, unknown>): Promise<Response> {
    requireSchemaVersion(body)
    const reclaimed = this.state.storage.transactionSync(() => this.expireDueReservations(Date.now()))
    await this.scheduleNextAlarm()
    return json({ schema_version: SCHEMA_VERSION, reclaimed })
  }

  private async verifyAuthorization(input: {
    subscriptionId: string
    userId: string
    groupId: string
    apiKeyId: string
    apiKeyAuthVersion: number
    now: number
  }): Promise<void> {
    if (this.env?.DB === undefined) {
      throw new StateApiError(503, 'authorization_store_unavailable', 'Authorization store is unavailable')
    }
    const row = await this.env.DB.prepare(
      `SELECT s.id AS subscription_id, g.enabled AS group_enabled, g.platform
         FROM user_subscriptions s
         JOIN "groups" g ON g.id = s.group_id AND g.group_type = 'subscription'
         JOIN api_keys k ON k.user_id = s.user_id AND k.group_id = s.group_id
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.group_id = ?
          AND s.status = 'active' AND s.starts_at_ms <= ? AND s.expires_at_ms > ?
          AND k.id = ? AND k.auth_version = ? AND k.enabled = 1
          AND k.revoked_at_ms IS NULL AND (k.expires_at_ms IS NULL OR k.expires_at_ms > ?)
          AND u.status = 'active'
        LIMIT 1`,
    ).bind(
      input.subscriptionId,
      input.userId,
      input.groupId,
      input.now,
      input.now,
      input.apiKeyId,
      input.apiKeyAuthVersion,
      input.now,
    ).first<AuthorizationRow>()
    if (row === null || row.subscription_id !== input.subscriptionId) {
      throw new StateApiError(403, 'subscription_unavailable', 'Subscription entitlement is no longer active')
    }
    if (row.group_enabled !== 1 || (!isProviderPlatform(row.platform) && row.platform !== 'composite')) {
      throw new StateApiError(403, 'group_unavailable', 'API key group is unavailable')
    }
  }

  private initializeSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        subscription_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > starts_at_ms),
        daily_quota_micros INTEGER CHECK (daily_quota_micros IS NULL OR daily_quota_micros >= 0),
        weekly_quota_micros INTEGER CHECK (weekly_quota_micros IS NULL OR weekly_quota_micros >= 0),
        monthly_quota_micros INTEGER CHECK (monthly_quota_micros IS NULL OR monthly_quota_micros >= 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        daily_anchor_ms INTEGER NOT NULL DEFAULT 0 CHECK (daily_anchor_ms >= 0),
        weekly_anchor_ms INTEGER NOT NULL CHECK (weekly_anchor_ms >= 0),
        monthly_anchor_ms INTEGER NOT NULL CHECK (monthly_anchor_ms >= 0),
        term_generation INTEGER NOT NULL DEFAULT 1 CHECK (term_generation >= 0),
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0),
        quota_reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_generation >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    const profileColumns = Array.from(this.state.storage.sql.exec(
      'PRAGMA table_info(subscription_profile)',
    )) as Array<{ name?: string }>
    if (!profileColumns.some((column) => column.name === 'enabled')) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_profile ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))',
      )
    }
    if (!profileColumns.some((column) => column.name === 'quota_reset_epoch')) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_profile ADD COLUMN quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0)',
      )
    }
    if (!profileColumns.some((column) => column.name === 'quota_reset_generation')) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_profile ADD COLUMN quota_reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_generation >= 0)',
      )
    }
    if (!profileColumns.some((column) => column.name === 'term_generation')) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_profile ADD COLUMN term_generation INTEGER NOT NULL DEFAULT 1 CHECK (term_generation >= 0)',
      )
    }
    const addedDailyAnchor = !profileColumns.some((column) => column.name === 'daily_anchor_ms')
    if (addedDailyAnchor) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_profile ADD COLUMN daily_anchor_ms INTEGER NOT NULL DEFAULT 0 CHECK (daily_anchor_ms >= 0)',
      )
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_windows (
        kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
        used_micros INTEGER NOT NULL DEFAULT 0 CHECK (used_micros >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (kind, start_ms)
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_requests (
        request_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('authorized', 'reserved', 'cancelled', 'settled', 'expired')),
        committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
        reserved_micros INTEGER NOT NULL CHECK (reserved_micros >= 0),
        settled_micros INTEGER CHECK (settled_micros IS NULL OR settled_micros >= 0),
        reservation_expires_at_ms INTEGER CHECK (reservation_expires_at_ms IS NULL OR reservation_expires_at_ms >= 0),
        reservation_ttl_ms INTEGER CHECK (reservation_ttl_ms IS NULL OR reservation_ttl_ms > 0),
        renewal_sequence INTEGER NOT NULL DEFAULT 0 CHECK (renewal_sequence >= 0),
        last_renewal_ttl_ms INTEGER CHECK (last_renewal_ttl_ms IS NULL OR last_renewal_ttl_ms > 0),
        daily_window_start_ms INTEGER CHECK (daily_window_start_ms IS NULL OR daily_window_start_ms >= 0),
        weekly_window_start_ms INTEGER CHECK (weekly_window_start_ms IS NULL OR weekly_window_start_ms >= 0),
        monthly_window_start_ms INTEGER CHECK (monthly_window_start_ms IS NULL OR monthly_window_start_ms >= 0),
        term_generation INTEGER NOT NULL DEFAULT 0 CHECK (term_generation >= 0),
        quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0),
        authorized_at_ms INTEGER NOT NULL CHECK (authorized_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) STRICT
    `)
    const requestColumns = Array.from(this.state.storage.sql.exec(
      'PRAGMA table_info(subscription_requests)',
    )) as Array<{ name?: string }>
    if (!requestColumns.some((column) => column.name === 'committed')) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_requests ADD COLUMN committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1))',
      )
    }
    const addedRequestTermGeneration = !requestColumns.some((column) => column.name === 'term_generation')
    const addedRequestQuotaResetEpoch = !requestColumns.some((column) => column.name === 'quota_reset_epoch')
    if (addedRequestTermGeneration) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_requests ADD COLUMN term_generation INTEGER NOT NULL DEFAULT 0 CHECK (term_generation >= 0)',
      )
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET term_generation = CASE
              WHEN authorized_at_ms < COALESCE((SELECT starts_at_ms FROM subscription_profile WHERE singleton = 1), 0)
                THEN MAX(COALESCE((SELECT term_generation FROM subscription_profile WHERE singleton = 1), 1) - 1, 0)
              ELSE COALESCE((SELECT term_generation FROM subscription_profile WHERE singleton = 1), 1)
            END`,
      )
    }
    if (addedRequestQuotaResetEpoch) {
      this.state.storage.sql.exec(
        'ALTER TABLE subscription_requests ADD COLUMN quota_reset_epoch INTEGER NOT NULL DEFAULT 0 CHECK (quota_reset_epoch >= 0)',
      )
      this.state.storage.sql.exec(
        `UPDATE subscription_requests
            SET quota_reset_epoch = CASE
              WHEN authorized_at_ms < COALESCE((SELECT starts_at_ms FROM subscription_profile WHERE singleton = 1), 0)
                THEN MAX(COALESCE((SELECT quota_reset_epoch FROM subscription_profile WHERE singleton = 1), 0) - 1, 0)
              ELSE COALESCE((SELECT quota_reset_epoch FROM subscription_profile WHERE singleton = 1), 0)
            END`,
      )
    }
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_term_windows (
        term_generation INTEGER NOT NULL CHECK (term_generation >= 0),
        quota_reset_epoch INTEGER NOT NULL CHECK (quota_reset_epoch >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
        used_micros INTEGER NOT NULL DEFAULT 0 CHECK (used_micros >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (term_generation, quota_reset_epoch, kind, start_ms)
      ) STRICT
    `)
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
      ) STRICT
    `)
    const termWindowMigration = firstRow<{ version: number }>(this.state.storage.sql.exec(
      'SELECT version FROM subscription_schema_migrations WHERE version = 1',
    ))
    if (termWindowMigration === undefined) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO subscription_term_windows (
           term_generation, quota_reset_epoch, kind, start_ms, end_ms, used_micros, updated_at_ms
         )
         SELECT COALESCE((SELECT term_generation FROM subscription_profile WHERE singleton = 1), 1),
                CASE WHEN kind = 'daily'
                  THEN COALESCE((SELECT quota_reset_epoch FROM subscription_profile WHERE singleton = 1), 0)
                  ELSE 0 END,
                kind, start_ms, end_ms, used_micros, updated_at_ms
           FROM subscription_windows`,
      )
      this.state.storage.sql.exec(
        'INSERT INTO subscription_schema_migrations (version, applied_at_ms) VALUES (1, ?)',
        Date.now(),
      )
    }
    if (addedDailyAnchor) {
      this.state.storage.sql.exec(
        `UPDATE subscription_profile
            SET daily_anchor_ms = starts_at_ms
          WHERE EXISTS (
            SELECT 1 FROM subscription_term_windows window
             WHERE window.term_generation = subscription_profile.term_generation
               AND window.kind = 'daily'
               AND window.start_ms = subscription_profile.starts_at_ms
          )`,
      )
    }
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_subscription_requests_active_expiry
         ON subscription_requests(status, reservation_expires_at_ms)`,
    )
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_outbox (
        event_id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
        published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      ) STRICT
    `)
    this.state.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_subscription_outbox_pending
         ON subscription_outbox(available_at_ms, event_id) WHERE published_at_ms IS NULL`,
    )
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_mutations (
        mutation_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN ('reset_quota')),
        payload_json TEXT NOT NULL,
        control_version INTEGER NOT NULL CHECK (control_version >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      ) STRICT
    `)
  }

  private loadProfile(): SubscriptionProfileRow | null {
    return firstRow<SubscriptionProfileRow>(this.state.storage.sql.exec(
      `SELECT subscription_id, user_id, group_id, starts_at_ms, expires_at_ms,
              daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
              enabled, daily_anchor_ms, weekly_anchor_ms, monthly_anchor_ms,
              term_generation, control_version,
              quota_reset_epoch, quota_reset_generation, updated_at_ms
         FROM subscription_profile WHERE singleton = 1`,
    )) ?? null
  }

  private requireProfile(): SubscriptionProfileRow {
    const profile = this.loadProfile()
    if (profile === null) throw new StateApiError(404, 'subscription_not_configured', 'Subscription state is not configured')
    return profile
  }

  private persistProfile(
    input: ConfigureInput,
    now: number,
    dailyAnchor: number,
    weeklyAnchor: number,
    monthlyAnchor: number,
    termGeneration: number,
    updateAnchors: boolean,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO subscription_profile (
         singleton, subscription_id, user_id, group_id, starts_at_ms, expires_at_ms,
         daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
         enabled, daily_anchor_ms, weekly_anchor_ms, monthly_anchor_ms,
         term_generation, control_version,
         quota_reset_epoch, quota_reset_generation, updated_at_ms
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         starts_at_ms = excluded.starts_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         daily_quota_micros = excluded.daily_quota_micros,
         weekly_quota_micros = excluded.weekly_quota_micros,
         monthly_quota_micros = excluded.monthly_quota_micros,
         enabled = excluded.enabled,
         daily_anchor_ms = CASE WHEN ? THEN excluded.daily_anchor_ms ELSE daily_anchor_ms END,
         weekly_anchor_ms = CASE WHEN ? THEN excluded.weekly_anchor_ms ELSE weekly_anchor_ms END,
         monthly_anchor_ms = CASE WHEN ? THEN excluded.monthly_anchor_ms ELSE monthly_anchor_ms END,
         term_generation = excluded.term_generation,
         control_version = excluded.control_version,
         quota_reset_epoch = excluded.quota_reset_epoch,
         quota_reset_generation = excluded.quota_reset_generation,
         updated_at_ms = excluded.updated_at_ms`,
      input.subscription_id,
      input.user_id,
      input.group_id,
      input.starts_at_ms,
      input.expires_at_ms,
      input.daily_quota_micros,
      input.weekly_quota_micros,
      input.monthly_quota_micros,
      input.enabled,
      dailyAnchor,
      weeklyAnchor,
      monthlyAnchor,
      termGeneration,
      input.control_version,
      input.quota_reset_epoch,
      input.quota_reset_generation,
      now,
      updateAnchors ? 1 : 0,
      updateAnchors ? 1 : 0,
      updateAnchors ? 1 : 0,
    )
  }

  private loadMutation(mutationId: string): SubscriptionMutationRow | null {
    return firstRow<SubscriptionMutationRow>(this.state.storage.sql.exec(
      `SELECT mutation_id, operation, payload_json, control_version, created_at_ms
         FROM subscription_mutations WHERE mutation_id = ?`,
      mutationId,
    )) ?? null
  }

  private loadRequest(requestId: string): SubscriptionRequestRow | null {
    return firstRow<SubscriptionRequestRow>(this.state.storage.sql.exec(
      `SELECT request_id, status, committed, reserved_micros, settled_micros,
              reservation_expires_at_ms, reservation_ttl_ms, renewal_sequence,
              last_renewal_ttl_ms, daily_window_start_ms, weekly_window_start_ms,
              monthly_window_start_ms, term_generation, quota_reset_epoch,
              authorized_at_ms, updated_at_ms
         FROM subscription_requests WHERE request_id = ?`,
      requestId,
    )) ?? null
  }

  private requireRequest(requestId: string): SubscriptionRequestRow {
    const request = this.loadRequest(requestId)
    if (request === null) throw new StateApiError(404, 'request_not_authorized', 'Request is not authorized')
    return request
  }

  private windowsAt(profile: SubscriptionProfileRow, now: number): [WindowState, WindowState, WindowState] {
    return [
      this.dailyWindowAt(profile, now),
      currentWindow(profile, 'weekly', now),
      currentWindow(profile, 'monthly', now),
    ]
  }

  private dailyWindowAt(profile: SubscriptionProfileRow, now: number): WindowState {
    const persisted = firstRow<{ start_ms: number; end_ms: number }>(this.state.storage.sql.exec(
      `SELECT start_ms, end_ms
         FROM subscription_term_windows
        WHERE term_generation = ? AND quota_reset_epoch = ? AND kind = 'daily'
          AND start_ms <= ? AND end_ms > ?
        ORDER BY start_ms DESC LIMIT 1`,
      profile.term_generation,
      profile.quota_reset_epoch,
      now,
      now,
    ))
    if (persisted !== undefined) {
      return {
        kind: 'daily',
        start_ms: persisted.start_ms,
        end_ms: Math.min(persisted.end_ms, profile.expires_at_ms),
        term_generation: profile.term_generation,
        quota_reset_epoch: profile.quota_reset_epoch,
      }
    }
    return currentWindow(profile, 'daily', now)
  }

  private ensureWindow(window: WindowState, initialUsed: number): void {
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO subscription_term_windows (
         term_generation, quota_reset_epoch, kind, start_ms, end_ms, used_micros, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      window.term_generation,
      window.quota_reset_epoch,
      window.kind,
      window.start_ms,
      window.end_ms,
      initialUsed,
      Date.now(),
    )
  }

  private replaceWindowUsage(window: WindowState, usedMicros: number, now: number): void {
    this.state.storage.sql.exec(
      `INSERT INTO subscription_term_windows (
         term_generation, quota_reset_epoch, kind, start_ms, end_ms, used_micros, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(term_generation, quota_reset_epoch, kind, start_ms) DO UPDATE SET
         end_ms = excluded.end_ms,
         used_micros = excluded.used_micros,
         updated_at_ms = excluded.updated_at_ms`,
      window.term_generation,
      window.quota_reset_epoch,
      window.kind,
      window.start_ms,
      window.end_ms,
      usedMicros,
      now,
    )
  }

  private windowSnapshot(window: WindowState): {
    kind: WindowKind
    start_ms: number
    end_ms: number
    term_generation: number
    quota_reset_epoch: number
    used_micros: number
    reserved_micros: number
  } {
    const persisted = firstRow<{ used_micros: number }>(this.state.storage.sql.exec(
      `SELECT used_micros FROM subscription_term_windows
        WHERE term_generation = ? AND quota_reset_epoch = ? AND kind = ? AND start_ms = ?`,
      window.term_generation,
      window.quota_reset_epoch,
      window.kind,
      window.start_ms,
    ))
    const column = `${window.kind}_window_start_ms`
    const reserved = firstRow<{ reserved_micros: number }>(this.state.storage.sql.exec(
      `SELECT COALESCE(SUM(reserved_micros), 0) AS reserved_micros
         FROM subscription_requests
        WHERE (status = 'reserved' OR (status = 'expired' AND committed = 1))
          AND term_generation = ? AND ${column} = ?
          AND (? <> 'daily' OR quota_reset_epoch = ?)`,
      window.term_generation,
      window.start_ms,
      window.kind,
      window.quota_reset_epoch,
    ))?.reserved_micros ?? 0
    return {
      ...window,
      used_micros: persisted?.used_micros ?? 0,
      reserved_micros: reserved,
    }
  }

  private requestWindow(request: SubscriptionRequestRow, kind: WindowKind): WindowState {
    const start = request[`${kind}_window_start_ms`]
    if (start === null) {
      throw new StateApiError(500, 'invalid_persisted_state', 'Reserved request has no quota window')
    }
    const quotaResetEpoch = kind === 'daily' ? request.quota_reset_epoch : 0
    const persisted = firstRow<{ end_ms: number }>(this.state.storage.sql.exec(
      `SELECT end_ms FROM subscription_term_windows
        WHERE term_generation = ? AND quota_reset_epoch = ? AND kind = ? AND start_ms = ?`,
      request.term_generation,
      quotaResetEpoch,
      kind,
      start,
    ))
    const recovered: WindowState = {
      kind,
      start_ms: start,
      // Additive schema upgrades cannot reconstruct an old term's exact partial-period
      // end. The end is informational after admission, so recover a conservative natural
      // period while keeping the historical generation isolated from the active term.
      end_ms: persisted?.end_ms ?? checkedAdd(
        start,
        kind === 'daily' ? DAY_MS : kind === 'weekly' ? WEEK_MS : MONTH_MS,
        `${kind} window end`,
      ),
      term_generation: request.term_generation,
      quota_reset_epoch: quotaResetEpoch,
    }
    if (persisted === undefined) this.ensureWindow(recovered, 0)
    return recovered
  }

  private expireDueReservations(now: number): number {
    const due = firstRow<{ total: number }>(this.state.storage.sql.exec(
      `SELECT COUNT(*) AS total FROM subscription_requests
        WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
      now,
    ))?.total ?? 0
    if (due > 0) {
      this.state.storage.sql.exec(
        `UPDATE subscription_requests SET status = 'expired', updated_at_ms = ?
          WHERE status = 'reserved' AND committed = 0 AND reservation_expires_at_ms <= ?`,
        now, now,
      )
    }
    return due
  }

  private cleanupTombstones(now: number): void {
    this.state.storage.sql.exec(
      `DELETE FROM subscription_requests
        WHERE status IN ('cancelled', 'settled', 'expired') AND committed = 0 AND updated_at_ms < ?`,
      Math.max(0, now - TOMBSTONE_RETENTION_MS),
    )
    this.state.storage.sql.exec(
      `DELETE FROM subscription_outbox
        WHERE published_at_ms IS NOT NULL AND published_at_ms < ?`,
      Math.max(0, now - TOMBSTONE_RETENTION_MS),
    )
  }

  private appendProjectionEvent(
    profile: SubscriptionProfileRow,
    request: SubscriptionRequestRow,
    amount: number,
    now: number,
  ): void {
    if (this.env?.EVENTS_QUEUE === undefined) return
    const payload: SubscriptionStateChangedPayload = {
      request_id: request.request_id,
      subscription_id: profile.subscription_id,
      user_id: profile.user_id,
      group_id: profile.group_id,
      amount_micros: amount,
      daily_window_start_ms: request.daily_window_start_ms!,
      weekly_window_start_ms: request.weekly_window_start_ms!,
      monthly_window_start_ms: request.monthly_window_start_ms!,
      quota_reset_epoch: request.quota_reset_epoch,
      updated_at_ms: now,
    }
    const event: PlatformEvent<SubscriptionStateChangedPayload> = {
      schema_version: 1,
      event_id: `subscription-usage:${request.request_id}`,
      event_type: 'subscription.usage.settled.v1',
      occurred_at_ms: now,
      aggregate_type: 'subscription',
      aggregate_id: profile.subscription_id,
      payload,
    }
    this.appendOutboxEvent(event, `subscription:${request.request_id}`, now)
  }

  private appendOutboxEvent(event: unknown, dedupeKey: string, now: number): void {
    const eventId = (event as { event_id?: unknown } | null)?.event_id
    if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 256) {
      throw new StateApiError(400, 'invalid_outbox_event', 'Outbox event id is invalid')
    }
    const payloadJson = JSON.stringify(event)
    const existing = firstRow<{ payload_json: string }>(this.state.storage.sql.exec(
      'SELECT payload_json FROM subscription_outbox WHERE dedupe_key = ?', dedupeKey,
    ))
    if (existing !== undefined) {
      if (existing.payload_json !== payloadJson) {
        throw new StateApiError(409, 'outbox_event_conflict', 'Outbox key already has a different event')
      }
      return
    }
    this.state.storage.sql.exec(
      `INSERT INTO subscription_outbox (
         event_id, dedupe_key, payload_json, attempts, available_at_ms, published_at_ms, created_at_ms
       ) VALUES (?, ?, ?, 0, ?, NULL, ?)`,
      eventId, dedupeKey, payloadJson, now, now,
    )
  }

  private async publishPendingOutbox(): Promise<void> {
    if (this.env?.EVENTS_QUEUE === undefined) return
    const now = Date.now()
    const rows = Array.from(this.state.storage.sql.exec(
      `SELECT event_id, payload_json, attempts FROM subscription_outbox
        WHERE published_at_ms IS NULL AND available_at_ms <= ?
        ORDER BY available_at_ms, event_id LIMIT 10`,
      now,
    )) as Array<{ event_id: string; payload_json: string; attempts: number }>
    for (const row of rows) {
      try {
        await this.env.EVENTS_QUEUE.send(JSON.parse(row.payload_json))
        this.state.storage.sql.exec(
          'UPDATE subscription_outbox SET published_at_ms = ? WHERE event_id = ? AND published_at_ms IS NULL',
          Date.now(), row.event_id,
        )
      } catch (error) {
        this.state.storage.sql.exec(
          `UPDATE subscription_outbox SET attempts = attempts + 1, available_at_ms = ?
            WHERE event_id = ? AND published_at_ms IS NULL`,
          Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6)), row.event_id,
        )
        console.error('subscription outbox publish failed', {
          event_id: row.event_id,
          name: error instanceof Error ? error.name : 'unknown',
        })
        break
      }
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const reservation = firstRow<{ next_alarm_ms: number | null }>(this.state.storage.sql.exec(
      `SELECT MIN(reservation_expires_at_ms) AS next_alarm_ms FROM subscription_requests
        WHERE status = 'reserved' AND committed = 0`,
    ))?.next_alarm_ms
    const outbox = firstRow<{ next_alarm_ms: number | null }>(this.state.storage.sql.exec(
      `SELECT MIN(available_at_ms) AS next_alarm_ms FROM subscription_outbox
        WHERE published_at_ms IS NULL`,
    ))?.next_alarm_ms
    const candidates = [reservation, outbox].filter((value): value is number => typeof value === 'number')
    if (candidates.length > 0) {
      await this.state.storage.setAlarm(Math.max(Math.min(...candidates), Date.now()))
    }
  }
}

function parseConfigure(body: Record<string, unknown>): ConfigureInput {
  requireSchemaVersion(body)
  const input: ConfigureInput = {
    subscription_id: requireString(body, 'subscription_id'),
    user_id: requireString(body, 'user_id'),
    group_id: requireString(body, 'group_id'),
    starts_at_ms: requireSafeInteger(body, 'starts_at_ms'),
    expires_at_ms: requireSafeInteger(body, 'expires_at_ms', { minimum: 1 }),
    daily_quota_micros: nullableSafeInteger(body, 'daily_quota_micros'),
    weekly_quota_micros: nullableSafeInteger(body, 'weekly_quota_micros'),
    monthly_quota_micros: nullableSafeInteger(body, 'monthly_quota_micros'),
    enabled: body.enabled === undefined ? 1 : requireBoolean(body, 'enabled') ? 1 : 0,
    daily_used_micros: requireSafeInteger(body, 'daily_used_micros'),
    weekly_used_micros: requireSafeInteger(body, 'weekly_used_micros'),
    monthly_used_micros: requireSafeInteger(body, 'monthly_used_micros'),
    daily_anchor_ms: requireSafeInteger(body, 'daily_anchor_ms'),
    daily_window_start_ms: nullableSafeInteger(body, 'daily_window_start_ms'),
    weekly_window_start_ms: nullableSafeInteger(body, 'weekly_window_start_ms'),
    monthly_window_start_ms: nullableSafeInteger(body, 'monthly_window_start_ms'),
    control_version: requireSafeInteger(body, 'control_version'),
    quota_reset_epoch: requireSafeInteger(body, 'quota_reset_epoch'),
    quota_reset_generation: requireSafeInteger(body, 'quota_reset_generation'),
    updated_at_ms: Date.now(),
  }
  if (input.expires_at_ms <= input.starts_at_ms) {
    throw new StateApiError(400, 'invalid_subscription_window', 'expires_at_ms must be after starts_at_ms')
  }
  if (input.daily_anchor_ms !== 0 && input.daily_anchor_ms !== input.starts_at_ms) {
    throw new StateApiError(400, 'invalid_daily_anchor', 'daily_anchor_ms must be zero or starts_at_ms')
  }
  return input
}

function parseResetQuota(body: Record<string, unknown>): ResetQuotaInput {
  requireSchemaVersion(body)
  const rawWindows = body.windows
  if (rawWindows === null || typeof rawWindows !== 'object' || Array.isArray(rawWindows)) {
    throw new StateApiError(400, 'invalid_windows', 'windows must be an object')
  }
  const windowBody = rawWindows as Record<string, unknown>
  const windows = {
    daily: nullableSafeInteger(windowBody, 'daily'),
    weekly: nullableSafeInteger(windowBody, 'weekly'),
    monthly: nullableSafeInteger(windowBody, 'monthly'),
  }
  if (windows.daily === null && windows.weekly === null && windows.monthly === null) {
    throw new StateApiError(400, 'empty_quota_reset', 'At least one quota window must be reset')
  }
  return {
    mutation_id: requireString(body, 'mutation_id'),
    subscription_id: requireString(body, 'subscription_id'),
    control_version: requireSafeInteger(body, 'control_version'),
    windows,
  }
}

function requireObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateApiError(400, `invalid_${field}`, `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function nullableSafeInteger(body: Record<string, unknown>, field: string): number | null {
  if (body[field] === null) return null
  return requireSafeInteger(body, field)
}

function parseOptionalUsageEvent(
  value: unknown,
  requestId: string,
  amount: number,
): Record<string, unknown> | null {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateApiError(400, 'invalid_usage_event', 'usage_event must be an object')
  }
  const event = value as Record<string, unknown>
  const payload = event.payload as Record<string, unknown> | null
  if (
    event.schema_version !== 1 ||
    event.event_type !== 'usage.settled.v1' ||
    typeof event.event_id !== 'string' ||
    event.aggregate_type !== 'user' ||
    payload === null || typeof payload !== 'object' ||
    payload.request_id !== requestId || payload.amount_micros !== amount
  ) {
    throw new StateApiError(400, 'invalid_usage_event', 'usage_event has an invalid envelope')
  }
  return event
}

function validateUsageEventBilling(
  event: Record<string, unknown> | null,
  profile: SubscriptionProfileRow,
): void {
  if (event === null) return
  const payload = event.payload as Record<string, unknown>
  if (
    event.aggregate_id !== profile.user_id ||
    payload.user_id !== profile.user_id ||
    payload.group_id !== profile.group_id ||
    payload.billing_type !== 'subscription' ||
    payload.subscription_id !== profile.subscription_id
  ) {
    throw new StateApiError(400, 'usage_event_billing_mismatch', 'usage_event does not match subscription billing state')
  }
}

function currentWindow(
  profile: SubscriptionProfileRow,
  kind: WindowKind,
  now: number,
): WindowState {
  if (now < profile.starts_at_ms || now >= profile.expires_at_ms) {
    throw new StateApiError(403, 'subscription_expired', 'Subscription is not active at this time')
  }
  const period = kind === 'daily' ? DAY_MS : kind === 'weekly' ? WEEK_MS : MONTH_MS
  const anchor = kind === 'daily'
    ? profile.daily_anchor_ms + Math.floor((now - profile.daily_anchor_ms) / DAY_MS) * DAY_MS
    : (() => {
        const periodicAnchor = kind === 'weekly' ? profile.weekly_anchor_ms : profile.monthly_anchor_ms
        return periodicAnchor + Math.floor((now - periodicAnchor) / period) * period
      })()
  const naturalEnd = kind === 'daily'
    ? checkedAdd(anchor, DAY_MS, 'window end')
    : checkedAdd(anchor, period, 'window end')
  return {
    kind,
    start_ms: anchor,
    end_ms: Math.min(naturalEnd, profile.expires_at_ms),
    term_generation: profile.term_generation,
    quota_reset_epoch: kind === 'daily' ? profile.quota_reset_epoch : 0,
  }
}

function initialPeriodicAnchor(
  input: ConfigureInput,
  kind: 'weekly' | 'monthly',
  now: number,
): number {
  const persisted = input[`${kind}_window_start_ms`]
  if (persisted === null) return now
  const legacyActivationDay = Math.floor(input.starts_at_ms / DAY_MS) * DAY_MS
  return persisted === legacyActivationDay ? input.starts_at_ms : persisted
}

function windowFor(profile: SubscriptionProfileRow, kind: WindowKind, start: number): WindowState {
  const period = kind === 'daily' ? DAY_MS : kind === 'weekly' ? WEEK_MS : MONTH_MS
  const naturalEnd = checkedAdd(start, period, 'window end')
  return {
    kind,
    start_ms: start,
    end_ms: Math.min(naturalEnd, profile.expires_at_ms),
    term_generation: profile.term_generation,
    quota_reset_epoch: kind === 'daily' ? profile.quota_reset_epoch : 0,
  }
}

function quotaFor(profile: SubscriptionProfileRow, kind: WindowKind): number | null {
  return profile[`${kind}_quota_micros`]
}

function assertActive(profile: SubscriptionProfileRow, now: number): void {
  if (profile.enabled !== 1) {
    throw new StateApiError(403, 'subscription_disabled', 'Subscription is disabled')
  }
  if (now < profile.starts_at_ms || now >= profile.expires_at_ms) {
    throw new StateApiError(403, 'subscription_expired', 'Subscription is not active at this time')
  }
}

function assertCurrentRequestGeneration(
  request: Pick<SubscriptionRequestRow, 'term_generation' | 'quota_reset_epoch'>,
  profile: Pick<SubscriptionProfileRow, 'term_generation' | 'quota_reset_epoch'>,
): void {
  if (
    request.term_generation !== profile.term_generation ||
    request.quota_reset_epoch !== profile.quota_reset_epoch
  ) {
    throw new StateApiError(
      409,
      'subscription_generation_changed',
      'Subscription term or quota epoch changed before reservation',
    )
  }
}

function incrementGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new StateApiError(409, 'term_generation_exhausted', 'Subscription term generation is exhausted')
  }
  return value + 1
}

function checkedAdd(value: number, delta: number, field: string): number {
  const result = value + delta
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new StateApiError(500, 'state_amount_overflow', `${field} exceeds the supported range`)
  }
  return result
}

function sameConfiguration(a: SubscriptionProfileRow, b: ConfigureInput): boolean {
  return a.starts_at_ms === b.starts_at_ms &&
    a.expires_at_ms === b.expires_at_ms &&
    a.daily_quota_micros === b.daily_quota_micros &&
    a.weekly_quota_micros === b.weekly_quota_micros &&
    a.monthly_quota_micros === b.monthly_quota_micros
    && a.enabled === b.enabled && a.daily_anchor_ms === b.daily_anchor_ms
    && a.quota_reset_epoch === b.quota_reset_epoch
    && a.quota_reset_generation === b.quota_reset_generation
}

function firstRow<T>(rows: Iterable<unknown>): T | undefined {
  return Array.from(rows)[0] as T | undefined
}

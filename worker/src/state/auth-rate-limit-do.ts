import {
  errorResponse,
  json,
  readJsonObject,
  requireSchemaVersion,
  requireString,
  StateApiError,
} from './http'

type AuthAction = 'login' | 'register'
type LimitDimension = 'ip' | 'account'

interface LimitRule {
  windowMs: number
  maxAttempts: number
  failureThreshold: number
  baseCooldownMs: number
  maxCooldownMs: number
}

interface LimitRow {
  action: AuthAction
  dimension: LimitDimension
  subject_digest: string
  window_started_at_ms: number
  attempts: number
  consecutive_failures: number
  blocked_until_ms: number
  updated_at_ms: number
}

interface LimitSubjects {
  action: AuthAction
  ipDigest: string
  accountDigest: string
}

const RETENTION_MS = 24 * 60 * 60 * 1_000
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

const RULES: Record<AuthAction, Record<LimitDimension, LimitRule>> = {
  login: {
    ip: {
      windowMs: 15 * 60 * 1_000,
      maxAttempts: 50,
      failureThreshold: 10,
      baseCooldownMs: 2_000,
      maxCooldownMs: 15 * 60 * 1_000,
    },
    account: {
      windowMs: 15 * 60 * 1_000,
      maxAttempts: 10,
      failureThreshold: 3,
      baseCooldownMs: 2_000,
      maxCooldownMs: 15 * 60 * 1_000,
    },
  },
  register: {
    ip: {
      windowMs: 60 * 60 * 1_000,
      maxAttempts: 5,
      failureThreshold: 3,
      baseCooldownMs: 30_000,
      maxCooldownMs: 60 * 60 * 1_000,
    },
    account: {
      windowMs: 60 * 60 * 1_000,
      maxAttempts: 3,
      failureThreshold: 1,
      baseCooldownMs: 30_000,
      maxCooldownMs: 15 * 60 * 1_000,
    },
  },
}

/**
 * Globally serializes the relatively low-volume password entry points. A
 * request has both an IP and account key, so sharding by either key would need
 * a fallible cross-object transaction to preserve all-or-nothing admission.
 * Keep this coordinator single and put Cloudflare WAF limits in front of it.
 * The Worker sends only keyed SHA-256 digests; raw addresses and emails never
 * enter the object's name, request log, or storage.
 */
export class AuthRateLimitDO {
  constructor(private readonly state: DurableObjectState) {
    this.state.blockConcurrencyWhile(async () => {
      this.initializeSchema()
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname
      if (request.method !== 'POST') {
        throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
      }
      const body = await readJsonObject(request)
      requireSchemaVersion(body)
      if (pathname === '/anonymous-attempt') return this.anonymousAttempt(body)
      const subjects = parseSubjects(body)
      if (pathname === '/check') return this.admission(subjects, false)
      if (pathname === '/attempt') return this.attempt(subjects)
      if (pathname === '/failure') return this.failure(subjects)
      if (pathname === '/success') return this.success(subjects)
      throw new StateApiError(404, 'route_not_found', 'Durable object route was not found')
    } catch (error) {
      return errorResponse(error)
    }
  }

  private anonymousAttempt(body: Record<string, unknown>): Response {
    const now = Date.now()
    const ipDigest = requireDigest(body, 'ip_digest')
    const result = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      const state = this.load('login', 'ip', ipDigest, now)
      const rule = RULES.login.ip
      if (state.blocked_until_ms > now || state.attempts >= rule.maxAttempts) {
        const blockedUntilMs = Math.max(
          state.blocked_until_ms,
          state.window_started_at_ms + rule.windowMs,
          now + 1_000,
        )
        state.blocked_until_ms = blockedUntilMs
        state.updated_at_ms = now
        this.persist(state)
        return blockedUntilMs
      }
      state.attempts += 1
      state.updated_at_ms = now
      this.persist(state)
      return 0
    })
    if (result === 0) {
      return json({ schema_version: 1, allowed: true, retry_after_seconds: 0, blocked_by: [] })
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((result - now) / 1_000))
    const response = json({
      schema_version: 1,
      allowed: false,
      retry_after_seconds: retryAfterSeconds,
      blocked_by: ['ip'],
    }, 429)
    response.headers.set('retry-after', String(retryAfterSeconds))
    return response
  }

  private attempt(subjects: LimitSubjects): Response {
    return this.admission(subjects, true)
  }

  private admission(subjects: LimitSubjects, consume: boolean): Response {
    const now = Date.now()
    const result = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      const states = this.loadBoth(subjects, now)
      const blockedBy: LimitDimension[] = []
      let retryAfterMs = 0

      for (const dimension of dimensions()) {
        const state = states[dimension]
        const rule = RULES[subjects.action][dimension]
        if (state.blocked_until_ms > now) {
          blockedBy.push(dimension)
          retryAfterMs = Math.max(retryAfterMs, state.blocked_until_ms - now)
          continue
        }
        if (state.attempts >= rule.maxAttempts) {
          const exhaustedUntilMs = Math.max(now + 1_000, state.window_started_at_ms + rule.windowMs)
          if (consume) {
            state.blocked_until_ms = exhaustedUntilMs
            state.updated_at_ms = now
            this.persist(state)
          }
          blockedBy.push(dimension)
          retryAfterMs = Math.max(retryAfterMs, exhaustedUntilMs - now)
        }
      }

      if (blockedBy.length > 0) return { blockedBy, retryAfterMs }
      if (consume) {
        for (const state of Object.values(states)) {
          state.attempts += 1
          state.updated_at_ms = now
          this.persist(state)
        }
      }
      return { blockedBy, retryAfterMs: 0 }
    })

    if (result.blockedBy.length === 0) {
      return json({ schema_version: 1, allowed: true, retry_after_seconds: 0, blocked_by: [] })
    }
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000))
    const response = json({
      schema_version: 1,
      allowed: false,
      retry_after_seconds: retryAfterSeconds,
      blocked_by: result.blockedBy,
    }, 429)
    response.headers.set('retry-after', String(retryAfterSeconds))
    return response
  }

  private failure(subjects: LimitSubjects): Response {
    const now = Date.now()
    const result = this.state.storage.transactionSync(() => {
      this.cleanup(now)
      const states = this.loadBoth(subjects, now)
      let blockedUntilMs = 0
      for (const dimension of dimensions()) {
        const state = states[dimension]
        const rule = RULES[subjects.action][dimension]
        state.consecutive_failures += 1
        if (state.consecutive_failures >= rule.failureThreshold) {
          const exponent = Math.min(30, state.consecutive_failures - rule.failureThreshold)
          const cooldownMs = Math.min(rule.maxCooldownMs, rule.baseCooldownMs * 2 ** exponent)
          state.blocked_until_ms = Math.max(state.blocked_until_ms, now + cooldownMs)
        }
        state.updated_at_ms = now
        this.persist(state)
        blockedUntilMs = Math.max(blockedUntilMs, state.blocked_until_ms)
      }
      return blockedUntilMs
    })
    return json({
      schema_version: 1,
      recorded: true,
      blocked_until_ms: result === 0 ? null : result,
    })
  }

  private success(subjects: LimitSubjects): Response {
    const now = Date.now()
    this.state.storage.transactionSync(() => {
      this.cleanup(now)
      this.state.storage.sql.exec(
        `DELETE FROM auth_rate_limits
          WHERE action = ? AND dimension = ? AND subject_digest = ?`,
        subjects.action,
        'account',
        subjects.accountDigest,
      )
    })
    return json({ schema_version: 1, cleared: ['account'] })
  }

  private loadBoth(
    subjects: LimitSubjects,
    now: number,
  ): Record<LimitDimension, LimitRow> {
    return {
      ip: this.load(subjects.action, 'ip', subjects.ipDigest, now),
      account: this.load(subjects.action, 'account', subjects.accountDigest, now),
    }
  }

  private load(
    action: AuthAction,
    dimension: LimitDimension,
    digest: string,
    now: number,
  ): LimitRow {
    const stored = Array.from(this.state.storage.sql.exec(
      `SELECT action, dimension, subject_digest, window_started_at_ms,
              attempts, consecutive_failures, blocked_until_ms, updated_at_ms
         FROM auth_rate_limits
        WHERE action = ? AND dimension = ? AND subject_digest = ?`,
      action,
      dimension,
      digest,
    ))[0] as unknown as LimitRow | undefined
    const rule = RULES[action][dimension]
    if (stored === undefined || stored.window_started_at_ms + rule.windowMs <= now) {
      return {
        action,
        dimension,
        subject_digest: digest,
        window_started_at_ms: now,
        attempts: 0,
        consecutive_failures: 0,
        blocked_until_ms: 0,
        updated_at_ms: now,
      }
    }
    return { ...stored }
  }

  private persist(row: LimitRow): void {
    this.state.storage.sql.exec(
      `INSERT INTO auth_rate_limits (
         action, dimension, subject_digest, window_started_at_ms,
         attempts, consecutive_failures, blocked_until_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (action, dimension, subject_digest) DO UPDATE SET
         window_started_at_ms = excluded.window_started_at_ms,
         attempts = excluded.attempts,
         consecutive_failures = excluded.consecutive_failures,
         blocked_until_ms = excluded.blocked_until_ms,
         updated_at_ms = excluded.updated_at_ms`,
      row.action,
      row.dimension,
      row.subject_digest,
      row.window_started_at_ms,
      row.attempts,
      row.consecutive_failures,
      row.blocked_until_ms,
      row.updated_at_ms,
    )
  }

  private cleanup(now: number): void {
    this.state.storage.sql.exec(
      'DELETE FROM auth_rate_limits WHERE updated_at_ms < ?',
      now - RETENTION_MS,
    )
  }

  private initializeSchema(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        action TEXT NOT NULL CHECK (action IN ('login', 'register')),
        dimension TEXT NOT NULL CHECK (dimension IN ('ip', 'account')),
        subject_digest TEXT NOT NULL CHECK (length(subject_digest) = 64),
        window_started_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        blocked_until_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (action, dimension, subject_digest)
      ) WITHOUT ROWID
    `)
    this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx ON auth_rate_limits(updated_at_ms)',
    )
  }
}

function parseSubjects(body: Record<string, unknown>): LimitSubjects {
  const action = requireString(body, 'action', 16)
  if (action !== 'login' && action !== 'register') {
    throw new StateApiError(400, 'invalid_action', 'action must be login or register')
  }
  return {
    action,
    ipDigest: requireDigest(body, 'ip_digest'),
    accountDigest: requireDigest(body, 'account_digest'),
  }
}

function requireDigest(body: Record<string, unknown>, field: string): string {
  const digest = requireString(body, field, 64)
  if (!DIGEST_PATTERN.test(digest)) {
    throw new StateApiError(400, `invalid_${field}`, `${field} must be a lowercase SHA-256 digest`)
  }
  return digest
}

function dimensions(): readonly LimitDimension[] {
  return ['ip', 'account']
}

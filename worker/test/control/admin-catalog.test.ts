import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

type Row = Record<string, any>

class CatalogStatement {
  values: unknown[] = []

  constructor(readonly query: string, private readonly database: CatalogDatabase) {}

  bind(...values: unknown[]): CatalogStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('SELECT 1 AS allowed') && this.query.includes('FROM admin_user_roles')) {
      return { allowed: 1 } as T
    }
    if (this.query.includes('FROM admin_sessions')) {
      return { session_id: 'session-1', user_id: 'admin-1' } as T
    }
    if (this.query.includes('FROM control_idempotency')) {
      return (this.database.idempotency.get(`${this.values[0]}:${this.values[1]}`) ?? null) as T | null
    }
    if (this.query.includes('SELECT MAX(version) AS version FROM model_prices')) {
      const prices = this.database.pricesFor(String(this.values[0]), String(this.values[1]))
      return { version: prices.length === 0 ? null : Math.max(...prices.map((price) => price.version)) } as T
    }
    if (this.query.includes('FROM group_models gm JOIN models')) {
      return this.database.joinedGroupModel(String(this.values[0]), String(this.values[1])) as T | null
    }
    if (this.query.includes('FROM "groups"') && this.query.includes('WHERE name = ?')) {
      return ([...this.database.groups.values()].find((group) => group.name === this.values[0]) ?? null) as T | null
    }
    if (this.query.includes('FROM "groups"') && this.query.includes('WHERE id = ?')) {
      return (this.database.groups.get(String(this.values[0])) ?? null) as T | null
    }
    if (this.query.includes('FROM models') && this.query.includes('WHERE id = ?')) {
      return (this.database.models.get(String(this.values[0])) ?? null) as T | null
    }
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.query.includes('FROM group_models gm JOIN models')) {
      const groupId = String(this.values[0])
      const rows = [...this.database.groupModels.values()]
        .filter((link) => link.group_id === groupId)
        .map((link) => this.database.joinedGroupModel(link.group_id, link.model_id))
        .filter((row): row is Row => row !== null)
        .sort((left, right) => left.sort_order - right.sort_order || left.public_name.localeCompare(right.public_name))
      return rowsResult(rows as T[])
    }
    if (this.query.includes('FROM model_prices WHERE group_id = ? AND model_id = ?')) {
      const rows = this.database.pricesFor(String(this.values[0]), String(this.values[1]))
        .sort((left, right) => right.version - left.version)
      return rowsResult(rows as T[])
    }
    throw new Error(`Unexpected all query: ${this.query}`)
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.query.includes('INSERT INTO "groups"')) {
      const [
        id, name, description, platform, enabled, sortOrder, multiplier, rpmLimit,
        catalogMode, groupType, isExclusive, dailyQuota, weeklyQuota, monthlyQuota,
        allowImage, allowBatchImage, imageRateIndependent, imageRateMultiplier,
        batchDiscountMultiplier, batchHoldMultiplier, imagePrice1k, imagePrice2k,
        imagePrice4k, createdAt, updatedAt,
      ] = this.values
      this.database.groups.set(String(id), {
        id: String(id),
        name: String(name),
        description: description === null ? null : String(description),
        platform: String(platform),
        enabled: Number(enabled),
        sort_order: Number(sortOrder),
        rate_multiplier_ppm: Number(multiplier),
        rpm_limit: Number(rpmLimit),
        catalog_mode: String(catalogMode),
        group_type: String(groupType),
        is_exclusive: Number(isExclusive),
        daily_quota_micros: dailyQuota === null ? null : Number(dailyQuota),
        weekly_quota_micros: weeklyQuota === null ? null : Number(weeklyQuota),
        monthly_quota_micros: monthlyQuota === null ? null : Number(monthlyQuota),
        allow_image_generation: Number(allowImage),
        allow_batch_image_generation: Number(allowBatchImage),
        image_rate_independent: Number(imageRateIndependent),
        image_rate_multiplier_ppm: Number(imageRateMultiplier),
        batch_image_discount_multiplier_ppm: Number(batchDiscountMultiplier),
        batch_image_hold_multiplier_ppm: Number(batchHoldMultiplier),
        image_price_1k_micros: imagePrice1k === null ? null : Number(imagePrice1k),
        image_price_2k_micros: imagePrice2k === null ? null : Number(imagePrice2k),
        image_price_4k_micros: imagePrice4k === null ? null : Number(imagePrice4k),
        control_version: 0,
        created_at_ms: Number(createdAt),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('UPDATE "groups"') && this.query.includes('SET enabled = 0')) {
      const [expected, nextVersion, updatedAt, id] = this.values
      const group = this.database.requireRow(this.database.groups, String(id))
      this.database.assertVersion(group, Number(expected))
      Object.assign(group, { enabled: 0, control_version: Number(nextVersion), updated_at_ms: Number(updatedAt) })
      return result()
    }
    if (this.query.includes('UPDATE "groups"')) {
      const [
        name, description, platform, enabled, sortOrder, multiplier, rpmLimit,
        catalogMode, groupType, isExclusive, dailyQuota, weeklyQuota, monthlyQuota,
        allowImage, allowBatchImage, imageRateIndependent, imageRateMultiplier,
        batchDiscountMultiplier, batchHoldMultiplier, imagePrice1k, imagePrice2k,
        imagePrice4k, expected, nextVersion, updatedAt, id,
      ] = this.values
      const group = this.database.requireRow(this.database.groups, String(id))
      this.database.assertVersion(group, Number(expected))
      Object.assign(group, {
        name: String(name),
        description: description === null ? null : String(description),
        platform: String(platform),
        enabled: Number(enabled),
        sort_order: Number(sortOrder),
        rate_multiplier_ppm: Number(multiplier),
        rpm_limit: Number(rpmLimit),
        catalog_mode: String(catalogMode),
        group_type: String(groupType),
        is_exclusive: Number(isExclusive),
        daily_quota_micros: dailyQuota === null ? null : Number(dailyQuota),
        weekly_quota_micros: weeklyQuota === null ? null : Number(weeklyQuota),
        monthly_quota_micros: monthlyQuota === null ? null : Number(monthlyQuota),
        allow_image_generation: Number(allowImage),
        allow_batch_image_generation: Number(allowBatchImage),
        image_rate_independent: Number(imageRateIndependent),
        image_rate_multiplier_ppm: Number(imageRateMultiplier),
        batch_image_discount_multiplier_ppm: Number(batchDiscountMultiplier),
        batch_image_hold_multiplier_ppm: Number(batchHoldMultiplier),
        image_price_1k_micros: imagePrice1k === null ? null : Number(imagePrice1k),
        image_price_2k_micros: imagePrice2k === null ? null : Number(imagePrice2k),
        image_price_4k_micros: imagePrice4k === null ? null : Number(imagePrice4k),
        control_version: Number(nextVersion),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('INSERT INTO models')) {
      const [id, platform, publicName, upstreamName, endpoint, embeddings, enabled, createdAt, updatedAt] = this.values
      this.database.models.set(String(id), {
        id: String(id),
        platform: String(platform),
        public_name: String(publicName),
        upstream_name: String(upstreamName),
        endpoint: String(endpoint),
        embeddings: Number(embeddings),
        enabled: Number(enabled),
        control_version: 0,
        created_at_ms: Number(createdAt),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('UPDATE models SET platform')) {
      const [platform, publicName, upstreamName, endpoint, embeddings, enabled,
        expected, nextVersion, updatedAt, id] = this.values
      const model = this.database.requireRow(this.database.models, String(id))
      this.database.assertVersion(model, Number(expected))
      Object.assign(model, {
        platform: String(platform),
        public_name: String(publicName),
        upstream_name: String(upstreamName),
        endpoint: String(endpoint),
        embeddings: Number(embeddings),
        enabled: Number(enabled),
        control_version: Number(nextVersion),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('INSERT INTO group_models')) {
      const [groupId, modelId, upstreamOverride, enabled, catalogVisible, sortOrder,
        maxOutput, defaultMaxOutput, createdAt, updatedAt] = this.values
      this.database.groupModels.set(this.database.linkKey(String(groupId), String(modelId)), {
        group_id: String(groupId),
        model_id: String(modelId),
        upstream_name_override: upstreamOverride === null ? null : String(upstreamOverride),
        enabled: Number(enabled),
        catalog_visible: Number(catalogVisible),
        sort_order: Number(sortOrder),
        max_output_tokens: Number(maxOutput),
        default_max_output_tokens: Number(defaultMaxOutput),
        control_version: 0,
        created_at_ms: Number(createdAt),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('UPDATE group_models SET upstream_name_override')) {
      const [upstreamOverride, enabled, catalogVisible, sortOrder, maxOutput, defaultMaxOutput,
        expected, nextVersion, updatedAt, groupId, modelId] = this.values
      const link = this.database.requireRow(
        this.database.groupModels,
        this.database.linkKey(String(groupId), String(modelId)),
      )
      this.database.assertVersion(link, Number(expected))
      Object.assign(link, {
        upstream_name_override: upstreamOverride === null ? null : String(upstreamOverride),
        enabled: Number(enabled),
        catalog_visible: Number(catalogVisible),
        sort_order: Number(sortOrder),
        max_output_tokens: Number(maxOutput),
        default_max_output_tokens: Number(defaultMaxOutput),
        control_version: Number(nextVersion),
        updated_at_ms: Number(updatedAt),
      })
      return result()
    }
    if (this.query.includes('UPDATE model_prices SET active = 0')) {
      const [retiredAt, groupId, modelId] = this.values
      for (const price of this.database.pricesFor(String(groupId), String(modelId))) {
        if (price.active === 1) Object.assign(price, { active: 0, retired_at_ms: Number(retiredAt) })
      }
      return result()
    }
    if (this.query.includes('INSERT INTO model_prices')) {
      const [id, groupId, modelId, version, input, output, cacheRead, perRequest,
        minimumReservation, effectiveAt, createdAt] = this.values
      this.database.prices.set(String(id), {
        id: String(id),
        group_id: String(groupId),
        model_id: String(modelId),
        version: Number(version),
        active: 1,
        input_micros_per_million: Number(input),
        output_micros_per_million: Number(output),
        cache_read_micros_per_million: Number(cacheRead),
        per_request_micros: Number(perRequest),
        minimum_reservation_micros: Number(minimumReservation),
        effective_at_ms: Number(effectiveAt),
        retired_at_ms: null,
        created_at_ms: Number(createdAt),
      })
      return result()
    }
    if (this.query.includes('UPDATE group_models SET') && this.query.includes('control_version = CASE')) {
      const [expected, nextVersion, updatedAt, groupId, modelId] = this.values
      const link = this.database.requireRow(
        this.database.groupModels,
        this.database.linkKey(String(groupId), String(modelId)),
      )
      this.database.assertVersion(link, Number(expected))
      Object.assign(link, { control_version: Number(nextVersion), updated_at_ms: Number(updatedAt) })
      return result()
    }
    if (this.query.includes('INSERT INTO control_idempotency')) {
      const [scope, keyHash, requestHash, resourceType, resourceId, responseJson, createdAt, expiresAt] = this.values
      const key = `${scope}:${keyHash}`
      if (this.database.idempotency.has(key)) throw new Error('UNIQUE constraint failed: control_idempotency')
      this.database.idempotency.set(key, {
        scope,
        key_hash: keyHash,
        request_hash: requestHash,
        resource_type: resourceType,
        resource_id: resourceId,
        response_json: responseJson,
        created_at_ms: createdAt,
        expires_at_ms: expiresAt,
      })
      return result()
    }
    throw new Error(`Unexpected run query: ${this.query}`)
  }
}

class CatalogDatabase {
  readonly groups = new Map<string, Row>()
  readonly models = new Map<string, Row>()
  readonly groupModels = new Map<string, Row>()
  readonly prices = new Map<string, Row>()
  readonly idempotency = new Map<string, Row>()
  beforeBatch?: () => void

  prepare(query: string): CatalogStatement {
    return new CatalogStatement(query, this)
  }

  async batch(statements: CatalogStatement[]): Promise<D1Result<unknown>[]> {
    this.beforeBatch?.()
    this.beforeBatch = undefined
    const before = {
      groups: cloneRows(this.groups),
      models: cloneRows(this.models),
      groupModels: cloneRows(this.groupModels),
      prices: cloneRows(this.prices),
      idempotency: cloneRows(this.idempotency),
    }
    try {
      const values = []
      for (const statement of statements) values.push(await statement.run())
      return values
    } catch (error) {
      restoreRows(this.groups, before.groups)
      restoreRows(this.models, before.models)
      restoreRows(this.groupModels, before.groupModels)
      restoreRows(this.prices, before.prices)
      restoreRows(this.idempotency, before.idempotency)
      throw error
    }
  }

  linkKey(groupId: string, modelId: string): string {
    return `${groupId}:${modelId}`
  }

  pricesFor(groupId: string, modelId: string): Row[] {
    return [...this.prices.values()].filter((price) => price.group_id === groupId && price.model_id === modelId)
  }

  joinedGroupModel(groupId: string, modelId: string): Row | null {
    const link = this.groupModels.get(this.linkKey(groupId, modelId))
    const model = this.models.get(modelId)
    if (link === undefined || model === undefined) return null
    const price = this.pricesFor(groupId, modelId).find((candidate) => candidate.active === 1)
    return {
      ...link,
      public_name: model.public_name,
      upstream_name: model.upstream_name,
      endpoint: model.endpoint,
      embeddings: model.embeddings,
      price_id: price?.id ?? null,
      price_version: price?.version ?? null,
      input_micros_per_million: price?.input_micros_per_million ?? null,
      output_micros_per_million: price?.output_micros_per_million ?? null,
      cache_read_micros_per_million: price?.cache_read_micros_per_million ?? null,
      per_request_micros: price?.per_request_micros ?? null,
      minimum_reservation_micros: price?.minimum_reservation_micros ?? null,
    }
  }

  requireRow(rows: Map<string, Row>, key: string): Row {
    const row = rows.get(key)
    if (row === undefined) throw new Error('missing fake database row')
    return row
  }

  assertVersion(row: Row, expected: number): void {
    if (row.control_version !== expected) throw new Error('CHECK constraint failed: control_version')
  }
}

function cloneRows(rows: Map<string, Row>): Map<string, Row> {
  return new Map([...rows].map(([key, value]) => [key, { ...value }]))
}

function restoreRows(target: Map<string, Row>, source: Map<string, Row>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

function result(): D1Result<unknown> {
  return { success: true, results: [], meta: { changes: 1 } as D1Meta & Record<string, unknown> }
}

function rowsResult<T>(rows: T[]): D1Result<T> {
  return { success: true, results: rows, meta: { changes: 0 } as D1Meta & Record<string, unknown> }
}

function env(database: CatalogDatabase): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: database as unknown as D1Database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

function headers(key: string): Record<string, string> {
  return {
    authorization: 'Bearer admin-session',
    'content-type': 'application/json',
    'idempotency-key': key,
  }
}

async function request(
  database: CatalogDatabase,
  path: string,
  method: string,
  key: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return createApp().request(
    path,
    {
      method,
      headers: headers(key),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(database),
  )
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

async function createGroup(database: CatalogDatabase, key: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await request(database, '/api/v1/admin/groups', 'POST', key, {
    name: `group-${key}`,
    platform: 'openai',
    ...body,
  })
  expect(response.status).toBe(201)
  return (await json(response)).data
}

async function createModel(database: CatalogDatabase, key: string, body: Record<string, unknown> = {}): Promise<Row> {
  const response = await request(database, '/api/v1/admin/models', 'POST', key, {
    public_name: `model-${key}`,
    platform: 'openai',
    ...body,
  })
  expect(response.status).toBe(201)
  return (await json(response)).data
}

async function linkModel(database: CatalogDatabase, groupId: string, modelId: string, key: string): Promise<Row> {
  const response = await request(
    database,
    `/api/v1/admin/groups/${groupId}/models/${modelId}`,
    'PUT',
    key,
    { expected_control_version: 0 },
  )
  expect(response.status).toBe(201)
  return (await json(response)).data
}

describe('admin catalog control plane', () => {
  it('creates an OpenAI group idempotently with gateway billing/catalog settings', async () => {
    const database = new CatalogDatabase()
    const body = {
      name: 'paid',
      description: 'paid traffic',
      platform: 'openai',
      rate_multiplier_ppm: 1_250_000,
      catalog_mode: 'allowlist',
      group_type: 'subscription',
      is_exclusive: true,
      daily_quota_micros: 10_000_000,
      weekly_quota_micros: 50_000_000,
      monthly_quota_micros: 150_000_000,
    }

    const created = await request(database, '/api/v1/admin/groups', 'POST', 'catalog-create-1', body)
    const replayed = await request(database, '/api/v1/admin/groups', 'POST', 'catalog-create-1', body)

    expect(created.status).toBe(201)
    expect(replayed.status).toBe(200)
    expect(await json(replayed)).toEqual(await json(created.clone()))
    expect(database.groups).toHaveLength(1)
    expect((await json(created)).data).toMatchObject({
      name: 'paid',
      platform: 'openai',
      status: 'active',
      rate_multiplier_ppm: 1_250_000,
      catalog_mode: 'allowlist',
      group_type: 'subscription',
      is_exclusive: true,
      daily_quota_micros: 10_000_000,
      weekly_quota_micros: 50_000_000,
      monthly_quota_micros: 150_000_000,
      control_version: 0,
    })
  })

  it('uses private-by-default groups and rejects subscription quotas on standard groups', async () => {
    const database = new CatalogDatabase()
    const created = await request(database, '/api/v1/admin/groups', 'POST', 'safe-group-defaults', {
      name: 'private-default',
      platform: 'openai',
    })
    const invalidQuota = await request(database, '/api/v1/admin/groups', 'POST', 'invalid-standard-quota', {
      name: 'invalid-standard',
      platform: 'openai',
      group_type: 'standard',
      daily_quota_micros: 1_000_000,
    })
    const invalidType = await request(database, '/api/v1/admin/groups', 'POST', 'invalid-group-type', {
      name: 'invalid-type',
      platform: 'openai',
      group_type: 'enterprise',
    })

    expect(created.status).toBe(201)
    expect((await json(created)).data).toMatchObject({
      group_type: 'standard',
      is_exclusive: true,
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: null,
    })
    expect(invalidQuota.status).toBe(400)
    expect((await json(invalidQuota)).code).toBe('standard_group_subscription_quota')
    expect(invalidType.status).toBe(400)
    expect((await json(invalidType)).code).toBe('invalid_group_type')
  })

  it('partially updates a group with CAS, rejects stale writes, and soft-disables it', async () => {
    const database = new CatalogDatabase()
    const group = await createGroup(database, 'group-partial', {
      description: 'keep me',
      rate_multiplier_ppm: 1_100_000,
      catalog_mode: 'allowlist',
    })

    const updated = await request(database, `/api/v1/admin/groups/${group.id}`, 'PUT', 'group-update', {
      expected_control_version: 0,
      name: 'renamed',
      group_type: 'subscription',
      daily_quota_micros: 25_000_000,
    })
    expect(updated.status).toBe(200)
    expect((await json(updated)).data).toMatchObject({
      name: 'renamed',
      description: 'keep me',
      rate_multiplier_ppm: 1_100_000,
      catalog_mode: 'allowlist',
      group_type: 'subscription',
      is_exclusive: true,
      daily_quota_micros: 25_000_000,
      status: 'active',
      control_version: 1,
    })

    const stale = await request(database, `/api/v1/admin/groups/${group.id}`, 'PUT', 'group-stale', {
      expected_control_version: 0,
      description: 'must not win',
    })
    expect(stale.status).toBe(412)
    expect((await json(stale)).code).toBe('control_version_conflict')

    const disabled = await request(database, `/api/v1/admin/groups/${group.id}`, 'DELETE', 'group-disable', {
      expected_control_version: 1,
    })
    expect(disabled.status).toBe(200)
    expect((await json(disabled)).data).toMatchObject({
      name: 'renamed',
      description: 'keep me',
      enabled: false,
      status: 'inactive',
      control_version: 2,
    })
  })

  it('maps a database-time CAS race to the same precondition response as a stale pre-read', async () => {
    const database = new CatalogDatabase()
    const group = await createGroup(database, 'group-race')
    database.beforeBatch = () => {
      database.groups.get(group.id)!.control_version = 1
    }

    const raced = await request(database, `/api/v1/admin/groups/${group.id}`, 'PUT', 'group-race-update', {
      expected_control_version: 0,
      description: 'must not win',
    })

    expect(raced.status).toBe(412)
    expect((await json(raced)).code).toBe('control_version_conflict')
    expect(database.groups.get(group.id)).toMatchObject({ control_version: 1, description: null })
  })

  it('creates a model and rejects an invalid endpoint without persisting it', async () => {
    const database = new CatalogDatabase()
    const created = await request(database, '/api/v1/admin/models', 'POST', 'model-create', {
      public_name: 'gpt-public',
      upstream_name: 'gpt-upstream',
      endpoint: 'responses',
    })
    expect(created.status).toBe(201)
    expect((await json(created)).data).toMatchObject({
      public_name: 'gpt-public',
      upstream_name: 'gpt-upstream',
      endpoint: 'responses',
      status: 'active',
      control_version: 0,
    })

    const invalid = await request(database, '/api/v1/admin/models', 'POST', 'model-invalid', {
      public_name: 'bad-endpoint',
      endpoint: 'completions',
    })
    expect(invalid.status).toBe(400)
    expect((await json(invalid)).code).toBe('invalid_endpoint')
    expect(database.models).toHaveLength(1)
  })

  it('creates and updates an explicit model embeddings capability while defaulting old clients to false', async () => {
    const database = new CatalogDatabase()
    const embeddingModel = await createModel(database, 'model-embeddings', { embeddings: true })
    const defaultModel = await createModel(database, 'model-default-embeddings')

    expect(embeddingModel).toMatchObject({ embeddings: true, platform: 'openai' })
    expect(defaultModel).toMatchObject({ embeddings: false, platform: 'openai' })

    const updated = await request(
      database,
      `/api/v1/admin/models/${embeddingModel.id}`,
      'PUT',
      'model-embeddings-update',
      { expected_control_version: 0, embeddings: false },
    )

    expect(updated.status).toBe(200)
    expect((await json(updated)).data).toMatchObject({
      id: embeddingModel.id,
      embeddings: false,
      control_version: 1,
    })
  })

  it('enforces platform and output-token boundaries when linking a model', async () => {
    const database = new CatalogDatabase()
    const group = await createGroup(database, 'link-boundary-group')
    const otherPlatformModel = await createModel(database, 'link-anthropic-model', {
      platform: 'anthropic',
      enabled: false,
    })

    const mismatch = await request(
      database,
      `/api/v1/admin/groups/${group.id}/models/${otherPlatformModel.id}`,
      'PUT',
      'link-platform-mismatch',
      { expected_control_version: 0 },
    )
    expect(mismatch.status).toBe(409)
    expect((await json(mismatch)).code).toBe('platform_mismatch')

    const model = await createModel(database, 'link-token-model')
    const zeroMax = await request(
      database,
      `/api/v1/admin/groups/${group.id}/models/${model.id}`,
      'PUT',
      'link-zero-max',
      { expected_control_version: 0, max_output_tokens: 0 },
    )
    expect(zeroMax.status).toBe(400)
    expect((await json(zeroMax)).code).toBe('invalid_max_output_tokens')

    const defaultOverMax = await request(
      database,
      `/api/v1/admin/groups/${group.id}/models/${model.id}`,
      'PUT',
      'link-default-over-max',
      { expected_control_version: 0, max_output_tokens: 100, default_max_output_tokens: 101 },
    )
    expect(defaultOverMax.status).toBe(400)
    expect((await json(defaultOverMax)).code).toBe('invalid_default_max_output_tokens')
    expect(database.groupModels).toHaveLength(0)
  })

  it('persists the group-model allowlist and routing fields independently', async () => {
    const database = new CatalogDatabase()
    const group = await createGroup(database, 'allowlist-group', { catalog_mode: 'allowlist' })
    const model = await createModel(database, 'allowlist-model')
    const linked = await request(
      database,
      `/api/v1/admin/groups/${group.id}/models/${model.id}`,
      'PUT',
      'allowlist-link',
      {
        expected_control_version: 0,
        upstream_name_override: 'regional-upstream',
        enabled: true,
        catalog_visible: false,
        sort_order: 7,
        max_output_tokens: 8_192,
        default_max_output_tokens: 2_048,
      },
    )
    expect(linked.status).toBe(201)
    expect((await json(linked)).data).toMatchObject({
      upstream_name_override: 'regional-upstream',
      enabled: true,
      catalog_visible: false,
      sort_order: 7,
      max_output_tokens: 8_192,
      default_max_output_tokens: 2_048,
      control_version: 0,
    })

    const listed = await request(database, `/api/v1/admin/groups/${group.id}/models`, 'GET', 'unused-list-key')
    expect(listed.status).toBe(200)
    expect((await json(listed)).data).toEqual([
      expect.objectContaining({
        model_id: model.id,
        upstream_name_override: 'regional-upstream',
        enabled: true,
        catalog_visible: false,
        max_output_tokens: 8_192,
        default_max_output_tokens: 2_048,
      }),
    ])
  })

  it('appends and replays prices, rejects invalid/CAS writes, and retains inactive history', async () => {
    const database = new CatalogDatabase()
    const group = await createGroup(database, 'price-group')
    const model = await createModel(database, 'price-model')
    await linkModel(database, group.id, model.id, 'price-link')
    const path = `/api/v1/admin/groups/${group.id}/models/${model.id}/prices`

    const negative = await request(database, path, 'POST', 'price-negative', {
      expected_control_version: 0,
      input_micros_per_million: -1,
      output_micros_per_million: 2_000,
    })
    expect(negative.status).toBe(400)
    expect((await json(negative)).code).toBe('invalid_input_micros_per_million')
    expect(database.prices).toHaveLength(0)

    const firstBody = {
      expected_control_version: 0,
      input_micros_per_million: 1_000,
      output_micros_per_million: 2_000,
      cache_read_micros_per_million: 100,
      per_request_micros: 10,
      minimum_reservation_micros: 5,
    }
    const first = await request(database, path, 'POST', 'price-first', firstBody)
    expect(first.status).toBe(201)
    const firstData = (await json(first.clone())).data
    expect(firstData).toMatchObject({
      version: 1,
      active: true,
      input_micros_per_million: 1_000,
      output_micros_per_million: 2_000,
      cache_read_micros_per_million: 100,
      per_request_micros: 10,
      minimum_reservation_micros: 5,
    })

    const replayed = await request(database, path, 'POST', 'price-first', firstBody)
    expect(replayed.status).toBe(200)
    expect(await json(replayed)).toEqual(await json(first))
    expect(database.prices).toHaveLength(1)

    const second = await request(database, path, 'POST', 'price-second', {
      expected_control_version: 1,
      input_micros_per_million: 3_000,
      output_micros_per_million: 4_000,
      minimum_reservation_micros: 7,
    })
    expect(second.status).toBe(201)
    expect((await json(second)).data).toMatchObject({ version: 2, active: true })

    const stale = await request(database, path, 'POST', 'price-stale', {
      expected_control_version: 1,
      input_micros_per_million: 9_000,
      output_micros_per_million: 9_000,
    })
    expect(stale.status).toBe(412)
    expect((await json(stale)).code).toBe('control_version_conflict')

    const history = await request(database, path, 'GET', 'unused-history-key')
    expect(history.status).toBe(200)
    expect((await json(history)).data).toEqual([
      expect.objectContaining({ version: 2, active: true, input_micros_per_million: 3_000 }),
      expect.objectContaining({
        id: firstData.id,
        version: 1,
        active: false,
        input_micros_per_million: 1_000,
        output_micros_per_million: 2_000,
        retired_at_ms: expect.any(Number),
      }),
    ])
  })

  it('rejects an enabled provider that the Worker gateway cannot consume', async () => {
    const response = await request(new CatalogDatabase(), '/api/v1/admin/groups', 'POST', 'catalog-create-2', {
      name: 'unsupported',
      platform: 'grok',
    })

    expect(response.status).toBe(409)
    expect((await json(response)).code).toBe('platform_not_supported')
  })
})

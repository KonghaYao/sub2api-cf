#!/usr/bin/env node

import { createDecipheriv, createHash, hkdfSync } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const SCHEMA = 'sub2api-production-cutover'
const VERSION = 1
const ARTIFACT_SCHEMA = 'sub2api-cloudflare-cutover-artifacts'
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const REQUIRED_DOMAINS = Object.freeze([
  'users', 'keys', 'balances', 'ledgers', 'subscriptions', 'orders', 'accounts', 'r2_objects',
])
const DEPENDENCY_DOMAINS = Object.freeze([
  'groups', 'models', 'group_models', 'subscription_plans', 'payment_provider_instances',
  'account_groups', 'account_models', 'account_secrets',
])
const RECONCILIATION_DOMAINS = Object.freeze([...REQUIRED_DOMAINS, ...DEPENDENCY_DOMAINS])
const STAGES = Object.freeze(['internal', '1', '5', '25', '50', '100'])
const HARD_LIMITS = Object.freeze({
  max_total_bytes: 4 * 1024 * 1024 * 1024,
  max_file_bytes: 1024 * 1024 * 1024,
  max_line_bytes: 1024 * 1024,
  max_rows_per_domain: 10_000_000,
})
const MAX_BUFFERED_JSON_BYTES = 16 * 1024 * 1024

class CutoverError extends Error {}

function fail(message) {
  throw new CutoverError(message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`)
  return value
}

function assertExactKeys(value, keys, label) {
  const expected = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains unknown field: ${key}`)
  }
  for (const key of keys) {
    if (!(key in value)) fail(`${label} is missing field: ${key}`)
  }
}

function assertOptionalExactKeys(value, required, optional, label) {
  const expected = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} contains unknown field: ${key}`)
  }
  for (const key of required) {
    if (!(key in value)) fail(`${label} is missing field: ${key}`)
  }
}

function assertString(value, label, { min = 1, max = 256 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value !== value.trim()) {
    fail(`${label} must be a trimmed string between ${min} and ${max} characters`)
  }
  return value
}

function assertStableId(value, label) {
  const id = assertString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    fail(`${label} must be a stable string id using only A-Z, a-z, 0-9, dot, underscore, colon, or hyphen`)
  }
  return id
}

function assertSafeInteger(value, label, { min = 0, max = MAX_SAFE } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be a safe integer between ${min} and ${max}`)
  }
  return value
}

function assertMicros(value, label, { signed = false, positive = false } = {}) {
  return assertSafeInteger(value, label, {
    min: signed ? -MAX_SAFE : positive ? 1 : 0,
    max: MAX_SAFE,
  })
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

function assertEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${label} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function assertTimestamp(value, label) {
  return assertSafeInteger(value, label, { min: 0, max: 8_640_000_000_000_000 })
}

function assertCanonicalIso(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be a canonical UTC ISO timestamp`)
  }
  return value
}

function assertNullableTimestamp(value, label) {
  return value === null ? null : assertTimestamp(value, label)
}

function assertNullableMicros(value, label) {
  return value === null ? null : assertMicros(value, label)
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function assertSafeRelativePath(value, label) {
  const path = assertString(value, label, { max: 1024 })
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0')) fail(`unsafe ${label}`)
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail(`unsafe ${label}`)
  return path
}

function assertNoDuplicate(rows, key, domain) {
  const seen = new Set()
  for (const row of rows) {
    const value = row[key]
    if (seen.has(value)) fail(`duplicate ${domain} id: ${String(value)}`)
    seen.add(value)
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readBoundedJson(path, maxBytes, label) {
  const metadata = await stat(path)
  if (!metadata.isFile()) fail(`${label} must be a regular file`)
  if (metadata.size > maxBytes) fail(`${label} exceeds byte limit ${maxBytes}`)
  const bytes = await readFile(path)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateManifest(raw) {
  const manifest = assertObject(raw, 'manifest')
  assertExactKeys(manifest, [
    'schema', 'version', 'snapshot_id', 'created_at', 'source_high_watermark', 'target_environment', 'd1_schema_version', 'do_schema_version',
    'r2_source_root', 'dependency_manifest', 'limits', 'domains',
  ], 'manifest')
  if (manifest.schema !== SCHEMA) fail(`manifest schema must be ${SCHEMA}`)
  if (manifest.version !== VERSION) fail(`unsupported manifest version: ${String(manifest.version)}`)
  assertStableId(manifest.snapshot_id, 'manifest.snapshot_id')
  if (typeof manifest.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.created_at) || Number.isNaN(Date.parse(manifest.created_at))) {
    fail('manifest.created_at must be a canonical UTC ISO timestamp')
  }
  assertStableId(manifest.source_high_watermark, 'manifest.source_high_watermark')
  assertStableId(manifest.target_environment, 'manifest.target_environment')
  assertSafeInteger(manifest.d1_schema_version, 'manifest.d1_schema_version', { min: 55 })
  if (manifest.do_schema_version !== 1) fail(`unsupported UserStateDO schema version: ${String(manifest.do_schema_version)}`)
  assertSafeRelativePath(manifest.r2_source_root, 'R2 source root')

  const limits = assertObject(manifest.limits, 'manifest.limits')
  assertExactKeys(limits, ['max_total_bytes', 'max_file_bytes', 'max_line_bytes', 'max_rows_per_domain'], 'manifest.limits')
  for (const [key, ceiling] of Object.entries(HARD_LIMITS)) {
    assertSafeInteger(limits[key], `manifest.limits.${key}`, { min: 1, max: ceiling })
  }
  if (limits.max_line_bytes > limits.max_file_bytes || limits.max_file_bytes > limits.max_total_bytes) {
    fail('manifest limits must satisfy max_line_bytes <= max_file_bytes <= max_total_bytes')
  }
  const dependencyManifest = assertObject(manifest.dependency_manifest, 'manifest.dependency_manifest')
  assertExactKeys(dependencyManifest, ['path', 'bytes', 'sha256'], 'manifest.dependency_manifest')
  assertSafeRelativePath(dependencyManifest.path, 'dependency manifest path')
  assertSafeInteger(dependencyManifest.bytes, 'manifest.dependency_manifest.bytes', { min: 1, max: Math.min(MAX_BUFFERED_JSON_BYTES, limits.max_file_bytes) })
  assertSha256(dependencyManifest.sha256, 'manifest.dependency_manifest.sha256')

  const domains = assertObject(manifest.domains, 'manifest.domains')
  for (const domain of REQUIRED_DOMAINS) {
    if (!(domain in domains)) fail(`missing required domain: ${domain}`)
  }
  for (const domain of Object.keys(domains)) {
    if (!REQUIRED_DOMAINS.includes(domain)) fail(`manifest.domains contains unknown domain: ${domain}`)
    const descriptor = assertObject(domains[domain], `manifest.domains.${domain}`)
    assertExactKeys(descriptor, ['path', 'format', 'bytes', 'rows', 'sha256'], `manifest.domains.${domain}`)
    assertSafeRelativePath(descriptor.path, 'domain path')
    assertEnum(descriptor.format, ['json', 'ndjson'], `manifest.domains.${domain}.format`)
    assertSafeInteger(descriptor.bytes, `manifest.domains.${domain}.bytes`, { min: 0, max: limits.max_file_bytes })
    assertSafeInteger(descriptor.rows, `manifest.domains.${domain}.rows`, { min: 0, max: limits.max_rows_per_domain })
    assertSha256(descriptor.sha256, `manifest.domains.${domain}.sha256`)
  }
  const totalBytes = REQUIRED_DOMAINS.reduce((sum, domain) => sum + domains[domain].bytes, dependencyManifest.bytes)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.max_total_bytes) fail('manifest domains exceed max_total_bytes')
  return manifest
}

async function resolveDomainFile(manifestPath, relativePath) {
  const root = await realpath(dirname(manifestPath))
  const candidate = resolve(root, relativePath)
  const lexical = relative(root, candidate)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) fail('unsafe domain path')
  let current = root
  const parts = relativePath.split('/')
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) fail('domain path must not contain symlinks')
    if (index < parts.length - 1 && !metadata.isDirectory()) fail('domain path ancestor must be a directory')
    if (index === parts.length - 1 && !metadata.isFile()) fail('domain path must resolve to a regular file')
  }
  const actual = await realpath(candidate)
  const traversal = relative(root, actual)
  if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) fail('unsafe domain path')
  return actual
}

async function resolveSafeDirectory(manifestPath, relativePath) {
  const root = await realpath(dirname(manifestPath))
  let current = root
  for (const part of relativePath.split('/')) {
    current = resolve(current, part)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) fail('R2 source root must not contain symlinks')
    if (!metadata.isDirectory()) fail('R2 source root must resolve to a directory')
  }
  const actual = await realpath(current)
  const traversal = relative(root, actual)
  if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) fail('unsafe R2 source root')
  return actual
}

async function resolveSafeR2Source(root, relativePath) {
  let current = root
  const parts = relativePath.split('/')
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) fail(`R2 source path must not contain symlinks: ${relativePath}`)
    if (index < parts.length - 1 && !metadata.isDirectory()) fail(`R2 source path ancestor is not a directory: ${relativePath}`)
    if (index === parts.length - 1 && !metadata.isFile()) fail(`R2 source path is not a regular file: ${relativePath}`)
  }
  const actual = await realpath(current)
  const traversal = relative(root, actual)
  if (traversal === '..' || traversal.startsWith(`..${sep}`) || isAbsolute(traversal)) fail(`unsafe R2 source path: ${relativePath}`)
  return actual
}

async function digestFile(path) {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (!Number.isSafeInteger(bytes)) fail(`file size exceeds safe integer range: ${path}`)
    digest.update(chunk)
  }
  return { bytes, sha256: digest.digest('hex') }
}

async function readNdjson(path, descriptor, limits, domain, onRow) {
  const digest = createHash('sha256')
  let bytesRead = 0
  let rowCount = 0
  let carry = Buffer.alloc(0)
  const stream = createReadStream(path, { highWaterMark: Math.min(limits.max_line_bytes, 64 * 1024) })

  const parseLine = (lineBytes) => {
    if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 13) lineBytes = lineBytes.subarray(0, -1)
    if (lineBytes.length === 0) fail(`${domain} contains an empty NDJSON line`)
    if (lineBytes.length > limits.max_line_bytes) fail(`${domain} line exceeds max_line_bytes`)
    let row
    try {
      row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lineBytes))
    } catch (error) {
      fail(`${domain} contains invalid NDJSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    rowCount += 1
    if (rowCount > limits.max_rows_per_domain) fail(`${domain} exceeds max_rows_per_domain`)
    onRow(row)
  }

  for await (const chunk of stream) {
    bytesRead += chunk.length
    if (bytesRead > limits.max_file_bytes || bytesRead > descriptor.bytes) fail(`${domain} exceeds its declared byte bound`)
    digest.update(chunk)
    let combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
    let start = 0
    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] === 10) {
        parseLine(combined.subarray(start, index))
        start = index + 1
      }
    }
    carry = Buffer.from(combined.subarray(start))
    if (carry.length > limits.max_line_bytes) fail(`${domain} line exceeds max_line_bytes`)
  }
  if (carry.length > 0) parseLine(carry)
  return { rowCount, bytesRead, digest: digest.digest('hex') }
}

async function readDomain(manifestPath, domain, descriptor, limits, onRow) {
  const path = await resolveDomainFile(manifestPath, descriptor.path)
  let result
  if (descriptor.format === 'ndjson') {
    result = await readNdjson(path, descriptor, limits, domain, onRow)
  } else {
    if (descriptor.bytes > MAX_BUFFERED_JSON_BYTES) {
      fail(`${domain} JSON exceeds the ${MAX_BUFFERED_JSON_BYTES}-byte buffered JSON limit; export NDJSON for streaming validation`)
    }
    const metadata = await stat(path)
    if (metadata.size > limits.max_file_bytes || metadata.size > descriptor.bytes) fail(`${domain} exceeds its declared byte bound`)
    const bytes = await readFile(path)
    let rows
    try {
      rows = JSON.parse(bytes.toString('utf8'))
    } catch (error) {
      fail(`${domain} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(rows)) fail(`${domain} JSON must contain one array of rows`)
    if (rows.length > limits.max_rows_per_domain) fail(`${domain} exceeds max_rows_per_domain`)
    for (const row of rows) onRow(row)
    result = { rowCount: rows.length, bytesRead: bytes.length, digest: sha256(bytes) }
  }
  if (result.bytesRead !== descriptor.bytes) fail(`${domain} byte count mismatch: expected ${descriptor.bytes}, got ${result.bytesRead}`)
  if (result.digest !== descriptor.sha256) fail(`${domain} SHA-256 mismatch`)
  if (result.rowCount !== descriptor.rows) fail(`${domain} row count mismatch: expected ${descriptor.rows}, got ${result.rowCount}`)
}

function validateUsers(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `users row ${index + 1}`)
    assertExactKeys(row, ['id', 'email', 'display_name', 'role', 'status', 'created_at_ms', 'updated_at_ms'], `users row ${index + 1}`)
    assertStableId(row.id, `users row ${index + 1}.id`)
    const email = assertString(row.email, `users ${row.id}.email`, { max: 320 })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`users ${row.id}.email is invalid`)
    if (typeof row.display_name !== 'string' || row.display_name.length > 256) fail(`users ${row.id}.display_name is invalid`)
    assertEnum(row.role, ['user', 'admin'], `users ${row.id}.role`)
    assertEnum(row.status, ['active', 'disabled'], `users ${row.id}.status`)
    assertTimestamp(row.created_at_ms, `users ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `users ${row.id}.updated_at_ms`)
    if (row.updated_at_ms < row.created_at_ms) fail(`users ${row.id} updated_at_ms precedes created_at_ms`)
  }
  assertNoDuplicate(rows, 'id', 'users')
}

function validateKeys(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `keys row ${index + 1}`)
    assertExactKeys(row, ['id', 'user_id', 'key_hash', 'name', 'enabled', 'group_id', 'expires_at_ms', 'last_used_at_ms', 'created_at_ms', 'updated_at_ms'], `keys row ${index + 1}`)
    assertStableId(row.id, `keys row ${index + 1}.id`)
    assertStableId(row.user_id, `keys ${row.id}.user_id`)
    assertSha256(row.key_hash, `keys ${row.id}.key_hash`)
    if (typeof row.name !== 'string' || row.name.length > 256) fail(`keys ${row.id}.name is invalid`)
    assertBoolean(row.enabled, `keys ${row.id}.enabled`)
    if (row.group_id !== null) assertStableId(row.group_id, `keys ${row.id}.group_id`)
    assertNullableTimestamp(row.expires_at_ms, `keys ${row.id}.expires_at_ms`)
    assertNullableTimestamp(row.last_used_at_ms, `keys ${row.id}.last_used_at_ms`)
    assertTimestamp(row.created_at_ms, `keys ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `keys ${row.id}.updated_at_ms`)
  }
  assertNoDuplicate(rows, 'id', 'keys')
  const hashes = new Set()
  for (const row of rows) {
    if (hashes.has(row.key_hash)) fail(`duplicate keys key_hash: ${row.key_hash}`)
    hashes.add(row.key_hash)
  }
}

function validateBalances(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `balances row ${index + 1}`)
    assertExactKeys(row, ['user_id', 'balance_micros', 'spend_debt_micros', 'enabled', 'state_version', 'updated_at_ms'], `balances row ${index + 1}`)
    assertStableId(row.user_id, `balances row ${index + 1}.user_id`)
    assertMicros(row.balance_micros, `balances ${row.user_id}.balance_micros`)
    assertMicros(row.spend_debt_micros, `balances ${row.user_id}.spend_debt_micros`)
    assertBoolean(row.enabled, `balances ${row.user_id}.enabled`)
    assertSafeInteger(row.state_version, `balances ${row.user_id}.state_version`, { min: 1 })
    assertTimestamp(row.updated_at_ms, `balances ${row.user_id}.updated_at_ms`)
  }
  assertNoDuplicate(rows, 'user_id', 'balances')
}

function validateLedgers(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `ledgers row ${index + 1}`)
    assertExactKeys(row, [
      'id', 'user_id', 'state_version', 'event_type', 'source_type', 'source_id', 'request_id',
      'amount_delta_micros', 'gross_amount_micros', 'spend_debt_delta_micros',
      'balance_after_micros', 'spend_debt_after_micros', 'occurred_at_ms',
    ], `ledgers row ${index + 1}`)
    assertStableId(row.id, `ledgers row ${index + 1}.id`)
    assertStableId(row.user_id, `ledgers ${row.id}.user_id`)
    assertSafeInteger(row.state_version, `ledgers ${row.id}.state_version`, { min: 1 })
    assertEnum(row.event_type, ['opening_balance', 'balance_adjustment', 'settlement'], `ledgers ${row.id}.event_type`)
    assertEnum(row.source_type, ['opening_balance', 'admin_adjustment', 'redeem_code', 'affiliate_transfer', 'affiliate_refund_clawback', 'auth_source_entitlement', 'usage_settlement', 'other_adjustment'], `ledgers ${row.id}.source_type`)
    assertStableId(row.source_id, `ledgers ${row.id}.source_id`)
    if (row.request_id !== null) assertStableId(row.request_id, `ledgers ${row.id}.request_id`)
    if (row.event_type === 'settlement' && row.request_id === null) fail(`ledgers ${row.id} settlement requires request_id`)
    if (row.event_type !== 'settlement' && row.request_id !== null) fail(`ledgers ${row.id} non-settlement must not have request_id`)
    assertMicros(row.amount_delta_micros, `ledgers ${row.id}.amount_delta_micros`, { signed: true })
    assertMicros(row.gross_amount_micros, `ledgers ${row.id}.gross_amount_micros`, { signed: true })
    assertMicros(row.spend_debt_delta_micros, `ledgers ${row.id}.spend_debt_delta_micros`, { signed: true })
    assertMicros(row.balance_after_micros, `ledgers ${row.id}.balance_after_micros`)
    assertMicros(row.spend_debt_after_micros, `ledgers ${row.id}.spend_debt_after_micros`)
    if (row.event_type === 'settlement' && (row.amount_delta_micros > 0 || row.gross_amount_micros < 0)) {
      fail(`ledgers ${row.id} settlement has invalid monetary direction`)
    }
    assertTimestamp(row.occurred_at_ms, `ledgers ${row.id}.occurred_at_ms`)
  }
  assertNoDuplicate(rows, 'id', 'ledgers')
  const versions = new Set()
  for (const row of rows) {
    const key = `${row.user_id}\0${row.state_version}`
    if (versions.has(key)) fail(`duplicate ledgers state_version ${row.state_version} for user ${row.user_id}`)
    versions.add(key)
  }
}

function validateSubscriptions(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `subscriptions row ${index + 1}`)
    assertExactKeys(row, [
      'id', 'user_id', 'group_id', 'plan_id', 'status', 'starts_at_ms', 'expires_at_ms',
      'daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros',
      'daily_used_micros', 'weekly_used_micros', 'monthly_used_micros',
      'source_type', 'source_id', 'created_at_ms', 'updated_at_ms',
    ], `subscriptions row ${index + 1}`)
    assertStableId(row.id, `subscriptions row ${index + 1}.id`)
    assertStableId(row.user_id, `subscriptions ${row.id}.user_id`)
    assertStableId(row.group_id, `subscriptions ${row.id}.group_id`)
    if (row.plan_id !== null) assertStableId(row.plan_id, `subscriptions ${row.id}.plan_id`)
    assertEnum(row.status, ['active', 'suspended', 'revoked', 'expired'], `subscriptions ${row.id}.status`)
    assertTimestamp(row.starts_at_ms, `subscriptions ${row.id}.starts_at_ms`)
    assertTimestamp(row.expires_at_ms, `subscriptions ${row.id}.expires_at_ms`)
    if (row.expires_at_ms <= row.starts_at_ms) fail(`subscriptions ${row.id} expires_at_ms must follow starts_at_ms`)
    for (const key of ['daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros']) assertNullableMicros(row[key], `subscriptions ${row.id}.${key}`)
    for (const key of ['daily_used_micros', 'weekly_used_micros', 'monthly_used_micros']) assertMicros(row[key], `subscriptions ${row.id}.${key}`)
    assertEnum(row.source_type, ['admin', 'registration', 'redeem', 'payment'], `subscriptions ${row.id}.source_type`)
    assertStableId(row.source_id, `subscriptions ${row.id}.source_id`)
    assertTimestamp(row.created_at_ms, `subscriptions ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `subscriptions ${row.id}.updated_at_ms`)
  }
  assertNoDuplicate(rows, 'id', 'subscriptions')
}

function validateOrders(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `orders row ${index + 1}`)
    assertOptionalExactKeys(row, [
      'id', 'user_id', 'provider_instance_id', 'out_trade_no', 'order_type', 'status',
      'amount_micros', 'pay_amount_micros', 'paid_amount_micros', 'refunded_amount_micros',
      'currency', 'expires_at_ms', 'paid_at_ms', 'completed_at_ms', 'created_at_ms', 'updated_at_ms',
    ], [
      'plan_id', 'plan_name_snapshot', 'plan_group_id_snapshot', 'plan_validity_days_snapshot',
      'plan_price_micros_snapshot', 'plan_currency_snapshot', 'plan_daily_quota_micros_snapshot',
      'plan_weekly_quota_micros_snapshot', 'plan_monthly_quota_micros_snapshot',
      'subscription_id', 'subscription_fulfilled_at_ms',
    ], `orders row ${index + 1}`)
    assertStableId(row.id, `orders row ${index + 1}.id`)
    assertStableId(row.user_id, `orders ${row.id}.user_id`)
    assertStableId(row.provider_instance_id, `orders ${row.id}.provider_instance_id`)
    assertStableId(row.out_trade_no, `orders ${row.id}.out_trade_no`)
    assertEnum(row.order_type, ['balance', 'subscription'], `orders ${row.id}.order_type`)
    assertEnum(row.status, ['PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'], `orders ${row.id}.status`)
    assertMicros(row.amount_micros, `orders ${row.id}.amount_micros`, { positive: true })
    assertMicros(row.pay_amount_micros, `orders ${row.id}.pay_amount_micros`)
    assertMicros(row.paid_amount_micros, `orders ${row.id}.paid_amount_micros`)
    assertMicros(row.refunded_amount_micros, `orders ${row.id}.refunded_amount_micros`)
    if (row.pay_amount_micros < row.amount_micros) fail(`orders ${row.id}.pay_amount_micros is below amount_micros`)
    if (row.refunded_amount_micros > row.paid_amount_micros) fail(`orders ${row.id}.refunded_amount_micros exceeds paid_amount_micros`)
    if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) fail(`orders ${row.id}.currency is invalid`)
    assertTimestamp(row.expires_at_ms, `orders ${row.id}.expires_at_ms`)
    assertNullableTimestamp(row.paid_at_ms, `orders ${row.id}.paid_at_ms`)
    assertNullableTimestamp(row.completed_at_ms, `orders ${row.id}.completed_at_ms`)
    assertTimestamp(row.created_at_ms, `orders ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `orders ${row.id}.updated_at_ms`)
    if (row.expires_at_ms <= row.created_at_ms) fail(`orders ${row.id}.expires_at_ms must follow created_at_ms`)
    const planKeys = ['plan_id', 'plan_name_snapshot', 'plan_group_id_snapshot', 'plan_validity_days_snapshot', 'plan_price_micros_snapshot', 'plan_currency_snapshot']
    if (row.order_type === 'subscription') {
      for (const key of planKeys) if (!(key in row) || row[key] === null) fail(`orders ${row.id} subscription requires ${key}`)
      assertStableId(row.plan_id, `orders ${row.id}.plan_id`)
      assertString(row.plan_name_snapshot, `orders ${row.id}.plan_name_snapshot`, { max: 256 })
      assertStableId(row.plan_group_id_snapshot, `orders ${row.id}.plan_group_id_snapshot`)
      assertSafeInteger(row.plan_validity_days_snapshot, `orders ${row.id}.plan_validity_days_snapshot`, { min: 1, max: 36500 })
      assertMicros(row.plan_price_micros_snapshot, `orders ${row.id}.plan_price_micros_snapshot`)
      if (!/^[A-Z]{3}$/.test(row.plan_currency_snapshot)) fail(`orders ${row.id}.plan_currency_snapshot is invalid`)
    } else {
      for (const key of planKeys) if (key in row && row[key] !== null) fail(`orders ${row.id} balance order must not include ${key}`)
    }
    for (const key of ['plan_daily_quota_micros_snapshot', 'plan_weekly_quota_micros_snapshot', 'plan_monthly_quota_micros_snapshot']) {
      if (key in row) assertNullableMicros(row[key], `orders ${row.id}.${key}`)
    }
    if ('subscription_id' in row && row.subscription_id !== null) assertStableId(row.subscription_id, `orders ${row.id}.subscription_id`)
    if ('subscription_fulfilled_at_ms' in row) assertNullableTimestamp(row.subscription_fulfilled_at_ms, `orders ${row.id}.subscription_fulfilled_at_ms`)
    if ((row.subscription_fulfilled_at_ms ?? null) !== null && (row.subscription_id ?? null) === null) fail(`orders ${row.id} fulfilled subscription requires subscription_id`)
  }
  assertNoDuplicate(rows, 'id', 'orders')
}

function validateAccounts(rows) {
  const providers = {
    openai: ['openai', 'bearer'], anthropic: ['anthropic', 'x-api-key'], gemini: ['gemini', 'x-goog-api-key'], codex: ['codex', 'bearer'],
  }
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `accounts row ${index + 1}`)
    assertExactKeys(row, ['id', 'platform', 'name', 'credential_ref', 'enabled', 'max_concurrency', 'base_url', 'config_version', 'provider_config', 'created_at_ms', 'updated_at_ms'], `accounts row ${index + 1}`)
    assertStableId(row.id, `accounts row ${index + 1}.id`)
    assertEnum(row.platform, Object.keys(providers), `accounts ${row.id}.platform`)
    assertString(row.name, `accounts ${row.id}.name`)
    assertStableId(row.credential_ref, `accounts ${row.id}.credential_ref`)
    assertBoolean(row.enabled, `accounts ${row.id}.enabled`)
    assertSafeInteger(row.max_concurrency, `accounts ${row.id}.max_concurrency`, { min: 1 })
    const baseUrl = assertString(row.base_url, `accounts ${row.id}.base_url`, { max: 2048 })
    let parsedBaseUrl
    try { parsedBaseUrl = new URL(baseUrl) } catch { fail(`accounts ${row.id}.base_url must be a valid runtime upstream URL`) }
    if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.username !== '' || parsedBaseUrl.password !== '' || parsedBaseUrl.hash !== '' || parsedBaseUrl.search !== '' || parsedBaseUrl.port !== '') fail(`accounts ${row.id}.base_url must be HTTPS on port 443 without credentials, query, or fragment`)
    const hostname = parsedBaseUrl.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname.includes(':')) fail(`accounts ${row.id}.base_url must not target a private or local host`)
    assertSafeInteger(row.config_version, `accounts ${row.id}.config_version`, { min: 1 })
    assertObject(row.provider_config, `accounts ${row.id}.provider_config`)
    const allowedConfig = row.platform === 'codex' ? ['account_id'] : []
    assertOptionalExactKeys(row.provider_config, [], allowedConfig, `accounts ${row.id}.provider_config`)
    if ('account_id' in row.provider_config) assertStableId(row.provider_config.account_id, `accounts ${row.id}.provider_config.account_id`)
    assertTimestamp(row.created_at_ms, `accounts ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `accounts ${row.id}.updated_at_ms`)
    row.protocol = providers[row.platform][0]
    row.auth_scheme = providers[row.platform][1]
  }
  assertNoDuplicate(rows, 'id', 'accounts')
}

function validateR2Objects(rows) {
  for (const [index, raw] of rows.entries()) {
    const row = assertObject(raw, `r2_objects row ${index + 1}`)
    assertExactKeys(row, ['key', 'size', 'sha256', 'source_path'], `r2_objects row ${index + 1}`)
    assertSafeRelativePath(row.key, 'R2 object key')
    assertSafeInteger(row.size, `r2_objects ${row.key}.size`, { min: 0 })
    assertSha256(row.sha256, `r2_objects ${row.key}.sha256`)
    assertSafeRelativePath(row.source_path, 'R2 source path')
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.key)) fail(`duplicate r2_objects id: ${row.key}`)
    seen.add(row.key)
  }
}

function validateDependencyManifest(raw) {
  const dependencies = assertObject(raw, 'dependency manifest')
  assertExactKeys(dependencies, ['schema', 'version', ...DEPENDENCY_DOMAINS], 'dependency manifest')
  if (dependencies.schema !== 'sub2api-cutover-d1-dependencies' || dependencies.version !== 1) fail('unsupported dependency manifest schema/version')
  for (const key of DEPENDENCY_DOMAINS) {
    if (!Array.isArray(dependencies[key])) fail(`dependency manifest.${key} must be an array`)
  }
  for (const [index, row] of dependencies.groups.entries()) {
    assertObject(row, `dependency groups row ${index + 1}`)
    assertExactKeys(row, ['id', 'name', 'platform', 'group_type', 'enabled', 'created_at_ms', 'updated_at_ms'], `dependency groups row ${index + 1}`)
    assertStableId(row.id, `dependency groups row ${index + 1}.id`)
    assertString(row.name, `dependency groups ${row.id}.name`)
    assertEnum(row.platform, ['openai', 'anthropic', 'gemini', 'codex', 'composite'], `dependency groups ${row.id}.platform`)
    assertEnum(row.group_type, ['standard', 'subscription'], `dependency groups ${row.id}.group_type`)
    assertBoolean(row.enabled, `dependency groups ${row.id}.enabled`)
    assertTimestamp(row.created_at_ms, `dependency groups ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency groups ${row.id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.models.entries()) {
    assertObject(row, `dependency models row ${index + 1}`)
    assertExactKeys(row, ['id', 'platform', 'public_name', 'upstream_name', 'endpoint', 'enabled', 'embeddings', 'image_generation', 'created_at_ms', 'updated_at_ms'], `dependency models row ${index + 1}`)
    assertStableId(row.id, `dependency models row ${index + 1}.id`)
    assertEnum(row.platform, ['openai', 'anthropic', 'gemini', 'codex'], `dependency models ${row.id}.platform`)
    assertString(row.public_name, `dependency models ${row.id}.public_name`)
    assertString(row.upstream_name, `dependency models ${row.id}.upstream_name`)
    assertEnum(row.endpoint, ['chat_completions', 'responses', 'both'], `dependency models ${row.id}.endpoint`)
    for (const key of ['enabled', 'embeddings', 'image_generation']) assertBoolean(row[key], `dependency models ${row.id}.${key}`)
    assertTimestamp(row.created_at_ms, `dependency models ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency models ${row.id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.group_models.entries()) {
    assertObject(row, `dependency group_models row ${index + 1}`)
    assertExactKeys(row, ['group_id', 'model_id', 'upstream_name_override', 'enabled', 'sort_order', 'max_output_tokens', 'default_max_output_tokens', 'catalog_visible', 'created_at_ms', 'updated_at_ms'], `dependency group_models row ${index + 1}`)
    assertStableId(row.group_id, `dependency group_models row ${index + 1}.group_id`)
    assertStableId(row.model_id, `dependency group_models row ${index + 1}.model_id`)
    if (row.upstream_name_override !== null) assertString(row.upstream_name_override, `dependency group_models ${row.group_id}/${row.model_id}.upstream_name_override`)
    assertBoolean(row.enabled, `dependency group_models ${row.group_id}/${row.model_id}.enabled`)
    assertSafeInteger(row.sort_order, `dependency group_models ${row.group_id}/${row.model_id}.sort_order`)
    assertSafeInteger(row.max_output_tokens, `dependency group_models ${row.group_id}/${row.model_id}.max_output_tokens`, { min: 1 })
    assertSafeInteger(row.default_max_output_tokens, `dependency group_models ${row.group_id}/${row.model_id}.default_max_output_tokens`, { min: 1, max: row.max_output_tokens })
    assertBoolean(row.catalog_visible, `dependency group_models ${row.group_id}/${row.model_id}.catalog_visible`)
    assertTimestamp(row.created_at_ms, `dependency group_models ${row.group_id}/${row.model_id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency group_models ${row.group_id}/${row.model_id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.subscription_plans.entries()) {
    assertObject(row, `dependency subscription_plans row ${index + 1}`)
    assertExactKeys(row, ['id', 'group_id', 'name', 'description', 'validity_days', 'price_micros', 'currency', 'daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros', 'enabled', 'sort_order', 'created_at_ms', 'updated_at_ms'], `dependency subscription_plans row ${index + 1}`)
    assertStableId(row.id, `dependency subscription_plans row ${index + 1}.id`)
    assertStableId(row.group_id, `dependency subscription_plans ${row.id}.group_id`)
    assertString(row.name, `dependency subscription_plans ${row.id}.name`)
    if (typeof row.description !== 'string') fail(`dependency subscription_plans ${row.id}.description must be a string`)
    assertSafeInteger(row.validity_days, `dependency subscription_plans ${row.id}.validity_days`, { min: 1, max: 36500 })
    assertMicros(row.price_micros, `dependency subscription_plans ${row.id}.price_micros`)
    if (!/^[A-Z]{3}$/.test(row.currency)) fail(`dependency subscription_plans ${row.id}.currency is invalid`)
    for (const key of ['daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros']) assertNullableMicros(row[key], `dependency subscription_plans ${row.id}.${key}`)
    assertBoolean(row.enabled, `dependency subscription_plans ${row.id}.enabled`)
    assertSafeInteger(row.sort_order, `dependency subscription_plans ${row.id}.sort_order`)
    assertTimestamp(row.created_at_ms, `dependency subscription_plans ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency subscription_plans ${row.id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.payment_provider_instances.entries()) {
    assertObject(row, `dependency payment_provider_instances row ${index + 1}`)
    assertExactKeys(row, ['id', 'provider_key', 'provider_type', 'display_name', 'config_ciphertext', 'config_nonce', 'config_key_id', 'enabled', 'version', 'created_at_ms', 'updated_at_ms'], `dependency payment_provider_instances row ${index + 1}`)
    assertStableId(row.id, `dependency payment_provider_instances row ${index + 1}.id`)
    assertStableId(row.provider_key, `dependency payment_provider_instances ${row.id}.provider_key`)
    assertEnum(row.provider_type, ['alipay', 'wxpay', 'alipay_direct', 'wxpay_direct', 'stripe', 'easypay', 'airwallex'], `dependency payment_provider_instances ${row.id}.provider_type`)
    assertString(row.display_name, `dependency payment_provider_instances ${row.id}.display_name`, { max: 200 })
    assertString(row.config_ciphertext, `dependency payment_provider_instances ${row.id}.config_ciphertext`, { max: 65536 })
    assertString(row.config_nonce, `dependency payment_provider_instances ${row.id}.config_nonce`, { max: 4096 })
    for (const key of ['config_ciphertext', 'config_nonce']) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row[key])) fail(`dependency payment_provider_instances ${row.id}.${key} is not canonical base64`)
    }
    assertString(row.config_key_id, `dependency payment_provider_instances ${row.id}.config_key_id`, { max: 256 })
    assertBoolean(row.enabled, `dependency payment_provider_instances ${row.id}.enabled`)
    if (row.provider_type !== 'stripe') fail(`payment provider ${row.id} uses unsupported runtime type ${row.provider_type}; do not import it`)
    assertSafeInteger(row.version, `dependency payment_provider_instances ${row.id}.version`)
    assertTimestamp(row.created_at_ms, `dependency payment_provider_instances ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency payment_provider_instances ${row.id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.account_groups.entries()) {
    assertObject(row, `dependency account_groups row ${index + 1}`)
    assertExactKeys(row, ['account_id', 'group_id', 'priority', 'weight', 'created_at_ms', 'updated_at_ms'], `dependency account_groups row ${index + 1}`)
    assertStableId(row.account_id, `dependency account_groups row ${index + 1}.account_id`)
    assertStableId(row.group_id, `dependency account_groups row ${index + 1}.group_id`)
    assertSafeInteger(row.priority, `dependency account_groups ${row.account_id}/${row.group_id}.priority`)
    assertSafeInteger(row.weight, `dependency account_groups ${row.account_id}/${row.group_id}.weight`, { min: 1 })
    assertTimestamp(row.created_at_ms, `dependency account_groups ${row.account_id}/${row.group_id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency account_groups ${row.account_id}/${row.group_id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.account_models.entries()) {
    assertObject(row, `dependency account_models row ${index + 1}`)
    assertExactKeys(row, ['account_id', 'model_id', 'chat_completions', 'responses', 'embeddings', 'image_generation', 'created_at_ms', 'updated_at_ms'], `dependency account_models row ${index + 1}`)
    assertStableId(row.account_id, `dependency account_models row ${index + 1}.account_id`)
    assertStableId(row.model_id, `dependency account_models row ${index + 1}.model_id`)
    for (const key of ['chat_completions', 'responses', 'embeddings', 'image_generation']) assertBoolean(row[key], `dependency account_models ${row.account_id}/${row.model_id}.${key}`)
    if (![row.chat_completions, row.responses, row.embeddings, row.image_generation].some(Boolean)) fail(`dependency account_models ${row.account_id}/${row.model_id} exposes no capability`)
    assertTimestamp(row.created_at_ms, `dependency account_models ${row.account_id}/${row.model_id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency account_models ${row.account_id}/${row.model_id}.updated_at_ms`)
  }
  for (const [index, row] of dependencies.account_secrets.entries()) {
    assertObject(row, `dependency account_secrets row ${index + 1}`)
    assertExactKeys(row, ['id', 'account_id', 'purpose', 'algorithm', 'key_version', 'nonce_b64', 'ciphertext_b64', 'created_at_ms', 'updated_at_ms'], `dependency account_secrets row ${index + 1}`)
    assertStableId(row.id, `dependency account_secrets row ${index + 1}.id`)
    assertStableId(row.account_id, `dependency account_secrets ${row.id}.account_id`)
    if (row.purpose !== 'upstream_auth' || row.algorithm !== 'AES-256-GCM') fail(`dependency account_secrets ${row.id} has unsupported encryption metadata`)
    assertSafeInteger(row.key_version, `dependency account_secrets ${row.id}.key_version`, { min: 1 })
    for (const key of ['nonce_b64', 'ciphertext_b64']) {
      const value = assertString(row[key], `dependency account_secrets ${row.id}.${key}`, { max: 65536 })
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(`dependency account_secrets ${row.id}.${key} is not canonical base64`)
    }
    assertTimestamp(row.created_at_ms, `dependency account_secrets ${row.id}.created_at_ms`)
    assertTimestamp(row.updated_at_ms, `dependency account_secrets ${row.id}.updated_at_ms`)
  }
  return dependencies
}

const DOMAIN_VALIDATORS = Object.freeze({
  users: validateUsers,
  keys: validateKeys,
  balances: validateBalances,
  ledgers: validateLedgers,
  subscriptions: validateSubscriptions,
  orders: validateOrders,
  accounts: validateAccounts,
  r2_objects: validateR2Objects,
})

export async function loadAndValidateCutover(manifestPath) {
  const absoluteManifest = resolve(manifestPath)
  const raw = await readBoundedJson(absoluteManifest, 1024 * 1024, 'manifest')
  const sourceManifestSha256 = sha256(await readFile(absoluteManifest))
  const manifest = validateManifest(raw)
  const dependencyPath = await resolveDomainFile(absoluteManifest, manifest.dependency_manifest.path)
  const dependencyIntegrity = await digestFile(dependencyPath)
  if (dependencyIntegrity.bytes !== manifest.dependency_manifest.bytes) fail(`dependency manifest byte count mismatch: expected ${manifest.dependency_manifest.bytes}, got ${dependencyIntegrity.bytes}`)
  if (dependencyIntegrity.sha256 !== manifest.dependency_manifest.sha256) fail('dependency manifest SHA-256 mismatch')
  const dependencies = validateDependencyManifest(await readBoundedJson(dependencyPath, MAX_BUFFERED_JSON_BYTES, 'dependency manifest'))
  const r2SourceRoot = await resolveSafeDirectory(absoluteManifest, manifest.r2_source_root)
  const scratchDirectory = await mkdtemp(join(tmpdir(), 'sub2api-cutover-'))
  const database = new DatabaseSync(join(scratchDirectory, 'validation.sqlite'))
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE records (
      domain TEXT NOT NULL,
      stable_id TEXT NOT NULL,
      sample_rank TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (domain, stable_id)
    ) STRICT;
    CREATE INDEX records_sample ON records(domain, sample_rank, stable_id);
    CREATE TABLE user_refs (
      domain TEXT NOT NULL,
      stable_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (domain, stable_id)
    ) STRICT;
    CREATE TABLE key_hashes (key_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL) STRICT;
    CREATE TABLE unique_values (
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      stable_id TEXT NOT NULL,
      PRIMARY KEY (kind, value)
    ) STRICT;
    CREATE TABLE ledger_versions (
      user_id TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      ledger_id TEXT NOT NULL,
      PRIMARY KEY (user_id, state_version)
    ) STRICT;
  `)
  const insertRecord = database.prepare('INSERT INTO records(domain, stable_id, sample_rank, json) VALUES (?, ?, ?, ?)')
  const insertReference = database.prepare('INSERT INTO user_refs(domain, stable_id, user_id) VALUES (?, ?, ?)')
  const insertHash = database.prepare('INSERT INTO key_hashes(key_hash, key_id) VALUES (?, ?)')
  const insertUnique = database.prepare('INSERT INTO unique_values(kind, value, stable_id) VALUES (?, ?, ?)')
  const insertLedgerVersion = database.prepare('INSERT INTO ledger_versions(user_id, state_version, ledger_id) VALUES (?, ?, ?)')

  try {
    database.exec('BEGIN IMMEDIATE')
    let observedBytes = manifest.dependency_manifest.bytes
    let r2ObjectBytes = 0
    for (const domain of DEPENDENCY_DOMAINS) {
      if (dependencies[domain].length > manifest.limits.max_rows_per_domain) fail(`dependency ${domain} exceeds max_rows_per_domain`)
      for (const row of dependencies[domain]) {
        const stableId = dependencyIdentity(domain, row)
        try {
          insertRecord.run(domain, stableId, sha256(`${domain}\0${stableId}`), canonicalJson(row))
        } catch {
          fail(`duplicate dependency ${domain} id: ${stableId}`)
        }
        const unique = domain === 'groups' ? ['dependency groups name', row.name] :
          domain === 'subscription_plans' ? ['dependency subscription plan group/name', `${row.group_id}\0${row.name}`] :
          domain === 'payment_provider_instances' ? ['dependency payment provider key', row.provider_key] :
          domain === 'models' ? ['dependency models platform/public-name', `${row.platform}\0${row.public_name}`] :
          domain === 'account_secrets' ? ['dependency account secret account/purpose', `${row.account_id}\0${row.purpose}`] : null
        if (unique !== null) {
          try { insertUnique.run(unique[0], unique[1], stableId) } catch { fail(`duplicate ${unique[0]}: ${unique[1].replaceAll('\0', '/')}`) }
        }
      }
    }
    for (const domain of REQUIRED_DOMAINS) {
      await readDomain(absoluteManifest, domain, manifest.domains[domain], manifest.limits, (row) => {
        DOMAIN_VALIDATORS[domain]([row])
        if (domain === 'r2_objects') {
          r2ObjectBytes += row.size
          if (!Number.isSafeInteger(r2ObjectBytes)) fail('r2_objects total size exceeds the safe integer range')
        }
        const stableId = identityFor(domain, row)
        try {
          insertRecord.run(domain, stableId, sha256(`${domain}\0${stableId}`), canonicalJson(row))
        } catch {
          fail(`duplicate ${domain} id: ${stableId}`)
        }
        if (['keys', 'balances', 'ledgers', 'subscriptions', 'orders'].includes(domain)) {
          insertReference.run(domain, stableId, row.user_id)
        }
        if (domain === 'keys') {
          try { insertHash.run(row.key_hash, row.id) } catch { fail(`duplicate keys key_hash: ${row.key_hash}`) }
        }
        const unique = domain === 'users' ? ['users email', row.email.toLowerCase()] :
          domain === 'accounts' ? ['accounts platform/name', `${row.platform}\0${row.name}`] :
          domain === 'orders' ? ['orders out_trade_no', row.out_trade_no] :
          domain === 'subscriptions' ? ['subscriptions user/group', `${row.user_id}\0${row.group_id}`] : null
        if (unique !== null) {
          try { insertUnique.run(unique[0], unique[1], stableId) } catch { fail(`duplicate ${unique[0]}: ${unique[1].replaceAll('\0', '/')}`) }
        }
        if (domain === 'ledgers') {
          try { insertLedgerVersion.run(row.user_id, row.state_version, row.id) } catch { fail(`duplicate ledgers state_version ${row.state_version} for user ${row.user_id}`) }
        }
      })
      observedBytes += manifest.domains[domain].bytes
      if (observedBytes > manifest.limits.max_total_bytes) fail('input exceeds max_total_bytes')
    }
    database.exec('COMMIT')
    validateScratchCrossDomain(database, manifest, process.env.CUTOVER_CREDENTIALS_MASTER_KEY)
    await verifyR2Sources(database, r2SourceRoot)
  } catch (error) {
    try { database.exec('ROLLBACK') } catch {}
    database.close()
    await rm(scratchDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    manifest,
    sourceManifestSha256,
    database,
    cleanup: async () => {
      database.close()
      await rm(scratchDirectory, { recursive: true, force: true })
    },
  }
}

function rowFromStored(record) {
  return JSON.parse(record.json)
}

function *rowsFor(database, domain, order = 'stable_id') {
  const clause = order === 'ledger' ?
    "json_extract(json, '$.user_id'), CAST(json_extract(json, '$.state_version') AS INTEGER), stable_id" :
    order === 'r2' ? "json_extract(json, '$.key')" : 'stable_id'
  const statement = database.prepare(`SELECT json FROM records WHERE domain = ? ORDER BY ${clause}`)
  for (const stored of statement.iterate(domain)) yield rowFromStored(stored)
}

async function verifyR2Sources(database, root) {
  for (const row of rowsFor(database, 'r2_objects', 'r2')) {
    const path = await resolveSafeR2Source(root, row.source_path)
    const actual = await digestFile(path)
    if (actual.bytes !== row.size) fail(`R2 object ${row.key} byte count mismatch: expected ${row.size}, got ${actual.bytes}`)
    if (actual.sha256 !== row.sha256) fail(`R2 object ${row.key} SHA-256 mismatch`)
  }
}

function decryptJsonEnvelope(nonceB64, ciphertextB64, masterKey, aad) {
  const nonce = Buffer.from(nonceB64, 'base64')
  const sealed = Buffer.from(ciphertextB64, 'base64')
    if (nonce.length !== 12 || sealed.length <= 16) throw new Error('invalid AES-GCM envelope')
    const ciphertext = sealed.subarray(0, -16)
    const authTag = sealed.subarray(-16)
    const key = hkdfSync('sha256', Buffer.from(masterKey), Buffer.from('sub2api-credential-salt-v1'), Buffer.from('account-upstream-auth/aes-256-gcm'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
}

function decryptCredentialForTarget(secret, account, manifest, masterKey) {
  if (typeof masterKey !== 'string' || masterKey.length < 32) fail(`account ${account.id} cannot be restored without CUTOVER_CREDENTIALS_MASTER_KEY`)
  try {
    const credential = decryptJsonEnvelope(secret.nonce_b64, secret.ciphertext_b64, masterKey, `${manifest.target_environment}/${account.id}/${secret.id}/${secret.key_version}`)
    if (!isObject(credential) || typeof credential.api_key !== 'string' || credential.api_key.length === 0) throw new Error('invalid credential payload')
  } catch {
    fail(`account ${account.id} credential ${secret.id} cannot be decrypted with target credentials master key and runtime AAD`)
  }
}

function validatePaymentProviderCredential(provider, manifest, masterKey) {
  if (typeof masterKey !== 'string' || masterKey.length < 32) fail(`enabled payment provider ${provider.id} cannot be activated without CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY`)
  try {
    const value = decryptJsonEnvelope(provider.config_nonce, provider.config_ciphertext, masterKey, `sub2api/payment-provider/v1/${manifest.target_environment}/${provider.id}/${provider.config_key_id}/${provider.version}`)
    if (!isObject(value) || typeof value.api_key !== 'string' || value.api_key.length === 0) throw new Error('invalid payment credential payload')
  } catch {
    fail(`enabled payment provider ${provider.id} cannot be decrypted with target payment credentials master key and runtime AAD`)
  }
}

function dependencyIdentity(domain, row) {
  if (domain === 'group_models') return `${row.group_id}:${row.model_id}`
  if (domain === 'account_groups') return `${row.account_id}:${row.group_id}`
  if (domain === 'account_models') return `${row.account_id}:${row.model_id}`
  return row.id
}

function validateScratchCrossDomain(database, manifest, credentialMasterKey) {
  const getRecord = database.prepare('SELECT json FROM records WHERE domain = ? AND stable_id = ?')
  const dangling = database.prepare(`
    SELECT ref.domain, ref.stable_id, ref.user_id
      FROM user_refs ref
      LEFT JOIN records user ON user.domain = 'users' AND user.stable_id = ref.user_id
     WHERE user.stable_id IS NULL
     ORDER BY CASE ref.domain WHEN 'keys' THEN 0 WHEN 'balances' THEN 1 WHEN 'ledgers' THEN 2 WHEN 'subscriptions' THEN 3 ELSE 4 END,
              ref.stable_id
     LIMIT 1
  `).get()
  if (dangling) fail(`${dangling.domain} ${dangling.stable_id} references missing user ${dangling.user_id}`)
  const missingBalance = database.prepare(`
    SELECT user.stable_id AS user_id
      FROM records user
      LEFT JOIN records balance ON balance.domain = 'balances' AND balance.stable_id = user.stable_id
     WHERE user.domain = 'users' AND balance.stable_id IS NULL
     ORDER BY user.stable_id LIMIT 1
  `).get()
  if (missingBalance) fail(`balances is missing user ${missingBalance.user_id}`)

  let currentUser = null
  let previousBalance = 0
  let previousDebt = 0
  let previousVersion = 0
  let seen = 0
  const finishUser = () => {
    if (currentUser === null) return
    const stored = database.prepare("SELECT json FROM records WHERE domain = 'balances' AND stable_id = ?").get(currentUser)
    const balance = rowFromStored(stored)
    if (previousBalance !== balance.balance_micros || previousDebt !== balance.spend_debt_micros) fail(`final ledger values disagree with balance for user ${currentUser}`)
    if (previousVersion > balance.state_version) fail(`ledger state_version exceeds balance state_version for user ${currentUser}`)
  }
  for (const entry of rowsFor(database, 'ledgers', 'ledger')) {
    if (entry.user_id !== currentUser) {
      finishUser()
      currentUser = entry.user_id
      previousBalance = 0
      previousDebt = 0
      previousVersion = 0
      seen = 0
    }
    if (seen === 0 && entry.event_type !== 'opening_balance') fail(`ledgers for user ${currentUser} must begin with opening_balance`)
    if (entry.state_version <= previousVersion) fail(`ledgers state_version is not increasing for user ${currentUser}`)
    if (entry.balance_after_micros !== previousBalance + entry.amount_delta_micros) fail(`ledgers ${entry.id} has inconsistent balance_after_micros`)
    if (entry.spend_debt_after_micros !== previousDebt + entry.spend_debt_delta_micros) fail(`ledgers ${entry.id} has inconsistent spend_debt_after_micros`)
    previousBalance = entry.balance_after_micros
    previousDebt = entry.spend_debt_after_micros
    previousVersion = entry.state_version
    seen += 1
  }
  finishUser()
  const userWithoutLedger = database.prepare(`
    SELECT user.stable_id AS user_id FROM records user
     LEFT JOIN user_refs ledger ON ledger.domain = 'ledgers' AND ledger.user_id = user.stable_id
     WHERE user.domain = 'users' AND ledger.stable_id IS NULL
     ORDER BY user.stable_id LIMIT 1
  `).get()
  if (userWithoutLedger) fail(`ledgers is missing user ${userWithoutLedger.user_id}`)
  for (const secret of rowsFor(database, 'account_secrets')) {
    const account = getRecord.get('accounts', secret.account_id)
    if (!account) fail(`account_secrets ${secret.id} references missing account ${secret.account_id}`)
  }
  for (const provider of rowsFor(database, 'payment_provider_instances')) {
    validatePaymentProviderCredential(provider, manifest, process.env.CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY)
  }
  for (const account of rowsFor(database, 'accounts')) {
    const stored = getRecord.get('account_secrets', account.credential_ref)
    if (!stored) fail(`${account.enabled ? 'enabled account' : 'account'} ${account.id} is missing restored credential ${account.credential_ref}`)
    if (stored && rowFromStored(stored).account_id !== account.id) fail(`account ${account.id} credential ${account.credential_ref} belongs to another account`)
    if (stored) decryptCredentialForTarget(rowFromStored(stored), account, manifest, credentialMasterKey)
    if (account.enabled) {
      const routable = database.prepare(`
        SELECT 1
          FROM records ag
          JOIN records am ON am.domain = 'account_models'
            AND json_extract(am.json, '$.account_id') = ?
          JOIN records gm ON gm.domain = 'group_models'
            AND json_extract(gm.json, '$.group_id') = json_extract(ag.json, '$.group_id')
            AND json_extract(gm.json, '$.model_id') = json_extract(am.json, '$.model_id')
          JOIN records g ON g.domain = 'groups'
            AND g.stable_id = json_extract(ag.json, '$.group_id')
          JOIN records m ON m.domain = 'models'
            AND m.stable_id = json_extract(am.json, '$.model_id')
         WHERE ag.domain = 'account_groups'
           AND json_extract(ag.json, '$.account_id') = ?
           AND json_extract(m.json, '$.platform') = ?
           AND (json_extract(g.json, '$.platform') = 'composite' OR json_extract(g.json, '$.platform') = ?)
           AND json_extract(g.json, '$.enabled') = 1
           AND json_extract(m.json, '$.enabled') = 1
           AND json_extract(gm.json, '$.enabled') = 1
           AND (
             (json_extract(am.json, '$.chat_completions') = 1 AND json_extract(m.json, '$.endpoint') IN ('chat_completions', 'both'))
             OR (json_extract(am.json, '$.responses') = 1 AND json_extract(m.json, '$.endpoint') IN ('responses', 'both'))
             OR (json_extract(am.json, '$.embeddings') = 1 AND json_extract(m.json, '$.embeddings') = 1)
             OR (json_extract(am.json, '$.image_generation') = 1 AND json_extract(m.json, '$.image_generation') = 1)
           )
         LIMIT 1
      `).get(account.id, account.id, account.platform, account.platform)
      if (!routable) fail(`enabled account ${account.id} has no routable model relation`)
    }
  }
  for (const key of rowsFor(database, 'keys')) {
    if (key.group_id !== null && !getRecord.get('groups', key.group_id)) fail(`keys ${key.id} references missing group ${key.group_id}`)
  }
  for (const plan of rowsFor(database, 'subscription_plans')) {
    const stored = getRecord.get('groups', plan.group_id)
    if (!stored) fail(`subscription_plans ${plan.id} references missing group ${plan.group_id}`)
    if (rowFromStored(stored).group_type !== 'subscription') fail(`subscription_plans ${plan.id} requires a subscription group`)
  }
  for (const relation of rowsFor(database, 'group_models')) {
    const group = getRecord.get('groups', relation.group_id)
    const model = getRecord.get('models', relation.model_id)
    if (!group) fail(`group_models ${relation.group_id}/${relation.model_id} references missing group ${relation.group_id}`)
    if (!model) fail(`group_models ${relation.group_id}/${relation.model_id} references missing model ${relation.model_id}`)
    if (rowFromStored(group).platform !== 'composite' && rowFromStored(group).platform !== rowFromStored(model).platform) fail(`group_models ${relation.group_id}/${relation.model_id} has a platform mismatch`)
  }
  for (const relation of rowsFor(database, 'account_groups')) {
    const account = getRecord.get('accounts', relation.account_id)
    const group = getRecord.get('groups', relation.group_id)
    if (!account) fail(`account_groups ${relation.account_id}/${relation.group_id} references missing account ${relation.account_id}`)
    if (!group) fail(`account_groups ${relation.account_id}/${relation.group_id} references missing group ${relation.group_id}`)
    if (rowFromStored(group).platform !== 'composite' && rowFromStored(account).platform !== rowFromStored(group).platform) fail(`account_groups ${relation.account_id}/${relation.group_id} has a platform mismatch`)
  }
  for (const relation of rowsFor(database, 'account_models')) {
    const account = getRecord.get('accounts', relation.account_id)
    const model = getRecord.get('models', relation.model_id)
    if (!account) fail(`account_models ${relation.account_id}/${relation.model_id} references missing account ${relation.account_id}`)
    if (!model) fail(`account_models ${relation.account_id}/${relation.model_id} references missing model ${relation.model_id}`)
    if (rowFromStored(account).platform !== rowFromStored(model).platform) fail(`account_models ${relation.account_id}/${relation.model_id} has a platform mismatch`)
  }
  for (const subscription of rowsFor(database, 'subscriptions')) {
    const storedGroup = getRecord.get('groups', subscription.group_id)
    if (!storedGroup) fail(`subscriptions ${subscription.id} references missing group ${subscription.group_id}`)
    if (rowFromStored(storedGroup).group_type !== 'subscription') fail(`subscriptions ${subscription.id} requires a subscription group`)
    if (subscription.plan_id !== null) {
      const storedPlan = getRecord.get('subscription_plans', subscription.plan_id)
      if (!storedPlan) fail(`subscriptions ${subscription.id} references missing plan ${subscription.plan_id}`)
      if (rowFromStored(storedPlan).group_id !== subscription.group_id) fail(`subscriptions ${subscription.id} plan/group mismatch`)
    }
  }
  for (const order of rowsFor(database, 'orders')) {
    if (!getRecord.get('payment_provider_instances', order.provider_instance_id)) fail(`orders ${order.id} references missing payment provider ${order.provider_instance_id}`)
    if (order.plan_id !== undefined && order.plan_id !== null && !getRecord.get('subscription_plans', order.plan_id)) fail(`orders ${order.id} references missing plan ${order.plan_id}`)
    if (order.subscription_id !== undefined && order.subscription_id !== null && !getRecord.get('subscriptions', order.subscription_id)) {
      fail(`orders ${order.id} references missing subscription ${order.subscription_id}`)
    }
  }
}

function sqlValue(value) {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return `'${String(value).replaceAll("'", "''")}'`
}

function insert(table, columns, values) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.map(sqlValue).join(', ')});`
}

async function writeD1Sql(path, manifest, database) {
  const file = await open(path, 'wx')
  const line = async (value) => file.write(`${value}\n`)
  try {
    await line(`-- ${ARTIFACT_SCHEMA} v${VERSION}; snapshot ${manifest.snapshot_id}; D1 schema ${manifest.d1_schema_version}`)
    await line('PRAGMA foreign_keys = ON;')
    await line('BEGIN IMMEDIATE;')
    for (const row of rowsFor(database, 'groups')) {
      await line(insert('"groups"', ['id', 'schema_version', 'name', 'platform', 'enabled', 'group_type', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.name, row.platform, row.enabled, row.group_type, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'models')) {
      await line(insert('models', ['id', 'platform', 'public_name', 'upstream_name', 'endpoint', 'enabled', 'embeddings', 'image_generation', 'created_at_ms', 'updated_at_ms'], [row.id, row.platform, row.public_name, row.upstream_name, row.endpoint, row.enabled, row.embeddings, row.image_generation, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'group_models')) {
      await line(insert('group_models', ['group_id', 'model_id', 'upstream_name_override', 'enabled', 'sort_order', 'max_output_tokens', 'default_max_output_tokens', 'catalog_visible', 'created_at_ms', 'updated_at_ms'], [row.group_id, row.model_id, row.upstream_name_override, row.enabled, row.sort_order, row.max_output_tokens, row.default_max_output_tokens, row.catalog_visible, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'subscription_plans')) {
      await line(insert('subscription_plans', ['id', 'schema_version', 'group_id', 'name', 'description', 'validity_days', 'price_micros', 'currency', 'daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros', 'enabled', 'sort_order', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.group_id, row.name, row.description, row.validity_days, row.price_micros, row.currency, row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros, row.enabled, row.sort_order, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'payment_provider_instances')) {
      await line(insert('payment_provider_instances', ['id', 'schema_version', 'provider_key', 'provider_type', 'display_name', 'config_ciphertext', 'config_nonce', 'config_key_id', 'enabled', 'version', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.provider_key, row.provider_type, row.display_name, row.config_ciphertext, row.config_nonce, row.config_key_id, row.enabled, row.version, row.created_at_ms, row.updated_at_ms]))
    }
    const balanceStatement = database.prepare("SELECT json FROM records WHERE domain = 'balances' AND stable_id = ?")
    for (const row of rowsFor(database, 'users')) {
      const balance = rowFromStored(balanceStatement.get(row.id))
      await line(insert('users', ['id', 'schema_version', 'email', 'display_name', 'role', 'status', 'balance_micros', 'spend_debt_micros', 'state_version', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.email, row.display_name, row.role, row.status, balance.balance_micros, balance.spend_debt_micros, balance.state_version, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'accounts')) {
      await line(insert('accounts', ['id', 'schema_version', 'platform', 'name', 'credential_ref', 'enabled', 'max_concurrency', 'created_at_ms', 'updated_at_ms', 'base_url', 'config_version', 'protocol', 'auth_scheme', 'provider_config_json'], [row.id, 1, row.platform, row.name, row.credential_ref, row.enabled, row.max_concurrency, row.created_at_ms, row.updated_at_ms, row.base_url, row.config_version, row.protocol, row.auth_scheme, canonicalJson(row.provider_config)]))
    }
    for (const row of rowsFor(database, 'account_groups')) {
      await line(insert('account_groups', ['account_id', 'group_id', 'priority', 'weight', 'created_at_ms', 'updated_at_ms'], [row.account_id, row.group_id, row.priority, row.weight, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'account_models')) {
      await line(insert('account_models', ['account_id', 'model_id', 'chat_completions', 'responses', 'embeddings', 'image_generation', 'created_at_ms', 'updated_at_ms'], [row.account_id, row.model_id, row.chat_completions, row.responses, row.embeddings, row.image_generation, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'account_secrets')) {
      await line(insert('account_secrets', ['id', 'account_id', 'purpose', 'algorithm', 'key_version', 'nonce_b64', 'ciphertext_b64', 'created_at_ms', 'updated_at_ms'], [row.id, row.account_id, row.purpose, row.algorithm, row.key_version, row.nonce_b64, row.ciphertext_b64, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'keys')) {
      await line(insert('api_keys', ['id', 'schema_version', 'user_id', 'key_hash', 'name', 'enabled', 'expires_at_ms', 'last_used_at_ms', 'created_at_ms', 'updated_at_ms', 'group_id'], [row.id, 1, row.user_id, row.key_hash, row.name, row.enabled, row.expires_at_ms, row.last_used_at_ms, row.created_at_ms, row.updated_at_ms, row.group_id]))
    }
    for (const row of rowsFor(database, 'subscriptions')) {
      await line(insert('user_subscriptions', ['id', 'schema_version', 'user_id', 'group_id', 'plan_id', 'status', 'starts_at_ms', 'expires_at_ms', 'daily_quota_micros', 'weekly_quota_micros', 'monthly_quota_micros', 'daily_used_micros', 'weekly_used_micros', 'monthly_used_micros', 'source_type', 'source_id', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.user_id, row.group_id, row.plan_id, row.status, row.starts_at_ms, row.expires_at_ms, row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros, row.daily_used_micros, row.weekly_used_micros, row.monthly_used_micros, row.source_type, row.source_id, row.created_at_ms, row.updated_at_ms]))
    }
    for (const row of rowsFor(database, 'orders')) {
      await line(insert('payment_orders', ['id', 'schema_version', 'user_id', 'provider_instance_id', 'provider_key_snapshot', 'out_trade_no', 'idempotency_key_hash', 'request_hash', 'order_type', 'status', 'amount_micros', 'pay_amount_micros', 'paid_amount_micros', 'refunded_amount_micros', 'currency', 'plan_id', 'plan_name_snapshot', 'plan_group_id_snapshot', 'plan_validity_days_snapshot', 'plan_price_micros_snapshot', 'plan_currency_snapshot', 'plan_daily_quota_micros_snapshot', 'plan_weekly_quota_micros_snapshot', 'plan_monthly_quota_micros_snapshot', 'subscription_id', 'subscription_fulfilled_at_ms', 'expires_at_ms', 'paid_at_ms', 'completed_at_ms', 'created_at_ms', 'updated_at_ms'], [row.id, 1, row.user_id, row.provider_instance_id, 'legacy-cutover', row.out_trade_no, sha256(`idempotency:${manifest.snapshot_id}:${row.id}`), sha256(`request:${manifest.snapshot_id}:${row.id}`), row.order_type, row.status, row.amount_micros, row.pay_amount_micros, row.paid_amount_micros, row.refunded_amount_micros, row.currency, row.plan_id ?? null, row.plan_name_snapshot ?? null, row.plan_group_id_snapshot ?? null, row.plan_validity_days_snapshot ?? null, row.plan_price_micros_snapshot ?? null, row.plan_currency_snapshot ?? null, row.plan_daily_quota_micros_snapshot ?? null, row.plan_weekly_quota_micros_snapshot ?? null, row.plan_monthly_quota_micros_snapshot ?? null, row.subscription_id ?? null, row.subscription_fulfilled_at_ms ?? null, row.expires_at_ms, row.paid_at_ms, row.completed_at_ms, row.created_at_ms, row.updated_at_ms]))
    }
    const projectedAt = Date.parse(manifest.created_at)
    for (const row of rowsFor(database, 'ledgers', 'ledger')) {
      await line(insert('user_financial_events', ['event_id', 'user_id', 'state_version', 'event_type', 'source_type', 'source_id', 'request_id', 'actor_user_id', 'actor_session_id', 'amount_delta_micros', 'gross_amount_micros', 'spend_debt_delta_micros', 'balance_after_micros', 'spend_debt_after_micros', 'occurred_at_ms', 'projected_at_ms'], [row.id, row.user_id, row.state_version, row.event_type, row.source_type, row.source_id, row.request_id, null, null, row.amount_delta_micros, row.gross_amount_micros, row.spend_debt_delta_micros, row.balance_after_micros, row.spend_debt_after_micros, row.occurred_at_ms, projectedAt]))
    }
    await line('COMMIT;')
  } finally {
    await file.close()
  }
}

async function writeDependencyArtifact(path, database) {
  const file = await open(path, 'wx')
  const domains = DEPENDENCY_DOMAINS
  try {
    await file.write('{\n  "schema": "sub2api-cutover-d1-dependencies",\n  "version": 1')
    for (const domain of domains) {
      await file.write(`,\n  ${JSON.stringify(domain)}: [`)
      let first = true
      for (const row of rowsFor(database, domain)) {
        await file.write(`${first ? '' : ','}\n    ${canonicalJson(row)}`)
        first = false
      }
      await file.write(`${first ? '' : '\n  '}]`)
    }
    await file.write('\n}\n')
  } finally {
    await file.close()
  }
}

async function writeDoCommands(path, manifest, database) {
  const file = await open(path, 'wx')
  const userStatement = database.prepare("SELECT json FROM records WHERE domain = 'users' AND stable_id = ?")
  try {
    for (const row of rowsFor(database, 'balances')) {
      const user = rowFromStored(userStatement.get(row.user_id))
      const command = {
        schema: 'sub2api-user-state-initialization', version: 1, snapshot_id: manifest.snapshot_id,
        do_binding: 'USER_STATE', do_name: row.user_id, method: 'POST', path: '/configure',
        body: {
          schema_version: manifest.do_schema_version,
          mutation_id: `cutover:${manifest.snapshot_id}:configure`,
          user_id: row.user_id,
          balance_micros: row.balance_micros,
          spend_debt_micros: row.spend_debt_micros,
          enabled: row.enabled && user.status === 'active',
          initial_state_version: row.state_version,
        },
      }
      await file.write(`${canonicalJson(command)}\n`)
    }
  } finally {
    await file.close()
  }
}

async function writeR2Artifacts(inventoryPath, planPath, manifest, sourceManifestSha256, database) {
  const inventory = await open(inventoryPath, 'wx')
  const plan = await open(planPath, 'wx')
  const aggregate = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(CAST(json_extract(json, '$.size') AS INTEGER)), 0) AS bytes FROM records WHERE domain = 'r2_objects'").get()
  try {
    const sourceRoot = {
      kind: 'manifest-relative-local-export',
      relative_to_manifest: manifest.r2_source_root,
      source_manifest_sha256: sourceManifestSha256,
      descriptor_sha256: sha256(canonicalJson({ snapshot_id: manifest.snapshot_id, relative_to_manifest: manifest.r2_source_root, source_manifest_sha256: sourceManifestSha256 })),
    }
    await inventory.write(`${JSON.stringify({ schema: 'sub2api-r2-cutover-inventory', version: 1, snapshot_id: manifest.snapshot_id, source_root: sourceRoot, object_count: Number(aggregate.count), total_bytes: Number(aggregate.bytes) }).slice(0, -1)},\n  \"objects\": [`)
    let first = true
    for (const row of rowsFor(database, 'r2_objects', 'r2')) {
      const item = { key: row.key, size: row.size, sha256: row.sha256 }
      await inventory.write(`${first ? '' : ','}\n    ${canonicalJson(item)}`)
      first = false
      const command = {
        schema: 'sub2api-r2-copy-command', version: 1, snapshot_id: manifest.snapshot_id,
        source: { ...sourceRoot, relative_path: row.source_path },
        destination: { binding: 'MEDIA_BUCKET', key: row.key },
        expected_bytes: row.size, expected_sha256: row.sha256,
        if_destination_exists: 'verify-identical-or-halt',
      }
      await plan.write(`${canonicalJson(command)}\n`)
    }
    await inventory.write(`${first ? '' : '\n  '}]}\n`)
  } finally {
    await inventory.close()
    await plan.close()
  }
}

function identityFor(domain, row) {
  if (domain === 'balances') return row.user_id
  if (domain === 'r2_objects') return row.key
  return row.id
}

function buildMetrics(database) {
  const metrics = {}
  const countStatement = database.prepare('SELECT COUNT(*) AS count FROM records WHERE domain = ?')
  const sampleStatement = database.prepare('SELECT stable_id, json FROM records WHERE domain = ? ORDER BY sample_rank, stable_id LIMIT 32')
  const allStatement = database.prepare('SELECT stable_id, json FROM records WHERE domain = ? ORDER BY stable_id')
  for (const domain of RECONCILIATION_DOMAINS) {
    const sample = Array.from(sampleStatement.iterate(domain), (stored) => ({ id: stored.stable_id, row: rowFromStored(stored) }))
    const fullDigest = createHash('sha256')
    for (const stored of allStatement.iterate(domain)) fullDigest.update(`${stored.stable_id}\0${stored.json}\n`)
    metrics[domain] = {
      row_count: Number(countStatement.get(domain).count),
      sample_size: sample.length,
      sampled_ids: sample.map(({ id }) => id),
      sample_digest_sha256: sha256(sample.map(({ row }) => canonicalJson(row)).join('\n')),
      full_digest_sha256: fullDigest.digest('hex'),
    }
  }
  return metrics
}

function buildBaselineReport(manifest, database) {
  return {
    schema: 'sub2api-cutover-reconciliation', version: 1, snapshot_id: manifest.snapshot_id,
    status: 'baseline',
    digest_algorithm: 'sha256(stable-id + NUL + canonical-json + LF)',
    sample_selection: 'lowest sha256(domain + NUL + stable-id), maximum 32',
    domains: buildMetrics(database),
  }
}

function bucketForUser(userId) {
  return Number.parseInt(sha256(`cutover-cohort\0${userId}`).slice(0, 8), 16) % 100
}

function firstWorkerStage(user) {
  if (user.role === 'admin') return 'internal'
  const bucket = bucketForUser(user.id)
  for (const threshold of [1, 5, 25, 50, 100]) if (bucket < threshold) return String(threshold)
  return '100'
}

async function writeOwnershipAssignments(path, manifest, database) {
  const file = await open(path, 'wx')
  try {
    for (const user of rowsFor(database, 'users')) {
      await file.write(`${canonicalJson({
        schema: 'sub2api-cutover-user-ownership', version: 1, snapshot_id: manifest.snapshot_id,
        user_id: user.id,
        deterministic_bucket: bucketForUser(user.id),
        first_worker_stage: firstWorkerStage(user),
        before_stage_writer: 'old-go',
        at_and_after_stage_writer: 'worker',
      })}\n`)
    }
  } finally {
    await file.close()
  }
}

function buildOwnershipPlan(manifest) {
  return {
    schema: 'sub2api-cutover-ownership-plan', version: 1, snapshot_id: manifest.snapshot_id,
    current_stage: 'legacy',
    invariant: 'Every user has exactly one writer: old-go before eligibility, worker at and after the activated cohort stage.',
    failure_policy: 'Freeze the active cohort and halt. Do not route writes to a stale owner; reconcile final deltas before rollback.',
    assignments_artifact: 'ownership-assignments.ndjson',
    stages: STAGES.map((name, index) => ({
      name,
      ordinal: index,
      requires: ['cohort-frozen', 'final-delta-imported', 'reconciliation-passed'],
      activate_only_if: 'all requires are recorded as passed',
      on_failure: 'halted',
    })),
    assignment_algorithm: {
      internal_selector: 'users.role = admin',
      external_bucket: 'uint32(first 8 hex chars of sha256("cutover-cohort\\0" + user_id)) modulo 100',
      eligibility: 'first threshold strictly greater than the external bucket',
      thresholds: [1, 5, 25, 50, 100],
    },
    writer_rule: {
      before_eligibility: 'old-go',
      at_and_after_eligibility: 'worker',
    },
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

async function hashArtifact(path, logicalName, kind) {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    digest.update(chunk)
  }
  return { logical_name: logicalName, kind, bytes, sha256: digest.digest('hex') }
}

export async function buildCutover({ manifestPath, outputDirectory }) {
  const store = await loadAndValidateCutover(manifestPath)
  try {
    const { manifest, database } = store
    await mkdir(outputDirectory, { recursive: false })
    const d1Path = resolve(outputDirectory, 'd1-import.sql')
    const dependencyArtifactPath = resolve(outputDirectory, 'd1-dependencies.json')
    const doPath = resolve(outputDirectory, 'do-initialize.ndjson')
    const inventoryPath = resolve(outputDirectory, 'r2-inventory.json')
    const r2PlanPath = resolve(outputDirectory, 'r2-copy-plan.ndjson')
    const reconciliationPath = resolve(outputDirectory, 'reconciliation.json')
    const ownershipPath = resolve(outputDirectory, 'ownership-plan.json')
    const ownershipAssignmentsPath = resolve(outputDirectory, 'ownership-assignments.ndjson')
    const ownershipGenesisPath = resolve(outputDirectory, 'ownership-genesis.json')
    await writeD1Sql(d1Path, manifest, database)
    await writeDependencyArtifact(dependencyArtifactPath, database)
    await writeDoCommands(doPath, manifest, database)
    await writeR2Artifacts(inventoryPath, r2PlanPath, manifest, store.sourceManifestSha256, database)
    await writeJson(reconciliationPath, buildBaselineReport(manifest, database))
    await writeJson(ownershipPath, buildOwnershipPlan(manifest))
    await writeOwnershipAssignments(ownershipAssignmentsPath, manifest, database)
    const ownershipPlanIntegrity = await digestFile(ownershipPath)
    const ownershipAssignmentsIntegrity = await digestFile(ownershipAssignmentsPath)
    await writeJson(ownershipGenesisPath, {
      schema: 'sub2api-cutover-ownership-genesis', version: 1,
      snapshot_id: manifest.snapshot_id, stage: 'legacy', status: 'active',
      source_manifest_sha256: store.sourceManifestSha256,
      ownership_plan_sha256: ownershipPlanIntegrity.sha256,
      ownership_assignments_sha256: ownershipAssignmentsIntegrity.sha256,
    })
    const artifacts = []
    for (const [name, kind] of [
      ['d1-import.sql', 'd1-sql'], ['d1-dependencies.json', 'd1-dependencies'], ['do-initialize.ndjson', 'do-commands'],
      ['r2-inventory.json', 'r2-inventory'], ['r2-copy-plan.ndjson', 'r2-copy-plan'],
      ['reconciliation.json', 'reconciliation-baseline'], ['ownership-plan.json', 'ownership-plan'],
      ['ownership-assignments.ndjson', 'ownership-assignments'], ['ownership-genesis.json', 'ownership-genesis'],
    ]) artifacts.push(await hashArtifact(resolve(outputDirectory, name), name, kind))
    const artifactManifest = {
      schema: ARTIFACT_SCHEMA, version: 1, snapshot_id: manifest.snapshot_id,
      source_manifest_sha256: store.sourceManifestSha256,
      dependency_manifest_sha256: manifest.dependency_manifest.sha256,
      artifacts,
    }
    await writeJson(resolve(outputDirectory, 'artifact-manifest.json'), artifactManifest)
    return artifactManifest
  } finally {
    await store.cleanup()
  }
}

function validateArtifactManifest(raw) {
  const value = assertObject(raw, 'artifact manifest')
  assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'source_manifest_sha256', 'dependency_manifest_sha256', 'artifacts'], 'artifact manifest')
  if (value.schema !== ARTIFACT_SCHEMA || value.version !== 1) fail('unsupported artifact manifest schema/version')
  assertStableId(value.snapshot_id, 'artifact manifest.snapshot_id')
  assertSha256(value.source_manifest_sha256, 'artifact manifest.source_manifest_sha256')
  assertSha256(value.dependency_manifest_sha256, 'artifact manifest.dependency_manifest_sha256')
  if (!Array.isArray(value.artifacts)) fail('artifact manifest.artifacts must be an array')
  const names = new Set()
  const expectedKinds = new Map([
    ['d1-import.sql', 'd1-sql'], ['d1-dependencies.json', 'd1-dependencies'],
    ['do-initialize.ndjson', 'do-commands'], ['r2-inventory.json', 'r2-inventory'],
    ['r2-copy-plan.ndjson', 'r2-copy-plan'], ['reconciliation.json', 'reconciliation-baseline'],
    ['ownership-plan.json', 'ownership-plan'], ['ownership-assignments.ndjson', 'ownership-assignments'],
    ['ownership-genesis.json', 'ownership-genesis'],
  ])
  for (const [index, rawArtifact] of value.artifacts.entries()) {
    const artifact = assertObject(rawArtifact, `artifact manifest artifact ${index + 1}`)
    assertExactKeys(artifact, ['logical_name', 'kind', 'bytes', 'sha256'], `artifact manifest artifact ${index + 1}`)
    assertSafeRelativePath(artifact.logical_name, `artifact manifest artifact ${index + 1} logical_name`)
    assertString(artifact.kind, `artifact manifest artifact ${index + 1} kind`)
    assertSafeInteger(artifact.bytes, `artifact manifest artifact ${index + 1} bytes`)
    assertSha256(artifact.sha256, `artifact manifest artifact ${index + 1} sha256`)
    if (names.has(artifact.logical_name)) fail(`duplicate artifact manifest logical_name: ${artifact.logical_name}`)
    if (expectedKinds.get(artifact.logical_name) !== artifact.kind) fail(`artifact manifest contains unexpected artifact: ${artifact.logical_name}`)
    names.add(artifact.logical_name)
  }
  for (const name of expectedKinds.keys()) if (!names.has(name)) fail(`artifact manifest is missing artifact: ${name}`)
  return value
}

function artifactDescriptor(manifest, logicalName) {
  const matches = manifest.artifacts.filter((artifact) => artifact.logical_name === logicalName)
  if (matches.length !== 1) fail(`artifact manifest must contain exactly one ${logicalName}`)
  return matches[0]
}

function validatePathDigestDescriptor(raw, label) {
  const value = assertObject(raw, label)
  assertExactKeys(value, ['path', 'bytes', 'sha256'], label)
  assertSafeRelativePath(value.path, `${label}.path`)
  assertSafeInteger(value.bytes, `${label}.bytes`)
  assertSha256(value.sha256, `${label}.sha256`)
  return value
}

function validateDigestDescriptor(raw, label) {
  const value = assertObject(raw, label)
  assertExactKeys(value, ['bytes', 'sha256'], label)
  assertSafeInteger(value.bytes, `${label}.bytes`)
  assertSha256(value.sha256, `${label}.sha256`)
  return value
}

async function descriptorRelativeTo(outputPath, inputPath) {
  const path = relative(dirname(resolve(outputPath)), resolve(inputPath)).split(sep).join('/')
  assertSafeRelativePath(path, 'activation chain artifact path')
  return { path, ...await digestFile(resolve(inputPath)) }
}

function validateActivationArtifact(raw) {
  const value = assertObject(raw, 'previous activation')
  assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'previous_stage', 'stage', 'status', 'activated_at', 'source_high_watermark', 'artifact_manifest_sha256', 'reconciliation_gate_sha256', 'previous_activation_sha256', 'previous_activation', 'reconciliation_gate', 'reconciliation_artifacts', 'stage_evidence', 'assignment_algorithm', 'writer_rule'], 'previous activation')
  if (value.schema !== 'sub2api-cutover-ownership-activation' || value.version !== 1 || value.status !== 'ready-to-activate') fail('previous activation schema/version/status is invalid')
  assertStableId(value.snapshot_id, 'previous activation.snapshot_id')
  assertEnum(value.previous_stage, ['legacy', ...STAGES], 'previous activation.previous_stage')
  assertEnum(value.stage, STAGES, 'previous activation.stage')
  assertCanonicalIso(value.activated_at, 'previous activation.activated_at')
  assertStableId(value.source_high_watermark, 'previous activation.source_high_watermark')
  for (const key of ['artifact_manifest_sha256', 'reconciliation_gate_sha256', 'previous_activation_sha256']) assertSha256(value[key], `previous activation.${key}`)
  for (const key of ['previous_activation', 'reconciliation_gate', 'reconciliation_artifacts', 'stage_evidence']) validatePathDigestDescriptor(value[key], `previous activation.${key}`)
  const algorithm = assertObject(value.assignment_algorithm, 'previous activation.assignment_algorithm')
  assertExactKeys(algorithm, ['internal_selector', 'external_bucket', 'eligibility', 'thresholds'], 'previous activation.assignment_algorithm')
  if (canonicalJson(algorithm.thresholds) !== canonicalJson([1, 5, 25, 50, 100])) fail('previous activation thresholds are invalid')
  const writerRule = assertObject(value.writer_rule, 'previous activation.writer_rule')
  assertExactKeys(writerRule, ['before_eligibility', 'at_and_after_eligibility'], 'previous activation.writer_rule')
  if (writerRule.before_eligibility !== 'old-go' || writerRule.at_and_after_eligibility !== 'worker') fail('previous activation writer rule is invalid')
  return value
}

async function resolveAndVerifyChainArtifact(ownerPath, descriptor, label) {
  const path = await resolveDomainFile(resolve(ownerPath), descriptor.path)
  const actual = await digestFile(path)
  if (actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) fail(`${label} digest mismatch`)
  return { path, integrity: actual }
}

async function validatePreviousActivation(path, targetStage, baseArtifacts, baseIntegrity, ownershipIntegrity, ownershipPlan, artifactSetSha256, seen = new Set()) {
  if (!STAGES.includes(targetStage)) fail(`invalid cutover stage: ${targetStage}`)
  const targetIndex = STAGES.indexOf(targetStage)
  const expectedPrevious = targetIndex === 0 ? 'legacy' : STAGES[targetIndex - 1]
  const absolute = await realpath(resolve(path))
  if (seen.has(absolute)) fail('previous activation digest chain contains a cycle')
  seen.add(absolute)
  const integrity = await digestFile(absolute)
  const raw = await readBoundedJson(absolute, 4 * 1024 * 1024, 'previous activation')
  if (expectedPrevious === 'legacy') {
    const value = assertObject(raw, 'ownership genesis')
    assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'stage', 'status', 'source_manifest_sha256', 'ownership_plan_sha256', 'ownership_assignments_sha256'], 'ownership genesis')
    if (value.schema !== 'sub2api-cutover-ownership-genesis' || value.version !== 1 || value.stage !== 'legacy' || value.status !== 'active') fail('ownership genesis schema/version/status is invalid')
    for (const key of ['source_manifest_sha256', 'ownership_plan_sha256', 'ownership_assignments_sha256']) assertSha256(value[key], `ownership genesis.${key}`)
    const declared = artifactDescriptor(baseArtifacts, 'ownership-genesis.json')
    const assignments = artifactDescriptor(baseArtifacts, 'ownership-assignments.ndjson')
    if (integrity.bytes !== declared.bytes || integrity.sha256 !== declared.sha256 || value.snapshot_id !== baseArtifacts.snapshot_id || value.source_manifest_sha256 !== baseArtifacts.source_manifest_sha256 || value.ownership_plan_sha256 !== ownershipIntegrity.sha256 || value.ownership_assignments_sha256 !== assignments.sha256) fail('ownership genesis does not match artifact manifest')
    return { value, stage: 'legacy', integrity }
  }
  if (raw?.schema === 'sub2api-cutover-ownership-genesis') fail(`previous activation is not the required ${expectedPrevious} stage in this artifact chain`)
  const value = validateActivationArtifact(raw)
  if (value.stage !== expectedPrevious || value.snapshot_id !== baseArtifacts.snapshot_id || value.artifact_manifest_sha256 !== baseIntegrity.sha256 || canonicalJson(value.assignment_algorithm) !== canonicalJson(ownershipPlan.assignment_algorithm) || canonicalJson(value.writer_rule) !== canonicalJson(ownershipPlan.writer_rule)) fail(`previous activation is not the required ${expectedPrevious} stage in this artifact chain`)
  const previousIndex = STAGES.indexOf(value.stage)
  const requiredBeforePrevious = previousIndex === 0 ? 'legacy' : STAGES[previousIndex - 1]
  if (value.previous_stage !== requiredBeforePrevious) fail('previous activation contains a skipped stage')
  const previousFile = await resolveAndVerifyChainArtifact(absolute, value.previous_activation, 'previous activation chain predecessor')
  const gateFile = await resolveAndVerifyChainArtifact(absolute, value.reconciliation_gate, 'previous activation reconciliation gate')
  const reconciliationArtifactsFile = await resolveAndVerifyChainArtifact(absolute, value.reconciliation_artifacts, 'previous activation reconciliation artifact manifest')
  const evidenceFile = await resolveAndVerifyChainArtifact(absolute, value.stage_evidence, 'previous activation stage evidence')
  if (value.previous_activation_sha256 !== previousFile.integrity.sha256) fail('previous activation digest chain does not match its declared predecessor')
  if (value.reconciliation_gate_sha256 !== gateFile.integrity.sha256) fail('previous activation reconciliation gate digest does not match its declared gate')
  const predecessor = await validatePreviousActivation(previousFile.path, value.stage, baseArtifacts, baseIntegrity, ownershipIntegrity, ownershipPlan, artifactSetSha256, seen)
  const gate = validateReconciliationGate(await readBoundedJson(gateFile.path, 4 * 1024 * 1024, 'previous activation reconciliation gate'))
  const reconciliationArtifacts = validateReconciliationArtifactManifest(await readBoundedJson(reconciliationArtifactsFile.path, 4 * 1024 * 1024, 'previous activation reconciliation artifact manifest'))
  const evidence = validateStageEvidence(await readBoundedJson(evidenceFile.path, 4 * 1024 * 1024, 'previous activation stage evidence'))
  if (gate.status !== 'passed' || RECONCILIATION_DOMAINS.some((domain) => gate.domains[domain].matches !== true) || gate.stage !== value.stage || gate.expected_snapshot_id !== value.snapshot_id || gate.actual_snapshot_id !== value.snapshot_id || gate.expected_source_manifest_sha256 !== baseArtifacts.source_manifest_sha256 || gate.previous_activation_sha256 !== predecessor.integrity.sha256 || gate.artifact_manifest_sha256 !== baseIntegrity.sha256 || gate.artifact_set_sha256 !== artifactSetSha256 || gate.ownership_plan_sha256 !== ownershipIntegrity.sha256 || gate.actual_high_watermark !== value.source_high_watermark) fail('previous activation reconciliation gate is not valid for its stage')
  if (reconciliationArtifacts.snapshot_id !== value.snapshot_id || reconciliationArtifacts.stage !== value.stage || reconciliationArtifacts.base_artifact_manifest_sha256 !== baseIntegrity.sha256 || reconciliationArtifacts.artifact_set_sha256 !== artifactSetSha256 || reconciliationArtifacts.previous_activation.sha256 !== predecessor.integrity.sha256 || reconciliationArtifacts.previous_activation.bytes !== predecessor.integrity.bytes || reconciliationArtifacts.ownership_plan.sha256 !== ownershipIntegrity.sha256 || reconciliationArtifacts.ownership_plan.bytes !== ownershipIntegrity.bytes || reconciliationArtifacts.reconciliation_gate.sha256 !== gateFile.integrity.sha256 || reconciliationArtifacts.reconciliation_gate.bytes !== gateFile.integrity.bytes || reconciliationArtifactsFile.integrity.sha256 !== value.reconciliation_artifacts.sha256) fail('previous activation reconciliation artifact binding is invalid')
  if (evidence.snapshot_id !== value.snapshot_id || evidence.previous_stage !== predecessor.stage || evidence.stage !== value.stage || evidence.previous_activation_sha256 !== predecessor.integrity.sha256 || evidence.artifact_manifest_sha256 !== baseIntegrity.sha256 || evidence.reconciliation_gate_sha256 !== gateFile.integrity.sha256 || evidence.reconciliation_passed.sha256 !== gateFile.integrity.sha256 || value.activated_at !== evidence.reconciliation_passed.observed_at) fail('previous activation stage evidence binding is invalid')
  await verifyStageEvidenceFiles(evidence, evidenceFile.path, gateFile.path, gate, baseArtifacts, predecessor, Date.parse(value.activated_at))
  return { value, stage: value.stage, integrity }
}

async function verifyDeclaredArtifact(manifest, logicalName, path) {
  const descriptor = artifactDescriptor(manifest, logicalName)
  const actual = await digestFile(path)
  if (actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) fail(`${logicalName} does not match artifact manifest`)
  return actual
}

async function verifyAllDeclaredArtifacts(manifest, manifestPath) {
  const verified = []
  for (const descriptor of manifest.artifacts) {
    const path = await resolveDomainFile(resolve(manifestPath), descriptor.logical_name)
    const actual = await digestFile(path)
    if (actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) fail(`${descriptor.logical_name} does not match artifact manifest`)
    verified.push({ logical_name: descriptor.logical_name, bytes: actual.bytes, sha256: actual.sha256 })
  }
  return sha256(canonicalJson(verified))
}

function validateReconciliationArtifactManifest(raw) {
  const value = assertObject(raw, 'reconciliation artifact manifest')
  assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'stage', 'base_artifact_manifest_sha256', 'artifact_set_sha256', 'previous_activation', 'ownership_plan', 'reconciliation_gate'], 'reconciliation artifact manifest')
  if (value.schema !== 'sub2api-cutover-reconciliation-artifacts' || value.version !== 1) fail('unsupported reconciliation artifact manifest schema/version')
  assertStableId(value.snapshot_id, 'reconciliation artifact manifest.snapshot_id')
  assertEnum(value.stage, STAGES, 'reconciliation artifact manifest.stage')
  assertSha256(value.base_artifact_manifest_sha256, 'reconciliation artifact manifest.base_artifact_manifest_sha256')
  assertSha256(value.artifact_set_sha256, 'reconciliation artifact manifest.artifact_set_sha256')
  for (const key of ['previous_activation', 'ownership_plan', 'reconciliation_gate']) {
    const descriptor = assertObject(value[key], `reconciliation artifact manifest.${key}`)
    assertExactKeys(descriptor, ['bytes', 'sha256'], `reconciliation artifact manifest.${key}`)
    assertSafeInteger(descriptor.bytes, `reconciliation artifact manifest.${key}.bytes`)
    assertSha256(descriptor.sha256, `reconciliation artifact manifest.${key}.sha256`)
  }
  return value
}

function validateReconciliationGate(raw) {
  const value = assertObject(raw, 'reconciliation gate')
  assertExactKeys(value, ['schema', 'version', 'stage', 'target_environment', 'expected_snapshot_id', 'actual_snapshot_id', 'expected_high_watermark', 'actual_high_watermark', 'expected_source_manifest_sha256', 'actual_source_manifest_sha256', 'final_snapshot_sha256', 'freeze_proof', 'final_delta_proof', 'reconciled_at', 'status', 'artifact_manifest_sha256', 'artifact_set_sha256', 'ownership_plan_sha256', 'previous_activation_sha256', 'domains'], 'reconciliation gate')
  if (value.schema !== 'sub2api-cutover-reconciliation' || value.version !== 1) fail('unsupported reconciliation gate schema/version')
  assertEnum(value.stage, STAGES, 'reconciliation gate.stage')
  assertStableId(value.target_environment, 'reconciliation gate.target_environment')
  assertStableId(value.expected_snapshot_id, 'reconciliation gate.expected_snapshot_id')
  assertStableId(value.actual_snapshot_id, 'reconciliation gate.actual_snapshot_id')
  assertStableId(value.expected_high_watermark, 'reconciliation gate.expected_high_watermark')
  assertStableId(value.actual_high_watermark, 'reconciliation gate.actual_high_watermark')
  for (const key of ['expected_source_manifest_sha256', 'actual_source_manifest_sha256', 'final_snapshot_sha256']) assertSha256(value[key], `reconciliation gate.${key}`)
  validateDigestDescriptor(value.freeze_proof, 'reconciliation gate.freeze_proof')
  validateDigestDescriptor(value.final_delta_proof, 'reconciliation gate.final_delta_proof')
  assertCanonicalIso(value.reconciled_at, 'reconciliation gate.reconciled_at')
  assertEnum(value.status, ['passed', 'failed'], 'reconciliation gate.status')
  assertSha256(value.artifact_manifest_sha256, 'reconciliation gate.artifact_manifest_sha256')
  assertSha256(value.artifact_set_sha256, 'reconciliation gate.artifact_set_sha256')
  assertSha256(value.ownership_plan_sha256, 'reconciliation gate.ownership_plan_sha256')
  assertSha256(value.previous_activation_sha256, 'reconciliation gate.previous_activation_sha256')
  const domains = assertObject(value.domains, 'reconciliation gate.domains')
  assertExactKeys(domains, RECONCILIATION_DOMAINS, 'reconciliation gate.domains')
  for (const domain of RECONCILIATION_DOMAINS) {
    const result = assertObject(domains[domain], `reconciliation gate.domains.${domain}`)
    assertExactKeys(result, ['expected', 'actual', 'matches'], `reconciliation gate.domains.${domain}`)
    if (typeof result.matches !== 'boolean') fail(`reconciliation gate.domains.${domain}.matches must be boolean`)
    for (const side of ['expected', 'actual']) {
      const metric = assertObject(result[side], `reconciliation gate.domains.${domain}.${side}`)
      assertExactKeys(metric, ['row_count', 'sample_size', 'sampled_ids', 'sample_digest_sha256', 'full_digest_sha256'], `reconciliation gate.domains.${domain}.${side}`)
      assertSafeInteger(metric.row_count, `reconciliation gate.domains.${domain}.${side}.row_count`)
      assertSafeInteger(metric.sample_size, `reconciliation gate.domains.${domain}.${side}.sample_size`, { max: 32 })
      if (!Array.isArray(metric.sampled_ids) || metric.sampled_ids.length !== metric.sample_size) fail(`reconciliation gate.domains.${domain}.${side}.sampled_ids is invalid`)
      for (const id of metric.sampled_ids) assertString(id, `reconciliation gate.domains.${domain}.${side}.sampled_id`, { max: 1024 })
      assertSha256(metric.sample_digest_sha256, `reconciliation gate.domains.${domain}.${side}.sample_digest_sha256`)
      assertSha256(metric.full_digest_sha256, `reconciliation gate.domains.${domain}.${side}.full_digest_sha256`)
    }
  }
  const declaredFinalSnapshot = sha256(canonicalJson(Object.fromEntries(RECONCILIATION_DOMAINS.map((domain) => [domain, {
    row_count: value.domains[domain].actual.row_count,
    full_digest_sha256: value.domains[domain].actual.full_digest_sha256,
  }]))))
  if (value.final_snapshot_sha256 !== declaredFinalSnapshot) fail('reconciliation gate.final_snapshot_sha256 does not match its full-domain evidence')
  return value
}

async function validatePreReconciliationProofs({ freezeProofPath, finalDeltaProofPath, stage, expected, actual, previousActivation }) {
  const freezeIntegrity = await digestFile(resolve(freezeProofPath))
  const freeze = assertObject(await readBoundedJson(resolve(freezeProofPath), 1024 * 1024, 'cohort freeze proof'), 'cohort freeze proof')
  assertExactKeys(freeze, ['schema', 'version', 'snapshot_id', 'stage', 'source_manifest_sha256', 'previous_activation_sha256', 'frozen_at', 'cohort_frozen', 'old_writer_state', 'new_writer_state'], 'cohort freeze proof')
  assertCanonicalIso(freeze.frozen_at, 'cohort freeze proof.frozen_at')
  if (freeze.schema !== 'sub2api-cutover-freeze-proof' || freeze.version !== 1 || freeze.snapshot_id !== expected.manifest.snapshot_id || freeze.stage !== stage || freeze.source_manifest_sha256 !== expected.sourceManifestSha256 || freeze.previous_activation_sha256 !== previousActivation.integrity.sha256 || freeze.cohort_frozen !== true || freeze.old_writer_state !== 'frozen' || freeze.new_writer_state !== 'frozen') fail('cohort freeze proof is invalid for reconciliation')

  const deltaIntegrity = await digestFile(resolve(finalDeltaProofPath))
  const delta = assertObject(await readBoundedJson(resolve(finalDeltaProofPath), 1024 * 1024, 'final delta proof'), 'final delta proof')
  assertExactKeys(delta, ['schema', 'version', 'snapshot_id', 'stage', 'source_manifest_sha256', 'destination_manifest_sha256', 'previous_activation_sha256', 'imported_at', 'final_delta_imported', 'source_high_watermark', 'destination_high_watermark'], 'final delta proof')
  assertCanonicalIso(delta.imported_at, 'final delta proof.imported_at')
  if (delta.schema !== 'sub2api-cutover-final-delta-proof' || delta.version !== 1 || delta.snapshot_id !== expected.manifest.snapshot_id || delta.stage !== stage || delta.source_manifest_sha256 !== expected.sourceManifestSha256 || delta.destination_manifest_sha256 !== actual.sourceManifestSha256 || delta.previous_activation_sha256 !== previousActivation.integrity.sha256 || delta.final_delta_imported !== true || delta.source_high_watermark !== expected.manifest.source_high_watermark || delta.destination_high_watermark !== actual.manifest.source_high_watermark) fail('final delta proof is invalid for reconciliation')
  const freezeTime = Date.parse(freeze.frozen_at)
  const deltaTime = Date.parse(delta.imported_at)
  const now = Date.now()
  if (freezeTime > deltaTime || deltaTime > now + 5 * 60_000 || now - deltaTime > 15 * 60_000) fail('freeze/final-delta proofs are stale, future-dated, or out of order')
  return { freeze: { value: freeze, integrity: freezeIntegrity }, delta: { value: delta, integrity: deltaIntegrity } }
}

export async function reconcileCutover({ expectedManifestPath, actualManifestPath, artifactManifestPath, previousActivationPath, freezeProofPath, finalDeltaProofPath, stage, outputPath }) {
  const expected = await loadAndValidateCutover(expectedManifestPath)
  let actual
  try {
    actual = await loadAndValidateCutover(actualManifestPath)
    const artifactManifest = validateArtifactManifest(await readBoundedJson(resolve(artifactManifestPath), 4 * 1024 * 1024, 'artifact manifest'))
    const artifactManifestIntegrity = await digestFile(resolve(artifactManifestPath))
    if (artifactManifest.snapshot_id !== expected.manifest.snapshot_id || artifactManifest.source_manifest_sha256 !== expected.sourceManifestSha256 || artifactManifest.dependency_manifest_sha256 !== expected.manifest.dependency_manifest.sha256) {
      fail('artifact manifest does not bind the expected cutover input')
    }
    const ownershipPlanPath = resolve(dirname(artifactManifestPath), 'ownership-plan.json')
    const ownershipIntegrity = await verifyDeclaredArtifact(artifactManifest, 'ownership-plan.json', ownershipPlanPath)
    const ownershipPlan = validateOwnershipPlan(await readBoundedJson(ownershipPlanPath, 16 * 1024 * 1024, 'ownership plan'))
    const artifactSetSha256 = await verifyAllDeclaredArtifacts(artifactManifest, artifactManifestPath)
    const previousActivation = await validatePreviousActivation(previousActivationPath, stage, artifactManifest, artifactManifestIntegrity, ownershipIntegrity, ownershipPlan, artifactSetSha256)
    const expectedMetrics = buildMetrics(expected.database)
    const actualMetrics = buildMetrics(actual.database)
    const preReconciliationProofs = await validatePreReconciliationProofs({ freezeProofPath, finalDeltaProofPath, stage, expected, actual, previousActivation })
    const domains = {}
    let passed = expected.manifest.snapshot_id === actual.manifest.snapshot_id &&
      expected.manifest.source_high_watermark === actual.manifest.source_high_watermark &&
      expected.manifest.target_environment === actual.manifest.target_environment
    for (const domain of RECONCILIATION_DOMAINS) {
      const matches = expectedMetrics[domain].row_count === actualMetrics[domain].row_count &&
        expectedMetrics[domain].full_digest_sha256 === actualMetrics[domain].full_digest_sha256
      if (!matches) passed = false
      domains[domain] = { expected: expectedMetrics[domain], actual: actualMetrics[domain], matches }
    }
    const report = {
      schema: 'sub2api-cutover-reconciliation', version: 1,
      stage,
      target_environment: expected.manifest.target_environment,
      expected_snapshot_id: expected.manifest.snapshot_id,
      actual_snapshot_id: actual.manifest.snapshot_id,
      expected_high_watermark: expected.manifest.source_high_watermark,
      actual_high_watermark: actual.manifest.source_high_watermark,
      expected_source_manifest_sha256: expected.sourceManifestSha256,
      actual_source_manifest_sha256: actual.sourceManifestSha256,
      final_snapshot_sha256: sha256(canonicalJson(Object.fromEntries(RECONCILIATION_DOMAINS.map((domain) => [domain, { row_count: actualMetrics[domain].row_count, full_digest_sha256: actualMetrics[domain].full_digest_sha256 }])))),
      freeze_proof: preReconciliationProofs.freeze.integrity,
      final_delta_proof: preReconciliationProofs.delta.integrity,
      reconciled_at: new Date().toISOString(),
      status: passed ? 'passed' : 'failed',
      artifact_manifest_sha256: artifactManifestIntegrity.sha256,
      artifact_set_sha256: artifactSetSha256,
      ownership_plan_sha256: ownershipIntegrity.sha256,
      previous_activation_sha256: previousActivation.integrity.sha256,
      domains,
    }
    await writeJson(resolve(outputPath), report)
    const reportIntegrity = await digestFile(resolve(outputPath))
    await writeJson(resolve(`${outputPath}.artifact-manifest.json`), {
      schema: 'sub2api-cutover-reconciliation-artifacts', version: 1,
      snapshot_id: expected.manifest.snapshot_id,
      stage,
      base_artifact_manifest_sha256: artifactManifestIntegrity.sha256,
      artifact_set_sha256: artifactSetSha256,
      previous_activation: previousActivation.integrity,
      ownership_plan: ownershipIntegrity,
      reconciliation_gate: reportIntegrity,
    })
    return report
  } finally {
    if (actual) await actual.cleanup()
    await expected.cleanup()
  }
}

function validateOwnershipPlan(raw) {
  const plan = assertObject(raw, 'ownership plan')
  assertOptionalExactKeys(plan, ['schema', 'version', 'snapshot_id', 'current_stage', 'invariant', 'failure_policy', 'assignments_artifact', 'stages', 'assignment_algorithm', 'writer_rule'], ['last_transition'], 'ownership plan')
  if (plan.schema !== 'sub2api-cutover-ownership-plan' || plan.version !== 1) fail('unsupported ownership plan schema/version')
  assertStableId(plan.snapshot_id, 'ownership plan.snapshot_id')
  assertEnum(plan.current_stage, ['legacy', ...STAGES], 'ownership plan.current_stage')
  assertString(plan.invariant, 'ownership plan.invariant', { max: 1024 })
  assertString(plan.failure_policy, 'ownership plan.failure_policy', { max: 1024 })
  if (plan.assignments_artifact !== 'ownership-assignments.ndjson') fail('ownership plan.assignments_artifact is invalid')
  if (!Array.isArray(plan.stages) || plan.stages.length !== STAGES.length) fail('ownership plan.stages is invalid')
  for (const [index, stage] of plan.stages.entries()) {
    assertObject(stage, `ownership plan stage ${index + 1}`)
    assertExactKeys(stage, ['name', 'ordinal', 'requires', 'activate_only_if', 'on_failure'], `ownership plan stage ${index + 1}`)
    if (stage.name !== STAGES[index] || stage.ordinal !== index || canonicalJson(stage.requires) !== canonicalJson(['cohort-frozen', 'final-delta-imported', 'reconciliation-passed']) || stage.activate_only_if !== 'all requires are recorded as passed' || stage.on_failure !== 'halted') fail(`ownership plan stage ${index + 1} is invalid`)
  }
  const algorithm = assertObject(plan.assignment_algorithm, 'ownership plan.assignment_algorithm')
  assertExactKeys(algorithm, ['internal_selector', 'external_bucket', 'eligibility', 'thresholds'], 'ownership plan.assignment_algorithm')
  if (canonicalJson(algorithm.thresholds) !== canonicalJson([1, 5, 25, 50, 100])) fail('ownership plan thresholds are invalid')
  const writerRule = assertObject(plan.writer_rule, 'ownership plan.writer_rule')
  assertExactKeys(writerRule, ['before_eligibility', 'at_and_after_eligibility'], 'ownership plan.writer_rule')
  if (writerRule.before_eligibility !== 'old-go' || writerRule.at_and_after_eligibility !== 'worker') fail('ownership plan writer rule is invalid')
  if ('last_transition' in plan) {
    const transition = assertObject(plan.last_transition, 'ownership plan.last_transition')
    assertExactKeys(transition, ['previous_stage', 'stage', 'status', 'reconciliation_expected_snapshot_id', 'reconciliation_actual_snapshot_id'], 'ownership plan.last_transition')
  }
  return plan
}

function validateStageEvidence(raw) {
  const evidence = assertObject(raw, 'stage evidence')
  assertExactKeys(evidence, ['schema', 'version', 'snapshot_id', 'previous_stage', 'stage', 'artifact_manifest_sha256', 'reconciliation_gate_sha256', 'previous_activation_sha256', 'cohort_frozen', 'final_delta_imported', 'reconciliation_passed'], 'stage evidence')
  if (evidence.schema !== 'sub2api-cutover-stage-evidence' || evidence.version !== 1) fail('unsupported stage evidence schema/version')
  assertStableId(evidence.snapshot_id, 'stage evidence.snapshot_id')
  assertEnum(evidence.previous_stage, ['legacy', ...STAGES], 'stage evidence.previous_stage')
  assertEnum(evidence.stage, STAGES, 'stage evidence.stage')
  assertSha256(evidence.artifact_manifest_sha256, 'stage evidence.artifact_manifest_sha256')
  assertSha256(evidence.reconciliation_gate_sha256, 'stage evidence.reconciliation_gate_sha256')
  assertSha256(evidence.previous_activation_sha256, 'stage evidence.previous_activation_sha256')
  for (const key of ['cohort_frozen', 'final_delta_imported', 'reconciliation_passed']) {
    const proof = assertObject(evidence[key], `stage evidence.${key}`)
    assertExactKeys(proof, ['confirmed', 'evidence_id', 'observed_at', 'path', 'bytes', 'sha256'], `stage evidence.${key}`)
    if (proof.confirmed !== true) fail(`cutover halted: ${key.replaceAll('_', '-')} evidence is not confirmed`)
    assertStableId(proof.evidence_id, `stage evidence.${key}.evidence_id`)
    assertCanonicalIso(proof.observed_at, `stage evidence.${key}.observed_at`)
    assertSafeRelativePath(proof.path, `stage evidence.${key}.path`)
    assertSafeInteger(proof.bytes, `stage evidence.${key}.bytes`)
    assertSha256(proof.sha256, `stage evidence.${key}.sha256`)
  }
  return evidence
}

async function verifyStageEvidenceFiles(evidence, evidencePath, gatePath, gate, baseArtifacts, previousActivation, freshnessReferenceMs = Date.now()) {
  const observedTimes = []
  for (const key of ['cohort_frozen', 'final_delta_imported', 'reconciliation_passed']) {
    const proof = evidence[key]
    const path = await resolveDomainFile(resolve(evidencePath), proof.path)
    const actual = await digestFile(path)
    if (actual.bytes !== proof.bytes || actual.sha256 !== proof.sha256) fail(`cutover halted: ${key.replaceAll('_', '-')} evidence digest mismatch`)
    observedTimes.push(Date.parse(proof.observed_at))
    if (key === 'reconciliation_passed' && await realpath(path) !== await realpath(resolve(gatePath))) fail('cutover halted: reconciliation evidence does not reference the gate')
    if (key === 'cohort_frozen' && (actual.bytes !== gate.freeze_proof.bytes || actual.sha256 !== gate.freeze_proof.sha256)) fail('cutover halted: reconciliation gate does not bind the cohort freeze proof')
    if (key === 'final_delta_imported' && (actual.bytes !== gate.final_delta_proof.bytes || actual.sha256 !== gate.final_delta_proof.sha256)) fail('cutover halted: reconciliation gate does not bind the final delta proof')
    if (key === 'cohort_frozen') {
      const value = assertObject(await readBoundedJson(path, 1024 * 1024, 'cohort freeze proof'), 'cohort freeze proof')
      assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'stage', 'source_manifest_sha256', 'previous_activation_sha256', 'frozen_at', 'cohort_frozen', 'old_writer_state', 'new_writer_state'], 'cohort freeze proof')
      assertCanonicalIso(value.frozen_at, 'cohort freeze proof.frozen_at')
      if (value.schema !== 'sub2api-cutover-freeze-proof' || value.version !== 1 || value.snapshot_id !== evidence.snapshot_id || value.stage !== evidence.stage || value.source_manifest_sha256 !== baseArtifacts.source_manifest_sha256 || value.previous_activation_sha256 !== previousActivation.integrity.sha256 || value.frozen_at !== proof.observed_at || value.cohort_frozen !== true || value.old_writer_state !== 'frozen' || value.new_writer_state !== 'frozen') fail('cutover halted: cohort freeze proof is invalid')
    }
    if (key === 'final_delta_imported') {
      const value = assertObject(await readBoundedJson(path, 1024 * 1024, 'final delta proof'), 'final delta proof')
      assertExactKeys(value, ['schema', 'version', 'snapshot_id', 'stage', 'source_manifest_sha256', 'destination_manifest_sha256', 'previous_activation_sha256', 'imported_at', 'final_delta_imported', 'source_high_watermark', 'destination_high_watermark'], 'final delta proof')
      assertCanonicalIso(value.imported_at, 'final delta proof.imported_at')
      if (value.schema !== 'sub2api-cutover-final-delta-proof' || value.version !== 1 || value.snapshot_id !== evidence.snapshot_id || value.stage !== evidence.stage || value.source_manifest_sha256 !== gate.expected_source_manifest_sha256 || value.destination_manifest_sha256 !== gate.actual_source_manifest_sha256 || value.previous_activation_sha256 !== previousActivation.integrity.sha256 || value.imported_at !== proof.observed_at || value.final_delta_imported !== true) fail('cutover halted: final delta proof is invalid')
      assertStableId(value.source_high_watermark, 'final delta proof.source_high_watermark')
      assertStableId(value.destination_high_watermark, 'final delta proof.destination_high_watermark')
      if (value.source_high_watermark !== value.destination_high_watermark) fail('cutover halted: final delta high-water marks disagree')
      if (value.source_high_watermark !== gate.actual_high_watermark) fail('cutover halted: final delta watermark does not match reconciliation gate')
    }
  }
  const gateTime = Date.parse(gate.reconciled_at)
  if (gateTime > freshnessReferenceMs + 5 * 60_000 || freshnessReferenceMs - gateTime > 15 * 60_000) fail('cutover halted: reconciliation gate is stale or future-dated')
  if (observedTimes[0] > observedTimes[1] || observedTimes[1] > gateTime || gateTime > observedTimes[2] || observedTimes[2] > freshnessReferenceMs + 5 * 60_000) fail('cutover halted: stage evidence timestamps are not fresh and monotonic')
  if (previousActivation.stage !== 'legacy' && Date.parse(previousActivation.value.activated_at) > observedTimes[0]) fail('cutover halted: cohort freeze predates the previous activation')
}

export async function advanceOwnership({ planPath, stage, gatePath, artifactManifestPath, reconciliationArtifactManifestPath, previousActivationPath, evidencePath, sourceManifestPath, outputPath }) {
  const gate = validateReconciliationGate(await readBoundedJson(resolve(gatePath), 4 * 1024 * 1024, 'reconciliation gate'))
  if (gate.status !== 'passed' || RECONCILIATION_DOMAINS.some((domain) => gate.domains[domain].matches !== true)) {
    fail('cutover halted: reconciliation gate failed')
  }
  const plan = validateOwnershipPlan(await readBoundedJson(resolve(planPath), 16 * 1024 * 1024, 'ownership plan'))
  const baseArtifacts = validateArtifactManifest(await readBoundedJson(resolve(artifactManifestPath), 4 * 1024 * 1024, 'artifact manifest'))
  const reconciliationArtifacts = validateReconciliationArtifactManifest(await readBoundedJson(resolve(reconciliationArtifactManifestPath), 4 * 1024 * 1024, 'reconciliation artifact manifest'))
  const evidence = validateStageEvidence(await readBoundedJson(resolve(evidencePath), 4 * 1024 * 1024, 'stage evidence'))
  const baseIntegrity = await digestFile(resolve(artifactManifestPath))
  const planIntegrity = await verifyDeclaredArtifact(baseArtifacts, 'ownership-plan.json', resolve(planPath))
  const artifactSetSha256 = await verifyAllDeclaredArtifacts(baseArtifacts, artifactManifestPath)
  const previousActivation = await validatePreviousActivation(previousActivationPath, stage, baseArtifacts, baseIntegrity, planIntegrity, plan, artifactSetSha256)
  const gateIntegrity = await digestFile(resolve(gatePath))
  if (gate.stage !== stage || gate.previous_activation_sha256 !== previousActivation.integrity.sha256) fail('cutover halted: stale reconciliation gate cannot be replayed for this stage')
  const source = await loadAndValidateCutover(sourceManifestPath)
  try {
    if (source.sourceManifestSha256 !== baseArtifacts.source_manifest_sha256 || source.manifest.snapshot_id !== plan.snapshot_id || source.manifest.source_high_watermark !== gate.actual_high_watermark || source.manifest.target_environment !== gate.target_environment) fail('cutover halted: source export no longer matches the reconciled artifact chain')
  } finally {
    await source.cleanup()
  }
  await verifyStageEvidenceFiles(evidence, evidencePath, gatePath, gate, baseArtifacts, previousActivation)
  if (baseArtifacts.snapshot_id !== plan.snapshot_id || reconciliationArtifacts.snapshot_id !== plan.snapshot_id || gate.expected_snapshot_id !== plan.snapshot_id || gate.actual_snapshot_id !== plan.snapshot_id) fail('cutover halted: artifact snapshot binding failed')
  if (reconciliationArtifacts.stage !== stage || reconciliationArtifacts.base_artifact_manifest_sha256 !== baseIntegrity.sha256 || reconciliationArtifacts.artifact_set_sha256 !== artifactSetSha256 || reconciliationArtifacts.previous_activation.sha256 !== previousActivation.integrity.sha256 || reconciliationArtifacts.previous_activation.bytes !== previousActivation.integrity.bytes || reconciliationArtifacts.ownership_plan.sha256 !== planIntegrity.sha256 || reconciliationArtifacts.ownership_plan.bytes !== planIntegrity.bytes || reconciliationArtifacts.reconciliation_gate.sha256 !== gateIntegrity.sha256 || reconciliationArtifacts.reconciliation_gate.bytes !== gateIntegrity.bytes) fail('cutover halted: artifact digest binding failed')
  if (gate.artifact_manifest_sha256 !== baseIntegrity.sha256 || gate.artifact_set_sha256 !== artifactSetSha256 || gate.ownership_plan_sha256 !== planIntegrity.sha256) fail('cutover halted: reconciliation gate artifact binding failed')
  if (evidence.snapshot_id !== plan.snapshot_id || evidence.previous_stage !== previousActivation.stage || evidence.stage !== stage || evidence.previous_activation_sha256 !== previousActivation.integrity.sha256 || evidence.artifact_manifest_sha256 !== baseIntegrity.sha256 || evidence.reconciliation_gate_sha256 !== gateIntegrity.sha256 || evidence.reconciliation_passed.sha256 !== gateIntegrity.sha256) fail('cutover halted: stage evidence artifact binding failed')
  if (!STAGES.includes(stage)) fail(`invalid cutover stage: ${stage}`)
  if (plan.current_stage !== 'legacy' || 'last_transition' in plan) fail('cutover halted: ownership plan must be the immutable build artifact')
  const currentIndex = previousActivation.stage === 'legacy' ? -1 : STAGES.indexOf(previousActivation.stage)
  const targetIndex = STAGES.indexOf(stage)
  if (targetIndex !== currentIndex + 1) fail(`stage ${stage} is not the next stage after ${previousActivation.stage}`)
  const previousActivationDescriptor = await descriptorRelativeTo(outputPath, previousActivationPath)
  const reconciliationGateDescriptor = await descriptorRelativeTo(outputPath, gatePath)
  const reconciliationArtifactsDescriptor = await descriptorRelativeTo(outputPath, reconciliationArtifactManifestPath)
  const stageEvidenceDescriptor = await descriptorRelativeTo(outputPath, evidencePath)
  const result = {
    schema: 'sub2api-cutover-ownership-activation', version: 1,
    snapshot_id: plan.snapshot_id,
    previous_stage: previousActivation.stage,
    stage,
    status: 'ready-to-activate',
    activated_at: evidence.reconciliation_passed.observed_at,
    source_high_watermark: gate.actual_high_watermark,
    artifact_manifest_sha256: baseIntegrity.sha256,
    reconciliation_gate_sha256: gateIntegrity.sha256,
    previous_activation_sha256: previousActivation.integrity.sha256,
    previous_activation: previousActivationDescriptor,
    reconciliation_gate: reconciliationGateDescriptor,
    reconciliation_artifacts: reconciliationArtifactsDescriptor,
    stage_evidence: stageEvidenceDescriptor,
    assignment_algorithm: plan.assignment_algorithm,
    writer_rule: plan.writer_rule,
  }
  await writeJson(resolve(outputPath), result)
  return result
}

function parseArguments(argv) {
  const [command, ...rawRest] = argv
  const rest = rawRest[0] === '--' ? rawRest.slice(1) : rawRest
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined || value.startsWith('--')) fail(`invalid argument near ${String(key)}`)
    options[key.slice(2)] = value
  }
  return { command, options }
}

function requireOption(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || value.length === 0) fail(`missing required option --${key}`)
  return value
}

export async function runCli(argv) {
  const { command, options } = parseArguments(argv)
  if (command === 'validate') {
    assertOptionSet(options, ['manifest'])
    const store = await loadAndValidateCutover(requireOption(options, 'manifest'))
    await store.cleanup()
    return 0
  }
  if (command === 'build') {
    assertOptionSet(options, ['manifest', 'out'])
    await buildCutover({ manifestPath: requireOption(options, 'manifest'), outputDirectory: requireOption(options, 'out') })
    return 0
  }
  if (command === 'reconcile') {
    assertOptionSet(options, ['expected', 'actual', 'artifacts', 'previous-activation', 'freeze-proof', 'final-delta-proof', 'stage', 'out'])
    const report = await reconcileCutover({ expectedManifestPath: requireOption(options, 'expected'), actualManifestPath: requireOption(options, 'actual'), artifactManifestPath: requireOption(options, 'artifacts'), previousActivationPath: requireOption(options, 'previous-activation'), freezeProofPath: requireOption(options, 'freeze-proof'), finalDeltaProofPath: requireOption(options, 'final-delta-proof'), stage: requireOption(options, 'stage'), outputPath: requireOption(options, 'out') })
    return report.status === 'passed' ? 0 : 2
  }
  if (command === 'advance') {
    assertOptionSet(options, ['plan', 'stage', 'gate', 'artifacts', 'reconciliation-artifacts', 'previous-activation', 'evidence', 'source-manifest', 'out'])
    await advanceOwnership({ planPath: requireOption(options, 'plan'), stage: requireOption(options, 'stage'), gatePath: requireOption(options, 'gate'), artifactManifestPath: requireOption(options, 'artifacts'), reconciliationArtifactManifestPath: requireOption(options, 'reconciliation-artifacts'), previousActivationPath: requireOption(options, 'previous-activation'), evidencePath: requireOption(options, 'evidence'), sourceManifestPath: requireOption(options, 'source-manifest'), outputPath: requireOption(options, 'out') })
    return 0
  }
  fail('usage: cutover.mjs validate --manifest FILE | build --manifest FILE --out DIR | reconcile --expected FILE --actual FILE --artifacts FILE --previous-activation FILE --freeze-proof FILE --final-delta-proof FILE --stage STAGE --out FILE | advance --plan FILE --stage STAGE --gate FILE --artifacts FILE --reconciliation-artifacts FILE --previous-activation FILE --evidence FILE --source-manifest FILE --out FILE')
}

function assertOptionSet(options, allowed) {
  for (const key of Object.keys(options)) if (!allowed.includes(key)) fail(`unknown option --${key}`)
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(`Cutover failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

// @ts-expect-error Node-only migration tool test runs outside the Worker runtime.
import { spawnSync } from 'node:child_process'
// @ts-expect-error Node-only migration tool test runs outside the Worker runtime.
import { createHash } from 'node:crypto'
// @ts-expect-error Node-only migration tool test runs outside the Worker runtime.
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
// @ts-expect-error Node-only migration tool test runs outside the Worker runtime.
import { tmpdir } from 'node:os'
// @ts-expect-error Node-only migration tool test runs outside the Worker runtime.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const scriptPath = decodeURIComponent(new URL('../../tools/migration/cutover.mjs', import.meta.url).pathname)
const fixtureDirectory = decodeURIComponent(new URL('./fixtures/migration/', import.meta.url).pathname)
const temporaryDirectories: string[] = []
const domains = ['users', 'keys', 'balances', 'ledgers', 'subscriptions', 'orders', 'accounts', 'r2_objects'] as const
const credentialMasterKey = 'fixture-master-key-that-is-at-least-32-bytes-long'
const paymentCredentialMasterKey = 'fixture-payment-master-key-that-is-at-least-32-bytes'

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-cutover-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createManifest(root: string): Promise<string> {
  const source = join(root, 'source')
  await cp(fixtureDirectory, source, { recursive: true })
  const descriptors: Record<string, unknown> = {}
  for (const domain of domains) {
    const path = join(source, `${domain}.ndjson`)
    const bytes = await readFile(path)
    const rows = bytes.toString('utf8').trimEnd().split('\n').length
    descriptors[domain] = {
      path: `source/${domain}.ndjson`,
      format: 'ndjson',
      bytes: (await stat(path)).size,
      rows,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  const dependencyBytes = await readFile(join(source, 'dependencies.json'))
  const manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify({
    schema: 'sub2api-production-cutover',
    version: 1,
    snapshot_id: 'fixture-2026-09-06',
    created_at: '2026-09-06T00:00:00.000Z',
    source_high_watermark: 'watermark-fixture',
    target_environment: 'production',
    d1_schema_version: 58,
    do_schema_version: 1,
    r2_source_root: 'source/r2-source',
    dependency_manifest: {
      path: 'source/dependencies.json',
      bytes: dependencyBytes.length,
      sha256: createHash('sha256').update(dependencyBytes).digest('hex'),
    },
    limits: {
      max_total_bytes: 1_000_000,
      max_file_bytes: 200_000,
      max_line_bytes: 16_384,
      max_rows_per_domain: 100,
    },
    domains: descriptors,
  }, null, 2)}\n`, 'utf8')
  return manifestPath
}

async function refreshDomainDescriptor(manifestPath: string, domain: typeof domains[number]): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const path = join(manifestPath.slice(0, manifestPath.lastIndexOf('/')), manifest.domains[domain].path)
  const bytes = await readFile(path)
  manifest.domains[domain].bytes = bytes.length
  manifest.domains[domain].rows = bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).length
  manifest.domains[domain].sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
}

async function addExtraKeys(manifestPath: string, count: number): Promise<void> {
  const root = manifestPath.slice(0, manifestPath.lastIndexOf('/'))
  const path = join(root, 'source/keys.ndjson')
  const existing = (await readFile(path, 'utf8')).trimEnd().split('\n')
  const extra = Array.from({ length: count }, (_, index) => JSON.stringify({
    id: `key-extra-${index}`, user_id: 'user-regular',
    key_hash: createHash('sha256').update(`key-extra-${index}`).digest('hex'),
    name: `Extra ${index}`, enabled: true, expires_at_ms: null, last_used_at_ms: null,
    group_id: 'group-subscription', created_at_ms: 1700000000000 + index, updated_at_ms: 1700000000000 + index,
  }))
  await writeFile(path, `${[...existing, ...extra].join('\n')}\n`, 'utf8')
  await refreshDomainDescriptor(manifestPath, 'keys')
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CUTOVER_CREDENTIALS_MASTER_KEY: credentialMasterKey, CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY: paymentCredentialMasterKey },
  })
}

function runWithoutCredentialKey(...args: string[]) {
  const env = { ...process.env }
  delete env.CUTOVER_CREDENTIALS_MASTER_KEY
  env.CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY = paymentCredentialMasterKey
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env })
}

function runWithoutPaymentCredentialKey(...args: string[]) {
  const env = { ...process.env, CUTOVER_CREDENTIALS_MASTER_KEY: credentialMasterKey }
  delete env.CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', env })
}

async function fileIntegrity(path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function createPreReconciliationProofs(root: string, options: { stage: string; expectedManifest: string; actualManifest: string; artifacts: string; previousActivation: string; suffix?: string }): Promise<{ freezePath: string; deltaPath: string }> {
  const suffix = options.suffix ?? options.stage
  const freezePath = join(root, `freeze-${suffix}.json`)
  const deltaPath = join(root, `delta-${suffix}.json`)
  const artifactManifest = JSON.parse(await readFile(options.artifacts, 'utf8'))
  const expectedManifest = JSON.parse(await readFile(options.expectedManifest, 'utf8'))
  const actualManifest = JSON.parse(await readFile(options.actualManifest, 'utf8'))
  const previousActivationIntegrity = await fileIntegrity(options.previousActivation)
  const freezeAt = new Date().toISOString()
  const deltaAt = freezeAt
  await writeFile(freezePath, JSON.stringify({
    schema: 'sub2api-cutover-freeze-proof', version: 1, snapshot_id: expectedManifest.snapshot_id,
    stage: options.stage, source_manifest_sha256: artifactManifest.source_manifest_sha256,
    previous_activation_sha256: previousActivationIntegrity.sha256, frozen_at: freezeAt,
    cohort_frozen: true, old_writer_state: 'frozen', new_writer_state: 'frozen',
  }), 'utf8')
  await writeFile(deltaPath, JSON.stringify({
    schema: 'sub2api-cutover-final-delta-proof', version: 1, snapshot_id: expectedManifest.snapshot_id,
    stage: options.stage, source_manifest_sha256: artifactManifest.source_manifest_sha256,
    destination_manifest_sha256: createHash('sha256').update(await readFile(options.actualManifest)).digest('hex'),
    previous_activation_sha256: previousActivationIntegrity.sha256, imported_at: deltaAt,
    final_delta_imported: true,
    source_high_watermark: expectedManifest.source_high_watermark, destination_high_watermark: actualManifest.source_high_watermark,
  }), 'utf8')
  return { freezePath, deltaPath }
}

async function createStageEvidence(root: string, options: { previousStage: string; stage: string; artifacts: string; gate: string; previousActivation: string; freezePath: string; deltaPath: string; suffix?: string }): Promise<string> {
  const gate = JSON.parse(await readFile(options.gate, 'utf8'))
  const gateIntegrity = await fileIntegrity(options.gate)
  const previousActivationIntegrity = await fileIntegrity(options.previousActivation)
  const gateTime = Date.parse(gate.reconciled_at)
  const freezeAt = JSON.parse(await readFile(options.freezePath, 'utf8')).frozen_at
  const deltaAt = JSON.parse(await readFile(options.deltaPath, 'utf8')).imported_at
  const reconcileAt = new Date(gateTime + 1).toISOString()
  const artifactIntegrity = await fileIntegrity(options.artifacts)
  const proof = async (path: string, id: string, observedAt: string) => ({
    confirmed: true,
    evidence_id: id,
    observed_at: observedAt,
    path: path.slice(root.length + 1),
    ...await fileIntegrity(path),
  })
  const evidencePath = join(root, `evidence-${options.suffix ?? options.stage}.json`)
  await writeFile(evidencePath, JSON.stringify({
    schema: 'sub2api-cutover-stage-evidence', version: 1,
    snapshot_id: 'fixture-2026-09-06', previous_stage: options.previousStage, stage: options.stage,
    artifact_manifest_sha256: artifactIntegrity.sha256,
    reconciliation_gate_sha256: gateIntegrity.sha256,
    previous_activation_sha256: previousActivationIntegrity.sha256,
    cohort_frozen: await proof(options.freezePath, `freeze-${options.stage}`, freezeAt),
    final_delta_imported: await proof(options.deltaPath, `delta-${options.stage}`, deltaAt),
    reconciliation_passed: await proof(options.gate, `reconcile-${options.stage}`, reconcileAt),
  }), 'utf8')
  return evidencePath
}

describe('production cutover CLI', () => {
  it('builds deterministic D1, DO, R2, reconciliation, and single-writer cohort artifacts', async () => {
    const root = await temporaryDirectory()
    const manifest = await createManifest(root)
    const first = join(root, 'first')
    const second = join(root, 'second')

    expect(run('build', '--manifest', manifest, '--out', first)).toMatchObject({ status: 0 })
    expect(run('build', '--manifest', manifest, '--out', second)).toMatchObject({ status: 0 })

    const names = ['d1-import.sql', 'd1-dependencies.json', 'do-initialize.ndjson', 'r2-inventory.json', 'r2-copy-plan.ndjson', 'reconciliation.json', 'ownership-plan.json', 'ownership-assignments.ndjson', 'ownership-genesis.json', 'artifact-manifest.json']
    for (const name of names) {
      expect(await readFile(join(first, name), 'utf8')).toBe(await readFile(join(second, name), 'utf8'))
    }
    const artifactText = (await Promise.all(names.map((name) => readFile(join(first, name), 'utf8')))).join('\n')
    expect(artifactText).not.toContain(credentialMasterKey)
    expect(artifactText).not.toContain('fixture-upstream-key')
    expect(artifactText).not.toContain(paymentCredentialMasterKey)
    expect(artifactText).not.toContain('fixture-stripe-key')
    const sql = await readFile(join(first, 'd1-import.sql'), 'utf8')
    expect(sql).toContain('INSERT INTO users')
    expect(sql).toContain('INSERT INTO user_financial_events')
    expect(sql).toContain('1000')
    expect(JSON.parse(await readFile(join(first, 'd1-dependencies.json'), 'utf8'))).toMatchObject({
      schema: 'sub2api-cutover-d1-dependencies',
      account_secrets: [expect.objectContaining({ account_id: 'account-1', algorithm: 'AES-256-GCM' })],
      models: [expect.objectContaining({ id: 'model-fixture' })],
      account_groups: [expect.objectContaining({ account_id: 'account-1', group_id: 'group-subscription' })],
      account_models: [expect.objectContaining({ account_id: 'account-1', model_id: 'model-fixture' })],
    })
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(sql)
    expect(raw.prepare('SELECT COUNT(*) AS count FROM user_financial_events').get()).toEqual({ count: 2 })
    expect(raw.prepare("SELECT balance_micros, spend_debt_micros FROM users WHERE id = 'user-regular'").get()).toEqual({ balance_micros: 1000, spend_debt_micros: 125 })
    expect(raw.prepare("SELECT COUNT(*) AS count FROM account_secrets WHERE account_id = 'account-1'").get()).toEqual({ count: 1 })
    expect(raw.prepare("SELECT COUNT(*) AS count FROM account_models WHERE account_id = 'account-1'").get()).toEqual({ count: 1 })

    const doCommands = (await readFile(join(first, 'do-initialize.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
    expect(doCommands).toHaveLength(2)
    expect(doCommands[1]).toMatchObject({ do_name: 'user-regular', path: '/configure', body: { balance_micros: 1000, initial_state_version: 1 } })
    expect(JSON.parse(await readFile(join(first, 'r2-inventory.json'), 'utf8'))).toMatchObject({ object_count: 1, total_bytes: 18 })

    const report = JSON.parse(await readFile(join(first, 'reconciliation.json'), 'utf8'))
    expect(Object.keys(report.domains)).toEqual([...domains, 'groups', 'models', 'group_models', 'subscription_plans', 'payment_provider_instances', 'account_groups', 'account_models', 'account_secrets'])
    expect(report.domains.balances).toMatchObject({ row_count: 2, sample_size: 2 })
    expect(report.domains.balances.sample_digest_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.domains.balances.full_digest_sha256).toMatch(/^[a-f0-9]{64}$/)
    const r2Plan = JSON.parse((await readFile(join(first, 'r2-copy-plan.ndjson'), 'utf8')).trim())
    expect(r2Plan.source).toMatchObject({ kind: 'manifest-relative-local-export', relative_to_manifest: 'source/r2-source', source_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), relative_path: 'exports/usage/fixture.ndjson.gz' })

    const ownership = JSON.parse(await readFile(join(first, 'ownership-plan.json'), 'utf8'))
    expect(ownership.stages.map((stage: { name: string }) => stage.name)).toEqual(['internal', '1', '5', '25', '50', '100'])
    expect(ownership.invariant).toContain('exactly one writer')
    expect(ownership.assignment_algorithm).toMatchObject({
      internal_selector: 'users.role = admin',
      thresholds: [1, 5, 25, 50, 100],
    })
    expect(ownership.writer_rule).toEqual({ before_eligibility: 'old-go', at_and_after_eligibility: 'worker' })
    const assignments = (await readFile(join(first, 'ownership-assignments.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse)
    expect(assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 'user-admin', first_worker_stage: 'internal' }),
      expect.objectContaining({ user_id: 'user-regular', before_stage_writer: 'old-go', at_and_after_stage_writer: 'worker' }),
    ]))
    const artifactManifest = JSON.parse(await readFile(join(first, 'artifact-manifest.json'), 'utf8'))
    expect(artifactManifest.source_manifest_sha256).toBe(createHash('sha256').update(await readFile(manifest)).digest('hex'))
  })

  it('fails closed on missing domains, duplicate ids, invalid micros, dangling references, and unsafe paths', async () => {
    const cases: Array<[string, (root: string, manifest: Record<string, any>) => Promise<void>, RegExp]> = [
      ['missing domain', async (_root, manifest) => { delete manifest.domains.orders }, /missing required domain: orders/i],
      ['duplicate id', async (root) => { const path = join(root, 'source/users.ndjson'); const first = (await readFile(path, 'utf8')).split('\n')[0]; await writeFile(path, `${first}\n${first}\n`, 'utf8') }, /duplicate users id: user-admin/i],
      ['invalid money', async (root) => { const path = join(root, 'source/balances.ndjson'); await writeFile(path, '{"user_id":"user-admin","balance_micros":1.5,"spend_debt_micros":0,"enabled":true,"state_version":1,"updated_at_ms":1}\n', 'utf8') }, /balance_micros.*safe integer/i],
      ['dangling reference', async (root) => { const path = join(root, 'source/keys.ndjson'); const row = JSON.parse(await readFile(path, 'utf8')); row.user_id = 'missing-user'; await writeFile(path, `${JSON.stringify(row)}\n`, 'utf8') }, /keys key-1 references missing user missing-user/i],
      ['unsafe path', async (_root, manifest) => { manifest.domains.users.path = '../users.ndjson' }, /unsafe domain path/i],
      ['symlink path', async (root, manifest) => { await symlink(join(root, 'source'), join(root, 'linked'), 'dir'); manifest.domains.users.path = 'linked/users.ndjson' }, /domain path must not contain symlinks/i],
      ['bounded line', async (_root, manifest) => { manifest.limits.max_line_bytes = 64 }, /line exceeds max_line_bytes/i],
      ['unknown row field', async (root) => { const path = join(root, 'source/accounts.ndjson'); const row = JSON.parse(await readFile(path, 'utf8')); row.plaintext_secret = 'forbidden'; await writeFile(path, `${JSON.stringify(row)}\n`, 'utf8') }, /accounts row 1 contains unknown field: plaintext_secret/i],
      ['missing account base URL', async (root) => { const path = join(root, 'source/accounts.ndjson'); const row = JSON.parse(await readFile(path, 'utf8')); row.base_url = null; await writeFile(path, `${JSON.stringify(row)}\n`, 'utf8') }, /accounts account-1\.base_url must be a trimmed string/i],
      ['unsafe account base URL', async (root) => { const path = join(root, 'source/accounts.ndjson'); const row = JSON.parse(await readFile(path, 'utf8')); row.base_url = 'https://127.0.0.1'; await writeFile(path, `${JSON.stringify(row)}\n`, 'utf8') }, /base_url must not target a private or local host/i],
      ['tampered R2 source', async (root) => { await writeFile(join(root, 'source/r2-source/exports/usage/fixture.ndjson.gz'), 'tampered-r2-object\n', 'utf8') }, /R2 object .* byte count mismatch|R2 object .* SHA-256 mismatch/i],
      ['symlinked R2 source', async (root) => { const path = join(root, 'source/r2-source/exports/usage/fixture.ndjson.gz'); await rm(path); await symlink(join(root, 'source/users.ndjson'), path) }, /R2 source path must not contain symlinks/i],
      ['missing account secret', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.account_secrets = []; await writeFile(path, JSON.stringify(value), 'utf8') }, /enabled account account-1 is missing restored credential account-secret-1/i],
      ['disabled account missing secret', async (root) => { const accountPath = join(root, 'source/accounts.ndjson'); const account = JSON.parse(await readFile(accountPath, 'utf8')); account.enabled = false; await writeFile(accountPath, `${JSON.stringify(account)}\n`, 'utf8'); const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.account_secrets = []; await writeFile(path, JSON.stringify(value), 'utf8') }, /account account-1 is missing restored credential account-secret-1/i],
      ['disabled account bad secret', async (root) => { const accountPath = join(root, 'source/accounts.ndjson'); const account = JSON.parse(await readFile(accountPath, 'utf8')); account.enabled = false; await writeFile(accountPath, `${JSON.stringify(account)}\n`, 'utf8'); const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.account_secrets[0].ciphertext_b64 = 'ZmFrZS1jaXBoZXJ0ZXh0'; await writeFile(path, JSON.stringify(value), 'utf8') }, /account account-1 credential account-secret-1 cannot be decrypted/i],
      ['missing group dependency', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.groups = []; await writeFile(path, JSON.stringify(value), 'utf8') }, /subscription_plans plan-fixture references missing group group-subscription|enabled account account-1 has no routable model relation/i],
      ['missing model relation', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.account_models = []; await writeFile(path, JSON.stringify(value), 'utf8') }, /enabled account account-1 has no routable model relation/i],
      ['no routing capability intersection', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); Object.assign(value.account_models[0], { chat_completions: false, responses: false, embeddings: true, image_generation: false }); await writeFile(path, JSON.stringify(value), 'utf8') }, /enabled account account-1 has no routable model relation/i],
      ['undecryptable account secret', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.account_secrets[0].ciphertext_b64 = 'ZmFrZS1jaXBoZXJ0ZXh0'; await writeFile(path, JSON.stringify(value), 'utf8') }, /cannot be decrypted with target credentials master key and runtime AAD/i],
      ['undecryptable payment secret', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.payment_provider_instances[0].config_ciphertext = 'ZmFrZS1jaXBoZXJ0ZXh0'; await writeFile(path, JSON.stringify(value), 'utf8') }, /cannot be decrypted with target payment credentials master key and runtime AAD/i],
      ['enabled unsupported payment provider', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.payment_provider_instances[0].provider_type = 'alipay'; await writeFile(path, JSON.stringify(value), 'utf8') }, /payment provider payment-provider-existing uses unsupported runtime type alipay/i],
      ['disabled unsupported payment provider', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.payment_provider_instances[0].provider_type = 'alipay'; value.payment_provider_instances[0].enabled = false; await writeFile(path, JSON.stringify(value), 'utf8') }, /payment provider payment-provider-existing uses unsupported runtime type alipay/i],
      ['disabled bad payment secret', async (root) => { const path = join(root, 'source/dependencies.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.payment_provider_instances[0].enabled = false; value.payment_provider_instances[0].config_ciphertext = 'ZmFrZS1jaXBoZXJ0ZXh0'; await writeFile(path, JSON.stringify(value), 'utf8') }, /cannot be decrypted with target payment credentials master key and runtime AAD/i],
    ]

    for (const [, mutate, expected] of cases) {
      const root = await temporaryDirectory()
      const manifestPath = await createManifest(root)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await mutate(root, manifest)
      // Refresh declared integrity after mutations so semantic validation is reached.
      for (const domain of domains) {
        if (!manifest.domains[domain]) continue
        const path = join(root, manifest.domains[domain].path)
        if (manifest.domains[domain].path.includes('..')) continue
        const bytes = await readFile(path)
        manifest.domains[domain].bytes = bytes.length
        manifest.domains[domain].rows = bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).length
        manifest.domains[domain].sha256 = createHash('sha256').update(bytes).digest('hex')
      }
      const dependencyBytes = await readFile(join(root, manifest.dependency_manifest.path))
      manifest.dependency_manifest.bytes = dependencyBytes.length
      manifest.dependency_manifest.sha256 = createHash('sha256').update(dependencyBytes).digest('hex')
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
      const result = run('build', '--manifest', manifestPath, '--out', join(root, 'out'))
      expect(result.status, result.stderr).not.toBe(0)
      expect(result.stderr).toMatch(expected)
    }

    const root = await temporaryDirectory()
    const manifestPath = await createManifest(root)
    const missingKey = runWithoutCredentialKey('build', '--manifest', manifestPath, '--out', join(root, 'missing-key'))
    expect(missingKey.status).not.toBe(0)
    expect(missingKey.stderr).toMatch(/cannot be restored without CUTOVER_CREDENTIALS_MASTER_KEY/i)
    const paymentRoot = await temporaryDirectory()
    const paymentManifest = await createManifest(paymentRoot)
    const missingPaymentKey = runWithoutPaymentCredentialKey('build', '--manifest', paymentManifest, '--out', join(paymentRoot, 'missing-payment-key'))
    expect(missingPaymentKey.status).not.toBe(0)
    expect(missingPaymentKey.stderr).toMatch(/cannot be activated without CUTOVER_PAYMENT_CREDENTIALS_MASTER_KEY/i)

  })

  it('compares destination exports and halts ownership advancement on any mismatch', async () => {
    const root = await temporaryDirectory()
    const expected = await createManifest(root)
    const output = join(root, 'output')
    expect(run('build', '--manifest', expected, '--out', output).status).toBe(0)

    const actualRoot = join(root, 'actual')
    await mkdir(actualRoot)
    const actual = await createManifest(actualRoot)
    const actualUsers = join(actualRoot, 'source/users.ndjson')
    const rows = (await readFile(actualUsers, 'utf8')).trimEnd().split('\n').map(JSON.parse)
    rows[1].display_name = 'Changed'
    await writeFile(actualUsers, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8')
    const actualManifest = JSON.parse(await readFile(actual, 'utf8'))
    const bytes = await readFile(actualUsers)
    actualManifest.domains.users.bytes = bytes.length
    actualManifest.domains.users.sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(actual, JSON.stringify(actualManifest), 'utf8')

    const reportPath = join(root, 'failed-reconciliation.json')
    const baseArtifacts = join(output, 'artifact-manifest.json')
    const genesis = join(output, 'ownership-genesis.json')
    const failedProofs = await createPreReconciliationProofs(root, { stage: 'internal', expectedManifest: expected, actualManifest: actual, artifacts: baseArtifacts, previousActivation: genesis, suffix: 'failed' })
    const reconcile = run('reconcile', '--expected', expected, '--actual', actual, '--artifacts', baseArtifacts, '--previous-activation', genesis, '--freeze-proof', failedProofs.freezePath, '--final-delta-proof', failedProofs.deltaPath, '--stage', 'internal', '--out', reportPath)
    expect(reconcile.status).toBe(2)
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({ status: 'failed' })

    const advanced = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', reportPath, '--artifacts', baseArtifacts, '--reconciliation-artifacts', `${reportPath}.artifact-manifest.json`, '--previous-activation', genesis, '--evidence', join(root, 'unused-evidence.json'), '--source-manifest', expected, '--out', join(root, 'advance.json'))
    expect(advanced.status).not.toBe(0)
    expect(advanced.stderr).toMatch(/cutover halted: reconciliation gate failed/i)

    const handwrittenGate = join(root, 'handwritten-gate.json')
    await writeFile(handwrittenGate, JSON.stringify({ schema: 'sub2api-cutover-reconciliation', version: 1, status: 'passed', snapshot_id: 'fixture-2026-09-06' }), 'utf8')
    const handwrittenAdvance = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', handwrittenGate, '--artifacts', baseArtifacts, '--reconciliation-artifacts', `${reportPath}.artifact-manifest.json`, '--previous-activation', genesis, '--evidence', join(root, 'unused-evidence.json'), '--source-manifest', expected, '--out', join(root, 'handwritten-activation.json'))
    expect(handwrittenAdvance.status).not.toBe(0)
    expect(handwrittenAdvance.stderr).toMatch(/reconciliation gate.*unknown field|missing field/i)

    const passedReport = join(root, 'passed-reconciliation.json')
    const internalProofs = await createPreReconciliationProofs(root, { stage: 'internal', expectedManifest: expected, actualManifest: expected, artifacts: baseArtifacts, previousActivation: genesis })
    const reverseDeltaPath = join(root, 'delta-reverse-order.json')
    const reverseDelta = JSON.parse(await readFile(internalProofs.deltaPath, 'utf8'))
    reverseDelta.imported_at = new Date(Date.parse(JSON.parse(await readFile(internalProofs.freezePath, 'utf8')).frozen_at) - 1_000).toISOString()
    await writeFile(reverseDeltaPath, JSON.stringify(reverseDelta), 'utf8')
    const reverseOrder = run('reconcile', '--expected', expected, '--actual', expected, '--artifacts', baseArtifacts, '--previous-activation', genesis, '--freeze-proof', internalProofs.freezePath, '--final-delta-proof', reverseDeltaPath, '--stage', 'internal', '--out', join(root, 'reverse-order-gate.json'))
    expect(reverseOrder.status).not.toBe(0)
    expect(reverseOrder.stderr).toMatch(/stale, future-dated, or out of order/i)
    expect(run('reconcile', '--expected', expected, '--actual', expected, '--artifacts', baseArtifacts, '--previous-activation', genesis, '--freeze-proof', internalProofs.freezePath, '--final-delta-proof', internalProofs.deltaPath, '--stage', 'internal', '--out', passedReport).status).toBe(0)
    const reconciliationArtifacts = `${passedReport}.artifact-manifest.json`
    const internalEvidence = await createStageEvidence(root, { previousStage: 'legacy', stage: 'internal', artifacts: baseArtifacts, gate: passedReport, previousActivation: genesis, ...internalProofs })
    const internalActivation = join(root, 'internal-activation.json')
    expect(run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', internalEvidence, '--source-manifest', expected, '--out', internalActivation).status).toBe(0)
    const unconfirmedEvidence = join(root, 'unconfirmed-evidence.json')
    const evidenceBody = JSON.parse(await readFile(internalEvidence, 'utf8'))
    evidenceBody.cohort_frozen.confirmed = false
    await writeFile(unconfirmedEvidence, JSON.stringify(evidenceBody), 'utf8')
    const unconfirmedAdvance = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', unconfirmedEvidence, '--source-manifest', expected, '--out', join(root, 'unconfirmed-activation.json'))
    expect(unconfirmedAdvance.status).not.toBe(0)
    expect(unconfirmedAdvance.stderr).toMatch(/cohort-frozen evidence is not confirmed/i)
    const onePercentReport = join(root, 'one-percent-reconciliation.json')
    const onePercentProofs = await createPreReconciliationProofs(root, { stage: '1', expectedManifest: expected, actualManifest: expected, artifacts: baseArtifacts, previousActivation: internalActivation })
    expect(run('reconcile', '--expected', expected, '--actual', expected, '--artifacts', baseArtifacts, '--previous-activation', internalActivation, '--freeze-proof', onePercentProofs.freezePath, '--final-delta-proof', onePercentProofs.deltaPath, '--stage', '1', '--out', onePercentReport).status).toBe(0)
    const onePercentEvidence = await createStageEvidence(root, { previousStage: 'internal', stage: '1', artifacts: baseArtifacts, gate: onePercentReport, previousActivation: internalActivation, ...onePercentProofs })
    const onePercentActivation = join(root, 'one-percent-activation.json')
    const onePercentAdvance = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', '1', '--gate', onePercentReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', `${onePercentReport}.artifact-manifest.json`, '--previous-activation', internalActivation, '--evidence', onePercentEvidence, '--source-manifest', expected, '--out', onePercentActivation)
    expect(onePercentAdvance.status, onePercentAdvance.stderr).toBe(0)
    expect(JSON.parse(await readFile(onePercentActivation, 'utf8'))).toMatchObject({ previous_stage: 'internal', stage: '1', status: 'ready-to-activate' })

    const forgedValidPredecessor = join(root, 'forged-valid-one-percent.json')
    const forgedValidBody = JSON.parse(await readFile(onePercentActivation, 'utf8'))
    forgedValidBody.previous_activation_sha256 = 'f'.repeat(64)
    forgedValidBody.reconciliation_gate_sha256 = 'e'.repeat(64)
    await writeFile(forgedValidPredecessor, `${JSON.stringify(forgedValidBody, null, 2)}\n`, 'utf8')
    const forgedPredecessorAdvance = run('reconcile', '--expected', expected, '--actual', expected, '--artifacts', baseArtifacts, '--previous-activation', forgedValidPredecessor, '--freeze-proof', onePercentProofs.freezePath, '--final-delta-proof', onePercentProofs.deltaPath, '--stage', '5', '--out', join(root, 'forged-predecessor-gate.json'))
    expect(forgedPredecessorAdvance.status).not.toBe(0)
    expect(forgedPredecessorAdvance.stderr).toMatch(/previous activation digest chain|reconciliation gate digest/i)

    const forgedGate = join(root, 'forged-gate.json')
    const gateBody = JSON.parse(await readFile(passedReport, 'utf8'))
    gateBody.domains.users.actual.sample_digest_sha256 = 'f'.repeat(64)
    await writeFile(forgedGate, JSON.stringify(gateBody), 'utf8')
    const forgedEvidence = await createStageEvidence(root, { previousStage: 'legacy', stage: 'internal', artifacts: baseArtifacts, gate: forgedGate, previousActivation: genesis, ...internalProofs, suffix: 'forged' })
    const forgedAdvance = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', forgedGate, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', forgedEvidence, '--source-manifest', expected, '--out', join(root, 'forged-activation.json'))
    expect(forgedAdvance.status).not.toBe(0)
    expect(forgedAdvance.stderr).toMatch(/artifact digest binding failed/i)

    const mutatedPlan = join(root, 'mutated-plan.json')
    const planBody = JSON.parse(await readFile(join(output, 'ownership-plan.json'), 'utf8'))
    planBody.failure_policy = 'continue anyway'
    await writeFile(mutatedPlan, JSON.stringify(planBody), 'utf8')
    const mutatedEvidence = await createStageEvidence(root, { previousStage: 'legacy', stage: 'internal', artifacts: baseArtifacts, gate: passedReport, previousActivation: genesis, ...internalProofs, suffix: 'mutated' })
    const mutatedAdvance = run('advance', '--plan', mutatedPlan, '--stage', 'internal', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', mutatedEvidence, '--source-manifest', expected, '--out', join(root, 'mutated-activation.json'))
    expect(mutatedAdvance.status).not.toBe(0)
    expect(mutatedAdvance.stderr).toMatch(/ownership-plan.json does not match artifact manifest/i)

    const skipped = run('reconcile', '--expected', expected, '--actual', expected, '--artifacts', baseArtifacts, '--previous-activation', genesis, '--freeze-proof', internalProofs.freezePath, '--final-delta-proof', internalProofs.deltaPath, '--stage', '5', '--out', join(root, 'skipped.json'))
    expect(skipped.status).not.toBe(0)
    expect(skipped.stderr).toMatch(/previous activation is not the required 1 stage/i)

    const replayEvidence = await createStageEvidence(root, { previousStage: 'internal', stage: '1', artifacts: baseArtifacts, gate: passedReport, previousActivation: internalActivation, ...onePercentProofs, suffix: 'replay' })
    const replay = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', '1', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', internalActivation, '--evidence', replayEvidence, '--source-manifest', expected, '--out', join(root, 'replay.json'))
    expect(replay.status).not.toBe(0)
    expect(replay.stderr).toMatch(/stale reconciliation gate cannot be replayed|artifact digest binding failed|reconciliation predates the previous activation/i)

    const staleGate = join(root, 'stale-gate.json')
    const staleGateBody = JSON.parse(await readFile(passedReport, 'utf8'))
    staleGateBody.reconciled_at = new Date(Date.now() - 60 * 60_000).toISOString()
    await writeFile(staleGate, `${JSON.stringify(staleGateBody, null, 2)}\n`, 'utf8')
    const staleSidecar = join(root, 'stale-gate-artifacts.json')
    const staleSidecarBody = JSON.parse(await readFile(reconciliationArtifacts, 'utf8'))
    staleSidecarBody.reconciliation_gate = await fileIntegrity(staleGate)
    await writeFile(staleSidecar, `${JSON.stringify(staleSidecarBody, null, 2)}\n`, 'utf8')
    const staleEvidence = await createStageEvidence(root, { previousStage: 'legacy', stage: 'internal', artifacts: baseArtifacts, gate: staleGate, previousActivation: genesis, ...internalProofs, suffix: 'stale' })
    const staleAdvance = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', staleGate, '--artifacts', baseArtifacts, '--reconciliation-artifacts', staleSidecar, '--previous-activation', genesis, '--evidence', staleEvidence, '--source-manifest', expected, '--out', join(root, 'stale-activation.json'))
    expect(staleAdvance.status).not.toBe(0)
    expect(staleAdvance.stderr).toMatch(/reconciliation gate is stale or future-dated/i)

    for (const name of ['d1-import.sql', 'do-initialize.ndjson', 'r2-copy-plan.ndjson', 'd1-dependencies.json', 'ownership-assignments.ndjson']) {
      const path = join(output, name)
      const original = await readFile(path)
      await writeFile(path, Buffer.concat([original, Buffer.from('\n')]))
      const tampered = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', internalEvidence, '--source-manifest', expected, '--out', join(root, `tampered-${name.replaceAll('.', '-')}.json`))
      expect(tampered.status, `${name}: ${tampered.stderr}`).not.toBe(0)
      expect(tampered.stderr).toMatch(new RegExp(`${name.replaceAll('.', '\\.')} does not match artifact manifest`, 'i'))
      await writeFile(path, original)
    }

    await writeFile(join(root, 'source/r2-source/exports/usage/fixture.ndjson.gz'), 'changed-after-build\n', 'utf8')
    const changedSource = run('advance', '--plan', join(output, 'ownership-plan.json'), '--stage', 'internal', '--gate', passedReport, '--artifacts', baseArtifacts, '--reconciliation-artifacts', reconciliationArtifacts, '--previous-activation', genesis, '--evidence', internalEvidence, '--source-manifest', expected, '--out', join(root, 'changed-source.json'))
    expect(changedSource.status).not.toBe(0)
    expect(changedSource.stderr).toMatch(/R2 object .* byte count mismatch|R2 object .* SHA-256 mismatch/i)
  })

  it('uses full streaming digests so a non-sampled row cannot be changed', async () => {
    const root = await temporaryDirectory()
    const expected = await createManifest(root)
    await addExtraKeys(expected, 40)
    const output = join(root, 'output')
    expect(run('build', '--manifest', expected, '--out', output).status).toBe(0)

    const actualRoot = join(root, 'actual')
    await mkdir(actualRoot)
    const actual = await createManifest(actualRoot)
    await addExtraKeys(actual, 40)
    const baseline = JSON.parse(await readFile(join(output, 'reconciliation.json'), 'utf8'))
    const sampled = new Set<string>(baseline.domains.keys.sampled_ids)
    const keyPath = join(actualRoot, 'source/keys.ndjson')
    const rows = (await readFile(keyPath, 'utf8')).trimEnd().split('\n').map(JSON.parse)
    const nonSampled = rows.find((row: { id: string; name: string }) => !sampled.has(row.id))
    expect(nonSampled).toBeDefined()
    nonSampled.name = 'Tampered outside deterministic sample'
    await writeFile(keyPath, `${rows.map(JSON.stringify).join('\n')}\n`, 'utf8')
    await refreshDomainDescriptor(actual, 'keys')

    const report = join(root, 'full-digest-reconciliation.json')
    const artifactManifest = join(output, 'artifact-manifest.json')
    const genesis = join(output, 'ownership-genesis.json')
    const proofs = await createPreReconciliationProofs(root, { stage: 'internal', expectedManifest: expected, actualManifest: actual, artifacts: artifactManifest, previousActivation: genesis })
    const result = run('reconcile', '--expected', expected, '--actual', actual, '--artifacts', artifactManifest, '--previous-activation', genesis, '--freeze-proof', proofs.freezePath, '--final-delta-proof', proofs.deltaPath, '--stage', 'internal', '--out', report)
    expect(result.status).toBe(2)
    expect(JSON.parse(await readFile(report, 'utf8')).domains.keys).toMatchObject({ matches: false })
  })

  it('allows supported providers through composite groups but rejects ordinary cross-platform routing', async () => {
    const compositeRoot = await temporaryDirectory()
    const compositeManifest = await createManifest(compositeRoot)
    const compositeDependenciesPath = join(compositeRoot, 'source/dependencies.json')
    const compositeDependencies = JSON.parse(await readFile(compositeDependenciesPath, 'utf8'))
    compositeDependencies.groups[0].platform = 'composite'
    await writeFile(compositeDependenciesPath, JSON.stringify(compositeDependencies), 'utf8')
    const compositeManifestBody = JSON.parse(await readFile(compositeManifest, 'utf8'))
    const compositeBytes = await readFile(compositeDependenciesPath)
    compositeManifestBody.dependency_manifest.bytes = compositeBytes.length
    compositeManifestBody.dependency_manifest.sha256 = createHash('sha256').update(compositeBytes).digest('hex')
    await writeFile(compositeManifest, JSON.stringify(compositeManifestBody), 'utf8')
    expect(run('build', '--manifest', compositeManifest, '--out', join(compositeRoot, 'output')).status).toBe(0)

    const ordinaryRoot = await temporaryDirectory()
    const ordinaryManifest = await createManifest(ordinaryRoot)
    const ordinaryDependenciesPath = join(ordinaryRoot, 'source/dependencies.json')
    const ordinaryDependencies = JSON.parse(await readFile(ordinaryDependenciesPath, 'utf8'))
    ordinaryDependencies.groups[0].platform = 'anthropic'
    await writeFile(ordinaryDependenciesPath, JSON.stringify(ordinaryDependencies), 'utf8')
    const ordinaryManifestBody = JSON.parse(await readFile(ordinaryManifest, 'utf8'))
    const ordinaryBytes = await readFile(ordinaryDependenciesPath)
    ordinaryManifestBody.dependency_manifest.bytes = ordinaryBytes.length
    ordinaryManifestBody.dependency_manifest.sha256 = createHash('sha256').update(ordinaryBytes).digest('hex')
    await writeFile(ordinaryManifest, JSON.stringify(ordinaryManifestBody), 'utf8')
    const ordinary = run('build', '--manifest', ordinaryManifest, '--out', join(ordinaryRoot, 'output'))
    expect(ordinary.status).not.toBe(0)
    expect(ordinary.stderr).toMatch(/platform mismatch|no routable model relation/i)
  })
})

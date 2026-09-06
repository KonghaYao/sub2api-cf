#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIGRATION_FILENAME = /^(\d{4})_([a-z][a-z0-9_]*)\.sql$/
const SCHEMA_MIGRATION_INSERT = /INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*,\s*name\s*,\s*applied_at_ms\s*\)\s*VALUES\s*\(\s*(\d+)\s*,\s*'([a-z][a-z0-9_]*)'/gi
const CREATE_D1_MIGRATIONS = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`
const WRANGLER_CLI = fileURLToPath(import.meta.resolve('wrangler'))

/**
 * Discover and validate the version/name metadata embedded in migration files.
 *
 * @param {string} directory
 */
export async function discoverMigrations(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  const invalidEntry = sqlEntries.find((entry) => !MIGRATION_FILENAME.test(entry.name))
  if (invalidEntry) {
    throw new Error(`Invalid migration filename: ${invalidEntry.name}`)
  }
  const filenames = sqlEntries
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  const migrations = await Promise.all(filenames.map(async (filename) => {
    const filenameMatch = MIGRATION_FILENAME.exec(filename)
    if (!filenameMatch) {
      throw new Error(`Invalid migration filename: ${filename}`)
    }

    const sql = await readFile(join(directory, filename), 'utf8')
    const metadataMatches = [...sql.matchAll(SCHEMA_MIGRATION_INSERT)]
    if (metadataMatches.length !== 1) {
      throw new Error(`${filename} must record exactly one schema_migrations row`)
    }

    const version = Number(filenameMatch[1])
    const name = filenameMatch[2]
    const metadataVersion = Number(metadataMatches[0][1])
    const metadataName = metadataMatches[0][2]
    if (metadataVersion !== version || metadataName !== name) {
      throw new Error(
        `${filename} records schema migration ${metadataVersion}:${metadataName}; expected ${version}:${name}`,
      )
    }

    return Object.freeze({
      version,
      name,
      filename,
      path: join(directory, filename),
    })
  }))

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1]
    const current = migrations[index]
    if (previous.version === current.version) {
      throw new Error(
        `Duplicate migration version ${current.version}: ${previous.filename} and ${current.filename}`,
      )
    }
  }
  return migrations
}

/**
 * @param {string[]} arguments_
 * @param {string} cwd
 */
export function parseCliArguments(arguments_, cwd) {
  let database = 'DB'
  let environment
  let migrationsDirectory = resolve(cwd, 'migrations')
  let persistTo
  let remote

  const readValue = (index, flag) => {
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    return value
  }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--remote' || argument === '--local') {
      const requestedRemote = argument === '--remote'
      if (remote !== undefined) {
        throw new Error('Choose exactly one D1 target: --remote or --local')
      }
      remote = requestedRemote
      continue
    }
    if (argument === '--database') {
      database = readValue(index, argument)
      index += 1
      continue
    }
    if (argument === '--env') {
      environment = readValue(index, argument)
      index += 1
      continue
    }
    if (argument === '--migrations-dir') {
      migrationsDirectory = resolve(cwd, readValue(index, argument))
      index += 1
      continue
    }
    if (argument === '--persist-to') {
      persistTo = resolve(cwd, readValue(index, argument))
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }

  if (remote === undefined) {
    throw new Error('Choose exactly one D1 target: --remote or --local')
  }
  if (remote && persistTo) {
    throw new Error('--persist-to is available only with --local')
  }
  return {
    database,
    ...(environment ? { environment } : {}),
    migrationsDirectory,
    ...(persistTo ? { persistTo } : {}),
    remote,
  }
}

/** @param {string} value */
function quoteSqlText(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * @param {string} stdout
 * @param {string} operation
 */
function parseWranglerRows(stdout, operation) {
  let response
  try {
    response = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Wrangler returned invalid JSON while ${operation}`, { cause: error })
  }
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true) {
    throw new Error(`Wrangler reported failure while ${operation}`)
  }
  if (!Array.isArray(response[0].results)) {
    throw new Error(`Wrangler returned no result rows while ${operation}`)
  }
  return response[0].results
}

/**
 * Apply D1 migrations one file at a time, reconciling both the project and
 * Wrangler migration ledgers before and after every mutation.
 *
 * @param {{
 *   database: string,
 *   environment?: string,
 *   migrationsDirectory: string,
 *   persistTo?: string,
 *   remote: boolean,
 *   executeWrangler: (args: string[]) => Promise<string>,
 * }} options
 */
export async function runD1Migrations(options) {
  const migrations = await discoverMigrations(options.migrationsDirectory)
  const targetArgs = [options.remote ? '--remote' : '--local']
  if (options.persistTo) {
    if (options.remote) throw new Error('--persist-to is available only for local D1 targets')
    targetArgs.push('--persist-to', options.persistTo)
  }
  if (options.environment) {
    targetArgs.push('--env', options.environment)
  }

  const executeCommand = async (sql, operation) => {
    const stdout = await options.executeWrangler([
      'd1', 'execute', options.database,
      ...targetArgs,
      '--command', sql,
      '-y', '--json',
    ])
    return parseWranglerRows(stdout, operation)
  }

  await executeCommand(CREATE_D1_MIGRATIONS, 'initializing the Wrangler migration ledger')
  const d1Rows = await executeCommand(
    'SELECT name FROM d1_migrations ORDER BY id;',
    'reading the Wrangler migration ledger',
  )
  const schemaTableRows = await executeCommand(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations';",
    'checking the project migration ledger',
  )
  const schemaRows = schemaTableRows.length === 0
    ? []
    : await executeCommand(
        'SELECT version, name FROM schema_migrations ORDER BY version;',
        'reading the project migration ledger',
      )

  const localFilenames = new Set(migrations.map((migration) => migration.filename))
  const localSchemaNames = new Map(
    migrations.map((migration) => [migration.version, migration.name]),
  )
  for (const row of d1Rows) {
    if (typeof row.name !== 'string' || !localFilenames.has(row.name)) {
      throw new Error(`Wrangler migration ledger contains unknown migration ${String(row.name)}`)
    }
  }
  for (const row of schemaRows) {
    if (
      !Number.isSafeInteger(row.version)
      || typeof row.name !== 'string'
      || localSchemaNames.get(row.version) !== row.name
    ) {
      throw new Error(
        `Project migration ledger contains unknown migration ${String(row.version)}:${String(row.name)}`,
      )
    }
  }
  for (let index = 0; index < d1Rows.length; index += 1) {
    const expected = migrations[index]
    if (d1Rows[index].name !== expected?.filename) {
      throw new Error(
        'Wrangler migration ledger is not a continuous prefix: '
          + `found ${String(d1Rows[index].name)}, expected ${expected?.filename ?? 'no row'}`,
      )
    }
  }
  for (let index = 0; index < schemaRows.length; index += 1) {
    const expected = migrations[index]
    const row = schemaRows[index]
    if (row.version !== expected?.version || row.name !== expected?.name) {
      throw new Error(
        'Project migration ledger is not a continuous prefix: '
          + `found ${String(row.version)}:${String(row.name)}, `
          + `expected ${expected ? `${expected.version}:${expected.name}` : 'no row'}`,
      )
    }
  }

  const d1Names = new Set(d1Rows.map((row) => row.name))
  const schemaByVersion = new Map(schemaRows.map((row) => [row.version, row.name]))
  for (const migration of migrations) {
    if (
      d1Names.has(migration.filename)
      && schemaByVersion.get(migration.version) !== migration.name
    ) {
      throw new Error(
        `Wrangler marks ${migration.filename} applied but the project migration ledger does not`,
      )
    }
  }
  const result = { applied: [], recovered: [], skipped: [] }

  const verifySchema = async (migration) => {
    const rows = await executeCommand(
      `SELECT version, name FROM schema_migrations WHERE version = ${migration.version};`,
      `verifying ${migration.filename} in the project migration ledger`,
    )
    if (rows.length !== 1 || rows[0].version !== migration.version || rows[0].name !== migration.name) {
      throw new Error(
        `Migration ${migration.filename} did not record the expected schema_migrations row`,
      )
    }
    schemaByVersion.set(migration.version, migration.name)
  }

  const registerWithWrangler = async (migration) => {
    const quotedFilename = quoteSqlText(migration.filename)
    const quotedName = quoteSqlText(migration.name)
    await executeCommand(
      `INSERT INTO d1_migrations (name)
SELECT ${quotedFilename}
WHERE EXISTS (
  SELECT 1 FROM schema_migrations
  WHERE version = ${migration.version} AND name = ${quotedName}
)
ON CONFLICT(name) DO NOTHING;`,
      `registering ${migration.filename} with Wrangler`,
    )
    const rows = await executeCommand(
      `SELECT name FROM d1_migrations WHERE name = ${quotedFilename};`,
      `verifying ${migration.filename} in the Wrangler migration ledger`,
    )
    if (rows.length !== 1 || rows[0].name !== migration.filename) {
      throw new Error(`Wrangler migration registration failed for ${migration.filename}`)
    }
    d1Names.add(migration.filename)
  }

  for (const migration of migrations) {
    const d1Applied = d1Names.has(migration.filename)
    const schemaName = schemaByVersion.get(migration.version)
    if (schemaName !== undefined && schemaName !== migration.name) {
      throw new Error(
        `Project migration ledger conflict at version ${migration.version}: found ${schemaName}, expected ${migration.name}`,
      )
    }
    if (d1Applied && schemaName !== migration.name) {
      throw new Error(
        `Wrangler marks ${migration.filename} applied but the project migration ledger does not`,
      )
    }
    if (d1Applied) {
      result.skipped.push(migration.filename)
      continue
    }
    if (schemaName === migration.name) {
      await registerWithWrangler(migration)
      result.recovered.push(migration.filename)
      continue
    }

    await options.executeWrangler([
      'd1', 'execute', options.database,
      ...targetArgs,
      '--file', migration.path,
      '-y', '--json',
    ])
    await verifySchema(migration)
    await registerWithWrangler(migration)
    result.applied.push(migration.filename)
  }

  return result
}

/** @param {string[]} args */
function executeWrangler(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WRANGLER_CLI, ...args], {
      env: { ...process.env, EMSDK_QUIET: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout)
        return
      }
      const detail = stderr.trim() || stdout.trim() || `signal ${String(signal)}`
      reject(new Error(`Wrangler exited with code ${String(code)}: ${detail}`))
    })
  })
}

async function main() {
  try {
    const cli = parseCliArguments(process.argv.slice(2), process.cwd())
    const target = cli.environment ? `${cli.database}/${cli.environment}` : cli.database
    console.log(`Reconciling D1 migrations for ${target}...`)
    const result = await runD1Migrations({ ...cli, executeWrangler })
    console.log(
      `D1 migrations reconciled: ${result.applied.length} applied, `
        + `${result.recovered.length} recovered, ${result.skipped.length} already current.`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`D1 migration failed: ${message}`)
    process.exitCode = 1
  }
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  await main()
}

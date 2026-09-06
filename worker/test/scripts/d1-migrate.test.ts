import { describe, expect, it } from 'vitest'

import {
  discoverMigrations,
  parseCliArguments,
  runD1Migrations,
} from '../../scripts/d1-migrate.mjs'

const fixtureDirectory = decodeURIComponent(new URL('./fixtures/migrations', import.meta.url).pathname)
const singleMigrationDirectory = decodeURIComponent(
  new URL('./fixtures/single-migration', import.meta.url).pathname,
)
const productionMigrationDirectory = decodeURIComponent(
  new URL('../../migrations', import.meta.url).pathname,
)
const duplicateVersionDirectory = decodeURIComponent(
  new URL('./fixtures/duplicate-version', import.meta.url).pathname,
)
const invalidFilenameDirectory = decodeURIComponent(
  new URL('./fixtures/invalid-filename', import.meta.url).pathname,
)

function wranglerJson(results: unknown[]): string {
  return JSON.stringify([{ success: true, results }])
}

function createStatefulWrangler(
  migrations: Awaited<ReturnType<typeof discoverMigrations>>,
  wranglerCheckpoint: number,
  schemaCheckpoint = wranglerCheckpoint,
) {
  const d1Names = new Set(
    migrations.slice(0, wranglerCheckpoint).map((migration) => migration.filename),
  )
  const schemaRows = new Map(
    migrations.slice(0, schemaCheckpoint).map((migration) => [migration.version, migration.name]),
  )
  const fileCalls: string[] = []
  const registrationCalls: string[] = []

  return {
    fileCalls,
    registrationCalls,
    executeWrangler: async (args: string[]) => {
      const fileIndex = args.indexOf('--file')
      if (fileIndex >= 0) {
        const filename = args[fileIndex + 1]?.split('/').at(-1)
        const migration = migrations.find((candidate) => candidate.filename === filename)
        if (!migration) throw new Error(`Unknown migration file ${String(filename)}`)
        fileCalls.push(migration.filename)
        schemaRows.set(migration.version, migration.name)
        return wranglerJson([])
      }

      const command = args[args.indexOf('--command') + 1] ?? ''
      if (command.startsWith('CREATE TABLE IF NOT EXISTS d1_migrations')) {
        return wranglerJson([])
      }
      if (command === 'SELECT name FROM d1_migrations ORDER BY id;') {
        return wranglerJson([...d1Names].map((name) => ({ name })))
      }
      if (command.startsWith('SELECT name FROM sqlite_master')) {
        return wranglerJson(schemaRows.size === 0 ? [] : [{ name: 'schema_migrations' }])
      }
      if (command === 'SELECT version, name FROM schema_migrations ORDER BY version;') {
        return wranglerJson(
          [...schemaRows].map(([version, name]) => ({ version, name })),
        )
      }
      if (command.startsWith('SELECT version, name FROM schema_migrations WHERE version =')) {
        const version = Number(command.match(/version = (\d+)/)?.[1])
        const name = schemaRows.get(version)
        return wranglerJson(name === undefined ? [] : [{ version, name }])
      }
      if (command.startsWith('INSERT INTO d1_migrations')) {
        const filename = command.match(/SELECT '([^']+)'/)?.[1]
        if (!filename) throw new Error('Registration command omitted the migration filename')
        registrationCalls.push(filename)
        d1Names.add(filename)
        return wranglerJson([])
      }
      if (command.startsWith('SELECT name FROM d1_migrations WHERE name =')) {
        const filename = command.match(/name = '([^']+)'/)?.[1]
        return wranglerJson(filename && d1Names.has(filename) ? [{ name: filename }] : [])
      }
      throw new Error(`Unexpected Wrangler command: ${command}`)
    },
  }
}

describe('recoverable D1 migration runner', () => {
  it('discovers migrations in numeric order instead of filesystem order', async () => {
    const migrations = await discoverMigrations(fixtureDirectory)

    expect(migrations.map(({ version, name, filename }) => ({ version, name, filename }))).toEqual([
      { version: 1, name: 'first', filename: '0001_first.sql' },
      { version: 2, name: 'second', filename: '0002_second.sql' },
      { version: 10, name: 'tenth', filename: '0010_tenth.sql' },
    ])
  })

  it('rejects duplicate local versions before making a D1 call', async () => {
    await expect(discoverMigrations(duplicateVersionDirectory)).rejects.toThrow(
      'Duplicate migration version 1: 0001_first.sql and 0001_other.sql',
    )
  })

  it('rejects an SQL file that cannot participate in the ordered ledger', async () => {
    await expect(discoverMigrations(invalidFilenameDirectory)).rejects.toThrow(
      'Invalid migration filename: latest.sql',
    )
  })

  it('applies an empty database through file ingestion, verification, and registration', async () => {
    const responses = [
      wranglerJson([]),
      wranglerJson([]),
      wranglerJson([]),
      wranglerJson([]),
      wranglerJson([{ version: 1, name: 'initial' }]),
      wranglerJson([]),
      wranglerJson([{ name: '0001_initial.sql' }]),
    ]
    const calls: string[][] = []

    const result = await runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: singleMigrationDirectory,
      remote: true,
      executeWrangler: async (args) => {
        calls.push(args)
        const response = responses.shift()
        if (response === undefined) {
          throw new Error(`Unexpected Wrangler call: ${args.join(' ')}`)
        }
        return response
      },
    })

    expect(result).toEqual({
      applied: ['0001_initial.sql'],
      recovered: [],
      skipped: [],
    })
    expect(responses).toHaveLength(0)

    const fileCallIndex = calls.findIndex((args) => args.includes('--file'))
    const schemaVerificationIndex = calls.findIndex((args) =>
      args[args.indexOf('--command') + 1]?.includes('WHERE version = 1'),
    )
    const registrationIndex = calls.findIndex((args) =>
      args[args.indexOf('--command') + 1]?.includes('INSERT INTO d1_migrations'),
    )
    expect(fileCallIndex).toBeGreaterThan(0)
    expect(calls[fileCallIndex]).toEqual([
      'd1',
      'execute',
      'DB',
      '--remote',
      '--env',
      'production',
      '--file',
      decodeURIComponent(
        new URL('./fixtures/single-migration/0001_initial.sql', import.meta.url).pathname,
      ),
      '-y',
      '--json',
    ])
    expect(schemaVerificationIndex).toBeGreaterThan(fileCallIndex)
    expect(registrationIndex).toBeGreaterThan(schemaVerificationIndex)
  })

  it('fails closed when Wrangler records a migration absent from the local release', async () => {
    const responses = [
      wranglerJson([]),
      wranglerJson([{ name: '0001_different.sql' }]),
      wranglerJson([]),
    ]
    const calls: string[][] = []

    await expect(runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: singleMigrationDirectory,
      remote: true,
      executeWrangler: async (args) => {
        calls.push(args)
        return responses.shift() ?? wranglerJson([])
      },
    })).rejects.toThrow(
      'Wrangler migration ledger contains unknown migration 0001_different.sql',
    )
    expect(calls.some((args) => args.includes('--file'))).toBe(false)
  })

  it('fails closed when the project ledger records a version absent from the local release', async () => {
    const responses = [
      wranglerJson([]),
      wranglerJson([]),
      wranglerJson([{ name: 'schema_migrations' }]),
      wranglerJson([{ version: 99, name: 'future_release' }]),
    ]
    const calls: string[][] = []

    await expect(runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: singleMigrationDirectory,
      remote: true,
      executeWrangler: async (args) => {
        calls.push(args)
        return responses.shift() ?? wranglerJson([])
      },
    })).rejects.toThrow(
      'Project migration ledger contains unknown migration 99:future_release',
    )
    expect(calls.some((args) => args.includes('--file'))).toBe(false)
  })

  it('rejects a Wrangler ledger gap before repairing an earlier registration', async () => {
    const responses = [
      wranglerJson([]),
      wranglerJson([
        { name: '0001_first.sql' },
        { name: '0010_tenth.sql' },
      ]),
      wranglerJson([{ name: 'schema_migrations' }]),
      wranglerJson([
        { version: 1, name: 'first' },
        { version: 2, name: 'second' },
        { version: 10, name: 'tenth' },
      ]),
    ]
    const calls: string[][] = []

    await expect(runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: fixtureDirectory,
      remote: true,
      executeWrangler: async (args) => {
        calls.push(args)
        return responses.shift() ?? wranglerJson([])
      },
    })).rejects.toThrow(
      'Wrangler migration ledger is not a continuous prefix: found 0010_tenth.sql, expected 0002_second.sql',
    )
    expect(calls.some((args) =>
      args[args.indexOf('--command') + 1]?.startsWith('INSERT INTO d1_migrations'),
    )).toBe(false)
    expect(calls.some((args) => args.includes('--file'))).toBe(false)
  })

  it('rejects a project ledger gap before applying an older missing migration', async () => {
    const responses = [
      wranglerJson([]),
      wranglerJson([{ name: '0001_first.sql' }]),
      wranglerJson([{ name: 'schema_migrations' }]),
      wranglerJson([
        { version: 1, name: 'first' },
        { version: 10, name: 'tenth' },
      ]),
    ]
    const calls: string[][] = []

    await expect(runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: fixtureDirectory,
      remote: true,
      executeWrangler: async (args) => {
        calls.push(args)
        return responses.shift() ?? wranglerJson([])
      },
    })).rejects.toThrow(
      'Project migration ledger is not a continuous prefix: found 10:tenth, expected 2:second',
    )
    expect(calls.some((args) => args.includes('--file'))).toBe(false)
  })

  it.each([31, 34, 53])(
    'resumes from migration %i and is idempotent on the next run',
    async (checkpoint) => {
      const migrations = await discoverMigrations(productionMigrationDirectory)
      const wrangler = createStatefulWrangler(migrations, checkpoint)

      const first = await runD1Migrations({
        database: 'DB',
        environment: 'production',
        migrationsDirectory: productionMigrationDirectory,
        remote: true,
        executeWrangler: wrangler.executeWrangler,
      })

      expect(first.skipped).toEqual(
        migrations.slice(0, checkpoint).map((migration) => migration.filename),
      )
      expect(first.applied).toEqual(
        migrations.slice(checkpoint).map((migration) => migration.filename),
      )
      expect(first.recovered).toEqual([])

      const second = await runD1Migrations({
        database: 'DB',
        environment: 'production',
        migrationsDirectory: productionMigrationDirectory,
        remote: true,
        executeWrangler: wrangler.executeWrangler,
      })

      expect(second).toEqual({
        applied: [],
        recovered: [],
        skipped: migrations.map((migration) => migration.filename),
      })
      expect(wrangler.fileCalls).toEqual(
        migrations.slice(checkpoint).map((migration) => migration.filename),
      )
    },
  )

  it('recovers a migration whose SQL committed before Wrangler registration', async () => {
    const migrations = await discoverMigrations(productionMigrationDirectory)
    const wrangler = createStatefulWrangler(migrations, 31, 32)

    const result = await runD1Migrations({
      database: 'DB',
      environment: 'production',
      migrationsDirectory: productionMigrationDirectory,
      remote: true,
      executeWrangler: wrangler.executeWrangler,
    })

    expect(result.recovered).toEqual(['0032_promotions_affiliate.sql'])
    expect(result.applied[0]).toBe('0033_payment_reconciliation.sql')
    expect(wrangler.fileCalls).not.toContain('0032_promotions_affiliate.sql')
    expect(wrangler.registrationCalls[0]).toBe('0032_promotions_affiliate.sql')
  })

  it('parses an explicit isolated local CLI target without shell interpretation', () => {
    expect(parseCliArguments([
      '--local',
      '--database', 'DB',
      '--migrations-dir', 'migrations',
      '--persist-to', '.d1-state',
    ], '/srv/worker')).toEqual({
      database: 'DB',
      migrationsDirectory: '/srv/worker/migrations',
      persistTo: '/srv/worker/.d1-state',
      remote: false,
    })

    expect(() => parseCliArguments(['--env', 'production'], '/srv/worker')).toThrow(
      'Choose exactly one D1 target: --remote or --local',
    )
  })
})

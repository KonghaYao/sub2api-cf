// Node's SQLite binding is used only by Node-hosted integration tests. Production Worker code remains Web-API-only.
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { readFileSync, readdirSync } from 'node:fs'
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { DatabaseSync } from 'node:sqlite'

class SqliteD1Statement {
  private values: unknown[] = []

  constructor(
    readonly sql: string,
    private readonly database: any,
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.sql).all(...this.values) as T[]
    return d1Result(results, 0)
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.database.prepare(this.sql).run(...this.values) as { changes?: number }
    return d1Result([], result.changes ?? 0)
  }
}

class SqliteD1Database {
  private batchTail: Promise<void> = Promise.resolve()

  constructor(private readonly database: any) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(sql, this.database)
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result<unknown>[]> {
    const execute = async (): Promise<D1Result<unknown>[]> => {
      const results: D1Result<unknown>[] = []
      this.database.exec('BEGIN')
      try {
        for (const statement of statements) {
          results.push(await statement.all())
        }
        this.database.exec('COMMIT')
        return results
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
    const current = this.batchTail.then(execute, execute)
    this.batchTail = current.then(() => undefined, () => undefined)
    return current
  }
}

export function createSqliteD1(): { raw: any; d1: D1Database } {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON')
  return { raw, d1: new SqliteD1Database(raw) as unknown as D1Database }
}

export function applyMigrations(database: any, through = Number.POSITIVE_INFINITY): void {
  let applied = 0
  try {
    const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number | null
    }
    applied = row.version ?? 0
  } catch {
    // A fresh database does not have schema_migrations until 0001 is applied.
  }
  const directory = new URL('../../migrations/', import.meta.url)
  const files = readdirSync(directory)
    .filter((name: string) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name: string) => {
      const version = Number(name.slice(0, 4))
      return version > applied && version <= through
    })
    .sort()
  for (const file of files) {
    database.exec(readFileSync(new URL(file, directory), 'utf8'))
  }
}

function d1Result<T>(results: T[], changes: number): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes } as D1Meta & Record<string, unknown>,
  }
}

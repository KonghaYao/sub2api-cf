export interface D1Migration {
  readonly version: number
  readonly name: string
  readonly filename: string
  readonly path: string
}

export function discoverMigrations(directory: string): Promise<D1Migration[]>

export interface RunD1MigrationsOptions {
  readonly database: string
  readonly environment?: string
  readonly migrationsDirectory: string
  readonly persistTo?: string
  readonly remote: boolean
  readonly executeWrangler: (args: string[]) => Promise<string>
}

export interface D1MigrationRunResult {
  readonly applied: string[]
  readonly recovered: string[]
  readonly skipped: string[]
}

export function runD1Migrations(
  options: RunD1MigrationsOptions,
): Promise<D1MigrationRunResult>

export interface D1MigrationCliOptions {
  readonly database: string
  readonly environment?: string
  readonly migrationsDirectory: string
  readonly persistTo?: string
  readonly remote: boolean
}

export function parseCliArguments(
  arguments_: string[],
  cwd: string,
): D1MigrationCliOptions

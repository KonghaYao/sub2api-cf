import { sha256Hex } from '../gateway/crypto'

export interface CodexImportIdentity {
  accountId?: string; userId?: string; email?: string; accessToken?: string; refreshToken?: string
}
const trimmed = (value: string | undefined) => value?.trim() ?? ''

/** Original account_codex_import.go: access-only sessions match token fingerprints,
 * not team/user identifiers shared by independently issued sessions. */
export async function codexImportIdentityKeys(identity: CodexImportIdentity): Promise<string[]> {
  const token = trimmed(identity.accessToken)
  if (!trimmed(identity.refreshToken) && token) return [`access:${await sha256Hex(token)}`]
  return codexStoredIdentityKeys(identity)
}
export async function codexStoredIdentityKeys(identity: CodexImportIdentity): Promise<string[]> {
  const account = trimmed(identity.accountId), user = trimmed(identity.userId), token = trimmed(identity.accessToken)
  const keys: string[] = []
  if (user) keys.push(`user:${user}`)
  if (!account && !user && trimmed(identity.email)) keys.push(`email:${trimmed(identity.email).toLowerCase()}`)
  if (token) keys.push(`access:${await sha256Hex(token)}`)
  if (account) keys.push(`account:${account}`)
  return keys
}
export function codexAgentIdentityKeys(accountId: string): string[] {
  return accountId.trim() ? [`account:${accountId.trim()}`] : []
}
export function codexIdentityConflicts(key: string, userId: string, storedUserId: string): boolean {
  return key.startsWith('account:') && !!userId.trim() && !!storedUserId.trim() && userId.trim() !== storedUserId.trim()
}

/** Preserve the existing refresh token/client ID on access-only imports; an
 * absent new ID token must not retain old identity claims. */
export function mergeCodexImportCredentials(existing: Record<string,unknown>, incoming: Record<string,unknown>,
  imported: { refreshToken?: string; idToken?: string }): Record<string,unknown> {
  const next = { ...existing,...incoming }
  if (!trimmed(imported.refreshToken)) {
    if (typeof existing.refresh_token !== 'string' || !existing.refresh_token.trim()) {
      delete next.refresh_token; delete next.client_id
    } else {
      next.refresh_token = existing.refresh_token
      if (Object.hasOwn(existing,'client_id')) next.client_id = existing.client_id
    }
  }
  if (!trimmed(imported.idToken)) delete next.id_token
  return next
}

/** Replacing an indexed account removes obsolete token fingerprints. */
export class CodexImportAccountIndex<T extends { id: string; identity: CodexImportIdentity; agentRuntimeId?: string }> {
  private readonly byKey = new Map<string,T[]>()
  private readonly keysByAccount = new Map<string,Set<string>>()
  async add(account: T) {
    const keys = new Set(await codexStoredIdentityKeys(account.identity))
    if (trimmed(account.agentRuntimeId)) keys.add(`agent:${trimmed(account.agentRuntimeId)}`)
    const previous = this.keysByAccount.get(account.id) ?? new Set<string>()
    for (const key of previous) {
      const rows = this.byKey.get(key) ?? []
      this.byKey.set(key, keys.has(key) ? rows.map(row => row.id === account.id ? account : row) : rows.filter(row => row.id !== account.id))
    }
    for (const key of keys) if (!previous.has(key)) this.byKey.set(key,[...(this.byKey.get(key) ?? []),account])
    this.keysByAccount.set(account.id,keys)
  }
  find(keys: string[], userId: string): { account: T; key: string } | null {
    for (const key of keys) for (const account of this.byKey.get(key) ?? []) {
      if (!codexIdentityConflicts(key,userId,trimmed(account.identity.userId))) return { account,key }
    }
    return null
  }
}

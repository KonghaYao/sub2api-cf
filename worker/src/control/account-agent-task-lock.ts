import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
const databaseNow="CAST(unixepoch('subsec')*1000 AS INTEGER)"
/** Caller must re-read credentials under this lease before deciding to register. */
export async function claimAgentTaskRegistration(env:Env,accountId:string):Promise<string|null> {
  const token=crypto.randomUUID()
  const claimed=await env.DB.prepare(`INSERT INTO account_agent_task_registration(account_id,lease_token,lease_until_ms)
    SELECT id,?,${databaseNow}+60000 FROM accounts WHERE id=?
    ON CONFLICT(account_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until_ms=excluded.lease_until_ms
    WHERE account_agent_task_registration.lease_until_ms<=${databaseNow} RETURNING account_id`)
    .bind(token,accountId).first()
  if(claimed) return token
  if(!await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(accountId).first()) throw new GatewayError(404,'account_not_found','Account not found')
  return null
}
/** Include in the same D1 batch as vault/account writes. A missing lock must
 * fail as well, rather than silently executing a zero-row UPDATE guard. */
export function agentTaskRegistrationGuard(env:Env,accountId:string,token:string):D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO account_agent_task_registration(account_id,lease_token,lease_until_ms)
    VALUES (?,?,COALESCE((SELECT lease_until_ms FROM account_agent_task_registration
      WHERE account_id=? AND lease_token=? AND lease_until_ms>${databaseNow}),-1))
    ON CONFLICT(account_id) DO UPDATE SET lease_until_ms=excluded.lease_until_ms`)
    .bind(accountId,token,accountId,token)
}
export async function releaseAgentTaskRegistration(env:Env,accountId:string,token:string):Promise<void> {
  await env.DB.prepare('UPDATE account_agent_task_registration SET lease_token=NULL,lease_until_ms=0 WHERE account_id=? AND lease_token=?')
    .bind(accountId,token).run()
}

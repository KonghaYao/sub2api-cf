import { readUpstreamBillingConfig as loadSettings, saveUpstreamBillingConfig, parseUpstreamBillingConfig as settings } from './upstream-billing-config'
import { parseUpstreamBillingDeclaration, upstreamBillingSyncRate } from './upstream-billing-contract'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { accountProxyId } from '../proxy/account-fetch'
import type { Context } from 'hono'
import type { Env } from '../env'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess, readJsonObject } from './http'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { decryptCredential, sha256Hex } from '../gateway/crypto'
import { listAdminAccounts } from './accounts'
import { credentialAad, validateBaseUrl } from '../gateway/repository'

type Bindings = { Bindings: Env }
interface Settings { enabled: boolean; interval_minutes: number }
export interface BillingSnapshot {
  identity?: { credential_ref: string; base_url: string; platform: string }
  status: 'ok' | 'unsupported' | 'failed'
  data?: Record<string, unknown>
  received_at?: string
  fresh_until?: string
  last_attempt_at: string
  next_probe_at: string
  failure_count?: number
  http_status: number
  last_error?: string
  synced_rate_multiplier?: number
}
interface Account {
  proxy_version: number | null; id: string; platform: string; credential_kind: string; enabled: number
  base_url: string; credential_ref: string; config_version: number; control_version: number
  ui_config_json: string; billing_rate_multiplier_ppm: number
  secret_id: string; key_version: number; nonce_b64: string; ciphertext_b64: string
}
interface Result { account_id: string; snapshot?: BillingSnapshot; error?: string; pending?: true }
const DAY = 86400000
const OFFICIAL = ['openai.com','anthropic.com','googleapis.com','x.ai','deepseek.com','moonshot.cn','moonshot.ai','bigmodel.cn']

function extra(account: Account): Record<string, unknown> {
  const ui = JSON.parse(account.ui_config_json)
  return ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra : {}
}
function eligible(account: Account): boolean {
  return account.credential_kind === 'api_key' && ['openai','anthropic','gemini','codex','grok'].includes(account.platform)
}

export async function getUpstreamBillingProbeSettings(c: Context<Bindings>): Promise<Response> {
  try { await authenticateAdminSession(c.req.raw,c.env); return controlSuccess(await loadSettings(c.env)) }
  catch (error) { return controlError(asGatewayError(error)) }
}
export async function putUpstreamBillingProbeSettings(c: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(c.req.raw,c.env)
    return controlSuccess(await saveUpstreamBillingConfig(c.env, await readJsonObject(c.req.raw), actor.user_id))
  } catch (error) { return controlError(asGatewayError(error)) }
}
export async function setUpstreamBillingProbeEnabled(c: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(c.req.raw,c.env)
    const body = await readJsonObject(c.req.raw)
    if (Object.keys(body).some(k=>k!=='enabled') || typeof body.enabled!=='boolean') throw new GatewayError(400,'invalid_enabled','enabled must be boolean')
    const result = await c.env.DB.prepare(`UPDATE accounts SET ui_config_json=json_patch(ui_config_json,json_object('extra',json_object('upstream_billing_probe_enabled',json(?)))),
      control_version=control_version+1,billing_probe_next_at_ms=0,updated_at_ms=?
      WHERE id=? AND credential_kind='api_key' RETURNING id`).bind(body.enabled?'true':'false',Date.now(),c.req.param('id')).first()
    if (!result) throw new GatewayError(404,'probe_account_not_found','Compatible API-key account was not found')
    return controlSuccess({enabled:body.enabled})
  } catch (error) { return controlError(asGatewayError(error)) }
}
export async function handleUpstreamBillingProbe(c: Context<Bindings>): Promise<Response> {
  try { await authenticateAdminSession(c.req.raw,c.env); return controlSuccess((await probeAccounts(c.env,[c.req.param('id')!]))[0]) }
  catch (error) { return controlError(asGatewayError(error)) }
}
export async function probeUpstreamBillingBatch(c: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(c.req.raw,c.env)
    const body=await readJsonObject(c.req.raw)
    if(Object.keys(body).some(k=>k!=='account_ids') || !Array.isArray(body.account_ids) || body.account_ids.length<1 || body.account_ids.length>20 || body.account_ids.some(id=>typeof id!=='string'||!id||id.length>128)) throw new GatewayError(400,'invalid_account_ids','Provide 1 to 20 account IDs')
    return controlSuccess({results:await probeAccounts(c.env,[...new Set(body.account_ids as string[])])})
  } catch (error) { return controlError(asGatewayError(error)) }
}
export async function getUpstreamBillingRates(c: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(c.req.raw,c.env)
    const listed=await listAdminAccounts(c)
    if(!listed.ok)return listed
    const {data}=await listed.json() as {data:{items:Array<{id:string;extra?:Record<string,unknown>}>;total:number;page:number;page_size:number}}
    const payload={items:data.items.map(item=>({account_id:item.id,snapshot:item.extra?.upstream_billing_probe??null})),total:data.total,page:data.page,page_size:data.page_size}
    const etag='"'+await sha256Hex(JSON.stringify(payload))+'"'
    if(c.req.header('if-none-match')===etag)return new Response(null,{status:304,headers:{etag}})
    const response=controlSuccess(payload);response.headers.set('etag',etag);return response
  } catch (error) { return controlError(asGatewayError(error)) }
}

/** Called by an isolated maintenance Queue message; default one account keeps its D1 budget bounded. */
export async function runUpstreamBillingProbes(env: Env, limit=1): Promise<{checked:number}> {
  const config=await loadSettings(env)
  if(!config.enabled)return {checked:0}
  const now=Date.now()
  const due=await env.DB.prepare(`SELECT id FROM accounts WHERE enabled=1 AND credential_kind='api_key'
    AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
    AND billing_probe_next_at_ms<=? AND billing_probe_claim_until_ms<=? ORDER BY billing_probe_next_at_ms,id LIMIT ?`).bind(now,now,Math.max(1,Math.min(20,Math.floor(limit)))).all<{id:string}>()
  if(due.results.length===0)return {checked:0}
  const results=await probeAccounts(env,due.results.map(a=>a.id),config,true)
  return {checked:results.filter(r=>r.snapshot).length}
}

// Runtime capability observations may advance config_version without changing the
// billing identity. Keep control CAS and compare every field this probe consumes.
const probeIdentityPredicate = `AND base_url=? AND platform=? AND credential_kind=?
  AND EXISTS(SELECT 1 FROM account_secrets WHERE id=? AND account_id=accounts.id AND key_version=?)
  AND json_extract(ui_config_json,'$.proxy_id') IS json_extract(?,'$.proxy_id')
  AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled') IS json_extract(?,'$.extra.upstream_billing_probe_enabled')
  AND json_extract(ui_config_json,'$.extra.upstream_billing_rate_sync_enabled') IS json_extract(?,'$.extra.upstream_billing_rate_sync_enabled')`
function probeIdentityBindings(account:Account):unknown[]{return [account.base_url,account.platform,account.credential_kind,
  account.secret_id,account.key_version,account.ui_config_json,account.ui_config_json,account.ui_config_json]}

export async function probeAccounts(env:Env,ids:string[],config?:Settings,dueOnly=false):Promise<Result[]> {
  config ??= await loadSettings(env)
  const rows=await env.DB.prepare(`SELECT a.*,(SELECT control_version FROM proxies WHERE id=json_extract(a.ui_config_json,'$.proxy_id')) AS proxy_version,s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a
    JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<Account>()
  const available=new Map(rows.results.map(a=>[a.id,a]))
  const results=new Map<string,Result>(),claims:Array<{account:Account;token:string}>=[]
  let queryBudget = 40 // Leave ten statements for authentication, configuration, lookup and CAS cleanup.
  for(const id of ids){
    const account=available.get(id)
    if(!account || !eligible(account)){results.set(id,{account_id:id,error:'account_not_eligible'});continue}
    const cost=accountProxyId(account.ui_config_json)==null?2:3
    if(cost>queryBudget){results.set(id,{account_id:id,error:'probe_deferred_query_budget',pending:true});continue}
    queryBudget-=cost
    claims.push({account,token:crypto.randomUUID()})
  }
  if(claims.length===0)return ids.map(id=>results.get(id)!)
  const now=Date.now()
  const claimed=await env.DB.batch(claims.map(({account,token})=>env.DB.prepare(`UPDATE accounts SET billing_probe_claim_token=?,billing_probe_claim_until_ms=?
    WHERE id=? AND control_version=? AND credential_ref=? AND billing_probe_claim_until_ms<=? ${probeIdentityPredicate}
    ${dueOnly?"AND enabled=1 AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1":''} RETURNING id`).bind(token,now+60000,account.id,account.control_version,account.credential_ref,now,...probeIdentityBindings(account))))
  const active=claims.filter((claim,i)=>{if(claimed[i]!.results.length)return true;results.set(claim.account.id,{account_id:claim.account.id,error:'probe_in_progress_or_account_changed'});return false})
  const observations:Array<{account:Account;token:string;snapshot:BillingSnapshot}>=[]
  let cursor=0
  await Promise.all(Array.from({length:Math.min(4,active.length)},async()=>{
    while(cursor<active.length){const claim=active[cursor++]!;observations.push({...claim,snapshot:await observe(env,claim.account,config!)})}
  }))
  if(observations.length){
    const saved=await env.DB.batch(observations.map(({account,token,snapshot})=>{
      const rate=snapshot.synced_rate_multiplier
      const rateChanged = rate !== undefined && extra(account).upstream_billing_probe_enabled === true &&
        extra(account).upstream_billing_rate_sync_enabled === true && Math.round(rate * 1000000) !== account.billing_rate_multiplier_ppm
      return env.DB.prepare(`UPDATE accounts SET ui_config_json=json_patch(ui_config_json,json_object('extra',json_object('upstream_billing_probe',json(?)))),
        billing_rate_multiplier_ppm=CASE WHEN ? IS NOT NULL AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
          AND json_extract(ui_config_json,'$.extra.upstream_billing_rate_sync_enabled')=1 THEN ? ELSE billing_rate_multiplier_ppm END,
        billing_probe_next_at_ms=?,billing_probe_claim_token=NULL,billing_probe_claim_until_ms=0,control_version=control_version+?,config_version=config_version+?,updated_at_ms=?
        WHERE id=? AND billing_probe_claim_token=? AND control_version=? AND credential_ref=? ${probeIdentityPredicate}
        AND (SELECT control_version FROM proxies WHERE id=json_extract(accounts.ui_config_json,'$.proxy_id')) IS ? RETURNING id`)
        .bind(JSON.stringify(snapshot),rate??null,rate===undefined?null:Math.round(rate*1000000),Date.parse(snapshot.next_probe_at),rateChanged?1:0,rateChanged?1:0,Date.now(),account.id,token,account.control_version,account.credential_ref,...probeIdentityBindings(account),account.proxy_version)
    }))
    observations.forEach(({account,snapshot},i)=>results.set(account.id,saved[i]!.results.length?{account_id:account.id,snapshot}:{account_id:account.id,error:'account_identity_changed'}))
    const failed=observations.filter((_,i)=>saved[i]!.results.length===0)
    if(failed.length)await env.DB.prepare(`UPDATE accounts SET billing_probe_claim_token=NULL,billing_probe_claim_until_ms=0 WHERE billing_probe_claim_token IN (${failed.map(()=>'?').join(',')})`).bind(...failed.map(v=>v.token)).run()
  }
  return ids.map(id=>results.get(id)!)
}

async function observe(env:Env,account:Account,config:Settings):Promise<BillingSnapshot> {
  const now=Date.now(),base=config.interval_minutes*60000
  const stored=extra(account).upstream_billing_probe as BillingSnapshot|undefined
  const previous=stored?.identity?.credential_ref===account.credential_ref && stored.identity.base_url===account.base_url && stored.identity.platform===account.platform ? stored : undefined
  let status:BillingSnapshot['status']='failed',http=0,reason='request_failed',data:Record<string,unknown>|undefined
  let retryAfter=0
  try {
    const url=validateBaseUrl(account.base_url)
    if(OFFICIAL.some(domain=>url.hostname.replace(/\.$/,'')===domain||url.hostname.replace(/\.$/,'').endsWith('.'+domain))){status='unsupported';reason='unsupported'}
    else {
      url.pathname=url.pathname.replace(/\/(?:v1)?\/?$/,'')+'/v1/sub2api/billing'
      const credential=await decryptCredential(account.nonce_b64,account.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,credentialAad(env.ENVIRONMENT,account.id,account.secret_id,account.key_version))
      if(typeof credential.api_key!=='string'||!credential.api_key)throw new Error('credential_unavailable')
      const controller=new AbortController()
      let timer:ReturnType<typeof setTimeout>|undefined
      let activeReader:ReadableStreamDefaultReader<Uint8Array>|undefined
      try {
        const response=await Promise.race([
          (async()=>{
            const proxyId=accountProxyId(account.ui_config_json)
            const init:RequestInit={method:'GET',headers:{accept:'application/json',authorization:`Bearer ${credential.api_key}`},redirect:'manual',signal:controller.signal}
            const response=proxyId!=null&&String(proxyId)!=='0'?await fetchAccountProxy(env,String(proxyId),url,init,controller.signal):await fetch(url,init)
            http=response.status
            const retry=response.headers.get('retry-after');if(retry){const numeric=Number(retry);retryAfter=Number.isFinite(numeric)?Math.max(0,numeric*1000):Math.max(0,Date.parse(retry)-now)}
            if(response.status===404||response.status===405){status='unsupported';reason='unsupported';await response.body?.cancel();return null}
            if(!response.ok){reason='http_error';await response.body?.cancel();return null}
            const reader=response.body?.getReader();activeReader=reader;if(!reader){reason='empty_response';return null}
            let text='',bytes=0;const decoder=new TextDecoder()
            try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536){reason='response_too_large';await reader.cancel();return null}text+=decoder.decode(chunk.value,{stream:true})}text+=decoder.decode()}finally{reader.releaseLock()}
            try{return parseUpstreamBillingData(JSON.parse(text))}catch{reason='invalid_response';return null}
          })(),
          new Promise<null>(resolve=>{timer=setTimeout(()=>{reason='request_timeout';controller.abort();void activeReader?.cancel().catch(()=>undefined);resolve(null)},10000)}),
        ])
        if(response!==null){status='ok';data=response}
      } finally {if(timer!==undefined)clearTimeout(timer)}
    }
  } catch { /* Persist a bounded reason only; provider responses can contain credentials. */ }
  const failureCount=status==='ok'?0:Math.min(1000,(previous?.failure_count??0)+1)
  const delay=Math.min(8.64e15-now,Math.max(Math.min(DAY,base*(status==='unsupported'?8:1)),Number.isFinite(retryAfter)?retryAfter:0))
  const snapshot:BillingSnapshot={identity:{credential_ref:account.credential_ref,base_url:account.base_url,platform:account.platform},status,last_attempt_at:new Date(now).toISOString(),next_probe_at:new Date(now+delay).toISOString(),http_status:http,...(failureCount?{failure_count:failureCount,last_error:reason}:{})}
  if(data){snapshot.data=data;snapshot.received_at=new Date(now).toISOString();snapshot.fresh_until=new Date(now+2*base).toISOString()}
  else if(previous?.data){snapshot.data=previous.data;snapshot.received_at=previous.received_at;snapshot.fresh_until=previous.fresh_until}
  const flags=extra(account),rate=data?upstreamBillingSyncRate(data):null
  if(flags.upstream_billing_probe_enabled===true && flags.upstream_billing_rate_sync_enabled===true && rate!==null)snapshot.synced_rate_multiplier=rate
  return snapshot
}

export function parseUpstreamBillingData(value:unknown):Record<string,unknown> {
  return parseUpstreamBillingDeclaration(value)
}

/** All entry points acquire the same per-account lease and guarded write. */
export async function probeUpstreamBilling(env: Env, id: string, intervalMinutes = 30, scheduled = false): Promise<BillingSnapshot> {
  const [result] = await probeAccounts(env, [id], settings({ enabled: true, interval_minutes: intervalMinutes }), scheduled)
  if (result?.snapshot) return result.snapshot
  const changed = result?.error === 'account_identity_changed'
  throw new GatewayError(changed ? 409 : result?.error === 'account_not_eligible' ? 400 : 409,
    changed ? 'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED' : result?.error === 'account_not_eligible'
      ? 'UPSTREAM_BILLING_PROBE_ACCOUNT_INVALID' : 'UPSTREAM_BILLING_PROBE_NOT_DUE',
    changed ? 'Account changed during billing observation' : 'Account is not eligible or another probe is in progress')
}

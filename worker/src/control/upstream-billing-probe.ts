import { accountFetcher, accountProxyId } from '../proxy/account-fetch'
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
interface Snapshot {
  status: 'ok' | 'unsupported' | 'failed'
  data?: Record<string, unknown>
  received_at?: string
  fresh_until?: string
  last_attempt_at: string
  next_probe_at: string
  failure_count?: number
  http_status?: number
  last_error?: string
  synced_rate_multiplier?: number
}
interface Account {
  id: string; platform: string; credential_kind: string; enabled: number
  base_url: string; credential_ref: string; config_version: number; control_version: number
  ui_config_json: string; billing_rate_multiplier_ppm: number
  secret_id: string; key_version: number; nonce_b64: string; ciphertext_b64: string
}
interface Result { account_id: string; snapshot?: Snapshot; error?: string; pending?: true }
const NAME = 'upstream-billing-probe'
const DEFAULTS: Settings = { enabled: true, interval_minutes: 30 }
const DAY = 86400000
const OFFICIAL = ['openai.com','anthropic.com','googleapis.com','x.ai','deepseek.com','moonshot.cn','moonshot.ai','bigmodel.cn']

function settings(value: unknown): Settings {
  const v = value as Settings
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['enabled','interval_minutes'].includes(k)) || typeof v.enabled !== 'boolean' || !Number.isInteger(v.interval_minutes) || v.interval_minutes < 5 || v.interval_minutes > 1440) {
    throw new GatewayError(400, 'invalid_billing_probe_settings', 'Billing probe interval must be between 5 and 1440 minutes')
  }
  return { enabled: v.enabled, interval_minutes: v.interval_minutes }
}
async function loadSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind(NAME).first<{ value_json: string }>()
  return row ? settings(JSON.parse(row.value_json)) : { ...DEFAULTS }
}
function extra(account: Account): Record<string, unknown> {
  const ui = JSON.parse(account.ui_config_json)
  return ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra : {}
}
function eligible(account: Account): boolean {
  return account.credential_kind === 'api_key' && ['openai','anthropic','gemini','codex'].includes(account.platform)
}

export async function getUpstreamBillingProbeSettings(c: Context<Bindings>): Promise<Response> {
  try { await authenticateAdminSession(c.req.raw,c.env); return controlSuccess(await loadSettings(c.env)) }
  catch (error) { return controlError(asGatewayError(error)) }
}
export async function putUpstreamBillingProbeSettings(c: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(c.req.raw,c.env)
    const value = settings(await readJsonObject(c.req.raw))
    const current = await c.env.DB.prepare('SELECT control_version FROM runtime_settings WHERE name=?').bind(NAME).first<{control_version:number}>()
    const result = await c.env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_by,updated_at_ms) VALUES(?,?,1,?,?)
      ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,control_version=runtime_settings.control_version+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms
      WHERE runtime_settings.control_version=? RETURNING control_version`).bind(NAME,JSON.stringify(value),actor.user_id,Date.now(),current?.control_version??0).first()
    if (!result) throw new GatewayError(409,'settings_conflict','Billing probe settings changed; reload and retry')
    return controlSuccess(value)
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
export async function probeUpstreamBilling(c: Context<Bindings>): Promise<Response> {
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

async function probeAccounts(env:Env,ids:string[],config?:Settings,dueOnly=false):Promise<Result[]> {
  config ??= await loadSettings(env)
  const rows=await env.DB.prepare(`SELECT a.*,s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a
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
    WHERE id=? AND control_version=? AND credential_ref=? AND config_version=? AND billing_probe_claim_until_ms<=?
    ${dueOnly?"AND enabled=1 AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1":''} RETURNING id`).bind(token,now+60000,account.id,account.control_version,account.credential_ref,account.config_version,now)))
  const active=claims.filter((claim,i)=>{if(claimed[i]!.results.length)return true;results.set(claim.account.id,{account_id:claim.account.id,error:'probe_in_progress_or_account_changed'});return false})
  const observations:Array<{account:Account;token:string;snapshot:Snapshot}>=[]
  let cursor=0
  await Promise.all(Array.from({length:Math.min(4,active.length)},async()=>{
    while(cursor<active.length){const claim=active[cursor++]!;observations.push({...claim,snapshot:await observe(env,claim.account,config!)})}
  }))
  if(observations.length){
    const saved=await env.DB.batch(observations.map(({account,token,snapshot})=>{
      const rate=snapshot.synced_rate_multiplier
      return env.DB.prepare(`UPDATE accounts SET ui_config_json=json_patch(ui_config_json,json_object('extra',json_object('upstream_billing_probe',json(?)))),
        billing_rate_multiplier_ppm=CASE WHEN ? IS NOT NULL AND json_extract(ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
          AND json_extract(ui_config_json,'$.extra.upstream_billing_rate_sync_enabled')=1 THEN ? ELSE billing_rate_multiplier_ppm END,
        billing_probe_next_at_ms=?,billing_probe_claim_token=NULL,billing_probe_claim_until_ms=0,control_version=control_version+1,updated_at_ms=?
        WHERE id=? AND billing_probe_claim_token=? AND control_version=? AND config_version=? AND credential_ref=? RETURNING id`)
        .bind(JSON.stringify(snapshot),rate??null,rate===undefined?null:Math.round(rate*1000000),Date.parse(snapshot.next_probe_at),Date.now(),account.id,token,account.control_version,account.config_version,account.credential_ref)
    }))
    observations.forEach(({account,snapshot},i)=>results.set(account.id,saved[i]!.results.length?{account_id:account.id,snapshot}:{account_id:account.id,error:'account_identity_changed'}))
    const failed=observations.filter((_,i)=>saved[i]!.results.length===0)
    if(failed.length)await env.DB.prepare(`UPDATE accounts SET billing_probe_claim_token=NULL,billing_probe_claim_until_ms=0 WHERE billing_probe_claim_token IN (${failed.map(()=>'?').join(',')})`).bind(...failed.map(v=>v.token)).run()
  }
  return ids.map(id=>results.get(id)!)
}

async function observe(env:Env,account:Account,config:Settings):Promise<Snapshot> {
  const now=Date.now(),base=config.interval_minutes*60000
  const previous=extra(account).upstream_billing_probe as Snapshot|undefined
  let status:Snapshot['status']='failed',http=0,reason='request_failed',data:Record<string,unknown>|undefined
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
            const response=await accountFetcher(env, accountProxyId(account.ui_config_json))(url,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${credential.api_key}`},redirect:'manual',signal:controller.signal})
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
  const delay=Math.min(DAY,Math.max(base*(status==='unsupported'?8:1),Number.isFinite(retryAfter)?retryAfter:0))
  const snapshot:Snapshot={status,last_attempt_at:new Date(now).toISOString(),next_probe_at:new Date(now+delay).toISOString(),http_status:http,...(failureCount?{failure_count:failureCount,last_error:reason}:{})}
  if(data){snapshot.data=data;snapshot.received_at=new Date(now).toISOString();snapshot.fresh_until=new Date(now+2*base).toISOString()}
  else if(previous?.data){snapshot.data=previous.data;snapshot.received_at=previous.received_at;snapshot.fresh_until=previous.fresh_until}
  const flags=extra(account),declared=data?.resolved_rate_multiplier
  if(flags.upstream_billing_probe_enabled===true && flags.upstream_billing_rate_sync_enabled===true && typeof declared==='number' && declared>=0 && declared<=100)snapshot.synced_rate_multiplier=Math.round(declared*10000)/10000
  return snapshot
}

export function parseUpstreamBillingData(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('invalid_billing')
  const v=value as Record<string,unknown>
  if(v.object!=='sub2api.key_billing'||v.schema_version!==1||v.billing_scope!=='token'||typeof v.peak_rate_enabled!=='boolean')throw new Error('invalid_schema')
  for(const key of ['group_rate_multiplier','resolved_rate_multiplier','effective_rate_multiplier'])if(typeof v[key]!=='number'||!Number.isFinite(v[key])||(v[key] as number)<0)throw new Error('invalid_rate')
  if(v.user_rate_multiplier!==undefined && (typeof v.user_rate_multiplier!=='number'||!Number.isFinite(v.user_rate_multiplier)||v.user_rate_multiplier<0))throw new Error('invalid_rate')
  if(Math.abs((v.resolved_rate_multiplier as number)-(v.user_rate_multiplier??v.group_rate_multiplier as number) as number)>0.000001)throw new Error('inconsistent_rate')
  if(typeof v.observed_at!=='string'||v.observed_at.length>64||!Number.isFinite(Date.parse(v.observed_at)))throw new Error('invalid_observation_time')
  const clean:Record<string,unknown>={object:v.object,schema_version:1,billing_scope:'token',peak_rate_enabled:v.peak_rate_enabled,observed_at:new Date(v.observed_at).toISOString()}
  for(const key of ['group_rate_multiplier','user_rate_multiplier','resolved_rate_multiplier','effective_rate_multiplier'])if(v[key]!==undefined)clean[key]=v[key]
  if(v.peak_rate_enabled){
    for(const key of ['peak_start','peak_end'])if(typeof v[key]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v[key] as string))throw new Error('invalid_peak')
    if(typeof v.timezone!=='string'||v.timezone.length>100)throw new Error('invalid_timezone')
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:v.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(v.observed_at))
    const start=v.peak_start as string,end=v.peak_end as string,inPeak=start<end?parts>=start&&parts<end:parts>=start||parts<end
    for(const key of ['peak_rate_multiplier','applied_peak_multiplier'])if(typeof v[key]!=='number'||!Number.isFinite(v[key])||(v[key] as number)<0)throw new Error('invalid_peak')
    const applied=inPeak?v.peak_rate_multiplier:1
    if(Math.abs((v.applied_peak_multiplier as number)-(applied as number))>0.000001)throw new Error('inconsistent_peak')
    for(const key of ['peak_start','peak_end','timezone','peak_rate_multiplier','applied_peak_multiplier'])clean[key]=v[key]
  }
  const expected=(v.resolved_rate_multiplier as number)*(v.peak_rate_enabled?v.applied_peak_multiplier as number:1)
  if(!Number.isFinite(expected)||Math.abs((v.effective_rate_multiplier as number)-expected)>0.000001)throw new Error('inconsistent_effective_rate')
  return clean
}

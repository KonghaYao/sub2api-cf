import type { Context } from 'hono'
import { controlError, controlSuccess, queryInteger, readJsonObject, requireResourceId } from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateUserRequest } from '../auth/handler'

type Bindings = { Bindings: Env }
const DAY = 86_400_000
const MAX_LEGACY_PAGE = 100
const MAX_CURSOR_BYTES = 1_024

type UsageCursor = {
  v: 1
  occurred_at_ms: number
  event_id: string
}

export async function listUsage(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const filter = usageFilter(context, user.id)
    const cursorRaw = context.req.query('cursor')
    const limitRaw = context.req.query('limit')
    if (cursorRaw !== undefined || limitRaw !== undefined) {
      const limit = queryInteger(limitRaw ?? context.req.query('page_size'), 'limit', 20, 1, 100)
      const cursor = cursorRaw === undefined ? undefined : decodeUsageCursor(cursorRaw)
      const where = [filter.where]
      const values = [...filter.values]
      if (cursor !== undefined) {
        where.push('(occurred_at_ms < ? OR (occurred_at_ms = ? AND event_id < ?))')
        values.push(cursor.occurred_at_ms, cursor.occurred_at_ms, cursor.event_id)
      }
      const result = await context.env.DB.prepare(
        `SELECT ${USAGE_COLUMNS} FROM usage_projection WHERE ${where.join(' AND ')}
          ORDER BY occurred_at_ms DESC, event_id DESC LIMIT ?`,
      ).bind(...values, limit + 1).all<any>()
      const hasMore = result.results.length > limit
      const visible = result.results.slice(0, limit)
      const last = visible.at(-1)
      return controlSuccess({
        items: visible.map(usageLog),
        has_more: hasMore,
        next_cursor: hasMore && last !== undefined ? encodeUsageCursor(last) : null,
        page_size: limit,
      })
    }
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, MAX_LEGACY_PAGE)
    const size = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const [count, rows] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM usage_projection WHERE ${filter.where}`).bind(...filter.values),
      context.env.DB.prepare(`SELECT ${USAGE_COLUMNS} FROM usage_projection WHERE ${filter.where}
        ORDER BY occurred_at_ms DESC, event_id DESC LIMIT ? OFFSET ?`).bind(...filter.values, size, (page - 1) * size),
    ])
    const total = integer((count.results[0] as any)?.total)
    return controlSuccess({ items: rows.results.map(usageLog), total, page, page_size: size, pages: total === 0 ? 0 : Math.ceil(total / size) })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function getUsageDetail(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'usage')
    const row = await context.env.DB.prepare(`SELECT ${USAGE_COLUMNS} FROM usage_projection WHERE event_id = ? AND user_id = ?`).bind(id, user.id).first<any>()
    if (!row) throw new GatewayError(404, 'usage_not_found', 'Usage record was not found')
    return controlSuccess(usageLog(row))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function usageStats(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const filter = usageFilter(context, user.id, true)
    const row = await context.env.DB.prepare(`SELECT COUNT(*) total_requests, COALESCE(SUM(input_tokens),0) input_tokens,
      COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,
      COALESCE(SUM(amount_micros),0) amount_micros, CAST(ROUND(AVG(duration_ms)) AS INTEGER) average_duration_ms
      FROM usage_projection WHERE ${filter.where}`).bind(...filter.values).first<any>()
    return controlSuccess(stats(row, context.req.query('period')))
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function dashboardStats(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env); const today = utcDay(Date.now())
    const [usage, keys, recent] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) total_requests, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
       COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(amount_micros),0) amount_micros,
       COUNT(CASE WHEN occurred_at_ms >= ? THEN 1 END) today_requests,
       COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN input_tokens ELSE 0 END),0) today_input_tokens,
       COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN output_tokens ELSE 0 END),0) today_output_tokens,
       COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN cache_read_tokens ELSE 0 END),0) today_cache_read_tokens,
       COALESCE(SUM(CASE WHEN occurred_at_ms >= ? THEN amount_micros ELSE 0 END),0) today_amount_micros,
       CAST(ROUND(AVG(duration_ms)) AS INTEGER) average_duration_ms FROM usage_projection WHERE user_id = ?`).bind(today,today,today,today,today,user.id),
      context.env.DB.prepare(`SELECT COUNT(*) total_api_keys, COUNT(CASE WHEN enabled = 1 THEN 1 END) active_api_keys FROM api_keys WHERE user_id = ?`).bind(user.id),
      context.env.DB.prepare(`SELECT COUNT(*) requests, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens),0) tokens FROM usage_projection WHERE user_id = ? AND occurred_at_ms >= ?`).bind(user.id, Date.now() - 5 * 60_000),
    ])
    const u:any=usage.results[0]??{}, k:any=keys.results[0]??{}, r:any=recent.results[0]??{}; const totalTokens=sum(u.input_tokens,u.output_tokens,u.cache_read_tokens), todayTokens=sum(u.today_input_tokens,u.today_output_tokens,u.today_cache_read_tokens)
    return controlSuccess({ total_api_keys: integer(k.total_api_keys), active_api_keys: integer(k.active_api_keys), total_requests:integer(u.total_requests), total_input_tokens:integer(u.input_tokens), total_output_tokens:integer(u.output_tokens), total_cache_creation_tokens:0, total_cache_read_tokens:integer(u.cache_read_tokens), total_tokens:totalTokens, total_cost:usd(integer(u.amount_micros)), total_actual_cost:usd(integer(u.amount_micros)), today_requests:integer(u.today_requests), today_input_tokens:integer(u.today_input_tokens), today_output_tokens:integer(u.today_output_tokens), today_cache_creation_tokens:0, today_cache_read_tokens:integer(u.today_cache_read_tokens), today_tokens:todayTokens, today_cost:usd(integer(u.today_amount_micros)), today_actual_cost:usd(integer(u.today_amount_micros)), average_duration_ms:integer(u.average_duration_ms), rpm: Math.round(integer(r.requests)/5*100)/100, tpm: Math.round(integer(r.tokens)/5*100)/100, by_platform: [] })
  } catch (error) { return controlError(asGatewayError(error)) }
}

export async function dashboardTrend(context: Context<Bindings>): Promise<Response> { return dashboardAggregate(context, 'trend') }
export async function dashboardModels(context: Context<Bindings>): Promise<Response> { return dashboardAggregate(context, 'models') }
export async function dashboardSnapshot(context: Context<Bindings>): Promise<Response> { return dashboardAggregate(context, 'snapshot') }

/**
 * Compatibility endpoint retained by the user API client.  Ownership is
 * checked against api_keys before querying the projection: a caller must not
 * be able to use this inexpensive aggregate as an API-key existence oracle.
 */
export async function getUserApiKeyDailyUsage(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const apiKeyId = requireResourceId(context.req.param('id'), 'api_key')
    const days = queryInteger(context.req.query('days'), 'days', 30, 1, 90)
    const owned = await context.env.DB.prepare('SELECT 1 FROM api_keys WHERE id = ? AND user_id = ?')
      .bind(apiKeyId, user.id).first()
    if (owned === null) throw new GatewayError(404, 'api_key_not_found', 'API key was not found')

    const end = utcDay(Date.now())
    const start = end - (days - 1) * DAY
    const rows = await context.env.DB.prepare(`
      SELECT CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000 AS bucket,
        COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(amount_micros), 0) AS amount
      FROM usage_projection
      WHERE user_id = ? AND api_key_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      GROUP BY bucket ORDER BY bucket ASC
    `).bind(user.id, apiKeyId, start, end + DAY).all<any>()
    return controlSuccess({
      items: rows.results.map((row) => dailyPoint(row)),
      days,
      start_date: iso(start),
      end_date: iso(end),
    })
  } catch (error) { return controlError(asGatewayError(error)) }
}

async function dashboardAggregate(context: Context<Bindings>, kind: 'trend'|'models'|'snapshot'): Promise<Response> {
 try { const user=await authenticateUserRequest(context.req.raw,context.env); const f=usageFilter(context,user.id,true); const gran=context.req.query('granularity')==='hour'?'hour':'day'; const bucket=gran==='hour'?`CAST(occurred_at_ms / 3600000 AS INTEGER) * 3600000`:`CAST(occurred_at_ms / 86400000 AS INTEGER) * 86400000`
  if(kind==='models') return controlSuccess({models:await modelRows(context.env.DB, f),start_date:f.start,end_date:f.end})
  const includeTrend = kind === 'trend' || snapshotFlag(context, 'include_trend')
  const includeModels = kind === 'snapshot' && snapshotFlag(context, 'include_model_stats')
  const includeGroups = kind === 'snapshot' && snapshotFlag(context, 'include_group_stats')
  const statements: D1PreparedStatement[] = []
  if (includeTrend) statements.push(context.env.DB.prepare(`SELECT ${bucket} bucket, COUNT(*) requests, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(amount_micros),0) amount FROM usage_projection WHERE ${f.where} GROUP BY bucket ORDER BY bucket ASC`).bind(...f.values))
  if (includeModels) statements.push(modelStatement(context.env.DB, f))
  if (includeGroups) { const gf=usageFilter(context,user.id,true,'u.'); statements.push(groupStatement(context.env.DB, gf)) }
  const result = statements.length === 0 ? [] : await context.env.DB.batch(statements)
  let index = 0
  const trend = includeTrend ? (result[index++].results as any[]).map((x) => trendPoint(x,gran)) : undefined
  const models = includeModels ? (result[index++].results as any[]).map(modelStat) : undefined
  const groups = includeGroups ? (result[index++].results as any[]).map(groupStat) : undefined
  if(kind==='trend') return controlSuccess({trend:trend ?? [],start_date:f.start,end_date:f.end,granularity:gran})
  return controlSuccess({generated_at:new Date().toISOString(),start_date:f.start,end_date:f.end,granularity:gran,...(trend ? {trend} : {}),...(models ? {models} : {}),...(groups ? {groups} : {})})
 } catch(error){return controlError(asGatewayError(error))}
}

export async function dashboardApiKeysUsage(context: Context<Bindings>): Promise<Response> { try { const user=await authenticateUserRequest(context.req.raw,context.env); const body=await readJsonObject(context.req.raw); const ids=body.api_key_ids; if(!Array.isArray(ids)||ids.length>100) throw new GatewayError(400,'invalid_api_key_ids','api_key_ids must contain at most 100 ids'); const clean=ids.map(x=>typeof x==='string'?requireResourceId(x,'api_key'):Number.isSafeInteger(x)&&x>=0?requireResourceId(String(x),'api_key'):null); if(clean.some(x=>x===null)) throw new GatewayError(400,'invalid_api_key_ids','api_key_ids must contain ids'); if(clean.length===0)return controlSuccess({stats:{}}); const q=clean.map(()=>'?').join(','); const today=utcDay(Date.now()); const rows=await context.env.DB.prepare(`SELECT api_key_id, COALESCE(SUM(CASE WHEN occurred_at_ms>=? THEN amount_micros ELSE 0 END),0) today, COALESCE(SUM(amount_micros),0) total FROM usage_projection WHERE user_id=? AND api_key_id IN (${q}) GROUP BY api_key_id`).bind(today,user.id,...clean).all<any>(); const stats:Record<string,unknown>={}; for(const row of rows.results)stats[row.api_key_id]={api_key_id:row.api_key_id,today_actual_cost:usd(integer(row.today)),total_actual_cost:usd(integer(row.total))}; return controlSuccess({stats}) }catch(error){return controlError(asGatewayError(error))} }
const USAGE_COLUMNS=`event_id,request_id,user_id,api_key_id,account_id,COALESCE(requested_model,model) model,group_id,subscription_id,input_tokens,output_tokens,cache_read_tokens,input_amount_micros,output_amount_micros,cache_amount_micros,base_amount_micros,amount_micros,billing_type,outcome,stream,duration_ms,occurred_at_ms`
type UsageFilter = { where: string; values: unknown[]; start: string; end: string }

function modelStatement(db: D1Database, filter: UsageFilter): D1PreparedStatement {
  return db.prepare(`SELECT COALESCE(requested_model,model) model, COUNT(*) requests, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cache_read_tokens),0) cache_read_tokens, COALESCE(SUM(amount_micros),0) amount FROM usage_projection WHERE ${filter.where} GROUP BY model ORDER BY amount DESC, model ASC LIMIT 100`).bind(...filter.values)
}

async function modelRows(db: D1Database, filter: UsageFilter) {
  const rows = await modelStatement(db, filter).all<any>()
  return rows.results.map(modelStat)
}

function groupStatement(db: D1Database, filter: UsageFilter): D1PreparedStatement {
  return db.prepare(`SELECT u.group_id, COALESCE(g.name,'') group_name, COUNT(*) requests, COALESCE(SUM(u.input_tokens+u.output_tokens+u.cache_read_tokens),0) tokens, COALESCE(SUM(u.amount_micros),0) amount FROM usage_projection u LEFT JOIN "groups" g ON g.id=u.group_id WHERE ${filter.where} GROUP BY u.group_id,g.name ORDER BY amount DESC LIMIT 100`).bind(...filter.values)
}

function usageFilter(c:Context<Bindings>, user:string, period=false, prefix=''){const col=(x:string)=>`${prefix}${x}`;const w=[`${col('user_id')} = ?`],v:unknown[]=[user]; let start=c.req.query('start_date'),end=c.req.query('end_date'); if(period&&!start&&!end){const p=c.req.query('period')??'today'; if(!['today','week','month','year'].includes(p)) throw new GatewayError(400,'invalid_period','period must be today, week, month, or year'); const n=utcDay(Date.now()); start=new Date(p==='today'?n:p==='week'?n-6*DAY:p==='month'?n-29*DAY:n-364*DAY).toISOString().slice(0,10);end=new Date(n).toISOString().slice(0,10)} const range=dateRange(start,end); if(range){w.push(`${col('occurred_at_ms')} >= ?`,`${col('occurred_at_ms')} < ?`);v.push(range[0],range[1])} for(const [param,name] of [['api_key_id','api_key_id'],['group_id','group_id']] as const){const x=c.req.query(param);if(x){w.push(`${col(name)} = ?`);v.push(requireResourceId(x,param))}} const model=c.req.query('model'); if(model){w.push(`COALESCE(${col('requested_model')}, ${col('model')}) = ?`);v.push(model)} const b=c.req.query('billing_type');if(b){if(b!=='0'&&b!=='1'&&b!=='balance'&&b!=='subscription')throw new GatewayError(400,'invalid_billing_type','billing_type is invalid');w.push(`${col('billing_type')} = ?`);v.push(b==='1'?'subscription':b==='0'?'balance':b)} const s=c.req.query('stream');if(s!==undefined&&s!==''){if(s!=='true'&&s!=='false')throw new GatewayError(400,'invalid_stream','stream is invalid');w.push(`${col('stream')} = ?`);v.push(s==='true'?1:0)} return {where:w.join(' AND '),values:v,start:range?iso(range[0]):start??'',end:range?iso(range[1]-DAY):end??''}}
function snapshotFlag(context: Context<Bindings>, name: string): boolean { const value=context.req.query(name); if(value===undefined||value==='') return true; if(value==='true') return true; if(value==='false') return false; throw new GatewayError(400,`invalid_${name}`,`${name} must be true or false`) }
function dateRange(s?:string,e?:string):[number,number]|null{if(!s&&!e)return null; if(!s||!e||!/^\d{4}-\d\d-\d\d$/.test(s)||!/^\d{4}-\d\d-\d\d$/.test(e))throw new GatewayError(400,'invalid_date_range','start_date and end_date must be YYYY-MM-DD');const a=Date.parse(`${s}T00:00:00.000Z`),b=Date.parse(`${e}T00:00:00.000Z`);if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a>b||b-a>366*DAY)throw new GatewayError(400,'invalid_date_range','date range is invalid or exceeds 366 days');return[a,b+DAY]}
function usageLog(x:any){const amount=integer(x.amount_micros);return{id:x.event_id,user_id:x.user_id,api_key_id:x.api_key_id,account_id:x.account_id,request_id:x.request_id,model:x.model,group_id:x.group_id,subscription_id:x.subscription_id,input_tokens:integer(x.input_tokens),output_tokens:integer(x.output_tokens),cache_creation_tokens:0,cache_read_tokens:integer(x.cache_read_tokens),cache_creation_5m_tokens:0,cache_creation_1h_tokens:0,input_cost:usd(integer(x.input_amount_micros)),output_cost:usd(integer(x.output_amount_micros)),cache_creation_cost:0,cache_read_cost:usd(integer(x.cache_amount_micros)),total_cost:usd(integer(x.base_amount_micros)),actual_cost:usd(amount),rate_multiplier:1,long_context_billing_applied:false,billing_type:x.billing_type==='subscription'?1:0,stream:x.stream===1,native_compaction_v2:false,duration_ms:x.duration_ms,first_token_ms:null,image_count:0,image_size:null,image_input_size:null,image_output_size:null,image_size_source:null,image_size_breakdown:null,image_input_tokens:0,image_input_cost:0,image_output_tokens:0,image_output_cost:0,cache_ttl_overridden:false,billing_mode:x.billing_type,created_at:new Date(x.occurred_at_ms).toISOString()}}
function encodeUsageCursor(row:{occurred_at_ms:number;event_id:string}){const bytes=new TextEncoder().encode(JSON.stringify({v:1,occurred_at_ms:row.occurred_at_ms,event_id:row.event_id} satisfies UsageCursor));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function decodeUsageCursor(raw:string):UsageCursor{if(raw.length===0||raw.length>MAX_CURSOR_BYTES||!/^[A-Za-z0-9_-]+$/.test(raw))throw invalidUsageCursor();try{const padded=raw.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-raw.length%4)%4);const binary=atob(padded);const bytes=Uint8Array.from(binary,(character)=>character.charCodeAt(0));const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;if(value===null||typeof value!=='object'||Array.isArray(value)||(value as any).v!==1||!Number.isSafeInteger((value as any).occurred_at_ms)||(value as any).occurred_at_ms<0||typeof (value as any).event_id!=='string'||(value as any).event_id.length===0||(value as any).event_id.length>512)throw invalidUsageCursor();return value as UsageCursor}catch{throw invalidUsageCursor()}}
function invalidUsageCursor(){return new GatewayError(400,'invalid_usage_cursor','Usage cursor is invalid')}
function stats(x:any,p?:string){const i=integer(x.input_tokens),o=integer(x.output_tokens),c=integer(x.cache_read_tokens),a=integer(x.amount_micros);return{...(p?{period:p}:{}),total_requests:integer(x.total_requests),total_input_tokens:i,total_output_tokens:o,total_cache_tokens:c,total_cache_read_tokens:c,total_cache_creation_tokens:0,total_tokens:sum(i,o,c),total_cost:usd(a),total_actual_cost:usd(a),average_duration_ms:integer(x.average_duration_ms),models:{},endpoints:[]}}
function modelStat(x:any){const i=integer(x.input_tokens),o=integer(x.output_tokens),c=integer(x.cache_read_tokens),a=integer(x.amount);return{model:x.model,requests:integer(x.requests),input_tokens:i,output_tokens:o,cache_creation_tokens:0,cache_read_tokens:c,total_tokens:sum(i,o,c),cost:usd(a),actual_cost:usd(a)}}
function groupStat(x:any){const amount=integer(x.amount);return{group_id:x.group_id,group_name:x.group_name,requests:integer(x.requests),total_tokens:integer(x.tokens),cost:usd(amount),actual_cost:usd(amount)}}
function trendPoint(x:any,g:string){const i=integer(x.input_tokens),o=integer(x.output_tokens),c=integer(x.cache_read_tokens),a=integer(x.amount);return{date:g==='hour'?new Date(x.bucket).toISOString().slice(0,13)+':00:00Z':iso(x.bucket),requests:integer(x.requests),input_tokens:i,output_tokens:o,cache_creation_tokens:0,cache_read_tokens:c,total_tokens:sum(i,o,c),cost:usd(a),actual_cost:usd(a)}}
function dailyPoint(x:any){const i=integer(x.input_tokens),o=integer(x.output_tokens),c=integer(x.cache_read_tokens),a=integer(x.amount);return{date:iso(x.bucket),requests:integer(x.requests),input_tokens:i,output_tokens:o,cache_read_tokens:c,cache_write_tokens:0,total_tokens:sum(i,o,c),cost:usd(a),actual_cost:usd(a)}}
function integer(v:any){return Number.isSafeInteger(v)&&v>=0?v:0} function sum(...n:number[]){const x=n.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(x))throw new GatewayError(503,'invalid_usage_projection','Usage information is unavailable','server_error');return x} function usd(v:number){return v/1e6} function utcDay(n:number){return Math.floor(n/DAY)*DAY} function iso(n:number){return new Date(n).toISOString().slice(0,10)}

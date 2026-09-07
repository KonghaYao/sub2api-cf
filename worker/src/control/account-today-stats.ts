import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError,GatewayError } from '../gateway/errors'
import { controlSuccess,controlError,readJsonObject } from './http'

export async function accountTodayStats(c:Context<{Bindings:Env}>):Promise<Response>{
 try {
  const single=c.req.param('id'),body=single?{}:await readJsonObject(c.req.raw)
  const ids=single?[single]:body.account_ids
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.length>128))throw new GatewayError(400,'invalid_account_ids','Provide at most 100 account IDs')
  // This endpoint reports the UTC calendar day, matching the default account statistics API.
  const now=Date.now(),start=Math.floor(now/86400000)*86400000
  const result=await c.env.DB.prepare(`SELECT a.id,COUNT(u.event_id) AS requests,
    COALESCE(SUM(u.input_tokens+u.output_tokens),0) AS tokens,
    COALESCE(SUM(COALESCE(u.account_cost_micros,u.account_stats_cost_micros,u.standard_cost_micros,u.amount_micros)),0) AS cost,
    COALESCE(SUM(COALESCE(u.standard_cost_micros,u.amount_micros)),0) AS standard_cost,
    COALESCE(SUM(u.amount_micros),0) AS user_cost
    FROM accounts a LEFT JOIN usage_projection u ON u.account_id=a.id AND u.occurred_at_ms>=? AND u.occurred_at_ms<?
    WHERE a.id IN(SELECT value FROM json_each(?)) GROUP BY a.id`).bind(start,start+86400000,JSON.stringify([...new Set(ids)])).all<{id:string;requests:number;tokens:number;cost:number;standard_cost:number;user_cost:number}>()
  const stats=Object.fromEntries(result.results.map(({id,...row})=>[id,{...row,cost:row.cost/1000000,standard_cost:row.standard_cost/1000000,user_cost:row.user_cost/1000000}]))
  if(single&&!stats[single])throw new GatewayError(404,'account_not_found','Account not found')
  return controlSuccess(single?stats[single]:{stats})
 }catch(error){return controlError(asGatewayError(error))}
}

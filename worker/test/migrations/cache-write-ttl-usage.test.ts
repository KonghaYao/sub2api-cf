import { expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
it('adds TTL evidence without rewriting historical tokens or money',()=>{
  const {raw}=createSqliteD1()
  try{
    applyMigrations(raw,118)
    raw.exec("INSERT INTO users (id,email,display_name,created_at_ms,updated_at_ms) VALUES ('legacy-ttl','legacy@ttl.test','',1,1)")
    raw.exec("INSERT INTO usage_projection (event_id,request_id,user_id,model,input_tokens,output_tokens,cache_write_tokens,amount_micros,occurred_at_ms,projected_at_ms) VALUES ('legacy-ttl','legacy-ttl','legacy-ttl','m',10,2,5,71,1,1)")
    applyMigrations(raw,119)
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version=119').get()).toEqual({name:'cache_write_ttl_usage'})
    expect(raw.prepare('SELECT input_tokens,output_tokens,cache_write_tokens,cache_write_5m_tokens,cache_write_1h_tokens,amount_micros FROM usage_projection').get()).toEqual({input_tokens:10,output_tokens:2,cache_write_tokens:5,cache_write_5m_tokens:0,cache_write_1h_tokens:0,amount_micros:71})
    expect(()=>raw.exec('UPDATE usage_projection SET cache_write_1h_tokens=-1')).toThrow()
    const columns=raw.prepare('PRAGMA table_info(account_usage_15m_rollup)').all()
    for(const field of ['cache_write_5m_tokens','cache_write_1h_tokens'])expect(columns.find((x:any)=>x.name===field)).toMatchObject({notnull:1,dflt_value:'0'})
  }finally{raw.close()}
})

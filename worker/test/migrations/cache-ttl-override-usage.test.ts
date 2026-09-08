import { expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
it('defaults historical TTL override evidence to false and enforces a boolean flag',()=>{
  const {raw}=createSqliteD1()
  try{
    applyMigrations(raw,120)
    raw.exec("INSERT INTO users (id,email,display_name,created_at_ms,updated_at_ms) VALUES ('ttl-old','old@ttl.test','',1,1)")
    raw.exec("INSERT INTO usage_projection (event_id,request_id,user_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms) VALUES ('ttl-old','ttl-old','ttl-old','m',10,2,71,1,1)")
    applyMigrations(raw,121)
    expect(raw.prepare('SELECT amount_micros,cache_ttl_overridden FROM usage_projection').get()).toEqual({amount_micros:71,cache_ttl_overridden:0})
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version=121').get()).toEqual({name:'cache_ttl_override_usage'})
    expect(()=>raw.exec('UPDATE usage_projection SET cache_ttl_overridden=2')).toThrow()
  }finally{raw.close()}
})

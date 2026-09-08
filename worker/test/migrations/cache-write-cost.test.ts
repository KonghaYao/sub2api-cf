import { expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
it('adds cache write costs without changing historic charges', () => {
  const { raw } = createSqliteD1()
  try {
    applyMigrations(raw, 119)
    raw.exec("INSERT INTO users (id,email,display_name,created_at_ms,updated_at_ms) VALUES ('legacy-cost','legacy@cost.test','',1,1)")
    raw.exec("INSERT INTO usage_projection (event_id,request_id,user_id,model,input_tokens,output_tokens,cache_write_tokens,amount_micros,occurred_at_ms,projected_at_ms) VALUES ('legacy-cost','legacy-cost','legacy-cost','m',10,2,5,71,1,1)")
    applyMigrations(raw, 120)
    expect(raw.prepare('SELECT amount_micros,cache_write_tokens,cache_write_amount_micros FROM usage_projection').get()).toEqual({amount_micros:71,cache_write_tokens:5,cache_write_amount_micros:0})
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version=120').get()).toEqual({name:'cache_write_cost'})
    expect(() => raw.exec('UPDATE usage_projection SET cache_write_amount_micros=-1')).toThrow()
  } finally { raw.close() }
})

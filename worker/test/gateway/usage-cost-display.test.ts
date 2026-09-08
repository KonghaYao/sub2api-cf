import { expect, it } from 'vitest'
import { createSqliteD1 } from '../helpers/sqlite-d1'
import { usageCostDisplay, usageBasisAmountSql } from '../../src/gateway/usage-cost-display'
const evidence = {version:1,source:'channel',customer_rate_multiplier_ppm:1500000,basis_cost:{input_amount_micros:10,output_amount_micros:3,cache_amount_micros:1,cache_write_amount_micros:5,base_amount_micros:0,amount_micros:19}}
it('uses recorded pre-multiplier components without reverse-dividing rounded charges',()=>{
  expect(usageCostDisplay(JSON.stringify(evidence))).toEqual({input_cost:0.00001,output_cost:0.000003,cache_read_cost:0.000001,cache_creation_cost:0.000005,total_cost:0.000019,rate_multiplier:1.5})
  expect(usageCostDisplay(JSON.stringify({...evidence,source:'catalog',customer_rate_multiplier_ppm:0}))).toMatchObject({rate_multiplier:0,total_cost:0.000019})
})
it('falls back for legacy, malformed and inconsistent evidence',()=>{
  for(const value of [null,'{',JSON.stringify({version:1,source:'channel'}),JSON.stringify({...evidence,basis_cost:{...evidence.basis_cost,amount_micros:20}}),JSON.stringify({...evidence,basis_cost:{...evidence.basis_cost,input_amount_micros:-1}})])expect(usageCostDisplay(value)).toBeNull()
})

it('uses the same evidence and fallback in SQL totals as in detail responses',()=>{
  const {raw}=createSqliteD1()
  try {
    const query=raw.prepare(`SELECT ${usageBasisAmountSql()} amount FROM (SELECT ? customer_pricing_snapshot_json, 99 amount_micros)`)
    for(const value of [evidence,{...evidence,source:'catalog'},{...evidence,version:'1'},{...evidence,basis_cost:{...evidence.basis_cost,amount_micros:20}},{version:1,source:'channel'},null]) {
      const text=JSON.stringify(value)
      expect(query.get(text).amount).toBe(usageCostDisplay(text) ? 19 : 99)
    }
    expect(query.get('{').amount).toBe(99)
  }finally{raw.close()}
})

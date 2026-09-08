import { expect,it } from 'vitest'
import { parseCodexImportEntries,CodexImportNumber } from '../../src/control/codex-import-content'
it('combines content/files in order, flattens arrays and preserves one-based indexes',()=>{
  const entries=parseCodexImportEntries({content:' first-token\n\nsecond-token ',contents:['','[{"access_token":"third"},["fourth",null]]','{"access_token":"fifth"}{"access_token":"sixth"}']})
  expect(entries.map(e=>e.index)).toEqual([1,2,3,4,5,6,7])
  expect(entries.map(e=>e.value)).toEqual(['first-token','second-token',{access_token:'third'},'fourth',null,{access_token:'fifth'},{access_token:'sixth'}])
})
it('accepts pretty JSON and falls back to mixed JSON/token lines',()=>{
  expect(parseCodexImportEntries({content:'{\n "access_token": "value"\n}'})).toEqual([{index:1,value:{access_token:'value'}}])
  expect(parseCodexImportEntries({content:'{"access_token":"first"}\nsecond-token\n["third"]'}).map(e=>e.value)).toEqual([{access_token:'first'},'second-token','third'])
})
it('keeps JSON string escapes and large numeric identifiers lossless',()=>{
  const value=parseCodexImportEntries({content:'{"id":9007199254740993,"expiry":1.25e3,"access_token":"quote\\\"brace}\\\\end"}'})[0]!.value as any
  expect(value.id).toBeInstanceOf(CodexImportNumber)
  expect(value.id.toString()).toBe('9007199254740993');expect(value.expiry.toString()).toBe('1.25e3')
  expect(value.access_token).toBe('quote"brace}\\end')
})
it('keeps potentially special object keys as inert data',()=>{
  const value=parseCodexImportEntries({content:'{"__proto__":{"admin":true},"constructor":"data"}'})[0]!.value as any
  expect(Object.getPrototypeOf(value)).toBeNull();expect(value.__proto__.admin).toBe(true)
  expect(({} as any).admin).toBeUndefined()
})
it.each(['{"access_token":"secret",}','[{"x":1}', '{"x":01}', '{"x":NaN}', '{"x":"bad\\q"}', '{"x":1}\n{"access_token":"secret",}', '['.repeat(258)+'0'+']'.repeat(258)])('rejects malformed JSON without echoing secrets',content=>{
  try { parseCodexImportEntries({content});throw new Error('unexpected success') }
  catch(error:any) { expect(error.code).toBe('invalid_codex_import_json');expect(error.message).not.toContain('secret') }
})
it('does not treat plain quoted lines as JSON and ignores empty inputs',()=>{
  expect(parseCodexImportEntries({content:'"token"'})).toEqual([{index:1,value:'"token"'}])
  expect(parseCodexImportEntries({content:' ',contents:['\n']})).toEqual([])
})

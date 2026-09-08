import { describe, expect, it } from 'vitest'
import { dedupeRepeatedJsonArguments, normalizeResponsesToolArguments } from '../../../src/gateway/protocols/tool-arguments'

describe('original repeated JSON tool argument repair', () => {
 it.each(['{"city":"上海"}', '[1,{"emoji":"😀"}]', ' {"x":1} '])('repairs exactly duplicated JSON %s', value => {
  expect(dedupeRepeatedJsonArguments(value+value)).toBe(value)
 })
 it.each(['hellohello','11','"x""x"','{"x":1}{"x":2}','{}{}{}','{bad}{bad}',''])('preserves non-matching input %s', value => {
  expect(dedupeRepeatedJsonArguments(value)).toBe(value)
 })
 it('repairs snapshots and done arguments without mutating custom input or the source', () => {
  const source={type:'response.function_call_arguments.done',arguments:'{}{}',item:{type:'function_call',arguments:'[][]'},response:{output:[{type:'function_call',call_id:'c',arguments:'{}{}'},{type:'custom_tool_call',input:'{}{}'}]}}
  expect(normalizeResponsesToolArguments(source)).toEqual({type:source.type,arguments:'{}',item:{type:'function_call',arguments:'[]'},response:{output:[{type:'function_call',call_id:'c',arguments:'{}'},{type:'custom_tool_call',input:'{}{}'}]}})
  expect(source.arguments).toBe('{}{}')
  expect(source.response.output[0].arguments).toBe('{}{}')
 })
})

it('uses SSE event names when the payload omits type', () => {
 expect(normalizeResponsesToolArguments({arguments:'{}{}'}, 'response.function_call_arguments.done')).toEqual({arguments:'{}'})
})

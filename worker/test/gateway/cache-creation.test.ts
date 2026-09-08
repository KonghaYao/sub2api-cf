import { expect, it } from 'vitest'
import { normalizeCacheCreationBreakdown } from '../../src/gateway/cache-creation'
it.each([
  [100,90,60,60,40], [100,30,60,30,60], [100,0,60,0,60],
  [100,-50,150,0,100], [0,90,60,90,60], [3,1,1,1,1],
  [3,4,2,2,1], [1,1,1,1,0], [100,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,50,50],
  [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER-1,1],
])('normalizes total %s with TTL details %s/%s', (total,five,hour,wantFive,wantHour)=>{
  expect(normalizeCacheCreationBreakdown(total,five,hour)).toEqual([wantFive,wantHour])
})

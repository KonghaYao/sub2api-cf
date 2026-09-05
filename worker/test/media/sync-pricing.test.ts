import { describe, expect, it } from 'vitest'

import { GatewayError } from '../../src/gateway/errors'
import {
  calculateSyncImageActualCost,
  calculateSyncImageReservation,
  resolveSyncImagePricePolicy,
  type SyncImagePricePolicy,
} from '../../src/media/sync-pricing'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const policy: SyncImagePricePolicy = {
  rateMultiplierPpm: 1_500_000,
  price1kMicros: 100_000,
  price2kMicros: 200_000,
  price4kMicros: 400_000,
}

describe('synchronous image pricing', () => {
  it('reserves requested output count using the requested tier snapshot', () => {
    expect(calculateSyncImageReservation(policy, '1K', 2)).toBe(300_000)
    expect(calculateSyncImageReservation(policy, '2K', 3)).toBe(900_000)
  })

  it('settles each successful output at its actual decoded tier', () => {
    expect(calculateSyncImageActualCost(policy, ['1K', '4K'])).toBe(750_000)
    expect(calculateSyncImageActualCost(policy, [])).toBe(0)
  })

  it('supports explicitly free image groups and fails closed on missing prices', () => {
    expect(calculateSyncImageReservation({ ...policy, rateMultiplierPpm: 0 }, '4K', 10)).toBe(0)
    expect(() => calculateSyncImageReservation({ ...policy, price2kMicros: null }, '2K', 1))
      .toThrowError(GatewayError)
  })

  it('resolves the image-specific multiplier and entitlement from D1', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users(id,email,display_name,created_at_ms,updated_at_ms)
      VALUES('user-1','image-pricing@example.test','Image Pricing',1,1);
      INSERT INTO "groups"(
        id,name,platform,allow_image_generation,image_rate_independent,
        image_rate_multiplier_ppm,image_price_1k_micros,image_price_2k_micros,
        image_price_4k_micros,created_at_ms,updated_at_ms
      ) VALUES('group-1','Images','openai',1,1,750000,100000,200000,400000,1,1);
    `)

    await expect(resolveSyncImagePricePolicy({ DB: d1 }, {
      user_id: 'user-1', group_id: 'group-1',
    })).resolves.toEqual({
      rateMultiplierPpm: 750_000,
      price1kMicros: 100_000,
      price2kMicros: 200_000,
      price4kMicros: 400_000,
    })

    raw.prepare('UPDATE "groups" SET allow_image_generation = 0 WHERE id = ?').run('group-1')
    await expect(resolveSyncImagePricePolicy({ DB: d1 }, {
      user_id: 'user-1', group_id: 'group-1',
    })).rejects.toMatchObject({ status: 403, code: 'IMAGE_GENERATION_DISABLED' })
    raw.close()
  })
})

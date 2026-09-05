import { describe, expect, it } from 'vitest'

import {
  classifyImageBillingTier,
  detectImageDimensions,
  resolveImageBilling,
} from '../../src/media/image-accounting'

describe('synchronous image accounting', () => {
  it.each([
    ['1k', '1K'],
    ['1024X768', '1K'],
    ['1280x720', '2K'],
    ['2048x1152', '2K'],
    ['2560x1600', '4K'],
    ['3840x2160', '4K'],
  ])('classifies %s as %s', (input, expected) => {
    expect(classifyImageBillingTier(input)).toBe(expected)
  })

  it('reads dimensions from bounded PNG, JPEG, WebP VP8X, and WebP VP8L headers', () => {
    expect(detectImageDimensions(pngHeader(3840, 2160))).toEqual({ width: 3840, height: 2160 })
    expect(detectImageDimensions(jpegHeader(1536, 1024))).toEqual({ width: 1536, height: 1024 })
    expect(detectImageDimensions(webpVp8xHeader(2048, 1152))).toEqual({ width: 2048, height: 1152 })
    expect(detectImageDimensions(webpVp8lHeader(1024, 768))).toEqual({ width: 1024, height: 768 })
  })

  it('uses per-output actual tiers and never lets an input hint lower the charge', () => {
    expect(resolveImageBilling('1024x1024', [
      pngHeader(1024, 1024),
      pngHeader(2048, 1152),
      pngHeader(3840, 2160),
    ])).toEqual({
      billingTier: '4K',
      inputSize: '1024x1024',
      outputSize: '1024x1024',
      source: 'output',
      breakdown: { '1K': 1, '2K': 1, '4K': 1 },
    })
  })

  it('falls back to requested size, then conservative 2K when bytes are unknown', () => {
    expect(resolveImageBilling('1024x1024', [new Uint8Array([1, 2, 3])])).toMatchObject({
      billingTier: '1K', source: 'input',
    })
    expect(resolveImageBilling('auto', [new Uint8Array([1, 2, 3])])).toMatchObject({
      billingTier: '2K', source: 'default',
    })
  })
})

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x08, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11,
    0xff, 0xd9,
  ])
}

function webpVp8xHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
  writeUint24Le(bytes, 24, width - 1)
  writeUint24Le(bytes, 27, height - 1)
  return bytes
}

function webpVp8lHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8)
  bytes[20] = 0x2f
  const bits = BigInt(width - 1) | (BigInt(height - 1) << 14n)
  for (let index = 0; index < 4; index += 1) bytes[21 + index] = Number((bits >> BigInt(index * 8)) & 0xffn)
  return bytes
}

function writeUint24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = value >> 8 & 0xff
  bytes[offset + 2] = value >> 16 & 0xff
}

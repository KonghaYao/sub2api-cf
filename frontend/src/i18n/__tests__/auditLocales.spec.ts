import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from '../locales/en/admin/audit'
import zh from '../locales/zh/admin/audit'

describe('original operation audit translations', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/admin/AuditLogView.vue'), 'utf8')
  const keys = [...new Set([...source.matchAll(/t\('admin\.(audit\.[^']+)'/g)].map(match => match[1]))]
  it.each([['en', en], ['zh', zh]])('provides every visible label and action in %s', (_locale, messages) => {
    for (const key of keys) {
      const value = key.split('.').reduce<unknown>((current, part) =>
        current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, messages)
      expect(typeof value, key).toBe('string')
      expect(value, key).not.toBe('')
    }
  })
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the original Groups template and styles at 5097b3145', () => {
  const { descriptor, errors } = parse(readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8'))
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('5c2d4af428d409b5b04fd5b055d8c1e0f852d46c2f7b03ab0e1e7b0709dffa91')
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the original Groups template and styles at 5097b3145', () => {
  const { descriptor, errors } = parse(readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8'))
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('88c8776ce0930a555fe80f84aa39f145323385d77171da1a2a55e9adfcad7f35')
})

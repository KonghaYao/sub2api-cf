import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the original Groups template and styles at 5097b3145', () => {
  const { descriptor, errors } = parse(readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8'))
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('761c0b0fc6b8a3aefa03785aa7928325a5862d0a7dd76ded1966989a5854409b')
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the reviewed Groups template with only normalized group model synchronization UI', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8')
  expect(source).not.toContain('models_list_config')
  expect(source).not.toContain('ModelsListState')
  expect(source).toContain('syncGroupModelsFromAccounts')
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('0294a1f30bead7ecd3a72ad9a5a7bc0170d1efd1a53de7a11ec3697e38ae89aa')
})

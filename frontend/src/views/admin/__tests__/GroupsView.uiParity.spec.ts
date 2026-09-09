import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
it('preserves the reviewed Groups template with only normalized group model synchronization UI', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/views/admin/GroupsView.vue'), 'utf8')
  expect(source).not.toContain('models_list_config')
  expect(source).not.toContain('ModelsListState')
  expect(source).toContain('syncGroupModelsFromAccounts')
  expect(source).toContain('publishGroupModelPrice')
  expect(source).toContain('admin.groups.groupModels.setPrice')
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  expect(createHash('sha256').update(JSON.stringify({ template: descriptor.template?.content, styles: descriptor.styles.map(s => s.content) })).digest('hex')).toBe('921956d9c86c6b62fd09316192ce6ae6efb98f653a03b447305df67c6cffd89f')
})

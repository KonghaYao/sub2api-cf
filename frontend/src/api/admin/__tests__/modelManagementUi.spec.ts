import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('model management UI invariants', () => {
  const groups = readFileSync('src/views/admin/GroupsView.vue', 'utf8')
  const capabilities = readFileSync('src/components/admin/account/AccountModelCapabilitiesModal.vue', 'utf8')
  it('refreshes group model CAS version after publishing and defaults reservation to one', () => {
    expect(groups).toContain('groupModels.value = await adminAPI.groups.listGroupModels')
    expect(groups).toContain('minimum_reservation_micros: 1')
    expect(groups).toContain("field === 'minimum_reservation_micros' ? 1 : 0")
  })
  it('uses only the unified model dialog for compatibility configuration and blocks invalid restores', () => {
    expect(groups).not.toContain('const createModelsListState')
    expect(groups).not.toContain('const editModelsListState')
    expect(groups).not.toContain('loadModelsListCandidates')
    expect(groups).toContain('modelsListCompatibilityState')
    expect(groups).toContain(':disabled="!model.global_model_enabled || restoringGroupModelId === model.model_id"')
    expect(groups).toContain('restoreGlobalDisabled')
    expect(groups).toContain('restoringGroupModelId.value = null')
  })

  it('disables and clears capabilities that the global model does not support', () => {
    expect(capabilities).toContain(':disabled="!applicable(row.model, cap)"')
    expect(capabilities).toContain('applicable(row.model,c)&&row[c]')
  })
})

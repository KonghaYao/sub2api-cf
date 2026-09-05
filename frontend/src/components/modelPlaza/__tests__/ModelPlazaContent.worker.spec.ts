import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAuthenticated: false }),
}))
vi.mock('vue-i18n', async () => ({
  ...(await vi.importActual<typeof import('vue-i18n')>('vue-i18n')),
  useI18n: () => ({ t: (key: string) => key }),
}))

import ModelPlazaContent from '../ModelPlazaContent.vue'
import type { ModelPlazaResponse } from '@/api/modelPlaza'

const FilterStub = {
  props: ['groups'],
  emits: ['update:groupId'],
  template: `
    <div>
      <button
        v-for="group in groups"
        :key="group.id"
        :data-test="'choose-' + group.id"
        @click="$emit('update:groupId', group.id)"
      >{{ group.name }}</button>
    </div>
  `,
}

const GroupStub = {
  props: ['group'],
  template: '<div :data-test="\'visible-\' + group.id">{{ group.models.map(m => m.name).join(",") }}</div>',
}

describe('ModelPlazaContent Worker payload', () => {
  it('renders public aliases and filters opaque Worker group IDs without coercion', async () => {
    const response: ModelPlazaResponse = {
      description: 'Worker catalog',
      groups: [
        plazaGroup('a1111111-1111-4111-8111-111111111111', 'Public', 'friendly-alias'),
        plazaGroup(7, 'Legacy', 'legacy-model'),
      ],
    }
    const wrapper = mount(ModelPlazaContent, {
      props: { response, loading: false },
      global: { stubs: {
        PlazaFilterBar: FilterStub,
        PlazaGroupSection: GroupStub,
        Icon: true,
      } },
    })

    expect(wrapper.text()).toContain('friendly-alias')
    expect(wrapper.text()).toContain('legacy-model')
    await wrapper.get('[data-test="choose-a1111111-1111-4111-8111-111111111111"]').trigger('click')
    expect(wrapper.find('[data-test="visible-a1111111-1111-4111-8111-111111111111"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="visible-7"]').exists()).toBe(false)
  })
})

function plazaGroup(id: string | number, name: string, model: string) {
  return {
    id, name, description: '', platform: 'openai', subscription_type: 'standard',
    rate_multiplier: 1, peak_rate_enabled: false, peak_start: '', peak_end: '',
    peak_rate_multiplier: 1, is_exclusive: false, image_rate_independent: false,
    image_rate_multiplier: 1, long_context_pricing_enabled: false,
    models: [{ name: model, platform: 'openai', pricing: null, official_pricing: null }],
  }
}

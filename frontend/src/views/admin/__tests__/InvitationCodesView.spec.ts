import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { InvitationCode } from '@/api/admin/invitationCodes'

const listInvitationCodes = vi.hoisted(() => vi.fn())
const createInvitationCode = vi.hoisted(() => vi.fn())
const updateInvitationCode = vi.hoisted(() => vi.fn())
const deleteInvitationCode = vi.hoisted(() => vi.fn())
const listInvitationCodeUsages = vi.hoisted(() => vi.fn())
const showSuccess = vi.hoisted(() => vi.fn())
const showError = vi.hoisted(() => vi.fn())
const writeText = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showSuccess, showError }),
}))

vi.mock('@/api/admin/invitationCodes', () => ({
  listInvitationCodes,
  createInvitationCode,
  updateInvitationCode,
  deleteInvitationCode,
  listInvitationCodeUsages,
  default: {
    list: listInvitationCodes,
    create: createInvitationCode,
    update: updateInvitationCode,
    delete: deleteInvitationCode,
    listUsages: listInvitationCodeUsages,
  },
}))

import InvitationCodesView from '../InvitationCodesView.vue'

let currentCode: InvitationCode

beforeEach(() => {
  currentCode = invitationCode()
  listInvitationCodes.mockReset().mockImplementation(async () => ({
    items: [currentCode], total: 1, page: 1, page_size: 20, pages: 1,
  }))
  createInvitationCode.mockReset().mockResolvedValue(invitationCode({ id: 'created-uuid' }))
  updateInvitationCode.mockReset().mockImplementation(async (
    _id: string,
    version: number,
    patch: Partial<InvitationCode>,
  ) => {
    currentCode = invitationCode({ ...currentCode, ...patch, control_version: version + 1 })
    return currentCode
  })
  deleteInvitationCode.mockReset().mockResolvedValue({ message: 'deleted' })
  listInvitationCodeUsages.mockReset().mockResolvedValue({
    items: [{
      id: 'usage-uuid',
      invitation_code_id: currentCode.id,
      user_id: 'user-uuid',
      used_at: '2026-09-05T03:00:00.000Z',
      user: { id: 'user-uuid', email: 'invitee@example.test', username: 'Invitee' },
    }],
    total: 1,
    page: 1,
    page_size: 20,
    pages: 1,
  })
  showSuccess.mockReset()
  showError.mockReset()
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

describe('InvitationCodesView', () => {
  it('lists and searches invitation codes through the Worker API', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('TEAM-2026')
    expect(listInvitationCodes).toHaveBeenLastCalledWith({
      page: 1,
      page_size: 20,
      status: undefined,
      search: undefined,
    })

    await wrapper.get('[data-testid="invitation-search"]').setValue('team')
    await wrapper.get('[data-testid="invitation-search-submit"]').trigger('click')
    await flushPromises()

    expect(listInvitationCodes).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      search: 'team',
    }))
  })

  it('creates, edits, and deletes an unused UUID invitation code', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('[data-testid="invitation-create-open"]').trigger('click')
    await wrapper.get('[data-testid="invitation-create-code"]').setValue('FRIENDS')
    await wrapper.get('[data-testid="invitation-create-max-uses"]').setValue(3)
    await wrapper.get('#invitation-create-form').trigger('submit')
    await flushPromises()
    expect(createInvitationCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'FRIENDS',
      max_uses: 3,
    }))

    await wrapper.get('[data-testid="invitation-edit-invite-uuid"]').trigger('click')
    await wrapper.get('[data-testid="invitation-edit-status"]').setValue('disabled')
    await wrapper.get('[data-testid="invitation-edit-max-uses"]').setValue(8)
    await wrapper.get('#invitation-edit-form').trigger('submit')
    await flushPromises()
    expect(updateInvitationCode).toHaveBeenCalledWith(
      'invite-uuid',
      2,
      expect.objectContaining({ status: 'disabled', max_uses: 8 }),
    )

    await wrapper.get('[data-testid="invitation-delete-invite-uuid"]').trigger('click')
    await wrapper.get('[data-testid="confirm-invitation-delete"]').trigger('click')
    await flushPromises()
    expect(deleteInvitationCode).toHaveBeenCalledWith('invite-uuid', 3)
  })

  it('shows usage records and copies a registration link', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('[data-testid="invitation-usages-invite-uuid"]').trigger('click')
    await flushPromises()
    expect(listInvitationCodeUsages).toHaveBeenCalledWith('invite-uuid', {
      page: 1,
      page_size: 20,
    })
    expect(wrapper.get('[data-testid="invitation-usage-records"]').text()).toContain(
      'invitee@example.test',
    )

    await wrapper.get('[data-testid="invitation-copy-link-invite-uuid"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/register?invitation_code=TEAM-2026`,
    )
  })
})

function mountView() {
  return mount(InvitationCodesView, {
    global: {
      stubs: {
        AppLayout: { template: '<main><slot /></main>' },
        BaseDialog: {
          props: ['show'],
          template: '<section v-if="show"><slot /><slot name="footer" /></section>',
        },
        ConfirmDialog: {
          props: ['show'],
          emits: ['confirm', 'cancel'],
          template: '<button v-if="show" data-testid="confirm-invitation-delete" @click="$emit(\'confirm\')">confirm</button>',
        },
        Icon: true,
        Pagination: true,
      },
    },
  })
}

function invitationCode(overrides: Partial<InvitationCode> = {}): InvitationCode {
  return {
    id: 'invite-uuid',
    code: 'TEAM-2026',
    max_uses: 5,
    used_count: 0,
    status: 'active',
    expires_at: null,
    notes: 'Partner event',
    control_version: 2,
    created_at: '2026-09-05T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
    ...overrides,
  }
}

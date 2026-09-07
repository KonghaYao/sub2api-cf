import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import UserErrorRequestsTable from '../UserErrorRequestsTable.vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))

const DataTableStub = defineComponent({
  name: 'DataTable',
  props: {
    columns: Array,
    data: Array,
    loading: Boolean,
    serverSideSort: Boolean,
    defaultSortKey: String,
    defaultSortOrder: String,
  },
  emits: ['sort', 'rowClick'],
  template: `<div>
    <button data-testid="sort-status" @click="$emit('sort', 'status', 'asc')" />
    <button data-testid="open-row" @click="$emit('rowClick', data[0])" />
  </div>`,
})

const PaginationStub = defineComponent({
  name: 'Pagination',
  props: ['page', 'pageSize', 'total'],
  emits: ['update:page', 'update:pageSize'],
  template: `<div>
    <button data-testid="page" @click="$emit('update:page', 2)" />
    <button data-testid="page-size" @click="$emit('update:pageSize', 50)" />
  </div>`,
})

const DetailStub = defineComponent({
  name: 'UserErrorDetailModal',
  props: ['show', 'errorId'],
  emits: ['update:show'],
  template: '<div />',
})

function mountTable() {
  return mount(UserErrorRequestsTable, {
    props: {
      rows: [{
        id: 'error_opaque', created_at: '2026-09-07T00:00:00.000Z', model: 'gpt-5',
        inbound_endpoint: '/v1/responses', status_code: 502, category: 'upstream',
        platform: 'openai', message: 'failed', key_name: 'My key', key_deleted: false,
      }],
      total: 75,
      loading: false,
      page: 1,
      pageSize: 20,
    },
    global: {
      stubs: {
        DataTable: DataTableStub,
        Pagination: PaginationStub,
        UserErrorDetailModal: DetailStub,
        IpGeoBatchToolbar: true,
        IpGeoCell: true,
        EmptyState: true,
      },
    },
  })
}

describe('UserErrorRequestsTable original interactions', () => {
  it('delegates sorting to the server and maps the visible status column', async () => {
    const wrapper = mountTable()
    const table = wrapper.findComponent(DataTableStub)
    expect(table.props()).toMatchObject({
      serverSideSort: true,
      defaultSortKey: 'created_at',
      defaultSortOrder: 'desc',
    })
    expect((table.props('columns') as Array<{ key: string; sortable?: boolean }>))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'model', sortable: true }),
        expect.objectContaining({ key: 'status', sortable: true }),
        expect.objectContaining({ key: 'created_at', sortable: true }),
      ]))

    await wrapper.get('[data-testid="sort-status"]').trigger('click')
    expect(wrapper.emitted('sort')).toEqual([['status_code', 'asc']])
  })

  it('preserves total pagination, page-size changes, and opaque detail IDs', async () => {
    const wrapper = mountTable()
    expect(wrapper.findComponent(PaginationStub).props()).toMatchObject({
      page: 1, pageSize: 20, total: 75,
    })

    await wrapper.get('[data-testid="page"]').trigger('click')
    await wrapper.get('[data-testid="page-size"]').trigger('click')
    await wrapper.get('[data-testid="open-row"]').trigger('click')

    expect(wrapper.emitted('update:page')).toEqual([[2]])
    expect(wrapper.emitted('update:pageSize')).toEqual([[50]])
    expect(wrapper.findComponent(DetailStub).props()).toMatchObject({
      show: true,
      errorId: 'error_opaque',
    })
  })
})

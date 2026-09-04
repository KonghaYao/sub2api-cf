import { computed, shallowRef, type Ref } from 'vue'

interface UseTableSelectionOptions<T, ID extends string | number = number> {
  rows: Ref<T[]>
  getId: (row: T) => ID
  isSelectable?: (row: T) => boolean
}

export function useTableSelection<T, ID extends string | number = number>({
  rows,
  getId,
  isSelectable = () => true
}: UseTableSelectionOptions<T, ID>) {
  const selectedSet = shallowRef<Set<ID>>(new Set())

  const selectedIds = computed(() => Array.from(selectedSet.value))
  const selectedCount = computed(() => selectedSet.value.size)

  const isSelected = (id: ID) => selectedSet.value.has(id)

  const replaceSelectedSet = (next: Set<ID>) => {
    selectedSet.value = next
  }

  const setSelectedIds = (ids: ID[]) => {
    selectedSet.value = new Set(ids)
  }

  const select = (id: ID) => {
    if (selectedSet.value.has(id)) return
    const next = new Set(selectedSet.value)
    next.add(id)
    replaceSelectedSet(next)
  }

  const deselect = (id: ID) => {
    if (!selectedSet.value.has(id)) return
    const next = new Set(selectedSet.value)
    next.delete(id)
    replaceSelectedSet(next)
  }

  const toggle = (id: ID) => {
    if (selectedSet.value.has(id)) {
      deselect(id)
      return
    }
    select(id)
  }

  const clear = () => {
    if (selectedSet.value.size === 0) return
    replaceSelectedSet(new Set())
  }

  const removeMany = (ids: ID[]) => {
    if (ids.length === 0 || selectedSet.value.size === 0) return
    const next = new Set(selectedSet.value)
    let changed = false
    ids.forEach((id) => {
      if (next.delete(id)) changed = true
    })
    if (changed) replaceSelectedSet(next)
  }

  const allVisibleSelected = computed(() => {
    if (rows.value.length === 0) return false
    const selectableRows = rows.value.filter(isSelectable)
    if (selectableRows.length === 0) return false
    return selectableRows.every((row) => selectedSet.value.has(getId(row)))
  })

  const toggleVisible = (checked: boolean) => {
    const next = new Set(selectedSet.value)
    rows.value.forEach((row) => {
      if (!isSelectable(row)) return
      const id = getId(row)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
    })
    replaceSelectedSet(next)
  }

  const batchUpdate = (updater: (draft: Set<ID>) => void) => {
    const draft = new Set(selectedSet.value)
    updater(draft)
    replaceSelectedSet(draft)
  }

  const selectVisible = () => {
    toggleVisible(true)
  }

  return {
    selectedSet,
    selectedIds,
    selectedCount,
    allVisibleSelected,
    isSelected,
    setSelectedIds,
    select,
    deselect,
    toggle,
    clear,
    removeMany,
    toggleVisible,
    selectVisible,
    batchUpdate
  }
}

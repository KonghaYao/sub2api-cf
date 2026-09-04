import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('global admin step-up recovery', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('coalesces concurrent admin failures into one prompt', async () => {
    const { registerAdminStepUpPrompt, requestAdminStepUp } = await import('../adminStepUpRecovery')
    let resolvePrompt!: (value: boolean) => void
    const prompt = vi.fn(() => new Promise<boolean>((resolve) => {
      resolvePrompt = resolve
    }))
    const unregister = registerAdminStepUpPrompt(prompt)

    const first = requestAdminStepUp()
    const second = requestAdminStepUp()
    expect(prompt).toHaveBeenCalledOnce()
    resolvePrompt(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    unregister()
    await expect(requestAdminStepUp()).resolves.toBeNull()
  })
})

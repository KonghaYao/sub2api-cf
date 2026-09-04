type AdminStepUpPrompt = () => Promise<boolean>

let activePrompt: AdminStepUpPrompt | null = null
let pendingPrompt: Promise<boolean> | null = null

/** Register the single app-level TOTP prompt used to recover admin mutations. */
export function registerAdminStepUpPrompt(prompt: AdminStepUpPrompt): () => void {
  activePrompt = prompt
  return () => {
    if (activePrompt === prompt) activePrompt = null
  }
}

/** Coalesce concurrent step-up failures into one verification dialog. */
export function requestAdminStepUp(): Promise<boolean | null> {
  if (pendingPrompt !== null) return pendingPrompt
  if (activePrompt === null) return Promise.resolve(null)
  pendingPrompt = activePrompt().finally(() => {
    pendingPrompt = null
  })
  return pendingPrompt
}

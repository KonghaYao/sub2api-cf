import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function originalAccountModels() {
  const result = {}
  const fields = { ID: 'id', Object: 'object', Type: 'type', DisplayName: 'display_name', CreatedAt: 'created_at', Created: 'created', OwnedBy: 'owned_by' }
  for (const [platform, path] of Object.entries({ openai: 'openai/constants.go', anthropic: 'claude/constants.go', gemini: 'geminicli/models.go' })) {
    const go = readFileSync(resolve(root, 'backend/internal/pkg', path), 'utf8')
    const block = go.match(/var DefaultModels = \[\]Model\{([\s\S]*?)\n\}/)?.[1]
    if (!block) throw new Error(`No model defaults in ${path}`)
    result[platform] = [...block.matchAll(/\{([^{}]+)\}/g)].map(([, entry]) => {
      const model = {}
      for (const [, key, raw] of entry.matchAll(/(\w+):\s*("(?:[^"\\]|\\.)*"|\d+)/g)) {
        if (!(key in fields)) throw new Error(`Unmapped field ${key}`)
        model[fields[key]] = JSON.parse(raw)
      }
      if (typeof model.id !== 'string') throw new Error(`Missing model ID in ${path}`)
      return model
    })
  }
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(resolve(root, 'worker/src/control/account-model-defaults.ts'),
    '// Generated from the original Go model catalogs by scripts/account-model-defaults.mjs.\n' +
    'export const DEFAULT_ACCOUNT_MODELS = ' + JSON.stringify(originalAccountModels(), null, 2) + ' as const\n')
}

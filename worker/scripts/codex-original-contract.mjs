import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = path => readFileSync(resolve(root, 'backend/internal', path), 'utf8')
const source = read('service/openai_codex_transform.go')
const block = source.match(/var codexModelMap = map\[string\]string\{([\s\S]*?)\n\}/)?.[1]
if (!block) throw new Error('Missing original Codex model aliases')
const aliases = Object.fromEntries([...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(match => [match[1], match[2]]))
const version = read('service/openai_gateway_service.go').match(/codexCLIVersion = "([^"]+)"/)?.[1]
const originator = read('pkg/openai/request.go').match(/const CodexDefaultOriginator = "([^"]+)"/)?.[1]
if (!version || !originator || !aliases['gpt-5.3']) throw new Error('Incomplete original Codex contract')
writeFileSync(resolve(root, 'worker/src/gateway/codex-original-contract.ts'),
  '// Generated from original Go sources by scripts/codex-original-contract.mjs.\n' +
  `export const CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = ${JSON.stringify(aliases, null, 2)}\n` +
  `export const CODEX_VERSION = ${JSON.stringify(version)}\n` +
  `export const CODEX_ORIGINATOR = ${JSON.stringify(originator)}\n` +
  `export const CODEX_DEFAULT_INSTRUCTIONS = ${JSON.stringify(read('pkg/openai/instructions.txt'))}\n`)

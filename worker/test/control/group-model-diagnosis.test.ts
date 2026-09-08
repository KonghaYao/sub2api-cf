import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diagnoseAdminGroupModel } from '../../src/control/catalog'
import { modelCapabilityCompatibleSql } from '../../src/gateway/account-model-policy'

describe('group model routing diagnosis contract', () => {
  const diagnosis = diagnoseAdminGroupModel.toString()
  const catalogSource = readFileSync('src/control/catalog.ts', 'utf8')
  const repositorySource = readFileSync('src/gateway/repository.ts', 'utf8')
  const compatibility = modelCapabilityCompatibleSql()

  it('shares the exact capability compatibility SQL with gateway discovery', () => {
    expect(catalogSource).toContain('modelCapabilityCompatibleSql()')
    expect(repositorySource).toContain('modelCapabilityCompatibleSql()')
    expect(compatibility).toContain('WHEN m.image_generation = 1 THEN am.image_generation = 1')
    expect(compatibility).toContain('WHEN m.embeddings = 1 THEN am.embeddings = 1')
    expect(compatibility).toContain("WHEN m.endpoint = 'chat_completions'")
    expect(compatibility).toContain("WHEN m.endpoint = 'responses'")
  })

  it('applies platform, catalog and runtime availability checks', () => {
    expect(diagnosis).toContain('a.platform=m.platform')
    expect(diagnosis).toContain('row.catalog_mode === "allowlist"')
    expect(diagnosis).toContain('original_model_routing')
    expect(diagnosis).toContain('rate_limit_reset_at')
    expect(diagnosis).toContain('temp_unschedulable_until')
  })

  it('allows composite groups without weakening model/account platform compatibility', () => {
    expect(diagnosis).toContain('row.group_platform !== "composite"')
    expect(repositorySource).toContain("g.platform = 'composite'")
    expect(compatibility).toContain("a.platform IN ('openai', 'codex', 'grok', 'antigravity')")
  })
})

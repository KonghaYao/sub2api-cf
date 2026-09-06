export interface CutoverArtifactManifest {
  readonly schema: 'sub2api-cloudflare-cutover-artifacts'
  readonly version: 1
  readonly snapshot_id: string
  readonly source_manifest_sha256: string
  readonly artifacts: ReadonlyArray<{
    readonly logical_name: string
    readonly kind: string
    readonly bytes: number
    readonly sha256: string
  }>
}

export interface ReconciliationReport {
  readonly schema: 'sub2api-cutover-reconciliation'
  readonly version: 1
  readonly status: 'passed' | 'failed'
  readonly domains: Readonly<Record<string, unknown>>
}

export function loadAndValidateCutover(manifestPath: string): Promise<unknown>
export function buildCutover(options: { manifestPath: string; outputDirectory: string }): Promise<CutoverArtifactManifest>
export function reconcileCutover(options: { expectedManifestPath: string; actualManifestPath: string; artifactManifestPath: string; previousActivationPath: string; freezeProofPath: string; finalDeltaProofPath: string; stage: string; outputPath: string }): Promise<ReconciliationReport>
export function advanceOwnership(options: { planPath: string; stage: string; gatePath: string; artifactManifestPath: string; reconciliationArtifactManifestPath: string; previousActivationPath: string; evidencePath: string; sourceManifestPath: string; outputPath: string }): Promise<unknown>
export function runCli(argv: string[]): Promise<number>

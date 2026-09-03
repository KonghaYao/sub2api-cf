export function resolveBuildOutDir(mode: string): string {
  return mode === 'cloudflare' ? 'dist' : '../backend/internal/web/dist'
}

# Frontend builds

- `pnpm build` builds the legacy Go-embedded assets into `../backend/internal/web/dist`.
- `pnpm build:cloudflare` builds Cloudflare Workers Static Assets into `./dist`.

Both commands share `vite.config.ts`; the Cloudflare output is selected by Vite's
`cloudflare` mode.

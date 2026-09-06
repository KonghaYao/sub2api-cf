import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { unstable_startWorker } from 'wrangler'
import { reserveLoopbackPort, workerOriginBindings } from './runtime.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workerDirectory = resolve(scriptDirectory, '../..')
const repositoryDirectory = resolve(workerDirectory, '..')
const frontendDirectory = join(repositoryDirectory, 'frontend')
const configPath = join(workerDirectory, 'wrangler.browser-e2e.jsonc')
const persistenceDirectory = await mkdtemp(join(tmpdir(), 'sub2api-browser-e2e-'))
const portReservation = await reserveLoopbackPort()
const { origin, port } = portReservation

let worker
let shuttingDown = false

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryDirectory,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

function upstreamResponse(request) {
  const url = new URL(request.url)
  if (
    url.origin !== 'https://upstream.browser-e2e.invalid' ||
    url.pathname !== '/v1/chat/completions' ||
    request.method !== 'POST'
  ) {
    return Response.json({ error: 'unexpected browser E2E outbound request' }, { status: 502 })
  }

  return request.json().then((body) => {
    if (
      body?.model !== 'gpt-browser-e2e-upstream' ||
      body?.stream !== false ||
      body?.messages?.[0]?.content !== 'Say browser-gateway-ok.'
    ) {
      return Response.json({ error: 'unexpected Chat request', body }, { status: 422 })
    }
    return Response.json({
      id: 'chatcmpl-browser-e2e',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-browser-e2e-upstream',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'browser-gateway-ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })
}

async function waitForReady() {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
      lastError = new Error(`readiness returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error('Worker did not become ready within 30 seconds', { cause: lastError })
}

async function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  await portReservation.release().catch(() => {})
  await worker?.dispose().catch(() => {})
  await rm(persistenceDirectory, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130))
  })
}

try {
  console.log('[browser-e2e] building frontend assets')
  await run('pnpm', ['run', 'build:cloudflare'], { cwd: frontendDirectory })
  console.log('[browser-e2e] applying D1 migrations to isolated local state')
  await run(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      'wrangler.browser-e2e.jsonc',
      '--persist-to',
      persistenceDirectory,
    ],
    { cwd: workerDirectory },
  )

  console.log('[browser-e2e] starting local Worker')
  await portReservation.release()
  worker = await unstable_startWorker({
    config: configPath,
    bindings: workerOriginBindings(origin),
    dev: {
      remote: false,
      server: { hostname: '127.0.0.1', port, secure: false },
      inspector: false,
      persist: persistenceDirectory,
      watch: false,
      logLevel: 'warn',
      outboundService: upstreamResponse,
    },
  })
  await worker.ready
  console.log(`[browser-e2e] Worker listening at ${await worker.url}`)
  await waitForReady()

  console.log('[browser-e2e] running Playwright')
  await run('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.config.ts'], {
    cwd: frontendDirectory,
    env: { WORKER_BROWSER_E2E_ORIGIN: origin },
  })
} finally {
  await cleanup()
}

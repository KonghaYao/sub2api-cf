import { inspectAgentTaskResponse } from '../gateway/agent-task-response'
import type { Env } from '../env'
import { type ProviderAccount } from '../gateway/providers'
import type { UpstreamCredential } from '../gateway/types'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { CODEX_DEFAULT_INSTRUCTIONS } from '../gateway/codex-original-contract'
import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import { claudeTextDiagnosticRequest } from './claude-text-diagnostic'
import { acceptGeminiDiagnosticEvent, geminiDiagnosticRequest } from './gemini-text-diagnostic'
import { acceptOpenAIImageDiagnosticResult, createOpenAIImageDiagnosticCollector, isOpenAIImageDiagnosticModel, openAIImageDiagnosticRequest } from './openai-image-diagnostic'

export { accountUsesResponses as diagnosticUsesResponses } from '../gateway/account-openai-protocol'

/** Original account modal TestEvent stream, backed by a real provider request. */
export function accountTextDiagnostic(env: Env, account: ProviderAccount, credential: UpstreamCredential,
  model: string, proxyId: unknown, clientSignal: AbortSignal,
  options: { recoverAgent?: (taskId:string)=>Promise<{credential:UpstreamCredential;authorization:string}>; authorization?: string; responses?: boolean; prompt?: string; oauth?: boolean; anthropicBearer?: boolean; anthropicCredentialKind?: 'api_key' | 'oauth' | 'setup_token'; onResponse?: (response: Response) => Promise<void> } = {}): Response {
  let authorization=options.authorization
  const anthropic = account.platform === 'anthropic'
  const gemini = account.platform === 'gemini'
  const oauth = options.oauth === true || account.platform === 'codex'
  const openaiImage = (account.platform === 'openai' || account.platform === 'codex') && isOpenAIImageDiagnosticModel(model)
  const imageJson = openaiImage && !oauth
  const responses = oauth || options.responses !== false
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, clientSignal, AbortSignal.timeout(60000)])
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: Record<string, unknown>) => { if (!abort.signal.aborted && !clientSignal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
      void (async () => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          emit({ type: 'test_start', model })
          const buildPlan = () => anthropic ? claudeTextDiagnosticRequest(account, credential, model, options.anthropicBearer, options.anthropicCredentialKind)
            : gemini ? geminiDiagnosticRequest(account, credential, model, options.prompt)
            : openaiImage ? openAIImageDiagnosticRequest(account, credential, model, options.prompt, oauth, authorization)
            : buildAccountProviderRequest({ account: { ...account, credential_kind: oauth ? 'oauth' : 'api_key' }, credential, authorization,
            operation: responses ? 'responses' : 'chat_completions', model,
            body: responses ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
              instructions: CODEX_DEFAULT_INSTRUCTIONS, stream: true, ...(oauth ? { store: false } : {}) }
              : { model, messages: [{ role: 'user', content: options.prompt?.trim() || 'hi' }], stream: true } })
          let plan=buildPlan()
          const send=async()=>{
          const init: RequestInit = { method: plan.method, headers: plan.headers, body: JSON.stringify(plan.body), redirect: 'manual', signal }
          return proxyId != null && String(proxyId) !== '0'
            ? await fetchAccountProxy(env, String(proxyId), new URL(plan.url), init, signal) : await fetch(plan.url, init)
          }
          let response=await send()
          if(authorization) {
            let inspected=await inspectAgentTaskResponse(response,credential as unknown as Record<string,unknown>)
            response=inspected.response
            if(inspected.taskInvalid && options.recoverAgent && !signal.aborted) {
              const task=(credential as unknown as Record<string,unknown>).task_id
              const fresh=await options.recoverAgent(typeof task==='string'?task:'')
              credential=fresh.credential;authorization=fresh.authorization
              if(signal.aborted) throw new Error('aborted')
              plan=buildPlan();response=await send()
              inspected=await inspectAgentTaskResponse(response,credential as unknown as Record<string,unknown>)
              response=inspected.response
            }
          }
          if (options.onResponse) await options.onResponse(response)
          if (!response.ok || !response.body) {
            void response.body?.cancel().catch(() => undefined)
            throw new Error(`Upstream diagnostic returned HTTP ${response.status}`)
          }
          const textJson = !anthropic && !gemini && !openaiImage &&
            /(?:application\/json|\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = '', completed = false, sawText = false, bytes = 0, seenFinish = false
          const acceptImage = createOpenAIImageDiagnosticCollector(emit)
          const accept = (raw: string) => {
            if (!raw) return
            if (raw === '[DONE]') { if (anthropic || gemini || !responses) completed = true; return }
            const event = JSON.parse(raw) as Record<string, unknown>
            if (openaiImage) { completed = acceptImage.accept(event); return }
            if (gemini) { completed = acceptGeminiDiagnosticEvent(event, emit); return }
            if (anthropic) {
              if (event.type === 'error') throw new Error('Upstream diagnostic failed')
              if (event.type === 'content_block_delta' && event.delta && typeof event.delta === 'object' &&
                  'text' in event.delta && typeof event.delta.text === 'string') emit({ type: 'content', text: event.delta.text })
              if (event.type === 'message_stop') completed = true
              return
            }
            if (!responses) {
              if (event.error) throw new Error('Upstream diagnostic failed')
              if (Array.isArray(event.choices)) for (const choice of event.choices) {
                if (typeof choice?.delta?.content === 'string') emit({ type: 'content', text: choice.delta.content })
                if (typeof choice?.message?.content === 'string') emit({ type: 'content', text: choice.message.content })
                if (typeof choice?.finish_reason === 'string' && choice.finish_reason) seenFinish = true
              }
              return
            }
            if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('Upstream diagnostic failed')
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
              sawText = true; emit({ type: 'content', text: event.delta })
            }
            if (event.type === 'response.completed') {
              const result = event.response as Record<string, unknown> | undefined
              if (!result || result.status !== 'completed' || result.error) throw new Error('Invalid diagnostic completion')
              if (!sawText && Array.isArray(result.output)) for (const item of result.output) {
                if (Array.isArray(item?.content)) for (const part of item.content) {
                  if (part?.type === 'output_text' && typeof part.text === 'string') emit({ type: 'content', text: part.text })
                }
              }
              completed = true
            }
          }
          const acceptFrame = (frame: string) => accept(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
          while (!completed) {
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > (gemini || openaiImage ? 16 : 4) * 1024 * 1024) throw new Error('Diagnostic response exceeded its limit')
            if (imageJson || textJson) { buffer += decoder.decode(next.value, { stream: true }); continue }
            buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n')
            let end: number
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
              acceptFrame(frame)
              if (completed) break
            }
          }
          // Compatible Chat relays may close after the final data line without
          // an extra blank separator. Process the residual frame before judging EOF.
          if (!imageJson && !textJson && !completed) {
            buffer += decoder.decode()
            if (buffer.trim()) acceptFrame(buffer)
          }
          if (textJson) {
            const result = JSON.parse(buffer + decoder.decode()) as Record<string, unknown> | null
            if (!result || Array.isArray(result) || result.error) throw new Error('Upstream diagnostic failed')
            if (responses) {
              if (!Array.isArray(result.output)) throw new Error('Upstream diagnostic returned invalid JSON completion')
              accept(JSON.stringify({ type: 'response.completed', response: result }))
            } else {
              if (!Array.isArray(result.choices) || result.choices.length === 0 || result.choices.some(choice =>
                !choice?.message || typeof choice.message !== 'object' || Array.isArray(choice.message))) {
                throw new Error('Upstream diagnostic returned invalid JSON completion')
              }
              accept(JSON.stringify(result))
              completed = true
            }
          }
          if (imageJson) {
            acceptOpenAIImageDiagnosticResult(JSON.parse(buffer + decoder.decode()), emit)
            completed = true
          }
          // Original image collector accepts a finished image item even when
          // the provider omits the terminal envelope. Partial images never count.
          if (openaiImage && oauth && !completed) completed = acceptImage.finish()
          if (!completed && !(seenFinish && !responses)) throw new Error('Upstream diagnostic ended without a completion event')
          emit({ type: 'test_complete', success: true })
        } catch (error) {
          if (!abort.signal.aborted && !clientSignal.aborted) emit({ type: 'test_complete', success: false,
            error: error instanceof Error && error.message.startsWith('Upstream diagnostic') ? error.message : 'Upstream diagnostic request failed' })
        } finally {
          // A terminal diagnostic must close even if upstream cancellation never resolves.
          try { void reader?.cancel().catch(() => undefined) } catch { /* Keep the diagnostic result. */ }
          reader?.releaseLock()
          try { controller.close() } catch { /* Consumer already cancelled. */ }
        }
      })()
    },
    cancel() { abort.abort() },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', 'x-accel-buffering': 'no' } })
}

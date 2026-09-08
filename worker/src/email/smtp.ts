import type { SmtpConfig } from './config'

export interface SmtpMessage { to: string; subject: string; text: string; html: string; eventId: string }
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>
  close(): Promise<void>; startTls(): SmtpSocket
}
export type SmtpConnect = (address: { hostname: string; port: number }, options: { secureTransport: 'on' | 'starttls' }) => SmtpSocket
export class SmtpError extends Error { constructor(readonly code: string) { super(code) } }

/** Bounded SMTP exchange. Provider responses and credentials never enter thrown errors. */
export async function smtpExchange(config: SmtpConfig, message?: SmtpMessage, connector?: SmtpConnect): Promise<void> {
  if (!config.smtp_host) throw new SmtpError('smtp_host_required')
  if (config.smtp_port === 25) throw new SmtpError('smtp_port_25_not_supported')
  const connect = connector ?? (await import('cloudflare:sockets')).connect as unknown as SmtpConnect
  let socket = connect({ hostname: config.smtp_host, port: config.smtp_port }, { secureTransport: config.smtp_port === 465 ? 'on' : 'starttls' })
  let reader = socket.readable.getReader()
  let writer = socket.writable.getWriter()
  let buffer = ''
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    const reply = async (codes: number[]): Promise<string> => {
      let response = ''
      while (true) {
        let end = buffer.indexOf('\r\n')
        while (end < 0) {
          const chunk = await reader.read()
          if (chunk.done) throw new SmtpError('smtp_connection_closed')
          buffer += decoder.decode(chunk.value, { stream: true })
          if (buffer.length > 16384) throw new SmtpError('smtp_response_too_large')
          end = buffer.indexOf('\r\n')
        }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (!/^\d{3}[ -]/.test(line)) throw new SmtpError('smtp_invalid_response')
        response += line + '\n'
        if (response.length > 16384) throw new SmtpError('smtp_response_too_large')
        if (line[3] === ' ') {
          if (!codes.includes(Number(line.slice(0, 3)))) throw new SmtpError(`smtp_rejected_${line.slice(0, 3)}`)
          return response
        }
      }
    }
    const command = async (value: string, codes: number[]) => { await writer.write(encoder.encode(value + '\r\n')); return reply(codes) }
    await reply([220])
    let capabilities = await command('EHLO sub2api', [250])
    let secured = config.smtp_port === 465
    if (!secured && /STARTTLS/i.test(capabilities)) {
      await command('STARTTLS', [220])
      reader.releaseLock(); writer.releaseLock()
      socket = socket.startTls(); reader = socket.readable.getReader(); writer = socket.writable.getWriter(); buffer = ''
      secured = true
      capabilities = await command('EHLO sub2api', [250])
    }
    if (!secured && (config.smtp_use_tls || config.smtp_username)) throw new SmtpError('smtp_tls_required')
    if (config.smtp_username) {
      if (/AUTH[^\n]*\bPLAIN\b/i.test(capabilities)) {
        await command(`AUTH PLAIN ${base64(`\0${config.smtp_username}\0${config.smtp_password}`)}`, [235])
      } else if (/AUTH[^\n]*\bLOGIN\b/i.test(capabilities)) {
        await command('AUTH LOGIN', [334]); await command(base64(config.smtp_username), [334]); await command(base64(config.smtp_password), [235])
      } else throw new SmtpError('smtp_auth_not_supported')
    }
    if (message) {
      if (!isAddress(config.smtp_from_email) || !isAddress(message.to)) throw new SmtpError('smtp_address_invalid')
      const mime = mimeMessage(config, message)
      await command(`MAIL FROM:<${config.smtp_from_email}>`, [250])
      await command(`RCPT TO:<${message.to}>`, [250, 251])
      await command('DATA', [354])
      await command(mime.replace(/(^|\r\n)\./g, '$1..') + '\r\n.', [250])
    }
    await command('QUIT', [221])
  }
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new SmtpError('smtp_timeout')); void socket.close().catch(() => {}) }, 10000)
    })])
  } catch (error) {
    throw error instanceof SmtpError ? error : new SmtpError('smtp_connection_failed')
  } finally {
    if (timer) clearTimeout(timer)
    await socket.close().catch(() => {})
  }
}
function base64(value: string): string { return btoa(Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join('')) }
function isAddress(value: string): boolean { return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && !/[\r\n\0]/.test(value) }
function mimeMessage(config: SmtpConfig, message: SmtpMessage): string {
  const boundary = `sub2api-${crypto.randomUUID()}`
  const wrap = (value: string) => base64(value).match(/.{1,76}/g)?.join('\r\n') ?? ''
  return [
    `From: =?UTF-8?B?${base64(config.smtp_from_name)}?= <${config.smtp_from_email}>`,
    `To: <${message.to}>`, `Subject: =?UTF-8?B?${base64(message.subject)}?=`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(message.text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(message.html), `--${boundary}--`, '',
  ].join('\r\n')
}

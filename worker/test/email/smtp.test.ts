import { describe, it, expect } from 'vitest'
import { smtpExchange, type SmtpSocket, type SmtpConnect } from '../../src/email/smtp'
import type { SmtpConfig } from '../../src/email/config'

const config: SmtpConfig = { smtp_host: 'smtp.example.test', smtp_port: 587, smtp_username: 'smtp-user', smtp_password: 'smtp-private-password', smtp_use_tls: true, smtp_from_email: 'sender@example.test', smtp_from_name: '测试站点' }
function server(options: { authReject?: boolean; noTLS?: boolean } = {}) {
  const commands: string[] = []
  const connections: unknown[] = []
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let secure = false
  let closed = false
  const send = (text: string) => controller.enqueue(new TextEncoder().encode(text))
  const socket: SmtpSocket = {
    readable: new ReadableStream({ start(value) { controller = value; send('220 ready\r\n') } }),
    writable: new WritableStream({ write(bytes) {
      const command = new TextDecoder().decode(bytes); commands.push(command)
      if (command.startsWith('EHLO')) send(!secure && !options.noTLS ? '250-server\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n' : '250 AUTH PLAIN LOGIN\r\n')
      else if (command.startsWith('STARTTLS')) send('220 upgrade\r\n')
      else if (command.startsWith('AUTH')) send(options.authReject ? '535 reject smtp-private-password\r\n' : '235 authenticated\r\n')
      else if (command.startsWith('DATA')) send('354 send data\r\n')
      else if (command.startsWith('QUIT')) send('221 bye\r\n')
      else send('250 accepted\r\n')
    } }),
    async close() { closed = true },
    startTls() { secure = true; return socket },
  }
  const connect: SmtpConnect = (address, options) => { connections.push({ address, options }); return socket }
  return { connect, commands, connections, closed: () => closed }
}
describe('bounded SMTP protocol', () => {
  it('upgrades STARTTLS before AUTH and sends a complete encoded MIME message', async () => {
    const smtp = server()
    await smtpExchange(config, { to: 'recipient@example.test', subject: '中文主题', text: 'plain body', html: '<p>HTML body</p>', eventId: 'event-1' }, smtp.connect)
    expect(smtp.commands.map((value) => value.split(' ')[0].trim())).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'From:', 'QUIT'])
    expect(smtp.commands[3]).toContain(btoa(`\0${config.smtp_username}\0${config.smtp_password}`))
    expect(smtp.commands[7]).toContain('Content-Type: multipart/alternative')
    expect(smtp.commands[7]).toContain(btoa('plain body'))
    expect(smtp.commands[7]).toContain(btoa('<p>HTML body</p>'))
    expect(smtp.closed()).toBe(true)
  })
  it('verifies SMTP authentication without sending mail during connection tests', async () => {
    const smtp = server()
    await smtpExchange(config, undefined, smtp.connect)
    expect(smtp.commands.some((value) => value.startsWith('AUTH'))).toBe(true)
    expect(smtp.commands.some((value) => value.startsWith('MAIL'))).toBe(false)
  })
  it('never sends a password when STARTTLS is unavailable, even when TLS toggle is false', async () => {
    const smtp = server({ noTLS: true })
    await expect(smtpExchange({ ...config, smtp_use_tls: false }, undefined, smtp.connect)).rejects.toMatchObject({ code: 'smtp_tls_required' })
    expect(smtp.commands.some((value) => value.startsWith('AUTH'))).toBe(false)
    expect(smtp.closed()).toBe(true)
  })
  it('redacts provider credential echoes from authentication failure', async () => {
    const smtp = server({ authReject: true })
    await expect(smtpExchange(config, undefined, smtp.connect)).rejects.toMatchObject({ message: 'smtp_rejected_535' })
    expect(smtp.closed()).toBe(true)
  })
})

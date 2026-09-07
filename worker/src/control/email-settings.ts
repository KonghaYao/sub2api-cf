import type { Context } from 'hono'
import type { Env } from '../env'
import { readSmtpConfig, mergeSmtpConfig, saveSmtpConfig } from '../email/config'
import { smtpExchange, SmtpError } from '../email/smtp'
import { TEMPLATE_EVENTS, TEMPLATE_LOCALES, officialTemplate, readEmailTemplate, renderTemplate, templateIdentity, validateTemplate } from '../email/templates'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject, requireExpectedControlVersion } from './http'

type C = Context<{ Bindings: Env }>
async function respond(action: () => Promise<unknown>): Promise<Response> {
  try { return controlSuccess(await action()) } catch (error) { return controlError(asGatewayError(error)) }
}
export function getEmailDeliverySettings(c: C): Promise<Response> {
  return respond(async () => {
    const { smtp_password: _, ...settings } = await readSmtpConfig(c.env, false)
    return settings
  })
}
export function updateEmailDeliverySettings(c: C): Promise<Response> {
  return respond(async () => {
    const body = await readJsonObject(c.req.raw, 16384)
    const expected = requireExpectedControlVersion(c.req.raw, body)
    const config = mergeSmtpConfig(await readSmtpConfig(c.env), body)
    await saveSmtpConfig(c.env, config, expected)
    const { smtp_password: _, ...settings } = await readSmtpConfig(c.env, false)
    return settings
  })
}
export function testSmtpConnection(c: C): Promise<Response> { return smtpTest(c, false) }
export function sendSmtpTestEmail(c: C): Promise<Response> { return smtpTest(c, true) }
function smtpTest(c: C, send: boolean): Promise<Response> {
  return respond(async () => {
    const body = await readJsonObject(c.req.raw, 16384)
    const config = mergeSmtpConfig(await readSmtpConfig(c.env), body)
    if (send && (typeof body.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(body.email))) throw new GatewayError(400, 'invalid_email', 'A valid test recipient is required')
    try {
      await smtpExchange(config, send ? { to: body.email as string, subject: 'Sub2API SMTP test', text: 'SMTP email delivery is working.', html: '<p>SMTP email delivery is working.</p>', eventId: crypto.randomUUID() } : undefined)
    } catch (error) {
      throw new GatewayError(502, error instanceof SmtpError ? error.code : 'smtp_connection_failed', 'SMTP connection or delivery failed; check the server, port, TLS and credentials')
    }
    return { message: send ? 'Test email sent successfully' : 'SMTP connection successful' }
  })
}
export function listEmailTemplates(c: C): Promise<Response> {
  return respond(async () => {
    const templates = await Promise.all(TEMPLATE_EVENTS.flatMap((event) => TEMPLATE_LOCALES.map((locale) => readEmailTemplate(c.env, event, locale))))
    return { events: TEMPLATE_EVENTS, locales: TEMPLATE_LOCALES, templates: templates.map(({ event, locale, subject, is_custom, updated_at }) => ({ event, locale, subject, is_custom, updated_at })), placeholders: [...new Set(templates.flatMap((template) => template.placeholders))] }
  })
}
export function getEmailTemplate(c: C): Promise<Response> {
  return respond(async () => { const { event, locale } = templateIdentity(c.req.param('event'), c.req.param('locale')); return readEmailTemplate(c.env, event, locale) })
}
export function updateEmailTemplate(c: C): Promise<Response> {
  return respond(async () => {
    const { event, locale } = templateIdentity(c.req.param('event'), c.req.param('locale'))
    const template = validateTemplate(event, locale, await readJsonObject(c.req.raw, 65536))
    await c.env.DB.prepare(`INSERT INTO email_template_overrides(event,locale,subject,html,updated_at_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(event,locale) DO UPDATE SET subject=excluded.subject,html=excluded.html,updated_at_ms=excluded.updated_at_ms`)
      .bind(event, locale, template.subject, template.html, Date.now()).run()
    return readEmailTemplate(c.env, event, locale)
  })
}
export function restoreOfficialEmailTemplate(c: C): Promise<Response> {
  return respond(async () => {
    const { event, locale } = templateIdentity(c.req.param('event'), c.req.param('locale'))
    await c.env.DB.prepare('DELETE FROM email_template_overrides WHERE event=? AND locale=?').bind(event, locale).run()
    return officialTemplate(event, locale)
  })
}
export function previewEmailTemplate(c: C): Promise<Response> {
  return respond(async () => {
    const body = await readJsonObject(c.req.raw, 65536)
    const { event, locale } = templateIdentity(body.event, body.locale)
    const template = validateTemplate(event, locale, body)
    const sample = Object.fromEntries(officialTemplate(event, locale).placeholders.map((field) => [field, `[${field}]`]))
    Object.assign(sample, { site_name: 'Sub2API', recipient_name: locale === 'zh' ? '张三' : 'Example user', recipient_email: 'user@example.com', verification_code: '123456', expires_in_minutes: '15', reset_url: 'https://example.com/reset-password?token=preview', action_url: 'https://example.com/verify?token=preview' })
    return renderTemplate(template, sample)
  })
}

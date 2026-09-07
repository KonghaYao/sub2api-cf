import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import official from './official-templates.json'

export const TEMPLATE_EVENTS = Object.keys(official)
export const TEMPLATE_LOCALES = ['en', 'zh']
export interface Template { event: string; locale: string; subject: string; html: string; is_custom: boolean; updated_at?: string; placeholders: string[] }
const source = official as Record<string, Record<string, { subject: string; html: string }>>
export function templateIdentity(event: unknown, locale: unknown): { event: string; locale: string } {
  if (typeof event !== 'string' || !TEMPLATE_EVENTS.includes(event)) throw new GatewayError(400, 'invalid_email_template_event', 'Unsupported email template event')
  if (typeof locale !== 'string' || !TEMPLATE_LOCALES.includes(locale)) throw new GatewayError(400, 'invalid_email_template_locale', 'Unsupported email template locale')
  return { event, locale }
}
export function officialTemplate(event: string, locale: string): Template {
  templateIdentity(event, locale)
  const value = source[event][locale]
  const placeholders = [...new Set([...`${value.subject}\n${value.html}`.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)].map((match) => match[1]).concat(['action_url', 'site_name', 'recipient_name', 'recipient_email']))]
  return { event, locale, ...value, is_custom: false, placeholders }
}
export async function readEmailTemplate(env: Pick<Env, 'DB'>, event: string, locale: string): Promise<Template> {
  const original = officialTemplate(event, locale)
  const row = await env.DB.prepare('SELECT subject,html,updated_at_ms FROM email_template_overrides WHERE event=? AND locale=?')
    .bind(event, locale).first<{ subject: string; html: string; updated_at_ms: number }>()
  return row ? { ...original, subject: row.subject, html: row.html, is_custom: true, updated_at: new Date(row.updated_at_ms).toISOString() } : original
}
export function validateTemplate(event: string, locale: string, body: Record<string, unknown>): { subject: string; html: string } {
  const original = officialTemplate(event, locale)
  if (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 200 || /[\r\n\0]/.test(body.subject)) throw new GatewayError(400, 'invalid_email_subject', 'Email subject is invalid')
  if (typeof body.html !== 'string' || !body.html.trim() || body.html.length > 30000) throw new GatewayError(400, 'invalid_email_html', 'Email HTML must be between 1 and 30000 characters')
  for (const match of `${body.subject}\n${body.html}`.matchAll(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g)) {
    if (!original.placeholders.includes(match[1])) throw new GatewayError(400, 'invalid_email_placeholder', `Unsupported placeholder: ${match[1]}`)
  }
  return { subject: body.subject.trim(), html: body.html }
}
export function renderTemplate(template: { subject: string; html: string }, variables: Record<string, string>): { subject: string; html: string } {
  const replace = (value: string, html: boolean) => value.replace(/{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g, (_, key: string) => html ? escapeHTML(variables[key] ?? '') : (variables[key] ?? '').replace(/[\r\n\0]/g, ''))
  return { subject: replace(template.subject, false), html: replace(template.html, true) }
}
function escapeHTML(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }

export function templateHTMLToText(html: string): string {
  return html.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replace(/\s+/g, ' ').trim()
}

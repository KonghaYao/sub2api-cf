import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '../../frontend/node_modules/typescript/lib/typescript.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.name === '__tests__' ? [] : entry.isDirectory() ? files(resolve(directory, entry.name))
      : /\.(ts|vue)$/.test(entry.name) ? [resolve(directory, entry.name)] : [])
}
function literal(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => `:param${span.literal.text}`).join('')
  return null
}
function visit(file, callback) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  function walk(node) { callback(node, source); ts.forEachChild(node, walk) }
  walk(source)
}
const routes = []
for (const file of files(resolve(root, 'worker/src'))) visit(file, node => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
  const method = node.expression.name.text.toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(method) || !node.arguments[0]) return
  const path = literal(node.arguments[0])
  if (!path?.startsWith('/api/v1/admin/')) return
  routes.push({ method, path: path.replace('/api/v1', ''), file: relative(root, file) })
})
function matches(pattern, path) {
  const left = pattern.split('/'), right = path.split('/')
  return left.length === right.length && left.every((value, index) => value.startsWith(':') || value === right[index])
}
const calls = []
for (const file of files(resolve(root, 'frontend/src/api'))) visit(file, (node, source) => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
  const method = node.expression.name.text.toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !node.arguments[0]) return
  const path = literal(node.arguments[0])
  if (!path?.startsWith('/admin/')) return
  const group = path.split('/')[2]
  const priority = ['accounts', 'groups', 'users', 'api-keys', 'subscriptions', 'channels'].includes(group) ? 'P0'
    : ['dashboard', 'usage', 'settings', 'redeem-codes', 'payment', 'ops', 'oauth-providers', 'proxies'].includes(group) ? 'P1' : 'P2'
  const candidates = routes.filter(route => !route.path.includes('*') && (route.method === method || route.method === 'ALL') && matches(route.path, path))
  let parent = node.parent
  while (parent && !ts.isFunctionDeclaration(parent) && !ts.isMethodDeclaration(parent)) parent = parent.parent
  calls.push({ priority, method, path, function: parent?.name?.getText(source) ?? null,
    source: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    registration: candidates.length ? 'candidate' : 'not-found', handlers: candidates.map(route => route.file),
  })
})
calls.sort((a, b) => a.priority.localeCompare(b.priority) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
const summary = Object.fromEntries(['P0', 'P1', 'P2'].map(priority => [priority, {
  calls: calls.filter(call => call.priority === priority).length,
  without_registration: calls.filter(call => call.priority === priority && call.registration === 'not-found').length,
}]))
const result = {
  scope: 'Static literal/template API-client calls in frontend/src/api. Dynamic helper URLs and direct view fetches require manual/browser audit. Candidate registration is not proof of compatible handler semantics or functioning UI.',
  summary, calls,
}
writeFileSync(resolve(root, 'worker/docs/ADMIN_API_INVENTORY.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))

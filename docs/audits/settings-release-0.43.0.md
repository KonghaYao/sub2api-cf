# Settings and operation audit repair — 0.43.0

This report describes the implemented release candidate, not a claim that every original Go feature has been migrated.

## Verified behavior

- Individual/bulk account scheduling stores its own boolean, uses control versions, and excludes paused accounts from model availability, selection and credential revalidation. Account enablement and health remain separate.
- `/admin/audit-logs` uses the original page template and restored English/Chinese labels. Filtering, pagination, details, cancellation of obsolete requests, redaction and protected clear-all have real backend contracts.
- Main settings, auth source/global signup grants, pagination, password reset, session binding, CAPTCHA, OAuth advanced flows, SMTP/templates, admin automation keys and payment selection/cancellation policies have concrete consumers.
- Runtime cooldowns, beta/fast policies, advanced scheduler, provider identity/prompt settings, notifications, channel monitors, Ops metrics/alerts/logging, S3/image storage, proxy transport/catalog and upstream/Ollama quota probes are implemented with versioned writes and bounded scheduled jobs.
- Native Responses upstream SSE can produce synchronous JSON. Stream/non-stream Cyber refusals leave wallet and key usage unchanged and can block subsequent requests in the same key/session. The observer accepts multiline SSE and CR/LF variants without retaining raw session IDs or prompts.
- API key ACLs keep Cloudflare client IP authority by default. Forwarded-header trust is opt-in. User error visibility is enforced by both owner list/detail endpoints.

## Validation of the candidate

- Worker: 215 suites / 2,012 tests passed.
- Frontend: 330 suites / 2,231 tests passed.
- Real workerd bindings: 20 suites / 59 tests passed.
- Browser route patrol: scheduling off/on persists, original operation audit filtering/details works, all covered admin pages produce zero page errors, failed requests or API errors. Latest patrol log: `/tmp/sub2api-settings-browser-final-candidate.log`.
- Proxy review found and fixed empty-password encryption and incorrect success lifecycle statistics. Independent security review found and fixed multiline SSE and nested error-code detection.

These tests use local provider fixtures. They do not establish production acceptance of every vendor OAuth credential, SMTP server, proxy, CAPTCHA provider or S3 endpoint.

## Still outstanding

- Original Grok and Antigravity platform-specific settings/consumers remain outside this Worker provider implementation.
- Original Codex CLI client blacklist/whitelist, app-server-client exception and engine-fingerprint signal settings still lack Worker consumers.
- Independent original scheduling controls listed in `settings-visible-field-gaps.md` remain to migrate.
- Native Go executable plugins and complete D1 + Durable Object + R2 backup/restore require an execution service; no compatible external service has been supplied. S3 connectivity and image storage are implemented independently. Backup UI reports this capability boundary instead of inventing completed backups.
- Official OpenAI 5h/7d quota auto-pause lacks a genuine provider quota source. Unsupported Ops host metrics are explicitly rejected; gateway usage is not substituted for official quotas or host CPU/memory.
- CCH signing is explicitly deprecated/no-op in the original Go source and is labelled disabled, not presented as a functioning signature feature.
- Risk-event recording/session blocking is implemented; the complete original moderation management/runtime is not covered by this release.

See `settings-users.md`, `runtime-settings.md`, and `lifecycle-audit-settings-notifications.md` for detailed ownership, behavior, evidence and limitations.

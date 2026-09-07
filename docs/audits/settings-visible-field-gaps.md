# Visible settings → Worker consumer audit (read-only snapshot)

Snapshot: 2026-09-07, isolated shared worktree. This is a source-path audit, not a claim of production validation. Enumerated 171 distinct `form.*` v-model roots, plus nested CAPTCHA, OAuth source grants, scheduler weights, beta/fast rules and six independent policy forms. A name absent from Worker alone is not considered a bug: OAuth/payment aliases were traced through their frontend adapters.

## Confirmed remaining gaps, ordered by practical impact

| Priority | Visible fields | Missing path / consequence |
|---|---|---|
| P1 | `risk_control_enabled`, `cyber_session_block_enabled`, `cyber_session_block_ttl_seconds` | SettingsView lines ~7250–7300 exposes security controls; Worker early-return omits them; neither gateway schema nor Worker runtime contains the fields. A successful save gives no enforcement. |
| P1 | `api_key_acl_trust_forwarded_ip`, forwarded-client-IP header list, `codex_cli_only_blacklist`, `codex_cli_only_whitelist`, `codex_cli_only_allow_app_server_clients`, `codex_cli_only_engine_fingerprint_signals` | ACL/client hardening form values never reach Worker main/gateway schema. Existing key ACL enforcement is independent and does not imply these controls work. |
| P1 | `default_balance`, `default_concurrency` | Main Worker save at ~11100 never includes either field. Per-auth-source grants work, but the distinct global default inputs do not affect newly registered users. Assigned back to this agent for repair. |
| P1 | `payment_cancel_rate_limit_enabled/max/window/unit/window_mode` | All five only appear in the Go payload below the Worker return; no Worker cancellation limiter consumer. Assigned back to this agent. |
| P2 | `grok_default_text_model`, `grok_cross_client_model_map_enabled`, `grok_default_base_url_mode` | All three visible under forwarding (~5215–5273); only Go payload saves them. No Worker schema or mapping/endpoint-selection consumer. |
| P2 | `fallback_model_antigravity`, `enable_identity_patch`, `identity_patch_prompt`, `antigravity_user_agent_version` | Antigravity-only settings have no Worker platform adapter/consumer. Gateway currently accepts fallback for anthropic/openai/gemini only; identity patch and UA are omitted. Some controls are conditionally displayed, but values still occur in original form. |
| P2 | `enable_fingerprint_unification`, `enable_cch_signing`, `enable_claude_oauth_system_prompt_injection`, `claude_oauth_system_prompt`, `claude_oauth_system_prompt_blocks`, `enable_client_dateline_normalization` | Existing metadata/cache rewriting does not implement these separate identity/header/system prompt/date behaviors. Worker gatewayDefaults excludes them. |
| P2 | `openai_codex_user_agent`, `openai_codex_client_version`, `openai_codex_version_auto_sync_enabled` (+ read-only synced version), `openai_ttft_mode` | UI edits do not reach runtime. Min/max client version checks are implemented and are a different feature. |
| P2 | `account_scheduling_thresholds`, `allow_ungrouped_key_scheduling`, `openai_low_upstream_rate_priority_enabled`, `openai_oauth_scheduling_rate_multiplier` | Separate original scheduling controls are absent from Worker schema/consumer even though the advanced weighted scheduler now works. |
| P2 | `openai_fast_policy_settings` | Original editable fast/flex rules only Go save path. Root is implementing gateway schema/consumer; this agent is adding the early-return object bridge. |
| P2 | `payment_load_balance_strategy` | Worker save omits it; backend exposes constant `round_robin` and rejects other strategies. Existing frontend default is `round-robin`, an additional alias mismatch. Assigned back to this agent. |
| P2 | `allow_user_view_error_requests` | Feature checkbox is omitted by Worker save and no user error visibility consumer exists. |
| P2 | Ollama Cloud usage `enabled/interval_minutes/debounce_minutes` | UI calls `/admin/accounts/ollama-cloud-usage/settings`; app.ts has no matching route. Upstream billing probe has now been implemented separately, and is not equivalent. |
| P3 | `plugin_management_enabled` | UI comment explicitly defines menu visibility, not plugin runtime. The boolean is still not persisted/projected in Worker, so even its intended menu toggle does not work. Plugin execution on Workers is a separate platform capability; do not count menu support as process-runtime support. |
| P2 (in progress) | `ops_monitoring_enabled`, `ops_realtime_monitoring_enabled`, `ops_query_mode_default`, `ops_metrics_interval_seconds` | Root already owns this implementation; at snapshot not yet in gatewayDefaults. |

## Categories with a real mapped path

- Branding, menu/endpoints, homepage/display, pagination: main public settings → public/bootstrap settings → existing frontend consumers.
- Registration/email reset/domain quota/forced third-party email, passkeys/TOTP/step-up/session binding, CAPTCHA and login agreement: main settings and encrypted secrets → auth/user handlers; source grants are separate atomic registration/bind consumers.
- SMTP: independent email-delivery CAS endpoint → native/SMTP delivery. OAuth: independent provider CAS endpoint → real provider login/link/pending flow, OIDC advanced/discovery, DingTalk staff and WeChat variants. Worker backend callback URLs are deployment-owned read-only fields, not silently editable values.
- Platform quota defaults and auth-source balance/concurrency/subscriptions/quotas: dedicated endpoints → registration/grants; these do not repair the separate global default controls above.
- Gateway fallback (three implemented platforms), min/max client versions, metadata passthrough, cache TTL/rewrite: gateway JSON → gateway request consumers.
- Advanced weighted scheduler and effective fields: scheduler config → DO telemetry/selection. Effective fields are response-only.
- Overload/429 cooldown, panel limiter, stream timeout, rectifier, beta policy: independent runtime endpoints and consumers implemented by billing agent.
- Web search: independent CAS config/test/reset → emulation and provider/proxy selection, owned by root.
- Notifications and channel monitor v1/v2: independent settings → scheduled scanner/probes; root has merged public monitor flags so menu state reflects actual settings.
- Payment enabled/method/min/max/daily/timeout/pending/product/help/fees and affiliate settings: dedicated payment/commercial APIs already consume these, subject to existing Worker capability restrictions (e.g. balance top-up remains explicitly unavailable). Cancellation and balancing above remain distinct gaps.
- Audit retention: scheduled cleanup; user/admin audit UI is real.
- Backup and upstream billing probe widgets: root-owned dedicated APIs now exist; not assessed as generic settings JSON.

Proxy verification added separately in `worker/test/control/proxies.test.ts`: encrypted/redacted credentials, duplicate create and conflicting reuse, CAS, blank-password preservation, deletion replay, account/fallback reference protection, explicit fallback, missing/expired/cyclic refusal, and transport refusal without a direct fetch.

## Subsequent closure (same worktree)

The audit above is the immutable discovery snapshot. This agent subsequently implemented and behavior-tested global defaults, payment cancellation/balancing, plugin/error booleans, fast-rule object/UUID bridge, and OAuth migration constraints. Root/billing are resolving risk/client/forwarding/scheduler rows. CCH has explicit original Go deprecated/no-op evidence and is disabled with a tooltip; it is not treated as a runnable Worker feature. Ollama provider usage is now implemented in a separate module with official HTML parser and encrypted web sessions; integration validation is ongoing.

Freeze recheck: Ollama settings/session/refresh/maintenance and list/detail projection passed local behavior tests. The remaining unmapped fields are the Grok, Antigravity and four independent scheduling controls listed above. The other discovery rows were subsequently implemented by this team; CCH is explicitly deprecated. See settings-users.md for validation scope and limitations.

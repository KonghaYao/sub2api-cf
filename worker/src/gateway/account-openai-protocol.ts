/** Original openai_compat.ShouldUseResponsesAPI: unknown support defaults to Responses. */
export function accountUsesResponses(value: unknown): boolean {
  const extra = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (extra.openai_responses_mode === 'force_responses') return true
  if (extra.openai_responses_mode === 'force_chat_completions') return false
  return extra.openai_responses_supported !== false
}

/** Original account forms select the upstream protocol independently of the public endpoint. */
export function accountOpenAIEndpointAllowed(value: unknown, endpoint: string): boolean {
  const row = value as { platform?: unknown; credential_kind?: unknown; ui_config_json?: unknown }
  if (row.platform !== 'openai' || row.credential_kind !== 'api_key' || !['responses', 'chat_completions'].includes(endpoint)) return true
  const ui = typeof row.ui_config_json === 'string' ? JSON.parse(row.ui_config_json) as Record<string, unknown> : {}
  // Explicit legacy account_models capabilities retain their existing contract.
  if (ui.original_model_routing !== true) return true
  return (endpoint === 'responses') === accountUsesResponses(ui.extra)
}

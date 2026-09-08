/** Original OpenAI scheduler privacy gate is group-scoped; never poison shared account health. */
export function accountGroupPrivacyAllowedSql(): string {
  return `(COALESCE(json_extract(g.ui_config_json, '$.require_privacy_set'), 0) <> 1
    OR a.platform <> 'openai'
    OR COALESCE(json_extract(a.ui_config_json, '$.extra.privacy_mode'), '') = 'training_off')`
}

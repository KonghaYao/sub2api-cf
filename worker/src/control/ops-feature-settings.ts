import type { Env } from '../env';
import { GatewayError } from '../gateway/errors';
export const opsFeatureDefaults = { ops_monitoring_enabled: true, ops_realtime_monitoring_enabled: true, ops_query_mode_default: 'auto', ops_metrics_interval_seconds: 60 };
export function parseOpsFeaturePatch(value: unknown): Partial<typeof opsFeatureDefaults> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new GatewayError(400, 'invalid_ops_settings', 'Invalid operations settings');
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!(key in opsFeatureDefaults))
            throw new GatewayError(400, 'invalid_ops_settings', 'Unknown operations setting');
        if (key.endsWith('_enabled') && typeof item !== 'boolean')
            throw new GatewayError(400, 'invalid_ops_settings', 'Operations switches must be boolean');
        if (key === 'ops_query_mode_default' && !['auto', 'raw', 'preagg'].includes(String(item)))
            throw new GatewayError(400, 'invalid_ops_settings', 'Invalid operations query mode');
        if (key === 'ops_metrics_interval_seconds' && (!Number.isSafeInteger(item) || Number(item) < 5 || Number(item) > 300))
            throw new GatewayError(400, 'invalid_ops_settings', 'Metrics interval must be 5–300 seconds');
        out[key] = item;
    }
    return out;
}
export function normalizeOpsFeature(value: unknown) { return { ...opsFeatureDefaults, ...parseOpsFeaturePatch(value ?? {}) }; }
export async function readOpsFeatures(env: Env) { const row = await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{
    gateway_json: string;
}>(); const raw = row ? JSON.parse(row.gateway_json) : {}; return normalizeOpsFeature(Object.fromEntries(Object.entries(raw).filter(([key]) => key in opsFeatureDefaults))); }

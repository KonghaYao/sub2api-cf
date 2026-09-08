import type { Context } from 'hono';
import type { Env } from '../env';
import { encryptCredential, decryptCredential } from '../gateway/crypto';
import { GatewayError, asGatewayError } from '../gateway/errors';
import { validateBaseUrl } from '../gateway/repository';
import { controlSuccess, controlError, readJsonObject, requireExpectedControlVersion } from './http';
import { s3Operation, presignS3Get, type S3Config } from '../storage/s3';
type C = Context<{
    Bindings: Env;
}>;
export interface ImageStorageConfig extends S3Config {
    enabled: boolean;
    reuse_backup_s3: boolean;
    public_base_url: string;
    presign_expiry_hours: number;
    max_download_bytes: number;
}
const S3_DEFAULT: S3Config = { endpoint: '', region: 'auto', bucket: '', access_key_id: '', secret_access_key: '', prefix: 'backups/', force_path_style: true };
const IMAGE_DEFAULT: ImageStorageConfig = { ...S3_DEFAULT, enabled: false, reuse_backup_s3: true, prefix: 'images/', public_base_url: '', presign_expiry_hours: 24, max_download_bytes: 20 * 1024 * 1024 };
const SCHEDULE_DEFAULT = { enabled: false, cron_expr: '0 2 * * *', retain_days: 14, retain_count: 10 };
type Stored<T> = {
    config: T;
    control_version: number;
};
function bad(message: string): never { throw new GatewayError(400, 'invalid_storage_config', message); }
async function reply(action: () => Promise<unknown>) { try {
    return controlSuccess(await action());
}
catch (error) {
    return controlError(asGatewayError(error));
} }
async function read<T>(env: Env, id: string, defaults: T): Promise<Stored<T>> { const row = await env.DB.prepare('SELECT config_json,nonce_b64,ciphertext_b64,control_version FROM object_storage_settings WHERE id=?').bind(id).first<{
    config_json: string;
    nonce_b64: string;
    ciphertext_b64: string;
    control_version: number;
}>(); if (!row)
    return { config: structuredClone(defaults), control_version: 0 }; const secret = row.ciphertext_b64 ? await decryptCredential(row.nonce_b64, row.ciphertext_b64, env.CREDENTIALS_MASTER_KEY!, 'object-storage:' + id + ':v1') : null; return { config: { ...defaults, ...JSON.parse(row.config_json), ...(secret ? { secret_access_key: secret.api_key } : {}) }, control_version: row.control_version }; }
async function save<T>(env: Env, id: string, config: T, expected: number) { const value = { ...config } as Record<string, unknown>, secret = typeof value.secret_access_key === 'string' ? value.secret_access_key : ''; delete value.secret_access_key; const encrypted = secret ? await encryptCredential({ api_key: secret }, env.CREDENTIALS_MASTER_KEY!, 'object-storage:' + id + ':v1') : { nonce_b64: '', ciphertext_b64: '' }; const result = await env.DB.prepare(`INSERT INTO object_storage_settings(id,config_json,nonce_b64,ciphertext_b64,control_version,updated_at_ms) SELECT ?,?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM object_storage_settings WHERE id=?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,nonce_b64=excluded.nonce_b64,ciphertext_b64=excluded.ciphertext_b64,control_version=object_storage_settings.control_version+1,updated_at_ms=excluded.updated_at_ms WHERE object_storage_settings.control_version=?`).bind(id, JSON.stringify(value), encrypted.nonce_b64, encrypted.ciphertext_b64, Date.now(), expected, id, expected).run(); if (!result.meta.changes)
    throw new GatewayError(412, 'control_version_conflict', 'Storage configuration changed; reload before saving'); }
function publicConfig<T extends S3Config>(stored: Stored<T>) { return { ...stored.config, secret_access_key: '', secret_configured: !!stored.config.secret_access_key, control_version: stored.control_version }; }
function normalizeS3(body: Record<string, unknown>, current: S3Config, required = true): S3Config { const next = { ...current }; for (const key of ['endpoint', 'region', 'bucket', 'access_key_id', 'prefix'] as const) {
    if (body[key] === undefined)
        continue;
    if (typeof body[key] !== 'string' || body[key].length > 2048 || /[\r\n\0]/.test(body[key]))
        bad('Invalid ' + key);
    next[key] = body[key].trim();
} if (body.secret_access_key !== undefined && body.secret_access_key !== '') {
    if (typeof body.secret_access_key !== 'string' || body.secret_access_key.length > 4096 || /[\r\n\0]/.test(body.secret_access_key))
        bad('Invalid storage secret');
    next.secret_access_key = body.secret_access_key;
} if (body.force_path_style !== undefined) {
    if (typeof body.force_path_style !== 'boolean')
        bad('force_path_style must be boolean');
    next.force_path_style = body.force_path_style;
} if (next.endpoint)
    next.endpoint = validateBaseUrl(next.endpoint).toString(); if (next.bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket))
    bad('Invalid bucket'); if (!/^[a-zA-Z0-9-]{1,64}$/.test(next.region))
    bad('Invalid region'); if (next.prefix.includes('..') || next.prefix.startsWith('/') || next.prefix.length > 512)
    bad('Invalid object prefix'); if (required && (!next.endpoint || !next.bucket || !next.access_key_id || !next.secret_access_key))
    bad('Configure endpoint, bucket and storage credentials'); return next; }
export const getBackupS3Config = (c: C) => reply(async () => publicConfig(await read(c.env, 'backup', S3_DEFAULT)));
export const updateBackupS3Config = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw, 16384), expected = requireExpectedControlVersion(c.req.raw, body), current = await read(c.env, 'backup', S3_DEFAULT), next = normalizeS3(body, current.config); await save(c.env, 'backup', next, expected); return publicConfig(await read(c.env, 'backup', S3_DEFAULT)); });
async function testStorage(config: S3Config) { const key = config.prefix.replace(/\/?$/, '/') + '.sub2api-connection-' + crypto.randomUUID(), bytes = new TextEncoder().encode(crypto.randomUUID()); let uploaded = false; try {
    await (await s3Operation(config, 'PUT', key, bytes, 'text/plain')).body?.cancel();
    uploaded = true;
    const result = await s3Operation(config, 'GET', key);
    const reader = result.body?.getReader();
    if (!reader)
        throw new Error('Object body missing');
    let offset = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (offset + value.byteLength > bytes.byteLength || value.some((v: number, i: number) => v !== bytes[offset + i]))
                throw new Error('Object readback mismatch');
            offset += value.byteLength;
        }
        if (offset !== bytes.byteLength)
            throw new Error('Object readback mismatch');
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    await (await s3Operation(config, 'DELETE', key)).body?.cancel();
    uploaded = false;
    return { ok: true, message: 'Object write, read verification and delete succeeded' };
}
catch {
    throw new GatewayError(502, 'storage_connection_failed', 'Object storage write/read/delete verification failed; check bucket permissions and endpoint');
}
finally {
    if (uploaded)
        try {
            await (await s3Operation(config, 'DELETE', key)).body?.cancel();
        }
        catch { /* Do not mask the primary sanitized error. */ }
} }
export const testBackupS3Config = (c: C) => reply(async () => testStorage(normalizeS3(await readJsonObject(c.req.raw, 16384), (await read(c.env, 'backup', S3_DEFAULT)).config)));
export async function readImageStorage(env: Env) { return read(env, 'images', IMAGE_DEFAULT); }
async function normalizeImage(env: Env, body: Record<string, unknown>, current: ImageStorageConfig): Promise<ImageStorageConfig> { const next = { ...current }; for (const key of ['enabled', 'reuse_backup_s3'] as const) {
    if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean')
            bad('Invalid ' + key);
        next[key] = body[key];
    }
} Object.assign(next, normalizeS3(body, next, next.enabled && !next.reuse_backup_s3)); if (body.public_base_url !== undefined) {
    if (typeof body.public_base_url !== 'string')
        bad('Invalid public base URL');
    next.public_base_url = body.public_base_url ? validateBaseUrl(body.public_base_url).toString() : '';
} for (const [key, min, max] of [['presign_expiry_hours', 1, 168], ['max_download_bytes', 1024, 100 * 1024 * 1024]] as const) {
    if (body[key] !== undefined) {
        if (!Number.isSafeInteger(body[key]) || Number(body[key]) < min || Number(body[key]) > max)
            bad('Invalid ' + key);
        next[key] = Number(body[key]);
    }
} if (next.enabled)
    await effectiveImageS3(env, next); return next; }
async function effectiveImageS3(env: Env, config: ImageStorageConfig): Promise<S3Config> { if (!config.reuse_backup_s3)
    return normalizeS3({}, config); const backup = (await read(env, 'backup', S3_DEFAULT)).config; return normalizeS3({}, { ...backup, bucket: config.bucket || backup.bucket, prefix: config.prefix }); }
export const getImageStorageConfig = (c: C) => reply(async () => { const stored = await readImageStorage(c.env); return { config: publicConfig(stored), secret_configured: stored.config.reuse_backup_s3 ? !!(await read(c.env, 'backup', S3_DEFAULT)).config.secret_access_key : !!stored.config.secret_access_key, control_version: stored.control_version }; });
export const updateImageStorageConfig = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw, 16384), expected = requireExpectedControlVersion(c.req.raw, body), next = await normalizeImage(c.env, body, (await readImageStorage(c.env)).config); await save(c.env, 'images', next, expected); return publicConfig(await readImageStorage(c.env)); });
export const testImageStorageConfig = (c: C) => reply(async () => { const next = await normalizeImage(c.env, await readJsonObject(c.req.raw, 16384), (await readImageStorage(c.env)).config); return testStorage(await effectiveImageS3(c.env, next)); });
export async function uploadConfiguredImage(env: Env, taskId: string, index: number, bytes: Uint8Array, mime: string): Promise<{url:string;storageRef:string;cleanup:()=>Promise<void>}|null> {
  const {config}=await readImageStorage(env)
  if(!config.enabled)return null
  if(bytes.byteLength>config.max_download_bytes)throw new Error('Configured image storage size limit exceeded')
  const storage=await effectiveImageS3(env,config)
  const extension=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':'png'
  const key=config.prefix.replace(/\/?$/,'/')+encodeURIComponent(taskId)+'/'+index+'.'+extension
  const sealed=await encryptCredential({api_key:JSON.stringify({storage,key})},env.CREDENTIALS_MASTER_KEY!,'image-storage-locator:v1')
  const storageRef=JSON.stringify(sealed)
  const url=config.public_base_url?config.public_base_url.replace(/\/$/,'')+'/'+key.split('/').map(encodeURIComponent).join('/'):await presignS3Get(storage,key,config.presign_expiry_hours*3600)
  await(await s3Operation(storage,'PUT',key,bytes,mime)).body?.cancel()
  return {url,storageRef,cleanup:async()=>{await(await s3Operation(storage,'DELETE',key)).body?.cancel()}}
}
export const getBackupSchedule = (c: C) => reply(async () => { const saved = await read(c.env, 'schedule', SCHEDULE_DEFAULT); return { ...saved.config, control_version: saved.control_version }; });
export const updateBackupSchedule = (c: C) => reply(async () => { const body = await readJsonObject(c.req.raw), expected = requireExpectedControlVersion(c.req.raw, body); if (typeof body.enabled !== 'boolean' || typeof body.cron_expr !== 'string' || body.cron_expr.split(/\s+/).length !== 5 || body.cron_expr.length > 100 || !Number.isSafeInteger(body.retain_days) || Number(body.retain_days) < 1 || Number(body.retain_days) > 3650 || !Number.isSafeInteger(body.retain_count) || Number(body.retain_count) < 1 || Number(body.retain_count) > 1000)
    bad('Invalid backup schedule'); if (body.enabled)
    throw new GatewayError(503, 'backup_executor_required', 'Full backup requires a configured executor for D1, Durable Object state and object inventory; run the existing backup CLI until an executor is configured'); const next = { enabled: false, cron_expr: body.cron_expr, retain_days: body.retain_days, retain_count: body.retain_count }; await save(c.env, 'schedule', next, expected); return { ...next, control_version: expected + 1 }; });
export const listManagedBackups = (c: C) => reply(async () => { const rows = await c.env.DB.prepare('SELECT record_json FROM managed_backup_records ORDER BY created_at_ms DESC LIMIT 200').all<{
    record_json: string;
}>(); return { items: rows.results.map(r => JSON.parse(r.record_json)), capabilities: { full_backup: false, restore: false, reason: 'Complete backup and restore require an execution service for D1, Durable Object state and object inventory. S3 and image storage are available independently.' } }; });
export const requireBackupExecutor = (_c: C) => reply(async () => { throw new GatewayError(503, 'backup_executor_required', 'A complete recoverable backup requires the existing CLI executor for D1 SQL, Durable Object state and object inventory; no backup or restore has been performed'); });
export const getManagedBackup = (c: C) => reply(async () => { const row = await c.env.DB.prepare('SELECT record_json FROM managed_backup_records WHERE id=?').bind(c.req.param('id')).first<{
    record_json: string;
}>(); if (!row)
    throw new GatewayError(404, 'backup_not_found', 'Backup not found'); return JSON.parse(row.record_json); });

export async function deleteConfiguredImage(env: Env, storageRef: string): Promise<void> {
 const sealed = JSON.parse(storageRef) as {nonce_b64:string;ciphertext_b64:string};
 const secret = await decryptCredential(sealed.nonce_b64,sealed.ciphertext_b64,env.CREDENTIALS_MASTER_KEY!,'image-storage-locator:v1');
 const {storage,key} = JSON.parse(secret.api_key) as {storage:S3Config;key:string};
 await (await s3Operation(storage,'DELETE',key)).body?.cancel();
}

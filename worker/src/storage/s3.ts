export interface S3Config {
    endpoint: string;
    region: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    prefix: string;
    force_path_style: boolean;
}
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
async function hash(value: string | Uint8Array) { return hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value as BufferSource)); }
async function hmac(key: string | ArrayBuffer, message: string) { const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return crypto.subtle.sign('HMAC', imported, encoder.encode(message)); }
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function objectURL(config: S3Config, key: string) { const url = new URL(config.endpoint); const segments = key.split('/').map(encode).join('/'); if (config.force_path_style)
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + encode(config.bucket) + '/' + segments;
else {
    url.hostname = config.bucket + '.' + url.hostname;
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + segments;
} return url; }
async function signingKey(config: S3Config, date: string) { return hmac(await hmac(await hmac(await hmac('AWS4' + config.secret_access_key, date), config.region), 's3'), 'aws4_request'); }
function timestamp(now: number) { return new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function query(url: URL) { return [...url.searchParams.entries()].map(([key, value]) => [encode(key), encode(value)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key, value]) => key + '=' + value).join('&'); }
export async function signedS3Request(config: S3Config, method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Uint8Array, contentType = 'application/octet-stream', now = Date.now()): Promise<Request> {
    const url = objectURL(config, key), date = timestamp(now), scope = date.slice(0, 8) + '/' + config.region + '/s3/aws4_request', payload = await hash(body ?? new Uint8Array()), headers = new Headers({ 'x-amz-date': date, 'x-amz-content-sha256': payload });
    if (method === 'PUT')
        headers.set('content-type', contentType);
    const canonicalHeaders = [...headers.entries(), ['host', url.host]].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.trim().replace(/\s+/g, ' ')]), names = canonicalHeaders.map(([k]) => k).join(';');
    const canonical = [method, url.pathname, query(url), canonicalHeaders.map(([k, v]) => k + ':' + v + '\n').join(''), names, payload].join('\n');
    const signature = hex(await hmac(await signingKey(config, date.slice(0, 8)), ['AWS4-HMAC-SHA256', date, scope, await hash(canonical)].join('\n')));
    headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${config.access_key_id}/${scope}, SignedHeaders=${names}, Signature=${signature}`);
    return new Request(url, { method, headers, ...(body ? { body: body as BodyInit } : {}), redirect: 'manual', signal: AbortSignal.timeout(15000) });
}
export async function s3Operation(config: S3Config, method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Uint8Array, contentType?: string): Promise<Response> { const response = await fetch(await signedS3Request(config, method, key, body, contentType)); if (!response.ok) {
    await response.body?.cancel();
    throw new Error('S3 operation failed');
} return response; }
export async function presignS3Get(config: S3Config, key: string, expiresSeconds: number, now = Date.now()): Promise<string> { const url = objectURL(config, key), date = timestamp(now), scope = date.slice(0, 8) + '/' + config.region + '/s3/aws4_request'; url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256'); url.searchParams.set('X-Amz-Credential', config.access_key_id + '/' + scope); url.searchParams.set('X-Amz-Date', date); url.searchParams.set('X-Amz-Expires', String(Math.min(604800, Math.max(1, Math.floor(expiresSeconds))))); url.searchParams.set('X-Amz-SignedHeaders', 'host'); const canonical = ['GET', url.pathname, query(url), 'host:' + url.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n'); url.searchParams.set('X-Amz-Signature', hex(await hmac(await signingKey(config, date.slice(0, 8)), ['AWS4-HMAC-SHA256', date, scope, await hash(canonical)].join('\n')))); return url.toString(); }

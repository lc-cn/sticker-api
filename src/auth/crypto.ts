import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const hmacHex = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type SessionKeys = { sign: Buffer; enc: Buffer; csrf: Buffer };

export function deriveSessionKeys(secret: Buffer): SessionKeys {
  const d = (info: string) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `sticker-api/${info}/v1`, 32));
  return { sign: d('session-sign'), enc: d('oauth-tx-enc'), csrf: d('csrf') };
}

/** Signed (not encrypted) compact token: base64url(json).base64url(hmac). */
export function signPayload(key: Buffer, purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key).update(`${purpose}.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPayload<T>(key: Buffer, purpose: string, token: string | undefined): T | null {
  if (!token || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = createHmac('sha256', key).update(`${purpose}.${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** AES-256-GCM sealed payload (used for the OAuth transaction cookie holding the PKCE verifier). */
export function seal(key: Buffer, aad: string, payload: object): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function unseal<T>(key: Buffer, aad: string, token: string | undefined): T | null {
  if (!token || token.length > 4096) return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    return null;
  }
}

import { randomBytes } from 'node:crypto';
import type { HmacKey } from '../config.js';
import { hmacHex } from '../auth/crypto.js';
import { AppError } from '../errors.js';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function readIdempotencyKey(header: unknown, required: boolean): string | null {
  if (header === undefined) {
    if (required) throw new AppError(428, 'idempotency_key_required', 'Idempotency-Key header (16–128 chars [A-Za-z0-9_-]) is required');
    return null;
  }
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_RE.test(header)) {
    throw new AppError(400, 'idempotency_key_invalid', 'Idempotency-Key must be 16–128 chars of [A-Za-z0-9_-]');
  }
  return header;
}

/** CONTRACT §3: op id derived from HMAC so a retry with the same key maps to the same event path. */
export function operationIdFor(key: HmacKey, scope: string, clientKey: string): string {
  return `op_${hmacHex(key.secret, `sticker-op/v1\n${scope}\n${clientKey}`).slice(0, 32)}`;
}
export function keyHmac(key: HmacKey, scope: string, clientKey: string): string {
  return hmacHex(key.secret, `${scope}\n${clientKey}`);
}
export function fingerprint(key: HmacKey, canonicalRequest: string): string {
  return hmacHex(key.secret, `sticker-fp/v1\n${canonicalRequest}`);
}
export const randomOperationId = () => `op_${randomBytes(16).toString('hex')}`;

/** Stable JSON (sorted keys) for request fingerprints. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

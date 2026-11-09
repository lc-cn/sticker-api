import { createHash } from 'node:crypto';

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** FNV-1a 32bit，输入按 UTF-8 字节 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(str)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const hex2 = (n) => n.toString(16).padStart(2, '0');

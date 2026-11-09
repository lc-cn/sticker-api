import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

function clean(v: string | undefined): string | null {
  if (!v) return null;
  let s = v.trim();
  if (s.startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s.toLowerCase() : null;
}

/**
 * Client IP for anonymous rate limiting.
 * - trustProxyHeaders=true (Vercel): `x-real-ip`, else the FIRST `x-forwarded-for` hop. Vercel overwrites
 *   both at its edge, so clients cannot spoof them there.
 * - otherwise: the TCP peer address only; forwarding headers are ignored (they are client-controlled).
 * Deliberately independent of Fastify's `trustProxy`/`req.ip`.
 */
export function clientIp(req: FastifyRequest, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const real = req.headers['x-real-ip'];
    const r = clean(Array.isArray(real) ? real[0] : real);
    if (r) return r;
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0];
    const f = clean(first);
    if (f) return f;
  }
  return clean(req.socket?.remoteAddress) ?? 'unknown';
}

/** IPv6 clients usually own a whole /64: bucket them by prefix so rotating addresses doesn't reset limits. */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const full = expandV6(ip);
  return full ? `${full.slice(0, 4).join(':')}::/64` : ip;
}

function expandV6(ip: string): string[] | null {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (tail === undefined) return h.length === 8 ? h : null;
  const fill = 8 - h.length - t.length;
  return fill < 0 ? null : [...h, ...Array(fill).fill('0'), ...t];
}

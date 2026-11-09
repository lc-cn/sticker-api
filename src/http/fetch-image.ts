/**
 * Fetch a remote image for render slots with SSRF protections.
 * http(s) only · DNS-resolved IPs must be public · redirects re-checked ·
 * size/time caps · magic-byte sniff before validateImage.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors.js';

export const FETCH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_IMAGE_TIMEOUT_MS = 8_000;
export const FETCH_IMAGE_MAX_REDIRECTS = 3;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/** Exported for unit tests. */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('fc') || x.startsWith('fd')) return true; // ULA
    if (x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return true; // link-local
    if (x.startsWith('ff')) return true; // multicast
    // IPv4-mapped
    if (x.startsWith('::ffff:')) {
      const mapped = x.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isBlockedIp(mapped);
    }
    return false;
  }
  return true;
}

function hostBlocked(hostname: string): boolean {
  const h = hostname.replace(/\.$/, '').toLowerCase();
  if (!h || BLOCKED_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h) && isBlockedIp(h)) return true;
  return false;
}

/** Parse + scheme/host checks (no DNS yet). */
export function parseImageUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new AppError(400, 'invalid_image_url', 'image URL too long or missing');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AppError(400, 'invalid_image_url', 'image URL is not valid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError(400, 'invalid_image_url', 'only http(s) image URLs are allowed');
  if (u.username || u.password) throw new AppError(400, 'invalid_image_url', 'image URL must not include credentials');
  if (hostBlocked(u.hostname)) throw new AppError(400, 'ssrf_blocked', 'image URL host is not allowed');
  return u;
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

async function assertPublicHostname(hostname: string, lookup: HostLookup): Promise<void> {
  if (hostBlocked(hostname)) throw new AppError(400, 'ssrf_blocked', 'image URL host is not allowed');
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new AppError(400, 'ssrf_blocked', 'image URL resolves to a private address');
    return;
  }
  let records: Array<{ address: string; family?: number }>;
  try {
    records = await lookup(hostname);
  } catch {
    throw new AppError(400, 'image_fetch_failed', 'could not resolve image URL host', { retryable: true });
  }
  if (!records.length) throw new AppError(400, 'image_fetch_failed', 'could not resolve image URL host', { retryable: true });
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new AppError(400, 'ssrf_blocked', 'image URL resolves to a private address');
  }
}

function sniffImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WEBP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch one remote image. `fetchImpl` is injectable for tests.
 * Caller must still run validateImage / size limits for render.
 */
const defaultLookup: HostLookup = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export async function fetchRemoteImage(
  rawUrl: string,
  opts: {
    fetchImpl?: FetchImpl;
    lookup?: HostLookup;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {},
): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  const maxBytes = opts.maxBytes ?? FETCH_IMAGE_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_IMAGE_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? FETCH_IMAGE_MAX_REDIRECTS;

  let current = parseImageUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHostname(current.hostname, lookup);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          accept: 'image/*,*/*;q=0.8',
          'user-agent': 'sticker-api-image-fetch/1.0',
        },
      });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw new AppError(400, 'image_fetch_failed', 'timed out fetching image URL', { retryable: true });
      throw new AppError(400, 'image_fetch_failed', 'failed to fetch image URL', { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new AppError(400, 'image_fetch_failed', 'redirect without location');
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw new AppError(400, 'invalid_image_url', 'redirect location is not a valid URL');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new AppError(400, 'ssrf_blocked', 'redirect to non-http(s) URL');
      if (next.username || next.password) throw new AppError(400, 'ssrf_blocked', 'redirect URL must not include credentials');
      if (hostBlocked(next.hostname)) throw new AppError(400, 'ssrf_blocked', 'redirect host is not allowed');
      if (hop === maxRedirects) throw new AppError(400, 'image_fetch_failed', 'too many redirects');
      current = next;
      continue;
    }

    if (!res.ok) throw new AppError(400, 'image_fetch_failed', `image URL returned HTTP ${res.status}`, { retryable: res.status >= 500 });

    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > maxBytes) throw new AppError(413, 'payload_too_large', `image URL content-length exceeds ${maxBytes} bytes`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
      throw new AppError(400, 'invalid_image', 'image URL Content-Type is not an image');
    }

    const reader = res.body?.getReader();
    if (!reader) throw new AppError(400, 'image_fetch_failed', 'empty image response');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { reader.cancel(); } catch { /* ignore */ }
        throw new AppError(413, 'payload_too_large', `image URL body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (!sniffImage(buf)) throw new AppError(400, 'invalid_image', 'URL body is not a recognized image (PNG/JPEG/GIF/WebP)');
    return buf;
  }
  throw new AppError(400, 'image_fetch_failed', 'too many redirects');
}

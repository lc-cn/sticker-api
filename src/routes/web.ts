/**
 * Public homepage, docs and admin shell. Pages are static files (web/*.html, public/assets/*), but HTML is
 * served by the function so its CSP can follow MIRROR_HOST_ALLOWLIST. On Vercel `/assets/*` is normally
 * answered by the static output (filesystem precedes rewrites); the route here keeps local dev identical.
 * The admin page contains NO data: everything comes from session-gated /v1 APIs.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';
import { PROJECT_ROOT } from '../app.js';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const ASSET_RE = /^[a-z0-9][a-z0-9-]{0,40}\.(js|css|svg|png|webmanifest)$/;

export function contentSecurityPolicy(config: AppConfig): string {
  const imgHosts = ['https://raw.githubusercontent.com', ...[...config.mirrorHostAllowlist].sort().map((h) => `https://${h}`)];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' blob: ${imgHosts.join(' ')}`,
    // connect: own API + image hosts (download button fetches the image to save it with a filename)
    `connect-src 'self' ${imgHosts.join(' ')}`,
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export async function registerWebRoutes(app: FastifyInstance, deps: { config: AppConfig }): Promise<void> {
  const csp = contentSecurityPolicy(deps.config);
  const cache = new Map<string, Buffer>();
  const read = (rel: string): Buffer | null => {
    if (cache.has(rel)) return cache.get(rel)!;
    try {
      const b = fs.readFileSync(path.join(PROJECT_ROOT, rel));
      cache.set(rel, b);
      return b;
    } catch {
      return null;
    }
  };

  const html = (rel: string, cacheControl: string) => async (_req: unknown, reply: FastifyReply) => {
    const b = read(rel);
    if (!b) return reply.code(404).header('cache-control', 'no-store').send({ error: { code: 'not_found', message: 'Page not built', retryable: false } });
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', csp)
      .header('x-frame-options', 'DENY')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('cache-control', cacheControl)
      .send(b);
  };

  // Public pages: short edge cache (CSP only changes on redeploy anyway).
  app.get('/', html('web/index.html', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'));
  app.get('/docs', html('web/docs.html', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600'));
  // Admin shell: never cached anywhere.
  app.get('/admin', html('web/admin.html', 'no-store'));

  app.get('/openapi.yaml', async (_req, reply) => {
    const b = read('openapi.yaml');
    if (!b) return reply.code(404).send({ error: { code: 'not_found', message: 'openapi.yaml missing', retryable: false } });
    return reply.header('content-type', 'text/yaml; charset=utf-8').header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').send(b);
  });

  app.get('/assets/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const b = ASSET_RE.test(file) ? read(`public/assets/${file}`) : null;
    if (!b) return reply.code(404).header('cache-control', 'no-store').send({ error: { code: 'not_found', message: 'Route not found', retryable: false } });
    return reply.header('content-type', TYPES[path.extname(file)]!).header('cache-control', 'public, max-age=300').send(b);
  });

  app.get('/favicon.ico', async (_req, reply) => reply.redirect('/assets/favicon.svg', 301));
}

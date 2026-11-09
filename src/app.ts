import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { AppError, isAppError } from './errors.js';
import { deriveSessionKeys } from './auth/crypto.js';
import { InstallationTokenProvider } from './github/app-token.js';
import { GitHubRepoClient } from './github/client.js';
import { MAX_MULTIPART_BYTES, readLimited } from './http/multipart.js';
import { HeadCache } from './repo/head.js';
import { Publisher } from './repo/publisher.js';
import { parseFonts, Renderer } from './render/renderer.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './routes/auth.js';
import { AssetService } from './services/assets.js';
import { RenderService } from './services/renders.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type AppDeps = { config: AppConfig; fetchImpl?: typeof fetch; now?: () => number };

export async function buildApp(deps: AppDeps) {
  const { config } = deps;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024, // JSON bodies (metadata/patch/render requests) ≤16 KiB
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  // Whole multipart request ≤3 MiB, counted on actual bytes; parsed later per route limits.
  app.addContentTypeParser('multipart/form-data', { bodyLimit: MAX_MULTIPART_BYTES }, (req, payload, done) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > MAX_MULTIPART_BYTES) {
      done(new AppError(413, 'payload_too_large', `Request body exceeds ${MAX_MULTIPART_BYTES} bytes`), undefined);
      return;
    }
    readLimited(payload, MAX_MULTIPART_BYTES).then(
      (raw) => done(null, { kind: 'raw-multipart', raw }),
      (e) => done(e as Error, undefined),
    );
  });

  const keys = config.sessionSecret ? deriveSessionKeys(config.sessionSecret) : null;
  let gh: GitHubRepoClient | null = null;
  let head: HeadCache | null = null;
  let publisher: Publisher | null = null;
  if (config.repo) {
    const tokens = config.githubApp ? new InstallationTokenProvider(config.githubApiBase, config.githubApp, config.repo.repo, deps.fetchImpl) : null;
    gh = new GitHubRepoClient({ apiBase: config.githubApiBase, rawBase: config.rawBase, ...config.repo, tokens, fetchImpl: deps.fetchImpl });
    const client = gh;
    head = new HeadCache(() => client.getHeadSha(), config.headTtlMs, config.headMaxStaleMs, deps.now);
    const h = head;
    publisher = new Publisher(client, config.publishMaxAttempts, (sha) => h.set(sha));
  }
  const assets = new AssetService(config, gh, head, publisher);
  const renderer = new Renderer(parseFonts(config.renderFonts, PROJECT_ROOT), config.renderTimeoutMs);
  const renders = new RenderService(config, assets, renderer);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id, retryable: false } });
  });

  app.setErrorHandler((err, req, reply) => {
    let e: AppError;
    if (isAppError(err)) e = err;
    else {
      const fe = err as { statusCode?: number; code?: string };
      if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AppError(413, 'payload_too_large', 'Request body too large');
      else if (fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') e = new AppError(415, 'unsupported_media_type', 'Unsupported Content-Type');
      else if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) e = new AppError(fe.statusCode, 'bad_request', 'Malformed request');
      else {
        // Never log bodies/tokens; message only.
        console.error('[error]', req.id, err instanceof Error ? err.message : 'unknown');
        e = new AppError(500, 'internal_error', 'Internal server error', { retryable: true });
      }
    }
    if (e.headers) for (const [k, v] of Object.entries(e.headers)) reply.header(k, v);
    if (e.statusCode >= 400) reply.header('cache-control', 'no-store');
    return reply.code(e.statusCode).send({
      error: { code: e.code, message: e.message, requestId: req.id, retryable: e.retryable, details: e.details ?? undefined },
    });
  });

  await registerAuthRoutes(app, { config, keys, fetchImpl: deps.fetchImpl });
  await registerApiRoutes(app, { config, keys, assets, renders });
  return { app, assets, renders, head };
}

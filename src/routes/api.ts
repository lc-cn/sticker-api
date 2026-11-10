import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { requirePrincipal } from '../auth/principal.js';
import type { SessionKeys } from '../auth/crypto.js';
import { readIdempotencyKey } from '../domain/idempotency.js';
import { validateImage } from '../domain/image.js';
import { parseIfMatch, parseJsonObject } from '../domain/metadata.js';
import { parseMultipart, type MultipartBody } from '../http/multipart.js';
import type { AssetService, Receipt } from '../services/assets.js';
import { BATCH_MAX_BYTES, BATCH_MAX_ITEMS } from '../services/assets.js';
import { RENDER_IMAGE_MAX, RENDER_IMAGES_TOTAL_MAX, type RenderCaller, type RenderService } from '../services/renders.js';
import type { CollectService } from '../services/collect.js';
import { parseCookies, SESSION_COOKIE } from '../auth/cookies.js';
import { clientIp, ipBucket } from '../http/client-ip.js';

const UPLOAD_MAX = 2 * 1024 * 1024;

const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

function receiptStatus(r: Receipt, created: boolean): number {
  if (r.status === 'created') return 201;
  if (r.status === 'replayed') return created ? 201 : 200;
  return 200;
}

async function multipart(req: FastifyRequest, opts: Parameters<typeof parseMultipart>[2]): Promise<MultipartBody> {
  const body = req.body as { kind?: string; raw?: Buffer } | undefined;
  if (!body || body.kind !== 'raw-multipart' || !body.raw) throw new AppError(415, 'unsupported_media_type', 'multipart/form-data required');
  return parseMultipart(body.raw, req.headers, opts);
}

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; keys: SessionKeys | null; assets: AssetService; renders: RenderService; collect: CollectService },
): Promise<void> {
  const { config, keys, assets, renders, collect } = deps;

  app.get('/v1/health', async (_req, reply) => {
    noStore(reply);
    return {
      ok: true,
      repoConfigured: !!config.repo,
      writes: config.writesEnabled && !!config.githubApp && config.idempotencyKeys.length > 0,
      renders: config.rendersEnabled,
      publicRenders: config.rendersEnabled && config.publicRendersEnabled,
      content: config.contentEnabled,
      adminLogin: !!config.login && !!keys,
      warningCount: config.warnings.length, // details only in server logs, not public
    };
  });

  // ---------- public reads (no login) ----------
  app.get('/v1/assets', async (req, reply) => {
    noStore(reply);
    const q = req.query as Record<string, string | undefined>;
    return assets.search({
      q: q.q?.trim() || undefined,
      category: q.category?.trim() || undefined,
      tag: q.tag?.trim() || undefined,
      sort: q.sort,
      limit: q.limit === undefined ? undefined : Number(q.limit),
      cursor: q.cursor,
    });
  });

  app.get('/v1/assets/:id', async (req, reply) => {
    noStore(reply);
    const { id } = req.params as { id: string };
    const q = req.query as { view?: string };
    const r = await assets.get(id, { full: q.view === 'full' });
    if (typeof r.rev === 'number') reply.header('etag', `"${r.rev}"`);
    return r;
  });

  app.get('/v1/assets/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { source } = req.query as { source?: string };
    const t = await assets.contentTarget(id, source);
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-sha256', t.sha256)
      .header('x-asset-commit', t.commit)
      .redirect(t.url, 302);
  });

  // Short public image URL: /v1/asset/<hex8-64>.<png|jpg|gif|webp> → 302 same mirror chain as /content.
  app.get('/v1/asset/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const m = /^([0-9a-fA-F]{8,64})\.(png|jpe?g|gif|webp)$/.exec(file);
    if (!m) throw new AppError(404, 'not_found', 'Unknown asset id');
    const t = await assets.contentTargetByShort(m[1]!.toLowerCase(), m[2]!.toLowerCase() === 'jpeg' ? 'jpg' : m[2]!.toLowerCase());
    return reply
      .header('cache-control', 'public, max-age=300, stale-while-revalidate=600')
      .header('x-content-sha256', t.sha256)
      .header('x-asset-commit', t.commit)
      .redirect(t.url, 302);
  });

  app.get('/v1/categories', async (_req, reply) => {
    noStore(reply);
    return assets.categories();
  });

  app.get('/v1/templates', async (_req, reply) => {
    noStore(reply);
    return renders.list();
  });

  // Short template thumb: /v1/templates/:id/preview → 302 to mirror (same chain as asset content).
  app.get('/v1/templates/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await renders.previewTarget(id);
    return reply
      .header('cache-control', 'public, max-age=300, stale-while-revalidate=600')
      .redirect(t.url, 302);
  });

  // ---------- writes ----------
  app.post('/v1/assets', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'assets:write');
    const idem = readIdempotencyKey(req.headers['idempotency-key'], true)!;
    const mp = await multipart(req, { maxFiles: 1, maxFileBytes: UPLOAD_MAX, maxTotalFileBytes: UPLOAD_MAX, allowedFileFields: ['file'] });
    const file = mp.files[0];
    if (!file) throw new AppError(400, 'empty_file', 'multipart field "file" is required');
    if ((mp.fields.metadata?.length ?? 0) !== 1) throw new AppError(400, 'invalid_metadata', 'exactly one "metadata" JSON field is required');
    const meta = parseJsonObject(mp.fields.metadata![0], 'metadata');
    const img = validateImage(file.bytes);
    const { receipt, created } = await assets.create(principal, img, meta, idem);
    return reply.code(receiptStatus(receipt, created)).send(receipt);
  });

  /**
   * Batch upload: many stickers → one GitHub commit (event import.batch).
   * Cap BATCH_MAX_ITEMS / BATCH_MAX_BYTES; whole multipart ≤4 MiB (Vercel).
   * Multipart: metadata = JSON array (same order as file parts), repeated field name "file".
   * Partial failure is per-item; daily/capacity stop further creates but still commit successes.
   */
  app.post('/v1/assets/batch', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'assets:write');
    const idem = readIdempotencyKey(req.headers['idempotency-key'], true)!;
    const mp = await multipart(req, {
      maxFiles: BATCH_MAX_ITEMS,
      maxFileBytes: UPLOAD_MAX,
      maxTotalFileBytes: BATCH_MAX_BYTES,
      allowedFileFields: ['file'],
    });
    if ((mp.fields.metadata?.length ?? 0) !== 1) {
      throw new AppError(400, 'invalid_metadata', 'exactly one "metadata" JSON array field is required');
    }
    let metas: unknown;
    try {
      metas = JSON.parse(mp.fields.metadata![0]!);
    } catch {
      throw new AppError(400, 'invalid_metadata', 'metadata must be JSON');
    }
    if (!Array.isArray(metas)) throw new AppError(400, 'invalid_metadata', 'metadata must be a JSON array');
    if (metas.length !== mp.files.length) {
      throw new AppError(400, 'invalid_metadata', `metadata length (${metas.length}) must match file count (${mp.files.length})`);
    }
    if (mp.files.length < 1) throw new AppError(400, 'empty_batch', 'batch requires at least one file');
    const items = mp.files.map((f, i) => {
      const meta = metas[i];
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        throw new AppError(400, 'invalid_metadata', `metadata[${i}] must be an object`);
      }
      return { img: validateImage(f.bytes), metadata: meta as Record<string, unknown> };
    });
    const { receipt, created } = await assets.createBatch(principal, items, idem);
    const code = receipt.status === 'created' ? 201 : 200;
    return reply.code(created || receipt.status === 'created' ? 201 : code).send(receipt);
  });

  app.patch('/v1/assets/:id', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'assets:moderate');
    const { id } = req.params as { id: string };
    const ifMatch = parseIfMatch(req.headers['if-match'], true)!;
    const idem = readIdempotencyKey(req.headers['idempotency-key'], false);
    const { receipt } = await assets.update(principal, id, req.body, ifMatch, idem);
    return receipt;
  });

  app.post('/v1/assets/:id/review', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'assets:moderate');
    const { id } = req.params as { id: string };
    const ifMatch = parseIfMatch(req.headers['if-match'], true)!;
    const idem = readIdempotencyKey(req.headers['idempotency-key'], false);
    const { receipt } = await assets.review(principal, id, req.body, ifMatch, idem);
    return receipt;
  });

  app.delete('/v1/assets/:id', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'assets:moderate');
    const { id } = req.params as { id: string };
    const { reason } = req.query as { reason?: string };
    const ifMatch = parseIfMatch(req.headers['if-match'], false);
    const idem = readIdempotencyKey(req.headers['idempotency-key'], false);
    const { receipt } = await assets.tombstone(principal, id, reason, ifMatch, idem);
    return receipt;
  });

  app.get('/v1/operations/:id', async (req, reply) => {
    noStore(reply);
    const principal = requirePrincipal(req, config, keys, 'operations:read');
    const { id } = req.params as { id: string };
    const idem = readIdempotencyKey(req.headers['idempotency-key'], false);
    return assets.operation(principal, id, idem);
  });

  // ---------- collection (admin session or machine token with collect:trigger) ----------
  app.get('/v1/collect/sources', async (req, reply) => {
    noStore(reply);
    requirePrincipal(req, config, keys, 'collect:trigger');
    return collect.sources();
  });

  app.get('/v1/collect-runs', async (req, reply) => {
    noStore(reply);
    requirePrincipal(req, config, keys, 'collect:trigger');
    return collect.runs();
  });

  app.post('/v1/collect-runs', async (req, reply) => {
    noStore(reply);
    requirePrincipal(req, config, keys, 'collect:trigger');
    return reply.code(202).send(await collect.trigger(req.body));
  });

  app.post('/v1/renders', async (req, reply) => {
    // No Authorization header and no admin cookie → anonymous homepage visitor (only if enabled).
    // Anything carrying credentials goes through the normal checks (bad token → 401, CSRF for cookies).
    const anonymous = req.headers.authorization === undefined && !parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const principal: RenderCaller =
      anonymous && config.publicRendersEnabled
        ? { kind: 'anonymous', ip: ipBucket(clientIp(req, config.trustProxyHeaders)) }
        : requirePrincipal(req, config, keys, 'render');
    let input: { template: unknown; version?: unknown; texts?: unknown; params?: unknown; assetIds?: unknown; imageUrls?: unknown };
    let images: Buffer[] = [];
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.startsWith('multipart/form-data')) {
      const mp = await multipart(req, { maxFiles: 2, maxFileBytes: RENDER_IMAGE_MAX, maxTotalFileBytes: RENDER_IMAGES_TOTAL_MAX, allowedFileFields: ['image'] });
      if ((mp.fields.request?.length ?? 0) !== 1) throw new AppError(400, 'invalid_request', 'exactly one "request" JSON field is required');
      input = parseJsonObject(mp.fields.request![0], 'request') as typeof input;
      images = mp.files.map((f) => f.bytes);
    } else {
      input = (req.body ?? {}) as typeof input;
    }
    if (typeof input.template !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(input.template)) throw new AppError(400, 'invalid_request', 'template id required');
    const texts = input.texts === undefined ? [] : input.texts;
    const assetIds = input.assetIds === undefined ? [] : input.assetIds;
    if (!Array.isArray(texts) || !Array.isArray(assetIds) || assetIds.some((x) => typeof x !== 'string')) throw new AppError(400, 'invalid_request', 'texts/assetIds must be arrays');
    let imageUrls: (string | null)[] = [];
    if (input.imageUrls !== undefined) {
      if (!Array.isArray(input.imageUrls) || input.imageUrls.length > 2) throw new AppError(400, 'invalid_request', 'imageUrls must be an array of ≤2 entries');
      imageUrls = input.imageUrls.map((u, i) => {
        if (u === null || u === undefined || u === '') return null;
        if (typeof u !== 'string') throw new AppError(400, 'invalid_request', `imageUrls[${i}] must be a string or null`);
        return u;
      });
    }
    const params = input.params === undefined ? {} : input.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new AppError(400, 'invalid_request', 'params must be an object');
    const version = input.version === undefined ? undefined : Number(input.version);
    if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw new AppError(400, 'invalid_request', 'version must be a positive integer');
    const out = await renders.render(principal, { template: input.template, version, texts: texts as string[], params: params as Record<string, unknown>, images, imageUrls, assetIds: assetIds as string[] });
    return reply.header('content-type', out.mime).header('cache-control', 'no-store').header('x-template', out.template).header('x-content-type-options', 'nosniff').send(out.bytes);
  });
}

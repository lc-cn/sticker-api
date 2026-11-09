import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { principalScope, type Principal } from '../auth/principal.js';
import { canonicalJson, fingerprint, keyHmac, operationIdFor, randomOperationId } from '../domain/idempotency.js';
import {
  applyPatch, asObject, parseCreateMetadata, parseReason, parseStatus, rightsInput,
} from '../domain/metadata.js';
import type { ValidatedImage } from '../domain/image.js';
import type { GitHubRepoClient } from '../github/client.js';
import {
  assertSchema, candidateUrls, cmp, eventPath, hashShard, INDEX_PATHS, licensePath, manifestPath, normalizeText, pretty,
  PLAN_STATUS, PlanError, planArchive, planCreate, planTombstone, planUpdate, queryTerms, referenceSearch, registry, termShard,
  type AssetRecord, type Catalog, type Changes, type DocSummary, type EventRecord, type Limits, type ManifestShard, type MirrorsConfig, type PlanCtx,
} from '../repo/contract.js';
import { withSyncRead } from '../repo/sync-read.js';
import type { HeadCache } from '../repo/head.js';
import type { Publisher } from '../repo/publisher.js';
import { LruBytes, Snapshot } from '../repo/snapshot.js';

export type PublicAsset = ReturnType<AssetService['publicAsset']>;
export type Receipt = {
  operationId: string | null;
  commit: string;
  status: 'created' | 'duplicate' | 'updated' | 'tombstoned' | 'unchanged' | 'replayed';
  replayedType?: string;
  asset: PublicAsset;
};

export type BatchItemResult =
  | { index: number; status: 'created' | 'duplicate'; asset: PublicAsset }
  | { index: number; status: 'error'; error: { code: string; message: string } };

export type BatchReceipt = {
  operationId: string | null;
  commit: string;
  status: 'created' | 'replayed' | 'unchanged';
  replayedType?: string;
  summary: { created: number; duplicate: number; error: number; addedBytes: number };
  items: BatchItemResult[];
};

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ID_RE = /^(?:sha256:)?([0-9a-f]{64})$/;
/** A indexes/docs keys use the first 12 hex of sha256 (DOC_KEY_LENGTH). At maxAssets=3000 this is unique in practice. */
export const SHORT_ID_LEN = 12;
/** Max stickers per POST /v1/assets/batch (one GitHub commit). Keep modest for Vercel 30s + 4.5MiB body. */
export const BATCH_MAX_ITEMS = 20;
/** Max sum of image bytes in one batch (metadata extra; whole multipart ≤ MAX_MULTIPART_BYTES). */
export const BATCH_MAX_BYTES = 3 * 1024 * 1024;
const SHORT_RE = /^([0-9a-f]{8,64})$/;
const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function parseAssetId(raw: string): string {
  const m = ID_RE.exec(raw);
  if (!m) throw new AppError(404, 'not_found', 'Unknown asset id');
  return m[1]!;
}

/** Canonical short public path: /v1/asset/<12hex>.<ext> */
export function shortContentPath(sha256: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] || 'png';
  return `/v1/asset/${sha256.slice(0, SHORT_ID_LEN)}.${ext}`;
}

export function mimeFromExt(ext: string): string | null {
  return MIME_BY_EXT[ext.toLowerCase()] ?? null;
}

const manilaFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
/** Display helper: "2026-11-09T11:28:00+08:00" (Asia/Manila). Storage stays UTC Z. */
export const toManila = (utc: string | null) => (utc ? `${manilaFmt.format(new Date(utc)).replace(' ', 'T')}+08:00` : null);

type Plan =
  | { kind: 'noop'; status: Receipt['status']; record: AssetRecord }
  | { kind: 'change'; status: Receipt['status']; after: AssetRecord; changes: Changes; seen: Map<string, string | undefined> };

type OpCtx = {
  operationId: string;
  at: string;
  actorKind: 'admin' | 'machine';
  idempotency: { keyId: string; keyHmac: string } | null;
  requestFingerprint: { keyId: string; hmac: string } | null;
};

type WriteResult = { receipt: Omit<Receipt, 'commit'>; created: boolean };

export class AssetService {
  private readonly cache = new LruBytes(16 * 1024 * 1024);

  constructor(
    private readonly config: AppConfig,
    private readonly gh: GitHubRepoClient | null,
    private readonly head: HeadCache | null,
    private readonly publisher: Publisher | null,
  ) {}

  // ---------------------------------------------------------------- reads
  async snapshot(): Promise<Snapshot> {
    if (!this.gh || !this.head) throw new AppError(503, 'repo_not_configured', 'Asset repository is not configured');
    const commit = await this.head.get();
    const gh = this.gh;
    const source = this.config.readSource === 'api' ? (c: string, p: string) => gh.readFileApi(c, p) : (c: string, p: string) => gh.readFileRaw(c, p);
    const snap = new Snapshot(commit, source, this.cache);
    await snap.assertSupported();
    return snap;
  }

  private async record(snap: Snapshot, sha: string): Promise<AssetRecord | null> {
    const shard = await snap.json<ManifestShard>(manifestPath(hashShard(sha)));
    return shard?.assets.find((a) => a.id === `sha256:${sha}`) ?? null;
  }

  async mirrors(snap: Snapshot): Promise<MirrorsConfig | null> {
    if (!this.config.repo) return null;
    const a = await snap.json<MirrorsConfig>('config/mirrors.json');
    if (!a) return null;
    if ((a.owner && a.owner !== this.config.repo.owner) || (a.repo && a.repo !== this.config.repo.repo)) {
      throw new AppError(503, 'mirror_config_mismatch', 'A config/mirrors.json owner/repo differs from service config');
    }
    // A decides enabled+verified mirrors; B additionally requires its own host allowlist (both must agree).
    const mirrors = a.mirrors.filter((m) => {
      try {
        return this.config.mirrorHostAllowlist.has(new URL(m.template.replace(/\{[a-z]+\}/g, 'x')).host);
      } catch {
        return false;
      }
    });
    return { ...a, owner: this.config.repo.owner, repo: this.config.repo.repo, mirrors };
  }

  sources(commit: string, path: string, mirrors: MirrorsConfig | null) {
    return mirrors ? candidateUrls({ commit, path }, mirrors) : [];
  }

  publicAsset(r: AssetRecord, commit: string, mirrors: MirrorsConfig | null) {
    const live = r.status !== 'tombstoned';
    return {
      id: r.id,
      revision: r.revision,
      status: r.status,
      title: r.title,
      categories: r.categories,
      tags: r.tags,
      aliases: r.aliases,
      language: r.language,
      tone: r.tone,
      safety: r.safety,
      text: r.text,
      object: { sha256: r.object.sha256, mime: r.object.mime, bytes: r.object.bytes, width: r.object.width, height: r.object.height, frames: r.object.frames, animated: r.object.animated },
      uploadedAt: r.uploadedAt,
      uploadedAtLocal: toManila(r.uploadedAt),
      firstSeenAt: r.firstSeenAt,
      source: r.source,
      rights: r.rights,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
      deletedAt: r.deletedAt,
      contentUrl: live ? shortContentPath(r.object.sha256, r.object.mime) : null,
      sources: live ? this.sources(commit, r.object.path, mirrors) : [],
    };
  }

  async get(rawId: string) {
    const sha = parseAssetId(rawId);
    const snap = await this.snapshot();
    const r = await this.record(snap, sha);
    if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
    if (r.status === 'tombstoned') {
      throw new AppError(410, 'gone', 'Asset was removed', { retryable: false, details: { id: r.id, deletedAt: r.deletedAt, revision: r.revision } });
    }
    return { commit: snap.commit, asset: this.publicAsset(r, snap.commit, await this.mirrors(snap)) };
  }

  /** Decide the 302 target *now* (fresh HEAD), so a tombstoned asset can never be redirected. */
  async contentTarget(rawId: string, sourceId?: string): Promise<{ url: string; sha256: string; commit: string }> {
    if (!this.config.contentEnabled) throw new AppError(503, 'content_disabled', 'Content serving is temporarily disabled');
    const sha = parseAssetId(rawId);
    const snap = await this.snapshot();
    const r = await this.record(snap, sha);
    if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
    if (r.status === 'tombstoned') throw new AppError(410, 'gone', 'Asset was removed', { retryable: false });
    const list = this.sources(snap.commit, r.object.path, await this.mirrors(snap));
    if (!list.length) throw new AppError(503, 'no_source', 'No content source configured');
    const pick = sourceId ? list.find((s) => s.id === sourceId) : list[0];
    if (!pick) throw new AppError(400, 'unknown_source', `source must be one of ${list.map((s) => s.id).join(',')}`);
    return { url: pick.url, sha256: r.object.sha256, commit: snap.commit };
  }

  /**
   * Resolve a hex prefix (8–64) to a live asset via indexes/docs (keyed by 12-hex docKey).
   * Ambiguous prefixes → 409; unknown → 404. Full 64-hex uses the manifest path directly.
   */
  async resolveByPrefix(prefix: string): Promise<{ sha: string; record: AssetRecord; snap: Snapshot }> {
    const m = SHORT_RE.exec(prefix.toLowerCase());
    if (!m) throw new AppError(404, 'not_found', 'Unknown asset id');
    const pfx = m[1]!;
    const snap = await this.snapshot();
    if (pfx.length === 64) {
      const r = await this.record(snap, pfx);
      if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
      return { sha: pfx, record: r, snap };
    }
    const catalog = await snap.json<Catalog>(INDEX_PATHS.catalog);
    if (!catalog) throw new AppError(404, 'not_found', 'Unknown asset id');
    const shards: string[] = pfx.length >= 3
      ? (catalog.docShards.includes(pfx.slice(0, 3)) ? [pfx.slice(0, 3)] : [])
      : catalog.docShards.filter((s) => s.startsWith(pfx));
    const hits: string[] = [];
    for (const hh of shards) {
      const file = await snap.json<{ docs?: Record<string, { id?: string }> }>(INDEX_PATHS.docs(hh));
      for (const [key, doc] of Object.entries(file?.docs ?? {})) {
        const full = typeof doc?.id === 'string' ? doc.id.replace(/^sha256:/, '') : '';
        if (!full || full.length !== 64) continue;
        if (key.startsWith(pfx) || full.startsWith(pfx)) {
          if (!hits.includes(full)) hits.push(full);
        }
      }
    }
    if (hits.length === 0) throw new AppError(404, 'not_found', 'Unknown asset id');
    if (hits.length > 1) {
      throw new AppError(409, 'ambiguous_id', `Prefix matches ${hits.length} assets; use a longer hex prefix (canonical short id is ${SHORT_ID_LEN} chars)`, {
        retryable: false,
        details: { prefix: pfx, candidates: hits.slice(0, 8).map((id) => id.slice(0, SHORT_ID_LEN)) },
      });
    }
    const sha = hits[0]!;
    const r = await this.record(snap, sha);
    if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
    return { sha, record: r, snap };
  }

  /** Short public URL target: same mirror chain as /v1/assets/:id/content, with ext check. */
  async contentTargetByShort(prefix: string, ext: string): Promise<{ url: string; sha256: string; commit: string; mime: string }> {
    if (!this.config.contentEnabled) throw new AppError(503, 'content_disabled', 'Content serving is temporarily disabled');
    const wantMime = mimeFromExt(ext);
    if (!wantMime) throw new AppError(404, 'not_found', 'Unknown asset id');
    const { sha, record: r, snap } = await this.resolveByPrefix(prefix);
    if (r.status === 'tombstoned') throw new AppError(410, 'gone', 'Asset was removed', { retryable: false });
    if (r.object.mime !== wantMime) {
      throw new AppError(404, 'not_found', `Extension .${ext} does not match this asset (expected .${EXT_BY_MIME[r.object.mime] || 'bin'})`);
    }
    const list = this.sources(snap.commit, r.object.path, await this.mirrors(snap));
    if (!list.length) throw new AppError(503, 'no_source', 'No content source configured');
    return { url: list[0]!.url, sha256: sha, commit: snap.commit, mime: r.object.mime };
  }

  /** Live object bytes at the current HEAD, hash-verified (used by renders referencing an asset). */
  async objectBytes(rawId: string): Promise<{ bytes: Buffer; record: AssetRecord }> {
    const sha = parseAssetId(rawId);
    const snap = await this.snapshot();
    const r = await this.record(snap, sha);
    if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
    if (r.status === 'tombstoned') throw new AppError(410, 'gone', 'Asset was removed', { retryable: false });
    const bytes = await snap.read(r.object.path, { metadata: false });
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha) {
      throw new AppError(503, 'object_unverifiable', 'Object bytes missing or hash mismatch');
    }
    return { bytes, record: r };
  }

  async search(p: { q?: string; category?: string; tag?: string; sort?: string; limit?: number; cursor?: string }) {
    const limit = p.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, 'invalid_limit', 'limit must be 1..50');
    const sort = p.sort ?? (p.q ? 'relevance' : 'uploaded');
    if (sort !== 'relevance' && sort !== 'uploaded') throw new AppError(400, 'invalid_sort', 'sort must be relevance|uploaded');
    let offset = 0;
    if (p.cursor) {
      const n = Number(Buffer.from(p.cursor, 'base64url').toString('utf8'));
      if (!Number.isInteger(n) || n < 0 || n >= 200) throw new AppError(400, 'invalid_cursor', 'Invalid cursor');
      offset = n;
    }
    if ((p.q?.length ?? 0) > 64) throw new AppError(400, 'query_too_long', 'q must be ≤64 characters');

    const snap = await this.snapshot();
    const catalog = await snap.json<Catalog>(INDEX_PATHS.catalog);
    const mirrors = await this.mirrors(snap);
    if (!catalog) return { commit: snap.commit, total: 0, truncated: false, items: [], nextCursor: null };
    const decorate = (d: DocSummary, score: number | undefined) => ({
      ...d,
      uploadedAtLocal: toManila(d.uploadedAt),
      score,
      contentUrl: shortContentPath(d.id.replace(/^sha256:/, ''), d.mime),
      sources: this.sources(snap.commit, d.path, mirrors),
    });
    const cursorFor = (total: number) => (offset + limit < total ? Buffer.from(String(offset + limit)).toString('base64url') : null);

    if (sort === 'relevance' || !p.q) {
      // A's reference implementation (lib/search.mjs), pinned to this commit; snapshot enforces the 512KiB read budget.
      const { value: r } = await withSyncRead(snap, (read) => referenceSearch(read, { q: p.q, category: p.category, tag: p.tag, limit, offset }));
      const items = r.items.map(({ key: _k, score, ...d }) => decorate(d as DocSummary, p.q ? score : undefined));
      return { commit: snap.commit, total: r.total, truncated: r.truncated, items, nextCursor: cursorFor(r.total) };
    }
    // sort=uploaded with a keyword query: same candidate set and filters as A's search, ordered by upload time.
    const recent = (await snap.json<{ items: Array<[string, number]> }>(INDEX_PATHS.recent))?.items ?? [];
    const uploaded = new Map(recent);
    const shardSet = new Set(catalog.termShards);
    const postings = async (term: string): Promise<Array<[string, number]>> => {
      const tt = termShard(term, catalog.termShardCount);
      if (!shardSet.has(tt)) return [];
      const f = await snap.json<{ terms: Record<string, Array<[string, number]>> }>(INDEX_PATHS.terms(tt));
      return f?.terms[term] ?? [];
    };

    // Filters are exact (AND); q terms are scored (sum of weights, CONTRACT §6 suggested algorithm).
    let allowed: Set<string> | null = null;
    const intersect = (keys: string[]) => {
      const s = new Set(keys);
      allowed = allowed ? new Set([...allowed].filter((k) => s.has(k))) : s;
    };
    if (p.category) intersect((await postings(`cat:${p.category}`)).map(([k]) => k));
    if (p.tag) {
      const n = normalizeText(p.tag);
      intersect(n ? (await postings(`tag:${n}`)).map(([k]) => k) : []);
    }
    const filter = allowed as Set<string> | null;
    let ranked: Array<{ key: string; score: number }>;
    const terms = p.q ? queryTerms(p.q).slice(0, 12) : [];
    if (terms.length) {
      const score = new Map<string, number>();
      for (const t of terms) for (const [k, w] of await postings(t)) score.set(k, (score.get(k) ?? 0) + w);
      ranked = [...score].map(([key, s]) => ({ key, score: s }));
      ranked = ranked.filter((r) => uploaded.has(r.key) && (!filter || filter.has(r.key)));
    } else {
      ranked = [];
    }
    const up = (k: string) => uploaded.get(k) ?? 0;
    ranked.sort((a, b) => up(b.key) - up(a.key) || cmp(a.key, b.key));
    const truncated = ranked.length > 200;
    const candidates = ranked.slice(0, 200);
    const page = candidates.slice(offset, offset + limit);
    const docShards = new Set(catalog.docShards);
    const items = [];
    for (const { key, score } of page) {
      const hh = key.slice(0, catalog.docShardPrefixLength);
      if (!docShards.has(hh)) continue;
      const docs = await snap.json<{ docs: Record<string, DocSummary> }>(INDEX_PATHS.docs(hh));
      const d = docs?.docs[key];
      if (d) items.push(decorate(d, score)); // never invent entries if the index is inconsistent
    }
    return { commit: snap.commit, total: candidates.length, truncated, items, nextCursor: cursorFor(candidates.length) };
  }

  /** Public taxonomy (A config/taxonomy.json) with live counts from the catalog when available. */
  async categories() {
    const snap = await this.snapshot();
    const t = await snap.json<{ categories: Array<{ slug: string; label: string }> }>('config/taxonomy.json');
    const catalog = await snap.json<Catalog & { categories?: Record<string, number> }>(INDEX_PATHS.catalog);
    const counts = (catalog as { categories?: Record<string, number> } | null)?.categories ?? {};
    return {
      commit: snap.commit,
      categories: (t?.categories ?? []).map((c) => ({ slug: c.slug, label: c.label, count: catalog ? (typeof counts[c.slug] === 'number' ? counts[c.slug]! : 0) : null })),
    };
  }

  async templatesIndex(snap?: Snapshot) {
    const s = snap ?? (await this.snapshot());
    const catalog = await s.json<Catalog>(INDEX_PATHS.catalog);
    return { snap: s, templates: catalog?.templates ?? [] };
  }

  async operation(principal: Principal, opId: string, idemKey: string | null) {
    if (!/^op_[0-9a-f]{32}$/.test(opId)) throw new AppError(404, 'not_confirmed', 'No published event for this operation');
    if (principal.kind === 'machine') {
      // Ownership proof without storing principals in A: the caller presents the original
      // Idempotency-Key, which must re-derive this operation id under its own scope.
      const scope = principalScope(principal);
      const ok = !!idemKey && this.config.idempotencyKeys.some((k) => operationIdFor(k, scope, idemKey) === opId);
      if (!ok) throw new AppError(403, 'forbidden', 'Operation not owned by this token (send the original Idempotency-Key)');
    }
    const snap = await this.snapshot();
    const ev = await snap.json<EventRecord>(eventPath(opId));
    if (!ev) throw new AppError(404, 'not_confirmed', 'No published event for this operation (not committed, or not yet visible)');
    return { commit: snap.commit, event: { operationId: ev.operationId, type: ev.type, occurredAt: ev.occurredAt, assets: ev.assets, summary: ev.summary } };
  }

  // ---------------------------------------------------------------- writes
  private writable(): Publisher {
    if (!this.config.writesEnabled) throw new AppError(503, 'writes_disabled', 'Writes are temporarily disabled');
    if (!this.publisher || !this.gh?.canWrite) throw new AppError(503, 'writes_disabled', 'Writer GitHub App is not configured');
    if (!this.config.idempotencyKeys.length) throw new AppError(503, 'writes_disabled', 'IDEMPOTENCY_HMAC_KEYS not configured');
    return this.publisher;
  }

  private async limits(snap: Snapshot): Promise<Limits> {
    const l = await snap.json<Limits>('config/limits.json');
    if (!l) throw new AppError(503, 'repo_corrupt', 'A config/limits.json missing');
    return l;
  }
  private async taxonomy(snap: Snapshot): Promise<string[]> {
    const t = await snap.json<{ categories: Array<{ slug: string }> }>('config/taxonomy.json');
    if (!t) throw new AppError(503, 'repo_corrupt', 'A config/taxonomy.json missing');
    return t.categories.map((c) => c.slug);
  }
  private async assertLicense(snap: Snapshot, rights: { basis: string; licenseId: string }) {
    const lic = await snap.json<{ id: string; kind: string }>(licensePath(rights.licenseId));
    if (!lic) throw new AppError(422, 'unknown_license', `licenses/${rights.licenseId}.json does not exist in A`);
    if (lic.kind !== rights.basis) throw new AppError(422, 'license_mismatch', `rights.basis must equal license kind (${lic.kind})`);
  }

  private async planCtx(snap: Snapshot): Promise<PlanCtx> {
    return { synonyms: await snap.json('config/synonyms.json'), limits: await this.limits(snap), registry };
  }

  /**
   * Shared write pipeline. A's lib/commit-plan.mjs computes the complete file set of ONE atomic
   * commit (object, manifest shard, indexes, event, budget); the Publisher only does Git Data API.
   */
  private async write(
    principal: Principal,
    type: string,
    idemKey: string | null,
    fpPayload: object,
    plan: (snap: Snapshot, op: OpCtx) => Promise<Plan>,
  ): Promise<{ receipt: Receipt; created: boolean }> {
    const publisher = this.writable();
    const keys = this.config.idempotencyKeys;
    const scope = principalScope(principal);
    const current = keys[0]!;
    const opId = idemKey ? operationIdFor(current, scope, idemKey) : randomOperationId();
    const canonical = canonicalJson({ type, ...fpPayload });

    const out = await publisher.publish<WriteResult>(async (snap) => {
      const mirrors = await this.mirrors(snap);
      if (idemKey) {
        for (const k of keys) {
          const id = operationIdFor(k, scope, idemKey);
          const ev = await snap.json<EventRecord>(eventPath(id));
          if (!ev) continue;
          if (ev.requestFingerprint?.hmac !== fingerprint(k, canonical)) {
            throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request', { retryable: false });
          }
          const ref = ev.assets[0];
          const rec = ref ? await this.record(snap, ref.id.slice(7)) : null;
          if (!rec) throw new AppError(503, 'repo_corrupt', 'Event references a missing asset');
          return {
            kind: 'noop',
            result: { created: ev.type === 'asset.create', receipt: { operationId: id, status: 'replayed', replayedType: ev.type, asset: this.publicAsset(rec, snap.commit, mirrors) } },
          };
        }
      }
      const op: OpCtx = {
        operationId: opId,
        at: nowUtc(),
        actorKind: principal.kind,
        idempotency: idemKey ? { keyId: current.keyId, keyHmac: keyHmac(current, scope, idemKey) } : null,
        requestFingerprint: idemKey ? { keyId: current.keyId, hmac: fingerprint(current, canonical) } : null,
      };
      let p: Plan;
      try {
        p = await plan(snap, op);
      } catch (e) {
        if (e instanceof PlanError) {
          const status = PLAN_STATUS[e.code] ?? 422;
          throw new AppError(status, e.code === 'tombstoned' ? 'asset_tombstoned' : e.code, e.message, { retryable: status === 429 || status === 503 });
        }
        throw e;
      }
      if (p.kind === 'noop') {
        return { kind: 'noop', result: { created: false, receipt: { operationId: null, status: p.status, asset: this.publicAsset(p.record, snap.commit, mirrors) } } };
      }
      // B-side guards on top of A's plan: schema self-check + per-file size budgets.
      const limits = await this.limits(snap);
      assertSchema('asset', p.after);
      const files = new Map<string, Buffer | null>();
      for (const [path, c] of p.changes) {
        if (c === null) {
          if (p.seen.has(path) && p.seen.get(path) === undefined && !path.startsWith('objects/')) continue; // never delete a missing file
          files.set(path, null);
          continue;
        }
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        if (path.startsWith('indexes/') || path.startsWith('manifests/')) {
          const max = path === INDEX_PATHS.catalog ? limits.maxCatalogBytes : limits.maxShardBytes;
          if (buf.length > max) throw new AppError(507, 'index_full', `${path} would exceed its size budget`);
        }
        files.set(path, buf);
      }
      return {
        kind: 'commit',
        files,
        message: `sticker: ${type} ${p.after.object.sha256.slice(0, 12)}\n\nSticker-Operation: ${opId}\n`,
        result: { created: type === 'asset.create', receipt: { operationId: opId, status: p.status, asset: this.publicAsset(p.after, '0'.repeat(40), null) } },
      };
    });

    const receipt = { ...out.result.receipt, commit: '' } as Receipt;
    if (out.commit) {
      // The Publisher already moved the HEAD cache to the new commit: re-render sources against it.
      const snap = await this.snapshot();
      const rec = await this.record(snap, receipt.asset.object.sha256);
      if (rec) receipt.asset = this.publicAsset(rec, snap.commit, await this.mirrors(snap));
      receipt.commit = out.commit;
    } else {
      receipt.commit = await this.head!.get();
    }
    return { receipt, created: out.result.created };
  }

  async create(principal: Principal, img: ValidatedImage, metadataRaw: Record<string, unknown>, idemKey: string) {
    const sha = createHash('sha256').update(img.bytes).digest('hex');
    const isAdmin = principal.kind === 'admin';
    return this.write(principal, 'asset.create', idemKey, { sha, metadata: metadataRaw }, async (snap, op) => {
      const existing = await this.record(snap, sha);
      if (existing?.status === 'tombstoned') {
        throw new AppError(409, 'asset_tombstoned', 'This image was removed and cannot be re-uploaded (admin restore only)', { retryable: false });
      }
      if (existing) return { kind: 'noop', status: 'duplicate', record: existing };
      const meta = parseCreateMetadata(metadataRaw, await this.taxonomy(snap), isAdmin);
      const { rightsIn, ...m } = meta;
      await this.assertLicense(snap, rightsIn);
      const ctx = await this.planCtx(snap);
      const { value: r, seen } = await withSyncRead(snap, (read) =>
        planCreate(read, { ...op, bytes: img.bytes, uploadedAt: op.at, meta: { ...m, rights: { ...rightsIn, reviewedAt: op.at } } }, ctx),
      );
      if (r.kind === 'duplicate') return { kind: 'noop', status: 'duplicate', record: r.asset };
      return { kind: 'change', status: 'created', after: r.asset, changes: r.changes!, seen };
    });
  }

  private async loadForChange(snap: Snapshot, rawId: string, ifMatch: number | null): Promise<AssetRecord> {
    const r = await this.record(snap, parseAssetId(rawId));
    if (!r) throw new AppError(404, 'not_found', 'Unknown asset id');
    if (r.status === 'tombstoned') throw new AppError(410, 'gone', 'Asset was removed', { retryable: false });
    if (ifMatch !== null && ifMatch !== r.revision) {
      throw new AppError(412, 'revision_mismatch', `Asset is at revision ${r.revision}`, { retryable: false, details: { revision: r.revision } });
    }
    return r;
  }

  async update(principal: Principal, rawId: string, body: unknown, ifMatch: number, idemKey: string | null) {
    const patchIn = asObject(body, 'body');
    return this.write(principal, 'asset.update', idemKey, { id: rawId, ifMatch, patch: patchIn }, async (snap, op) => {
      const before = await this.loadForChange(snap, rawId, ifMatch);
      const next = applyPatch(before, patchIn, await this.taxonomy(snap), principal.kind === 'admin');
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(patchIn)) patch[k] = (next as Record<string, unknown>)[k];
      const ctx = await this.planCtx(snap);
      const { value: r, seen } = await withSyncRead(snap, (read) => planUpdate(read, before.id, { ...op, patch, expectedRevision: ifMatch }, ctx));
      return { kind: 'change', status: 'updated', after: r.after, changes: r.changes, seen };
    });
  }

  /** Review: re-confirm/replace rights (asset.update) or archive (asset.archive). Un-archive is not in A v1. */
  async review(principal: Principal, rawId: string, body: unknown, ifMatch: number, idemKey: string | null) {
    const o = asObject(body, 'body');
    for (const k of Object.keys(o)) if (!['rights', 'status'].includes(k)) throw new AppError(400, 'invalid_metadata', `body.${k}: unknown field`);
    const status = parseStatus(o.status);
    if (status === 'active') throw new AppError(501, 'not_implemented', 'Un-archive (asset.restore) is not part of contract v1');
    if (status && o.rights !== undefined) throw new AppError(400, 'invalid_metadata', 'Send rights and status in separate requests');
    if (!status && o.rights === undefined) throw new AppError(400, 'invalid_metadata', 'rights or status required');
    const rights = o.rights === undefined ? null : rightsInput(o.rights);
    const type = status === 'archived' ? 'asset.archive' : 'asset.update';
    return this.write(principal, type, idemKey, { id: rawId, ifMatch, body: o }, async (snap, op) => {
      const before = await this.loadForChange(snap, rawId, ifMatch);
      const ctx = await this.planCtx(snap);
      if (status === 'archived') {
        const { value: r, seen } = await withSyncRead(snap, (read) => planArchive(read, before.id, { ...op, expectedRevision: ifMatch }, ctx));
        return { kind: 'change', status: 'updated', after: r.after, changes: r.changes, seen };
      }
      await this.assertLicense(snap, rights!);
      const patch = { rights: { ...rights!, reviewedAt: op.at } };
      const { value: r, seen } = await withSyncRead(snap, (read) => planUpdate(read, before.id, { ...op, patch, expectedRevision: ifMatch }, ctx));
      return { kind: 'change', status: 'updated', after: r.after, changes: r.changes, seen };
    });
  }

  async tombstone(principal: Principal, rawId: string, reasonRaw: unknown, ifMatch: number | null, idemKey: string | null) {
    const reason = parseReason(reasonRaw);
    return this.write(principal, 'asset.tombstone', idemKey, { id: rawId, ifMatch, reason }, async (snap, op) => {
      const existing = await this.record(snap, parseAssetId(rawId));
      if (!existing) throw new AppError(404, 'not_found', 'Unknown asset id');
      if (existing.status === 'tombstoned') return { kind: 'noop', status: 'unchanged', record: existing };
      const before = await this.loadForChange(snap, rawId, ifMatch);
      const ctx = await this.planCtx(snap);
      const { value: r, seen } = await withSyncRead(snap, (read) =>
        planTombstone(read, before.id, { ...op, reason, expectedRevision: ifMatch ?? undefined }, ctx),
      );
      return { kind: 'change', status: 'tombstoned', after: r.after, changes: r.changes, seen };
    });
  }

  /**
   * Create many assets in ONE GitHub commit (event type import.batch).
   * Cap: BATCH_MAX_ITEMS / BATCH_MAX_BYTES. Partial success is explicit per item;
   * daily/capacity errors stop further creates but still commit what already planned.
   */
  async createBatch(
    principal: Principal,
    items: Array<{ img: ValidatedImage; metadata: Record<string, unknown> }>,
    idemKey: string,
  ): Promise<{ receipt: BatchReceipt; created: boolean }> {
    if (items.length < 1) throw new AppError(400, 'empty_batch', 'batch requires at least one file');
    if (items.length > BATCH_MAX_ITEMS) {
      throw new AppError(400, 'batch_too_large', `At most ${BATCH_MAX_ITEMS} assets per batch (one commit; Vercel body/time limits)`);
    }
    const totalBytes = items.reduce((n, it) => n + it.img.bytes.length, 0);
    if (totalBytes > BATCH_MAX_BYTES) {
      throw new AppError(413, 'payload_too_large', `Batch images total must be ≤ ${BATCH_MAX_BYTES} bytes`);
    }

    const publisher = this.writable();
    const keys = this.config.idempotencyKeys;
    const scope = principalScope(principal);
    const current = keys[0]!;
    const opId = operationIdFor(current, scope, idemKey);
    const fpPayload = {
      items: items.map((it) => ({
        sha: createHash('sha256').update(it.img.bytes).digest('hex'),
        metadata: it.metadata,
      })),
    };
    const canonical = canonicalJson({ type: 'import.batch', ...fpPayload });
    const isAdmin = principal.kind === 'admin';

    type Built = {
      commitFiles: Map<string, Buffer | null>;
      itemResults: BatchItemResult[];
      summary: { created: number; duplicate: number; error: number; addedBytes: number };
      noopOnly: boolean;
    };

    const out = await publisher.publish<{ built: Built; replay?: BatchReceipt }>(async (snap) => {
      const mirrors = await this.mirrors(snap);
      for (const k of keys) {
        const id = operationIdFor(k, scope, idemKey);
        const ev = await snap.json<EventRecord>(eventPath(id));
        if (!ev) continue;
        if (ev.requestFingerprint?.hmac !== fingerprint(k, canonical)) {
          throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request', { retryable: false });
        }
        const itemsOut: BatchItemResult[] = [];
        for (let i = 0; i < ev.assets.length; i++) {
          const ref = ev.assets[i]!;
          const rec = await this.record(snap, ref.id.slice(7));
          if (!rec) throw new AppError(503, 'repo_corrupt', 'Batch event references a missing asset');
          itemsOut.push({ index: i, status: 'duplicate', asset: this.publicAsset(rec, snap.commit, mirrors) });
        }
        // Replay: treat as duplicate/replay of prior batch (assets already exist)
        const receipt: BatchReceipt = {
          operationId: id,
          commit: snap.commit,
          status: 'replayed',
          replayedType: ev.type,
          summary: {
            created: 0,
            duplicate: itemsOut.length,
            error: 0,
            addedBytes: typeof ev.summary.addedBytes === 'number' ? ev.summary.addedBytes : 0,
          },
          items: itemsOut.map((it) =>
            it.status === 'error' ? it : { index: it.index, status: 'duplicate' as const, asset: it.asset },
          ),
        };
        return { kind: 'noop', result: { built: { commitFiles: new Map(), itemResults: [], summary: receipt.summary, noopOnly: true }, replay: receipt } };
      }

      const op: OpCtx = {
        operationId: opId,
        at: nowUtc(),
        actorKind: principal.kind,
        idempotency: { keyId: current.keyId, keyHmac: keyHmac(current, scope, idemKey) },
        requestFingerprint: { keyId: current.keyId, hmac: fingerprint(current, canonical) },
      };
      const ctx = await this.planCtx(snap);
      const taxonomy = await this.taxonomy(snap);
      const limits = await this.limits(snap);

      const { value: built, seen } = await withSyncRead(snap, (baseRead) => {
        const overlay = new Map<string, Buffer | string | null>();
        const oread = (path: string): string | undefined => {
          if (overlay.has(path)) {
            const v = overlay.get(path);
            if (v === null || v === undefined) return undefined;
            return typeof v === 'string' ? v : v.toString('utf8');
          }
          return baseRead(path);
        };
        const itemResults: BatchItemResult[] = [];
        const summary = { created: 0, duplicate: 0, error: 0, addedBytes: 0 };
        let stop = false;
        for (let i = 0; i < items.length; i++) {
          const it = items[i]!;
          if (stop) {
            itemResults.push({ index: i, status: 'error', error: { code: 'batch_aborted', message: 'Earlier item hit daily/capacity limit; not attempted' } });
            summary.error++;
            continue;
          }
          try {
            const existing = (() => {
              const sha = createHash('sha256').update(it.img.bytes).digest('hex');
              const raw = oread(`manifests/${sha.slice(0, 2)}.json`);
              if (!raw) return null;
              const shard = JSON.parse(raw) as ManifestShard;
              return shard.assets.find((a) => a.id === `sha256:${sha}`) ?? null;
            })();
            if (existing?.status === 'tombstoned') {
              itemResults.push({ index: i, status: 'error', error: { code: 'asset_tombstoned', message: 'This image was removed and cannot be re-uploaded' } });
              summary.error++;
              continue;
            }
            if (existing) {
              itemResults.push({ index: i, status: 'duplicate', asset: this.publicAsset(existing, snap.commit, null) });
              summary.duplicate++;
              continue;
            }
            const meta = parseCreateMetadata(it.metadata, taxonomy, isAdmin);
            const { rightsIn, ...m } = meta;
            // license must exist on base or overlay
            const licRaw = oread(licensePath(rightsIn.licenseId));
            if (!licRaw) throw new PlanError('unknown_license', `licenses/${rightsIn.licenseId}.json does not exist in A`);
            const lic = JSON.parse(licRaw) as { kind: string };
            if (lic.kind !== rightsIn.basis) {
              throw new AppError(422, 'license_mismatch', `rights.basis must equal license kind (${lic.kind})`);
            }
            const r = planCreate(
              oread,
              {
                ...op,
                bytes: it.img.bytes,
                uploadedAt: op.at,
                meta: { ...m, rights: { ...rightsIn, reviewedAt: op.at } },
              },
              ctx,
            );
            if (r.kind === 'duplicate') {
              itemResults.push({ index: i, status: 'duplicate', asset: this.publicAsset(r.asset, snap.commit, null) });
              summary.duplicate++;
              continue;
            }
            assertSchema('asset', r.asset);
            for (const [path, c] of r.changes!) {
              overlay.set(path, c);
            }
            itemResults.push({ index: i, status: 'created', asset: this.publicAsset(r.asset, '0'.repeat(40), null) });
            summary.created++;
            summary.addedBytes += it.img.bytes.length;
          } catch (e) {
            if (e instanceof AppError) {
              itemResults.push({ index: i, status: 'error', error: { code: e.code, message: e.message } });
              summary.error++;
              if (e.code === 'daily_budget_exceeded' || e.code === 'capacity_exceeded') stop = true;
              continue;
            }
            if (e instanceof PlanError) {
              const code = e.code === 'tombstoned' ? 'asset_tombstoned' : e.code;
              itemResults.push({ index: i, status: 'error', error: { code, message: e.message } });
              summary.error++;
              if (e.code === 'daily_budget_exceeded' || e.code === 'capacity_exceeded') stop = true;
              continue;
            }
            throw e;
          }
        }

        if (summary.created === 0) {
          return { commitFiles: new Map<string, Buffer | null>(), itemResults, summary, noopOnly: true };
        }

        // Replace per-item asset.create event (same path overwritten N times) with one import.batch event.
        const createdAssets: Array<{ id: string; revision: number }> = [];
        for (const x of itemResults) {
          if (x.status === 'created') createdAssets.push({ id: x.asset.id, revision: x.asset.revision });
        }
        const ev: EventRecord = {
          schemaVersion: 1,
          operationId: opId,
          type: 'import.batch',
          occurredAt: op.at,
          actorKind: op.actorKind,
          idempotency: op.idempotency,
          requestFingerprint: op.requestFingerprint,
          assets: createdAssets,
          summary: { added: summary.created, addedBytes: summary.addedBytes },
        };
        assertSchema('event', ev);
        overlay.set(eventPath(opId), pretty(ev));

        const commitFiles = new Map<string, Buffer | null>();
        for (const [path, c] of overlay) {
          if (c === null) {
            commitFiles.set(path, null);
            continue;
          }
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          if (path.startsWith('indexes/') || path.startsWith('manifests/')) {
            const max = path === INDEX_PATHS.catalog ? limits.maxCatalogBytes : limits.maxShardBytes;
            if (buf.length > max) throw new AppError(507, 'index_full', `${path} would exceed its size budget`);
          }
          commitFiles.set(path, buf);
        }
        return { commitFiles, itemResults, summary, noopOnly: false };
      });

      void seen;
      if (built.noopOnly) {
        return { kind: 'noop', result: { built } };
      }
      return {
        kind: 'commit',
        files: built.commitFiles,
        message: `sticker: import.batch +${built.summary.created}\n\nSticker-Operation: ${opId}\n`,
        result: { built },
      };
    });

    if (out.result.replay) {
      return { receipt: { ...out.result.replay, commit: out.commit ?? out.result.replay.commit }, created: false };
    }
    const built = out.result.built;
    const commit = out.commit ?? (await this.head!.get());
    const mirrors = await this.mirrors(await this.snapshot());
    const snap = await this.snapshot();
    const itemsOut: BatchItemResult[] = [];
    for (const it of built.itemResults) {
      if (it.status === 'error') {
        itemsOut.push(it);
        continue;
      }
      const sha = it.asset.object.sha256;
      const rec = await this.record(snap, sha);
      itemsOut.push({
        index: it.index,
        status: it.status,
        asset: this.publicAsset(rec ?? (it.asset as unknown as AssetRecord), snap.commit, mirrors),
      });
    }
    return {
      receipt: {
        operationId: built.summary.created || built.summary.duplicate ? opId : null,
        commit,
        status: built.summary.created ? 'created' : 'unchanged',
        summary: built.summary,
        items: itemsOut,
      },
      created: built.summary.created > 0,
    };
  }
}

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
  assertSchema, candidateUrls, cmp, eventPath, hashShard, INDEX_PATHS, licensePath, manifestPath, normalizeText,
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

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ID_RE = /^(?:sha256:)?([0-9a-f]{64})$/;

export function parseAssetId(raw: string): string {
  const m = ID_RE.exec(raw);
  if (!m) throw new AppError(404, 'not_found', 'Unknown asset id');
  return m[1]!;
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
      contentUrl: live ? `/v1/assets/${r.id}/content` : null,
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
      contentUrl: `/v1/assets/${d.id}/content`,
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
}

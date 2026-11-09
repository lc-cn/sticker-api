/**
 * Thin typed facade over A's vendored contract libraries (vendor/sticker-assets, copied verbatim
 * by scripts/vendor-assets-contract.mjs). Tokenizer, shard hashing, incremental index updates and
 * mirror URL assembly are NOT re-implemented here, so B's commits stay byte-identical to A's
 * `buildIndex()` output (CONTRACT §6).
 */
// @ts-ignore vendored JS
import * as indexer from '../../vendor/sticker-assets/lib/indexer.mjs';
// @ts-ignore vendored JS
import * as tokenize from '../../vendor/sticker-assets/lib/tokenize.mjs';
// @ts-ignore vendored JS
import * as urls from '../../vendor/sticker-assets/lib/urls.mjs';
// @ts-ignore vendored JS
import * as image from '../../vendor/sticker-assets/lib/image.mjs';
// @ts-ignore vendored JS
import * as canonical from '../../vendor/sticker-assets/lib/canonical.mjs';
// @ts-ignore vendored JS
import * as time from '../../vendor/sticker-assets/lib/time.mjs';
// @ts-ignore vendored JS
import * as plan from '../../vendor/sticker-assets/lib/commit-plan.mjs';
// @ts-ignore vendored JS
import * as searchLib from '../../vendor/sticker-assets/lib/search.mjs';
// @ts-ignore vendored JS
import { SchemaRegistry } from '../../vendor/sticker-assets/lib/jsonschema.mjs';
// @ts-ignore vendored JS
import { SCHEMAS } from '../../vendor/sticker-assets/schemas.mjs';
import { AppError } from '../errors.js';

export type AssetStatus = 'active' | 'archived' | 'tombstoned';
export type AssetRecord = {
  id: string;
  revision: number;
  status: AssetStatus;
  object: { sha256: string; path: string; mime: 'image/png' | 'image/jpeg' | 'image/gif'; bytes: number; width: number; height: number; frames: number; animated: boolean };
  originalSha256: string | null;
  title: string;
  categories: string[];
  tags: string[];
  aliases: string[];
  language: string;
  tone: 'positive' | 'neutral' | 'negative' | 'sarcastic';
  safety: { rating: 'general' | 'mild' | 'sensitive'; offensive: boolean };
  text: { ocr: string | null; ocrSource: 'client' | 'manual' | null; ocrConfirmed: boolean };
  uploadedAt: string;
  firstSeenAt: string | null;
  source: { kind: string; adapter: string | null; url: string | null; itemId: string | null; publishedAt: string | null; confidence: string };
  rights: { basis: 'self-created' | 'license' | 'creator-permission' | 'pending'; licenseId: string; reviewedAt: string | null; publicUrl: string | null };
  updatedAt: string;
  lastOperationId: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  tombstone: { reason: string } | null;
};
export type ManifestShard = { schemaVersion: 1; shard: string; assets: AssetRecord[] };
export type EventRecord = {
  schemaVersion: 1;
  operationId: string;
  type: string;
  occurredAt: string;
  actorKind: 'admin' | 'machine' | 'actions';
  idempotency: { keyId: string; keyHmac: string } | null;
  requestFingerprint: { keyId: string; hmac: string } | null;
  assets: Array<{ id: string; revision: number }>;
  summary: Record<string, number | string>;
};
export type Limits = {
  maxAssets: number; maxManagedBytes: number; warnManagedBytes: number; maxObjectBytes: number; maxLongEdge: number;
  maxCanvasPixels: number; maxFrames: number; maxTotalFramePixels: number; dailyMaxAssets: number; dailyMaxBytes: number;
  maxCatalogBytes: number; maxShardBytes: number; maxTags: number; maxTagLength: number; maxTitleLength: number; maxCategories: number; termShardCount: number;
};
export type Catalog = {
  termShardCount: number;
  docShardPrefixLength: number;
  counts: { active: number; archived: number; tombstoned: number };
  bytes: { objects: number; templates: number };
  categories: Record<string, number>;
  termShards: string[];
  docShards: string[];
  templates: Array<{ id: string; version: number; path: string; title: string; status: string }>;
  limits: Limits;
};
export type DocSummary = {
  id: string; path: string; mime: string; bytes: number; width: number; height: number; frames: number; animated: boolean;
  title: string; categories: string[]; tags: string[]; tone: string; safety: AssetRecord['safety']; uploadedAt: string; publishedAt: string | null; revision: number;
};
export type MirrorsConfig = {
  owner: string | null; repo: string | null;
  origin: { id: string; template: string };
  mirrors: Array<{ id: string; template: string; enabled: boolean; verifiedAt: string | null }>;
  allowedHosts: string[];
};

export const INDEX_PATHS = indexer.paths as { catalog: string; recent: string; terms: (tt: string) => string; docs: (hh: string) => string };
export const docKey = (a: { object: { sha256: string } }): string => indexer.docKey(a);
/** manifests/<hh>.json shard (sha256 first 2 hex, CONTRACT §1) */
export const hashShard = (sha: string): string => sha.slice(0, 2);
export const termShard = (term: string, count: number): string => indexer.termShard(term, count);
export const synonymMap = (syn: unknown): Map<string, string[]> => indexer.synonymMap(syn);
export const termsForAsset = (a: AssetRecord, syn: Map<string, string[]>): Map<string, number> => indexer.termsForAsset(a, syn);
export const applyAssetChange = (
  read: (p: string) => string | undefined,
  before: AssetRecord | null,
  after: AssetRecord | null,
  ctx: { synonyms: unknown },
): Map<string, string | null> => indexer.applyAssetChange(read, before, after, ctx);
export const normalizeText = (s: string): string => tokenize.normalize(s);
export const queryTerms = (q: string): string[] => tokenize.queryTerms(q);
export const candidateUrls = (p: { commit: string; path: string }, cfg: MirrorsConfig): Array<{ id: string; url: string }> => urls.candidateUrls(p, cfg);
export const inspectImage = (b: Buffer): { mime: string | null; width: number; height: number; frames: number; animated: boolean; metadata: string[]; problems: string[] } =>
  image.inspectImage(b) as any;
export const budgetProblems = (info: { width: number; height: number; frames: number }, limits: Limits): string[] => image.budgetProblems(info, limits);
export const pretty = (v: unknown): string => canonical.pretty(v);
export const cmp = (a: string, b: string): number => canonical.cmp(a, b);
export const manilaDate = (utc: string): string => time.manilaDate(utc);

export type SyncRead = (path: string) => string | undefined;
export type Changes = Map<string, Buffer | string | null>;
export type PlanCtx = { synonyms: unknown; limits: Limits; registry: unknown };
export const PlanError: new (...a: any[]) => Error & { code: string; asset?: AssetRecord } = plan.PlanError;
export const planCreate = (read: SyncRead, op: object, ctx: PlanCtx): { kind: 'created' | 'duplicate'; asset: AssetRecord; changes?: Changes } =>
  plan.planCreate(read, op, ctx);
export const planUpdate = (read: SyncRead, id: string, op: object, ctx: PlanCtx): { before: AssetRecord; after: AssetRecord; changes: Changes } =>
  plan.planUpdate(read, id, op, ctx);
export const planArchive = (read: SyncRead, id: string, op: object, ctx: PlanCtx): { before: AssetRecord; after: AssetRecord; changes: Changes } =>
  plan.planArchive(read, id, op, ctx);
export const planTombstone = (read: SyncRead, id: string, op: object, ctx: PlanCtx): { before: AssetRecord; after: AssetRecord; changes: Changes } =>
  plan.planTombstone(read, id, op, ctx);
export const referenceSearch = (
  read: SyncRead,
  opts: { q?: string; category?: string; tag?: string; limit?: number; offset?: number },
): { total: number; truncated: boolean; items: Array<DocSummary & { key: string; score: number }>; bytesRead: number } => searchLib.search(read, opts) as any;
export const docShard = (sha: string): string => indexer.docShard(sha);

/** PlanError.code (CONTRACT §6.1) → HTTP status. */
export const PLAN_STATUS: Record<string, number> = {
  unsupported_media_type: 415, invalid_image: 400, metadata_not_stripped: 400, payload_too_large: 413,
  decode_budget_exceeded: 400, tombstoned: 409, invalid_metadata: 400, unknown_license: 422,
  repo_not_initialized: 503, capacity_exceeded: 507, daily_budget_exceeded: 429, not_found: 404,
  precondition_failed: 412, conflict: 409, gone: 410,
};

export const registry = new SchemaRegistry();
for (const s of SCHEMAS as object[]) registry.add(s);

/** Self-check with A's own JSON Schemas before anything is committed (CONTRACT §4). */
export function assertSchema(name: 'asset' | 'manifest-shard' | 'event' | 'budget', value: unknown): void {
  const errors = registry.validate(`urn:sticker-assets:v1:${name}`, value) as Array<{ path: string; message: string }>;
  if (errors.length) {
    throw new AppError(422, 'contract_violation', `Refusing to publish: ${name} fails A schema`, {
      retryable: false,
      details: errors.slice(0, 5),
    });
  }
}

export const objectPath = (sha: string, ext: string) => `objects/sha256/${sha.slice(0, 2)}/${sha}.${ext}`;
export const manifestPath = (hh: string) => `manifests/${hh}.json`;
export const eventPath = (opId: string) => `events/${opId.slice(3, 5)}/${opId}.json`;
export const budgetPath = (date: string) => `budgets/daily/${date}.json`;
export const licensePath = (id: string) => `licenses/${id}.json`;

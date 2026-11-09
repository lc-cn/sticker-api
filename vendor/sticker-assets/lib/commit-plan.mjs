// 提交计划：给定固定 commit H 的只读视图 read(path)，算出“一个原子 commit 需要写入/删除的全部文件”。
// B 拿到 changes 后只需：create blobs → create tree(base_tree=H) → commit(parents=[H]) → update ref force:false。
// 冲突时用新 HEAD 的 read 重新调用本函数，绝不复用旧 changes。
// changes: Map(path → Buffer | string | null)，null 表示从树中删除该路径。
import { sha256Hex } from './hash.mjs';
import { pretty, cmp } from './canonical.mjs';
import { inspectImage, budgetProblems, EXT_BY_MIME } from './image.mjs';
import { manilaDate } from './time.mjs';
import { normalize } from './tokenize.mjs';
import { applyAssetChange, paths as indexPaths } from './indexer.mjs';

export class PlanError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export const objectPath = (sha, mime) => `objects/sha256/${sha.slice(0, 2)}/${sha}.${EXT_BY_MIME[mime]}`;
export const manifestPath = (sha) => `manifests/${sha.slice(0, 2)}.json`;
export const eventPath = (opId) => `events/${opId.slice(3, 5)}/${opId}.json`;
export const budgetPath = (date) => `budgets/daily/${date}.json`;

const readJson = (read, p) => { const s = read(p); return s === undefined ? undefined : JSON.parse(typeof s === 'string' ? s : s.toString('utf8')); };

export function findAsset(read, id) {
  const sha = id.replace(/^sha256:/, '');
  return readJson(read, manifestPath(sha))?.assets.find((a) => a.id === `sha256:${sha}`) || null;
}

function shardWith(read, sha, record) {
  const p = manifestPath(sha);
  const cur = readJson(read, p)?.assets || [];
  const assets = cur.filter((a) => a.id !== record.id);
  assets.push(record);
  assets.sort((a, b) => cmp(a.id, b.id));
  return [p, pretty({ schemaVersion: 1, shard: sha.slice(0, 2), assets })];
}

function makeEvent({ operationId, type, occurredAt, actorKind, idempotency = null, requestFingerprint = null, assets, summary }) {
  return pretty({ schemaVersion: 1, operationId, type, occurredAt, actorKind, idempotency, requestFingerprint, assets, summary });
}

function checkMeta(meta, limits) {
  const bad = (m) => { throw new PlanError('invalid_metadata', m); };
  if (!meta.title || [...meta.title].length > limits.maxTitleLength) bad('title 为空或过长');
  if (!Array.isArray(meta.categories) || meta.categories.length < 1 || meta.categories.length > limits.maxCategories) bad('categories 数量不合法');
  for (const [n, list] of [['tags', meta.tags || []], ['aliases', meta.aliases || []]]) {
    if (list.length > limits.maxTags) bad(`${n} 过多`);
    if (list.some((t) => [...t].length > limits.maxTagLength || !normalize(t))) bad(`${n} 含过长或空项`);
    if (new Set(list.map(normalize)).size !== list.length) bad(`${n} 规范化后重复`);
  }
  if (!meta.rights || meta.rights.basis === 'pending') bad('rights.basis=pending 不得进入 A');
}

/**
 * 新增资产。
 * @param read (path)=>string|Buffer|undefined  —— 固定 H 的视图
 * @param op { bytes:Buffer, meta, uploadedAt, operationId, actorKind, idempotency?, requestFingerprint?, originalSha256? }
 *   meta = { title, categories, tags, aliases, language, tone, safety, text, firstSeenAt, source, rights }
 * @param ctx { synonyms, limits, now? }
 * @returns {{kind:'created'|'duplicate', asset, changes?: Map}}
 */
export function planCreate(read, op, ctx) {
  const { limits } = ctx;
  const info = inspectImage(op.bytes);
  if (!info.mime) throw new PlanError('unsupported_media_type', info.problems.join('; '));
  if (info.problems.length) throw new PlanError('invalid_image', info.problems.join('; '));
  if (info.metadata.length) throw new PlanError('metadata_not_stripped', `须先剥离元数据: ${info.metadata.join(',')}`);
  if (op.bytes.length > limits.maxObjectBytes) throw new PlanError('payload_too_large', '对象超过单图上限');
  const budget = budgetProblems(info, limits);
  if (budget.length) throw new PlanError('decode_budget_exceeded', budget.join('; '));
  const sha = sha256Hex(op.bytes);
  const id = `sha256:${sha}`;
  const existing = findAsset(read, id);
  if (existing?.status === 'tombstoned') throw new PlanError('tombstoned', '该图已下架，同 hash 重传不会复活（需独立管理员恢复操作）', { asset: existing });
  if (existing) return { kind: 'duplicate', asset: existing };
  checkMeta(op.meta, limits);
  if (read(`licenses/${op.meta.rights.licenseId}.json`) === undefined) throw new PlanError('unknown_license', `licenses/${op.meta.rights.licenseId}.json 不存在`);

  const catalog = readJson(read, indexPaths.catalog);
  if (!catalog) throw new PlanError('repo_not_initialized', '缺少 indexes/catalog.json');
  if (catalog.counts.active + catalog.counts.archived + 1 > limits.maxAssets) throw new PlanError('capacity_exceeded', `资产数将超过 ${limits.maxAssets}`);
  if (catalog.bytes.objects + catalog.bytes.templates + op.bytes.length > limits.maxManagedBytes) throw new PlanError('capacity_exceeded', '对象字节将超过上限');
  const date = manilaDate(op.uploadedAt);
  const bud = readJson(read, budgetPath(date)) || { schemaVersion: 1, date, timeZone: 'Asia/Manila', acceptedCount: 0, acceptedBytes: 0 };
  if (bud.acceptedCount + 1 > limits.dailyMaxAssets || bud.acceptedBytes + op.bytes.length > limits.dailyMaxBytes) throw new PlanError('daily_budget_exceeded', `${date} 当日成功发布预算已满`);

  const m = op.meta;
  const asset = {
    id, revision: 1, status: 'active',
    object: { sha256: sha, path: objectPath(sha, info.mime), mime: info.mime, bytes: op.bytes.length, width: info.width, height: info.height, frames: info.frames, animated: info.frames > 1 },
    originalSha256: op.originalSha256 && op.originalSha256 !== sha ? op.originalSha256 : null,
    title: m.title, categories: m.categories, tags: m.tags || [], aliases: m.aliases || [],
    language: m.language || 'zh-CN', tone: m.tone || 'neutral',
    safety: { rating: m.safety?.rating || 'general', offensive: !!m.safety?.offensive },
    text: { ocr: m.text?.ocr ?? null, ocrSource: m.text?.ocrSource ?? null, ocrConfirmed: !!m.text?.ocrConfirmed },
    uploadedAt: op.uploadedAt, firstSeenAt: m.firstSeenAt ?? null,
    source: { kind: m.source?.kind || 'manual-collection', adapter: m.source?.adapter ?? null, url: m.source?.url ?? null, itemId: m.source?.itemId ?? null, publishedAt: m.source?.publishedAt ?? null, confidence: m.source?.confidence || 'none' },
    rights: { basis: m.rights.basis, licenseId: m.rights.licenseId, reviewedAt: m.rights.reviewedAt ?? null, publicUrl: m.rights.publicUrl ?? null },
    updatedAt: op.uploadedAt, lastOperationId: op.operationId, archivedAt: null, deletedAt: null, tombstone: null,
  };
  if (ctx.registry) {
    const errs = ctx.registry.validate('urn:sticker-assets:v1:asset', asset);
    if (errs.length) throw new PlanError('invalid_metadata', errs.map((e) => `${e.path}: ${e.message}`).join('; '));
  }
  const changes = new Map();
  changes.set(asset.object.path, op.bytes);
  changes.set(...shardWith(read, sha, asset));
  for (const [p, c] of applyAssetChange((p) => { const s = read(p); return s === undefined ? undefined : String(s); }, null, asset, ctx)) changes.set(p, c);
  changes.set(budgetPath(date), pretty({ ...bud, acceptedCount: bud.acceptedCount + 1, acceptedBytes: bud.acceptedBytes + op.bytes.length }));
  changes.set(eventPath(op.operationId), makeEvent({ operationId: op.operationId, type: 'asset.create', occurredAt: op.uploadedAt, actorKind: op.actorKind, idempotency: op.idempotency, requestFingerprint: op.requestFingerprint, assets: [{ id, revision: 1 }], summary: { added: 1, addedBytes: op.bytes.length } }));
  return { kind: 'created', asset, changes };
}

function mutate(read, id, op, ctx, type, fn) {
  const before = findAsset(read, id);
  if (!before) throw new PlanError('not_found', `${id} 不存在`);
  if (op.expectedRevision !== undefined && op.expectedRevision !== before.revision) throw new PlanError('precondition_failed', `revision 已是 ${before.revision}`, { asset: before });
  const after = structuredClone(before);
  fn(after, before);
  after.revision = before.revision + 1;
  after.updatedAt = op.at;
  after.lastOperationId = op.operationId;
  if (ctx.registry) {
    const errs = ctx.registry.validate('urn:sticker-assets:v1:asset', after);
    if (errs.length) throw new PlanError('invalid_metadata', errs.map((e) => `${e.path}: ${e.message}`).join('; '));
  }
  const sha = before.object.sha256;
  const changes = new Map();
  changes.set(...shardWith(read, sha, after));
  for (const [p, c] of applyAssetChange((p) => { const s = read(p); return s === undefined ? undefined : String(s); }, before, after, ctx)) changes.set(p, c);
  changes.set(eventPath(op.operationId), makeEvent({ operationId: op.operationId, type, occurredAt: op.at, actorKind: op.actorKind, idempotency: op.idempotency, requestFingerprint: op.requestFingerprint, assets: [{ id, revision: after.revision }], summary: type === 'asset.tombstone' ? { removed: 1 } : { updated: 1 } }));
  return { before, after, changes };
}

const EDITABLE = ['title', 'categories', 'tags', 'aliases', 'language', 'tone', 'safety', 'text', 'firstSeenAt', 'source', 'rights'];

/** 元数据修改（PATCH）。op = { patch, expectedRevision, at, operationId, actorKind, ... } */
export function planUpdate(read, id, op, ctx) {
  for (const k of Object.keys(op.patch)) if (!EDITABLE.includes(k)) throw new PlanError('invalid_metadata', `不可修改字段 ${k}`);
  return mutate(read, id, op, ctx, 'asset.update', (a, before) => {
    if (before.status === 'tombstoned') throw new PlanError('tombstoned', '已下架资产不可修改');
    Object.assign(a, structuredClone(op.patch));
    checkMeta(a, ctx.limits);
  });
}

/** 归档：仍可按 id 读取，不进搜索。 */
export function planArchive(read, id, op, ctx) {
  return mutate(read, id, op, ctx, 'asset.archive', (a) => {
    if (a.status !== 'active') throw new PlanError('conflict', `当前状态 ${a.status} 不能归档`);
    a.status = 'archived'; a.archivedAt = op.at;
  });
}

/** 下架：删除当前树中的对象文件，保留 tombstone 记录阻止同 hash 复活。op.reason 见 schema。 */
export function planTombstone(read, id, op, ctx) {
  const r = mutate(read, id, op, ctx, 'asset.tombstone', (a) => {
    if (a.status === 'tombstoned') throw new PlanError('gone', '已下架');
    a.status = 'tombstoned'; a.deletedAt = op.at; a.tombstone = { reason: op.reason };
  });
  r.changes.set(r.before.object.path, null);
  return r;
}

/** 把 changes 应用到内存文件表（测试/本地工具用） */
export function applyChanges(files, changes) {
  for (const [p, c] of changes) { if (c === null) files.delete(p); else files.set(p, c); }
  return files;
}

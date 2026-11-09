// 索引构建（indexFormat 1）。纯函数、无 I/O：全量 buildIndex 与增量 applyAssetChange 结果必须逐字节一致。
import { analyze, normalize, TOKENIZER } from './tokenize.mjs';
import { fnv1a32, hex2 } from './hash.mjs';
import { compact, cmp } from './canonical.mjs';

export const INDEX_FORMAT = 1;
export const DOC_KEY_LENGTH = 12;
export const WEIGHTS = Object.freeze({
  tagWhole: 10, tagPart: 3, aliasWhole: 8, aliasPart: 3, titleWhole: 6, titlePart: 2,
  synonym: 5, ocrWhole: 3, ocrPart: 1, category: 1, exactTag: 10, max: 100,
});

export const docKey = (asset) => asset.object.sha256.slice(0, DOC_KEY_LENGTH);
export const DOC_SHARD_PREFIX = 3;
export const docShard = (sha256) => sha256.slice(0, DOC_SHARD_PREFIX);
export const termShard = (term, count) => hex2(fnv1a32(term) % count);

export const paths = {
  catalog: 'indexes/catalog.json',
  recent: 'indexes/recent.json',
  terms: (tt) => `indexes/terms/${tt}.json`,
  docs: (hh) => `indexes/docs/${hh}.json`,
};

/** 同义词表 → Map(规范化词 → 同组其它规范化词[]) */
export function synonymMap(synonyms) {
  const m = new Map();
  for (const group of synonyms?.groups || []) {
    const norm = [...new Set(group.map(normalize).filter(Boolean))];
    for (const w of norm) {
      const others = norm.filter((x) => x !== w);
      m.set(w, [...new Set([...(m.get(w) || []), ...others])]);
    }
  }
  return m;
}

/** 资产 → Map(term → weight) */
export function termsForAsset(asset, synMap = new Map()) {
  const w = new Map();
  const bump = (t, n) => w.set(t, Math.min(WEIGHTS.max, (w.get(t) || 0) + n));
  const field = (text, whole, part, withSyn) => {
    for (const [t, kind] of analyze(text)) {
      bump(t, kind === 'whole' ? whole : part);
      if (withSyn && kind === 'whole') for (const s of synMap.get(t) || []) bump(s, WEIGHTS.synonym);
    }
  };
  for (const tag of asset.tags) {
    field(tag, WEIGHTS.tagWhole, WEIGHTS.tagPart, true);
    const n = normalize(tag);
    if (n) bump(`tag:${n}`, WEIGHTS.exactTag);
  }
  for (const a of asset.aliases) field(a, WEIGHTS.aliasWhole, WEIGHTS.aliasPart, true);
  field(asset.title, WEIGHTS.titleWhole, WEIGHTS.titlePart, true);
  if (asset.text?.ocrConfirmed && asset.text.ocr) field(asset.text.ocr, WEIGHTS.ocrWhole, WEIGHTS.ocrPart, false);
  for (const c of asset.categories) bump(`cat:${c}`, WEIGHTS.category);
  return w;
}

export function docSummary(a) {
  return {
    id: a.id, path: a.object.path, mime: a.object.mime, bytes: a.object.bytes,
    width: a.object.width, height: a.object.height, frames: a.object.frames, animated: a.object.animated,
    title: a.title, categories: a.categories, tags: a.tags, tone: a.tone, safety: a.safety,
    uploadedAt: a.uploadedAt, publishedAt: a.source.publishedAt, revision: a.revision,
  };
}

const epochSec = (utc) => Math.floor(Date.parse(utc) / 1000);
const sortPostings = (list) => list.sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]));
const sortRecent = (items) => items.sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]));

function termsFile(tt, terms) {
  const ordered = {};
  for (const k of Object.keys(terms).sort(cmp)) ordered[k] = sortPostings(terms[k]);
  return compact({ schemaVersion: 1, indexFormat: INDEX_FORMAT, shard: tt, terms: ordered });
}
function docsFile(hh, docs) {
  const ordered = {};
  for (const k of Object.keys(docs).sort(cmp)) ordered[k] = docs[k];
  return compact({ schemaVersion: 1, indexFormat: INDEX_FORMAT, shard: hh, docs: ordered });
}
function recentFile(items) { return compact({ schemaVersion: 1, indexFormat: INDEX_FORMAT, items: sortRecent(items) }); }

function catalogFile(c) {
  const categories = {};
  for (const k of Object.keys(c.categories).sort(cmp)) if (c.categories[k] > 0) categories[k] = c.categories[k];
  return compact({
    schemaVersion: 1, indexFormat: INDEX_FORMAT, tokenizer: TOKENIZER,
    termShardCount: c.termShardCount, termShardHash: 'fnv1a32', docKeyLength: DOC_KEY_LENGTH, docShardPrefixLength: DOC_SHARD_PREFIX,
    counts: { active: c.counts.active, archived: c.counts.archived, tombstoned: c.counts.tombstoned },
    bytes: { objects: c.bytes.objects, templates: c.bytes.templates },
    categories,
    termShards: [...new Set(c.termShards)].sort(cmp),
    docShards: [...new Set(c.docShards)].sort(cmp),
    templates: [...c.templates].sort((a, b) => cmp(a.id, b.id) || a.version - b.version),
    synonymsSha256: c.synonymsSha256,
    limits: c.limits,
  });
}

export function templateEntries(templates) {
  return templates.map(({ path, template: t }) => ({ id: t.id, version: t.version, path, title: t.title, status: t.status }));
}
export const templateBytes = (templates) => templates.reduce((s, { template: t }) => s + t.files.reduce((x, f) => x + f.bytes, 0), 0);

/**
 * 全量构建。ctx = { assets, templates:[{path, template}], synonyms, synonymsSha256, limits }
 * 返回 Map(path → 文件内容字符串)，只含非空文件。
 */
export function buildIndex(ctx) {
  const count = ctx.limits.termShardCount;
  const synMap = synonymMap(ctx.synonyms);
  const terms = new Map(); // tt -> {term: [[key,w]]}
  const docs = new Map(); // hh -> {key: summary}
  const recent = [];
  const counts = { active: 0, archived: 0, tombstoned: 0 };
  const categories = {};
  let objectBytes = 0;
  for (const a of ctx.assets) {
    counts[a.status]++;
    if (a.status !== 'tombstoned') objectBytes += a.object.bytes;
    if (a.status !== 'active') continue;
    const key = docKey(a);
    for (const c of a.categories) categories[c] = (categories[c] || 0) + 1;
    for (const [t, w] of termsForAsset(a, synMap)) {
      const tt = termShard(t, count);
      if (!terms.has(tt)) terms.set(tt, {});
      (terms.get(tt)[t] ||= []).push([key, w]);
    }
    const hh = docShard(a.object.sha256);
    if (!docs.has(hh)) docs.set(hh, {});
    docs.get(hh)[key] = docSummary(a);
    recent.push([key, epochSec(a.uploadedAt)]);
  }
  const out = new Map();
  for (const [tt, t] of terms) out.set(paths.terms(tt), termsFile(tt, t));
  for (const [hh, d] of docs) out.set(paths.docs(hh), docsFile(hh, d));
  out.set(paths.recent, recentFile(recent));
  out.set(paths.catalog, catalogFile({
    termShardCount: count, counts, categories,
    bytes: { objects: objectBytes, templates: templateBytes(ctx.templates) },
    termShards: [...terms.keys()], docShards: [...docs.keys()],
    templates: templateEntries(ctx.templates), synonymsSha256: ctx.synonymsSha256, limits: ctx.limits,
  }));
  return out;
}

/**
 * 增量：单个资产 before → after（任一可为 null）。
 * read(path) → 当前（同一 commit H）文件内容字符串或 undefined。
 * 返回 Map(path → 新内容字符串 | null 表示删除该文件)。B 写 A 时用它生成受影响的索引文件。
 * 前提：catalog 的 limits / synonymsSha256 / templates 不变（变化时请全量 buildIndex）。
 */
export function applyAssetChange(read, before, after, ctx) {
  const parse = (p) => { const s = read(p); return s === undefined ? undefined : JSON.parse(s); };
  const catalog = parse(paths.catalog);
  if (!catalog) throw new Error('缺少 indexes/catalog.json；请先全量 buildIndex');
  if (catalog.indexFormat !== INDEX_FORMAT) throw new Error(`未知 indexFormat ${catalog.indexFormat}`);
  if (before && after && before.id !== after.id) throw new Error('before/after 必须是同一资产');
  const count = catalog.termShardCount;
  const synMap = synonymMap(ctx.synonyms);
  const out = new Map();
  const termShards = new Set(catalog.termShards);
  const docShards = new Set(catalog.docShards);

  const oldActive = before?.status === 'active' ? before : null;
  const newActive = after?.status === 'active' ? after : null;
  const key = (before || after) ? docKey(before || after) : null;

  // terms
  const oldTerms = oldActive ? termsForAsset(oldActive, synMap) : new Map();
  const newTerms = newActive ? termsForAsset(newActive, synMap) : new Map();
  const affected = new Set([...oldTerms.keys(), ...newTerms.keys()].map((t) => termShard(t, count)));
  for (const tt of [...affected].sort(cmp)) {
    const p = paths.terms(tt);
    const shard = parse(p)?.terms || {};
    for (const t of oldTerms.keys()) {
      if (termShard(t, count) !== tt || !shard[t]) continue;
      shard[t] = shard[t].filter((x) => x[0] !== key);
      if (!shard[t].length) delete shard[t];
    }
    for (const [t, w] of newTerms) {
      if (termShard(t, count) !== tt) continue;
      shard[t] = (shard[t] || []).filter((x) => x[0] !== key);
      shard[t].push([key, w]);
    }
    if (Object.keys(shard).length) { out.set(p, termsFile(tt, shard)); termShards.add(tt); }
    else { out.set(p, null); termShards.delete(tt); }
  }

  // docs + recent
  const hh = docShard((before || after).object.sha256);
  if (oldActive || newActive) {
    const p = paths.docs(hh);
    const d = parse(p)?.docs || {};
    delete d[key];
    if (newActive) d[key] = docSummary(newActive);
    if (Object.keys(d).length) { out.set(p, docsFile(hh, d)); docShards.add(hh); }
    else { out.set(p, null); docShards.delete(hh); }
    const items = (parse(paths.recent)?.items || []).filter((x) => x[0] !== key);
    if (newActive) items.push([key, epochSec(newActive.uploadedAt)]);
    out.set(paths.recent, recentFile(items));
  }

  // catalog
  const counts = { ...catalog.counts };
  const categories = { ...catalog.categories };
  let objectBytes = catalog.bytes.objects;
  if (before) { counts[before.status]--; if (before.status !== 'tombstoned') objectBytes -= before.object.bytes; }
  if (after) { counts[after.status]++; if (after.status !== 'tombstoned') objectBytes += after.object.bytes; }
  for (const c of oldActive?.categories || []) categories[c] = (categories[c] || 0) - 1;
  for (const c of newActive?.categories || []) categories[c] = (categories[c] || 0) + 1;
  out.set(paths.catalog, catalogFile({
    termShardCount: count, counts, categories,
    bytes: { objects: objectBytes, templates: catalog.bytes.templates },
    termShards: [...termShards], docShards: [...docShards],
    templates: catalog.templates, synonymsSha256: catalog.synonymsSha256, limits: catalog.limits,
  }));
  return out;
}

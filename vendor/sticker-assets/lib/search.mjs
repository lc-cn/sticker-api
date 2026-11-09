// 参考检索实现（B 可直接复用）：只读一个固定 commit 的索引分片，有界候选，不全量解析 manifests。
// 排序：score 降序 → uploadedAt 降序 → docKey 升序；uploadedAt 取自 recent.json（不必读全部 docs 分片）。
import { queryTerms, normalize } from './tokenize.mjs';
import { termShard, paths } from './indexer.mjs';
import { cmp } from './canonical.mjs';

export const MAX_CANDIDATES = 200;
export const MAX_PAGE = 50;

/**
 * @param read (path)=>string|undefined —— 必须全部来自同一个 commit
 * @param opts { q?, category?, tag?, limit?=20, offset?=0 }
 * @returns {{ total:number, truncated:boolean, items: object[], bytesRead:number }}
 */
export function search(read, opts = {}) {
  let bytesRead = 0;
  const load = (p) => { const s = read(p); if (s === undefined) return undefined; bytesRead += Buffer.byteLength(s); return JSON.parse(s); };
  const catalog = load(paths.catalog);
  if (!catalog || catalog.indexFormat !== 1) throw new Error('索引不可用或 indexFormat 未知（fail closed）');
  const limit = Math.min(Math.max(1, opts.limit ?? 20), MAX_PAGE);
  const offset = Math.max(0, opts.offset ?? 0);
  const present = new Set(catalog.termShards);
  const shardCache = new Map();
  const postings = (term) => {
    const tt = termShard(term, catalog.termShardCount);
    if (!present.has(tt)) return [];
    if (!shardCache.has(tt)) shardCache.set(tt, load(paths.terms(tt))?.terms || {});
    return shardCache.get(tt)[term] || [];
  };
  const time = new Map((load(paths.recent)?.items || []));

  const filters = [];
  if (opts.category) filters.push(new Set(postings(`cat:${opts.category}`).map((x) => x[0])));
  if (opts.tag) filters.push(new Set(postings(`tag:${normalize(opts.tag)}`).map((x) => x[0])));
  const pass = (k) => time.has(k) && filters.every((f) => f.has(k));

  const terms = opts.q ? queryTerms(opts.q) : [];
  const score = new Map();
  if (terms.length) { for (const t of terms) for (const [k, w] of postings(t)) if (pass(k)) score.set(k, (score.get(k) || 0) + w); }
  else for (const k of time.keys()) if (pass(k)) score.set(k, 0);

  const ranked = [...score].sort((a, b) => b[1] - a[1] || time.get(b[0]) - time.get(a[0]) || cmp(a[0], b[0]));
  const truncated = ranked.length > MAX_CANDIDATES;
  const cand = ranked.slice(0, MAX_CANDIDATES);
  const docShards = new Set(catalog.docShards);
  const docCache = new Map();
  const doc = (k) => {
    const hh = k.slice(0, catalog.docShardPrefixLength); // docKey 前3位 = sha256 前3位 = docs 分片
    if (!docShards.has(hh)) return undefined;
    if (!docCache.has(hh)) docCache.set(hh, load(paths.docs(hh))?.docs || {});
    return docCache.get(hh)[k];
  };
  const items = cand.slice(offset, offset + limit).map(([k, s]) => ({ key: k, score: s, ...doc(k) })).filter((x) => x.id);
  return { total: cand.length, truncated, items, bytesRead };
}

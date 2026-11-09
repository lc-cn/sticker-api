import { AppError } from '../errors.js';
import { normalizeText, type AssetRecord } from '../repo/contract.js';

const bad = (field: string, msg: string) => new AppError(400, 'invalid_metadata', `${field}: ${msg}`, { details: { field } });
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const HTTPS_RE = /^https:\/\/[^\s]+$/;
const LICENSE_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ADAPTER_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

type Obj = Record<string, unknown>;

function depth(v: unknown, d = 0): number {
  if (d > 6) return d;
  if (Array.isArray(v)) return Math.max(d + 1, ...v.map((x) => depth(x, d + 1)));
  if (v && typeof v === 'object') return Math.max(d + 1, ...Object.values(v).map((x) => depth(x, d + 1)));
  return d;
}

export function parseJsonObject(raw: string | undefined, field: string): Obj {
  if (raw === undefined) throw bad(field, 'is required');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad(field, 'must be JSON');
  }
  return asObject(v, field);
}

export function asObject(v: unknown, field: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(field, 'must be an object');
  if (depth(v) > 4) throw bad(field, 'nesting deeper than 4');
  return v as Obj;
}

function only(o: Obj, field: string, allowed: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${field}.${k}`, 'unknown field');
}
function str(v: unknown, field: string, max: number, opts: { min?: number; re?: RegExp } = {}): string {
  if (typeof v !== 'string') throw bad(field, 'must be a string');
  const s = v.normalize('NFC').trim();
  if (s.length < (opts.min ?? 1) || [...s].length > max) throw bad(field, `length must be ${opts.min ?? 1}..${max}`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad(field, 'control characters not allowed');
  if (opts.re && !opts.re.test(s)) throw bad(field, 'invalid format');
  return s;
}
function nullable<T>(v: unknown, f: (x: unknown) => T): T | null {
  return v === undefined || v === null ? null : f(v);
}
function oneOf<T extends string>(v: unknown, field: string, values: readonly T[], dflt?: T): T {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw bad(field, `must be one of ${values.join('|')}`);
  return v as T;
}
function bool(v: unknown, field: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') throw bad(field, 'must be boolean');
  return v;
}

export function tagList(v: unknown, field: string, max = 20, maxLen = 24): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(field, 'must be an array of strings');
  if (v.length > max) throw bad(field, `at most ${max} items`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, t] of v.entries()) {
    const s = str(t, `${field}[${i}]`, maxLen);
    const n = normalizeText(s);
    if (!n) throw bad(`${field}[${i}]`, 'empty after normalization');
    if (seen.has(n)) continue; // dedupe by A's normalization (validator rejects duplicates)
    seen.add(n);
    out.push(s);
  }
  return out;
}

export function categoryList(v: unknown, taxonomy: string[], max = 5): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) throw bad('categories', `1..${max} items required`);
  const out = [...new Set(v.map((c) => String(c)))];
  for (const c of out) if (!taxonomy.includes(c)) throw bad('categories', `unknown category ${c}`);
  return out;
}

const TONES = ['positive', 'neutral', 'negative', 'sarcastic'] as const;
const RATINGS = ['general', 'mild', 'sensitive'] as const;
const SOURCE_KINDS = ['self-created', 'manual-collection', 'approved-list', 'adapter', 'import'] as const;
const CONFIDENCE = ['none', 'low', 'medium', 'high'] as const;
const BASES = ['self-created', 'license', 'creator-permission'] as const;

export type CreateMetadata = Omit<AssetRecord, 'id' | 'revision' | 'status' | 'object' | 'originalSha256' | 'uploadedAt' | 'updatedAt' | 'lastOperationId' | 'archivedAt' | 'deletedAt' | 'tombstone'>;

function safety(v: unknown): AssetRecord['safety'] {
  const o = v === undefined ? {} : asObject(v, 'safety');
  only(o, 'safety', ['rating', 'offensive']);
  return { rating: oneOf(o.rating, 'safety.rating', RATINGS, 'general'), offensive: bool(o.offensive, 'safety.offensive', false) };
}

function text(v: unknown, isAdmin: boolean): AssetRecord['text'] {
  const o = v === undefined ? {} : asObject(v, 'text');
  only(o, 'text', ['ocr', 'ocrSource', 'ocrConfirmed']);
  const ocr = nullable(o.ocr, (x) => str(x, 'text.ocr', 200));
  const ocrSource = ocr ? oneOf(o.ocrSource, 'text.ocrSource', ['client', 'manual'] as const, isAdmin ? 'manual' : 'client') : null;
  const want = bool(o.ocrConfirmed, 'text.ocrConfirmed', false);
  // Plan §3: client OCR is indexed only after a human (admin) confirms it.
  if (want && !isAdmin) throw new AppError(403, 'forbidden', 'Only an administrator can confirm OCR text');
  if (want && !ocr) throw bad('text.ocrConfirmed', 'requires text.ocr');
  return { ocr, ocrSource, ocrConfirmed: want };
}

function utc(v: unknown, field: string): string | null {
  return nullable(v, (x) => str(x, field, 32, { re: UTC_RE }));
}

function source(v: unknown): AssetRecord['source'] {
  const o = v === undefined ? {} : asObject(v, 'source');
  only(o, 'source', ['kind', 'adapter', 'url', 'itemId', 'publishedAt', 'confidence']);
  const kind = oneOf(o.kind, 'source.kind', SOURCE_KINDS, 'manual-collection');
  const adapter = nullable(o.adapter, (x) => str(x, 'source.adapter', 32, { re: ADAPTER_RE }));
  if (kind === 'adapter' && !adapter) throw bad('source.adapter', 'required when kind=adapter');
  return {
    kind,
    adapter,
    url: nullable(o.url, (x) => str(x, 'source.url', 512, { re: HTTPS_RE })),
    itemId: nullable(o.itemId, (x) => str(x, 'source.itemId', 128)),
    publishedAt: utc(o.publishedAt, 'source.publishedAt'),
    confidence: oneOf(o.confidence, 'source.confidence', CONFIDENCE, 'none'),
  };
}

export function rightsInput(v: unknown): { basis: AssetRecord['rights']['basis']; licenseId: string; publicUrl: string | null } {
  const o = asObject(v, 'rights');
  only(o, 'rights', ['basis', 'licenseId', 'publicUrl']);
  if (o.basis === 'pending') {
    throw new AppError(422, 'rights_pending', 'rights.basis=pending must stay in the private local candidate area, not in A');
  }
  return {
    basis: oneOf(o.basis, 'rights.basis', BASES),
    licenseId: str(o.licenseId, 'rights.licenseId', 64, { re: LICENSE_RE }),
    publicUrl: nullable(o.publicUrl, (x) => str(x, 'rights.publicUrl', 512, { re: HTTPS_RE })),
  };
}

/** Upload metadata. Unknown keys are rejected so identity/chat fields cannot be smuggled into A. */
export function parseCreateMetadata(o: Obj, taxonomy: string[], isAdmin: boolean): CreateMetadata & { rightsIn: ReturnType<typeof rightsInput> } {
  only(o, 'metadata', ['title', 'categories', 'tags', 'aliases', 'language', 'tone', 'safety', 'text', 'source', 'firstSeenAt', 'rights', 'shareable']);
  if (o.shareable !== true) {
    throw new AppError(422, 'not_shareable', 'metadata.shareable must be true: A is a public repository (plan §1 公开边界)');
  }
  const rightsIn = rightsInput(o.rights);
  return {
    title: str(o.title, 'title', 80),
    categories: categoryList(o.categories, taxonomy),
    tags: tagList(o.tags, 'tags'),
    aliases: tagList(o.aliases, 'aliases'),
    language: o.language === undefined ? 'zh-CN' : str(o.language, 'language', 32, { re: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/ }),
    tone: oneOf(o.tone, 'tone', TONES, 'neutral'),
    safety: safety(o.safety),
    text: text(o.text, isAdmin),
    firstSeenAt: utc(o.firstSeenAt, 'firstSeenAt'),
    source: source(o.source),
    rights: { ...rightsIn, reviewedAt: null },
    rightsIn,
  };
}

/** PATCH: only descriptive fields; rights/status go through POST /review, deletion through DELETE. */
export function applyPatch(before: AssetRecord, o: Obj, taxonomy: string[], isAdmin: boolean): AssetRecord {
  only(o, 'patch', ['title', 'categories', 'tags', 'aliases', 'language', 'tone', 'safety', 'text', 'firstSeenAt', 'source']);
  const next: AssetRecord = structuredClone(before);
  if (o.title !== undefined) next.title = str(o.title, 'title', 80);
  if (o.categories !== undefined) next.categories = categoryList(o.categories, taxonomy);
  if (o.tags !== undefined) next.tags = tagList(o.tags, 'tags');
  if (o.aliases !== undefined) next.aliases = tagList(o.aliases, 'aliases');
  if (o.language !== undefined) next.language = str(o.language, 'language', 32, { re: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/ });
  if (o.tone !== undefined) next.tone = oneOf(o.tone, 'tone', TONES);
  if (o.safety !== undefined) next.safety = safety(o.safety);
  if (o.text !== undefined) next.text = text(o.text, isAdmin);
  if (o.firstSeenAt !== undefined) next.firstSeenAt = utc(o.firstSeenAt, 'firstSeenAt');
  if (o.source !== undefined) {
    const s = asObject(o.source, 'source');
    only(s, 'source', ['publishedAt', 'confidence', 'url', 'itemId']);
    if (s.publishedAt !== undefined) next.source.publishedAt = utc(s.publishedAt, 'source.publishedAt');
    if (s.confidence !== undefined) next.source.confidence = oneOf(s.confidence, 'source.confidence', CONFIDENCE);
    if (s.url !== undefined) next.source.url = nullable(s.url, (x) => str(x, 'source.url', 512, { re: HTTPS_RE }));
    if (s.itemId !== undefined) next.source.itemId = nullable(s.itemId, (x) => str(x, 'source.itemId', 128));
  }
  return next;
}

export const TOMBSTONE_REASONS = ['rights', 'privacy', 'quality', 'duplicate', 'policy', 'other'] as const;
export const parseReason = (v: unknown) => oneOf(v, 'reason', TOMBSTONE_REASONS, 'other');
export const parseStatus = (v: unknown) => (v === undefined ? undefined : oneOf(v, 'status', ['active', 'archived'] as const));

export function parseIfMatch(header: unknown, required: boolean): number | null {
  if (header === undefined) {
    if (required) throw new AppError(428, 'precondition_required', 'If-Match: "<revision>" is required');
    return null;
  }
  const m = typeof header === 'string' ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim()) : null;
  if (!m) throw new AppError(400, 'invalid_if_match', 'If-Match must be the asset revision, e.g. "3"');
  return Number(m[1]);
}

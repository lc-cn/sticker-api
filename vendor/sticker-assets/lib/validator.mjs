// A 仓库完整校验：路径/hash/图像结构/schema/生命周期/许可/预算/容量/索引一致性/密钥与身份字段扫描。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SchemaRegistry } from './jsonschema.mjs';
import { pretty, compact, cmp } from './canonical.mjs';
import { sha256Hex } from './hash.mjs';
import { inspectImage, budgetProblems, EXT_BY_MIME } from './image.mjs';
import { manilaDate } from './time.mjs';
import { normalize } from './tokenize.mjs';
import { buildIndex, docKey, INDEX_FORMAT } from './indexer.mjs';
import { walk, readText, readBuf, sizeOf, MANAGED_DIRS } from './repo.mjs';

const SCHEMA_DIR = fileURLToPath(new URL('../schemas/v1/', import.meta.url));
const S = (n) => `urn:sticker-assets:v1:${n}`;

export function loadSchemas() {
  const reg = new SchemaRegistry();
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.schema.json')).sort()) reg.add(JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')));
  return reg;
}

const ALLOWED_TOP = new Set(['README.md', 'CONTRACT.md', 'package.json', 'sticker-assets.json', '.gitignore', '.gitattributes', '.github', 'schemas', 'lib', 'scripts', 'test', 'config', 'docs', 'fixtures', ...MANAGED_DIRS]);

const PATTERNS = [
  /^objects\/sha256\/([0-9a-f]{2})\/(\1[0-9a-f]{62})\.(png|jpg|gif)$/,
  /^manifests\/[0-9a-f]{2}\.json$/,
  /^events\/([0-9a-f]{2})\/op_\1[0-9a-f]{30}\.json$/,
  /^indexes\/(catalog|recent)\.json$/,
  /^indexes\/terms\/[0-9a-f]{2}\.json$/,
  /^indexes\/docs\/[0-9a-f]{3}\.json$/,
  /^templates\/[a-z0-9][a-z0-9-]{1,47}\/[1-9][0-9]*\/(template\.json|[a-z0-9][a-z0-9_-]{0,47}\.(png|jpg|gif))$/,
  /^licenses\/([a-z0-9][a-z0-9-]{1,63}\.json|README\.md)$/,
  /^budgets\/daily\/\d{4}-\d{2}-\d{2}\.json$/,
  /(^|\/)\.gitkeep$/,
];

const FORBIDDEN_KEYS = new Set(['principal', 'userid', 'username', 'login', 'email', 'groupid', 'chatid', 'qq', 'token', 'accesstoken', 'refreshtoken', 'cookie', 'idempotencykey', 'password', 'secret', 'privateevidence', 'authorization']);

// 拼接构造，避免本文件自身被扫描命中
const SECRET_PATTERNS = [
  ['GitHub token', new RegExp('\\b(gh' + '[pousr]_[A-Za-z0-9]{30,}|github' + '_pat_[A-Za-z0-9_]{30,})')],
  ['私钥', new RegExp('-----BEGIN [A-Z ]*PRIVATE' + ' KEY-----')],
  ['Slack token', new RegExp('\\bxox' + '[abprs]-[A-Za-z0-9-]{10,}')],
  ['AWS key', new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b')],
  ['Vercel/通用 bearer', new RegExp('Bearer\\s+[A-Za-z0-9._-]{24,}')],
];

const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico)$/i;

function scanKeys(v, path, hit) {
  if (Array.isArray(v)) v.forEach((x, i) => scanKeys(x, `${path}[${i}]`, hit));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) hit(`${path}.${k}`);
    scanKeys(v[k], `${path}.${k}`, hit);
  }
}

/**
 * @param {string} root A 树根目录
 * @param {{isToolRepo?: boolean, skipIndex?: boolean}} opts
 * @returns {{errors: {file:string,message:string}[], warnings: {file:string,message:string}[], stats: object}}
 */
export function validateRepo(root, opts = {}) {
  const errors = [], warnings = [];
  const err = (file, message) => errors.push({ file, message });
  const warn = (file, message) => warnings.push({ file, message });
  const reg = loadSchemas();
  const files = walk(root);
  const fileSet = new Set(files);

  const json = (p, { format = 'pretty', schema } = {}) => {
    let text;
    try { text = readText(root, p); } catch { err(p, '无法读取'); return undefined; }
    let v;
    try { v = JSON.parse(text); } catch (e) { err(p, `JSON 解析失败: ${e.message}`); return undefined; }
    const canon = format === 'compact' ? compact(v) : pretty(v);
    if (format && text !== canon) err(p, `非规范 JSON 格式（应为 ${format}）`);
    if (schema) for (const e of reg.validate(S(schema), v)) err(p, `${e.path}: ${e.message}`);
    return v;
  };

  // 0. 版本标识与配置
  const marker = json('sticker-assets.json');
  if (marker && (marker.format !== 'sticker-assets' || marker.schemaVersion !== 1 || marker.indexFormat !== INDEX_FORMAT || marker.tokenizer !== 'zh-bigram-v1')) err('sticker-assets.json', '未知 format/schemaVersion/indexFormat/tokenizer，停止');
  const limits = json('config/limits.json');
  const taxonomy = json('config/taxonomy.json');
  json('config/synonyms.json');
  json('config/mirrors.json', { schema: 'mirrors' });
  if (!limits || !taxonomy) return { errors, warnings, stats: {} };
  const slugs = taxonomy.categories.map((c) => c.slug);
  const schemaEnum = JSON.parse(readFileSync(join(SCHEMA_DIR, 'common.schema.json'), 'utf8')).$defs.category.enum;
  if (JSON.stringify(slugs) !== JSON.stringify(schemaEnum)) err('config/taxonomy.json', '分类枚举与 schemas/v1/common.schema.json 不一致');
  const mirrors = fileSet.has('config/mirrors.json') ? JSON.parse(readText(root, 'config/mirrors.json')) : null;
  if (mirrors) {
    const allowed = new Set(mirrors.allowedHosts);
    for (const m of [mirrors.origin, ...mirrors.mirrors]) {
      try { const host = new URL(m.template.replace(/\{[a-z]+\}/g, 'x')).host; if (!allowed.has(host)) err('config/mirrors.json', `${m.id} host ${host} 不在 allowedHosts`); }
      catch { err('config/mirrors.json', `${m.id} 模板不是合法 URL`); }
    }
  }

  // 1. 路径白名单
  for (const f of files) {
    const top = f.split('/')[0];
    if (!ALLOWED_TOP.has(top)) { err(f, '非协议文件（不在允许的顶层目录/文件内）'); continue; }
    if (MANAGED_DIRS.includes(top) && !PATTERNS.some((re) => re.test(f))) err(f, '受管目录内路径不符合协议');
    if (!opts.isToolRepo && ['lib', 'scripts', 'test', 'schemas', 'fixtures'].includes(top)) { /* 迷你树中允许但忽略 */ }
  }

  // 2. 对象
  const objects = new Map(); // sha -> info
  for (const f of files.filter((x) => /^objects\/sha256\//.test(x) && !x.endsWith('.gitkeep'))) {
    const m = f.match(/^objects\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})\.(png|jpg|gif)$/);
    if (!m) continue;
    const buf = readBuf(root, f);
    const sha = sha256Hex(buf);
    if (sha !== m[1]) { err(f, `内容 sha256 ${sha} 与文件名不符`); continue; }
    if (buf.length > limits.maxObjectBytes) err(f, `对象 ${buf.length} 字节 > ${limits.maxObjectBytes}`);
    const info = inspectImage(buf);
    for (const p of info.problems) err(f, p);
    if (info.mime && EXT_BY_MIME[info.mime] !== m[2]) err(f, `扩展名 .${m[2]} 与实际格式 ${info.mime} 不符`);
    for (const md of info.metadata) err(f, `含未剥离元数据 ${md}（发布前必须清理）`);
    if (info.mime) for (const p of budgetProblems(info, limits)) err(f, p);
    objects.set(sha, { ...info, bytes: buf.length, path: f });
  }

  // 3. 许可
  const licenses = new Map();
  for (const f of files.filter((x) => /^licenses\/.+\.json$/.test(x))) {
    const v = json(f, { schema: 'license' });
    if (!v) continue;
    if (`licenses/${v.id}.json` !== f) err(f, `id ${v.id} 与文件名不符`);
    licenses.set(v.id, v);
  }

  // 4. manifests
  const assets = [];
  const seenKeys = new Map();
  for (const f of files.filter((x) => /^manifests\/[0-9a-f]{2}\.json$/.test(x))) {
    const v = json(f, { schema: 'manifest-shard' });
    if (!v) continue;
    const hh = f.slice(10, 12);
    if (v.shard !== hh) err(f, `shard 字段 ${v.shard} 与文件名不符`);
    const ids = v.assets.map((a) => a.id);
    if (JSON.stringify(ids) !== JSON.stringify([...new Set(ids)].sort(cmp))) err(f, 'assets 必须按 id 升序且唯一');
    for (const a of v.assets) {
      const where = `${f}#${a.id}`;
      assets.push(a);
      const sha = a.id.slice(7);
      if (sha.slice(0, 2) !== hh) err(where, '资产不属于此分片');
      if (a.object.sha256 !== sha) err(where, 'object.sha256 与 id 不符');
      const ext = EXT_BY_MIME[a.object.mime];
      const expectPath = `objects/sha256/${sha.slice(0, 2)}/${sha}.${ext}`;
      if (a.object.path !== expectPath) err(where, `object.path 应为 ${expectPath}`);
      if (a.object.animated !== (a.object.frames > 1)) err(where, 'animated 必须等于 frames>1');
      const key = docKey(a);
      if (seenKeys.has(key)) err(where, `docKey ${key} 与 ${seenKeys.get(key)} 冲突（需要提升 docKeyLength）`);
      seenKeys.set(key, a.id);
      const obj = objects.get(sha);
      if (a.status === 'tombstoned') {
        if (obj || fileSet.has(a.object.path)) err(where, 'tombstoned 资产的对象文件必须从当前树删除');
      } else {
        if (!obj) err(where, `缺少对象文件 ${a.object.path}`);
        else {
          for (const k of ['mime', 'bytes', 'width', 'height', 'frames']) if (obj[k] !== a.object[k]) err(where, `object.${k}=${a.object[k]} 与实际 ${obj[k]} 不符`);
          if (obj.path !== a.object.path) err(where, '对象实际路径与记录不符');
        }
        if (a.rights.basis === 'pending') err(where, 'rights.basis=pending 不得进入 A（留在本地私密候选区）');
      }
      if (a.rights.basis === 'pending' && a.status === 'tombstoned') { /* 历史下架记录允许保留 */ }
      if (!licenses.has(a.rights.licenseId)) err(where, `licenseId ${a.rights.licenseId} 不存在于 licenses/`);
      else if (a.rights.basis !== 'pending' && licenses.get(a.rights.licenseId).kind !== a.rights.basis) err(where, `rights.basis=${a.rights.basis} 与许可记录 kind=${licenses.get(a.rights.licenseId).kind} 不符`);
      if (a.status !== 'tombstoned' && !a.rights.reviewedAt) err(where, '进入 A 的资产必须有 rights.reviewedAt');
      for (const c of a.categories) if (!slugs.includes(c)) err(where, `未知分类 ${c}`);
      for (const [name, list] of [['tags', a.tags], ['aliases', a.aliases]]) {
        const norm = list.map(normalize);
        if (norm.some((n) => !n)) err(where, `${name} 含规范化后为空的项`);
        if (new Set(norm).size !== norm.length) err(where, `${name} 规范化后重复`);
      }
      if (Date.parse(a.updatedAt) < Date.parse(a.uploadedAt)) err(where, 'updatedAt 早于 uploadedAt');
      if (a.text.ocrConfirmed && !a.text.ocr) err(where, 'ocrConfirmed=true 但 ocr 为空');
      if (a.text.ocr && !a.text.ocrSource) err(where, 'ocr 有值时必须标记 ocrSource');
      if (a.source.kind === 'adapter' && !a.source.adapter) err(where, 'source.kind=adapter 必须写 adapter');
      if (a.revision === 1 && a.status === 'tombstoned') warn(where, 'revision=1 却已 tombstoned（应为新 revision）');
    }
  }
  const recordShas = new Set(assets.map((a) => a.id.slice(7)));
  for (const [sha, o] of objects) if (!recordShas.has(sha)) err(o.path, '孤儿对象：没有 manifest 记录');

  // 5. 事件
  const assetIds = new Set(assets.map((a) => a.id));
  const eventIds = new Set();
  for (const f of files.filter((x) => /^events\/.+\.json$/.test(x))) {
    const v = json(f, { schema: 'event' });
    if (!v) continue;
    if (f !== `events/${v.operationId.slice(3, 5)}/${v.operationId}.json`) err(f, 'operationId 与路径不符');
    eventIds.add(v.operationId);
    for (const r of v.assets) if (!assetIds.has(r.id)) err(f, `事件引用的资产 ${r.id} 不存在于 manifests`);
  }
  for (const a of assets) if (a.lastOperationId && !eventIds.has(a.lastOperationId)) warn(`manifests#${a.id}`, `lastOperationId ${a.lastOperationId} 没有对应事件文件`);

  // 6. 模板
  for (const f of files.filter((x) => /^templates\/[^/]+\/[^/]+\/template\.json$/.test(x))) {
    const t = json(f, { schema: 'template' });
    if (!t) continue;
    const [, id, ver] = f.split('/');
    if (t.id !== id || String(t.version) !== ver) err(f, 'id/version 与目录不符');
    const dir = `templates/${id}/${ver}/`;
    const declared = new Set(t.files.map((x) => x.path));
    for (const x of files.filter((y) => y.startsWith(dir) && y !== f)) if (!declared.has(x.slice(dir.length))) err(x, '模板目录内有未声明文件');
    for (const fd of t.files) {
      const p = dir + fd.path;
      if (!fileSet.has(p)) { err(f, `声明的文件不存在 ${fd.path}`); continue; }
      const buf = readBuf(root, p);
      if (sha256Hex(buf) !== fd.sha256) err(p, 'sha256 与 template.json 不符');
      if (buf.length !== fd.bytes) err(p, 'bytes 与 template.json 不符');
      const info = inspectImage(buf);
      for (const pr of info.problems) err(p, pr);
      for (const md of info.metadata) err(p, `含未剥离元数据 ${md}`);
      if (info.mime !== fd.mime) err(p, `mime 应为 ${info.mime}`);
      if (info.mime) for (const pr of budgetProblems(info, limits)) err(p, pr);
    }
    if (t.inputs.texts.min > t.inputs.texts.max || t.inputs.images.min > t.inputs.images.max) err(f, 'inputs min > max');
    const anim = t.animation;
    if (anim) {
      if (t.output.mime !== 'image/gif' || !t.output.animated) err(f, 'animation 要求 output.mime=image/gif 且 animated=true');
      for (const l of t.layers) {
        if (typeof l.frame === 'number' && l.frame >= anim.frameCount) err(f, `图层 frame ${l.frame} 超出 animation.frameCount`);
        if (l.keyframes && l.keyframes.length > anim.frameCount) err(f, 'keyframes 长于 animation.frameCount');
        if (l.type === 'image-sequence' && l.files.length > anim.frameCount) err(f, 'image-sequence 帧数大于 animation.frameCount');
      }
    } else if (t.output.animated || t.output.mime === 'image/gif') {
      err(f, '动图输出必须声明 animation');
    }
    if (t.canvas.fit && t.canvas.fit.slot >= t.inputs.images.max) err(f, `canvas.fit.slot 超出 inputs.images.max`);
    for (const l of t.layers) {
      if (l.type === 'image' && !declared.has(l.file)) err(f, `图层引用未声明文件 ${l.file}`);
      if (l.type === 'image-sequence') {
        for (const file of l.files) if (!declared.has(file)) err(f, `图层引用未声明文件 ${file}`);
        if (!anim) err(f, 'image-sequence 只能用于带 animation 的模板');
      }
      if (l.type === 'text' && l.slot >= t.inputs.texts.max) err(f, `文字槽 ${l.slot} 超出 inputs.texts.max`);
      if (l.type === 'text' && l.minFontSize > l.fontSize) err(f, 'minFontSize > fontSize');
      if (l.type === 'text' && !t.fonts.some((x) => x.id === l.font)) err(f, `字体 ${l.font} 未在 fonts 声明`);
      if (l.type === 'slot-image' && l.slot >= t.inputs.images.max) err(f, `图片槽 ${l.slot} 超出 inputs.images.max`);
      // Boxes may extend past the canvas (or be negative) and are clipped at render time.
      // Variable-canvas templates (canvas.fit) resolve size at render time, so skip a hard overflow check.
      if (!t.canvas.fit && l.box && !l.fill) {
        const bw = l.box.w, bh = l.box.h;
        if (bw < 1 || bh < 1) err(f, '图层尺寸无效');
      }
    }
    for (const lid of [...t.licenseIds, ...t.fonts.map((x) => x.licenseId)]) if (!licenses.has(lid)) err(f, `licenseId ${lid} 不存在`);
    if (t.canvas.width * t.canvas.height > limits.maxCanvasPixels) err(f, '模板画布超出像素预算');
  }

  // 7. 每日预算（由 manifests 推导，必须与提交的预算文件一致）
  const derived = new Map();
  for (const a of assets) {
    const d = manilaDate(a.uploadedAt);
    const cur = derived.get(d) || { acceptedCount: 0, acceptedBytes: 0 };
    cur.acceptedCount++; cur.acceptedBytes += a.object.bytes;
    derived.set(d, cur);
  }
  const budgetFiles = new Set();
  for (const f of files.filter((x) => /^budgets\/daily\/.+\.json$/.test(x))) {
    const v = json(f, { schema: 'budget' });
    if (!v) continue;
    budgetFiles.add(v.date);
    if (f !== `budgets/daily/${v.date}.json`) err(f, 'date 与文件名不符');
    const d = derived.get(v.date) || { acceptedCount: 0, acceptedBytes: 0 };
    if (v.acceptedCount !== d.acceptedCount || v.acceptedBytes !== d.acceptedBytes) err(f, `与 manifests 推导值不符（应为 ${d.acceptedCount} 张 / ${d.acceptedBytes} 字节）`);
  }
  for (const [d, v] of derived) {
    if (!budgetFiles.has(d)) err(`budgets/daily/${d}.json`, '缺少当日预算记录');
    if (v.acceptedCount > limits.dailyMaxAssets) err(`budgets/daily/${d}.json`, `当日 ${v.acceptedCount} 张 > ${limits.dailyMaxAssets}`);
    if (v.acceptedBytes > limits.dailyMaxBytes) err(`budgets/daily/${d}.json`, `当日 ${v.acceptedBytes} 字节 > ${limits.dailyMaxBytes}`);
  }

  // 8. 容量
  const live = assets.filter((a) => a.status !== 'tombstoned').length;
  if (live > limits.maxAssets) err('manifests', `资产数 ${live} > 上限 ${limits.maxAssets}（先到先停）`);
  let managedBytes = 0;
  for (const f of files) if (MANAGED_DIRS.includes(f.split('/')[0])) managedBytes += sizeOf(root, f);
  if (managedBytes > limits.maxManagedBytes) err('(repo)', `受管字节 ${managedBytes} > 上限 ${limits.maxManagedBytes}（先到先停）`);
  else if (managedBytes >= limits.warnManagedBytes) warn('(repo)', `受管字节 ${managedBytes} ≥ 预警线 ${limits.warnManagedBytes}`);
  for (const f of files) if (MANAGED_DIRS.includes(f.split('/')[0]) && sizeOf(root, f) > 50 * 1024 * 1024) err(f, '单文件 > 50MiB');

  // 9. 索引
  const idxSchemas = [[/^indexes\/catalog\.json$/, 'index-catalog', limits.maxCatalogBytes], [/^indexes\/recent\.json$/, 'index-recent', limits.maxShardBytes], [/^indexes\/terms\//, 'index-terms', limits.maxShardBytes], [/^indexes\/docs\//, 'index-docs', limits.maxShardBytes]];
  for (const f of files.filter((x) => x.startsWith('indexes/') && x.endsWith('.json'))) {
    const hit = idxSchemas.find(([re]) => re.test(f));
    if (!hit) continue;
    const v = json(f, { format: 'compact', schema: hit[1] });
    if (sizeOf(root, f) > hit[2]) err(f, `索引文件 ${sizeOf(root, f)} 字节 > ${hit[2]}（需细分分片）`);
    if (v && v.shard && !f.endsWith(`/${v.shard}.json`)) err(f, 'shard 字段与文件名不符');
  }
  for (const f of files.filter((x) => /^manifests\//.test(x))) if (sizeOf(root, f) > limits.maxShardBytes) err(f, `manifest 分片超过 ${limits.maxShardBytes} 字节`);
  if (!opts.skipIndex && errors.length === 0) {
    const synBuf = readBuf(root, 'config/synonyms.json');
    const templates = files.filter((x) => /^templates\/[^/]+\/[^/]+\/template\.json$/.test(x)).map((path) => ({ path, template: JSON.parse(readText(root, path)) }));
    const expected = buildIndex({ assets: [...assets].sort((a, b) => cmp(a.id, b.id)), templates, synonyms: JSON.parse(synBuf.toString('utf8')), synonymsSha256: sha256Hex(synBuf), limits });
    const actual = files.filter((x) => x.startsWith('indexes/') && !x.endsWith('.gitkeep'));
    for (const [p, content] of expected) {
      if (!fileSet.has(p)) err(p, '索引缺失（运行 npm run build-index）');
      else if (readText(root, p) !== content) err(p, '索引陈旧/被手工修改（与全量重建不一致）');
    }
    for (const p of actual) if (!expected.has(p)) err(p, '多余的索引文件（全量重建不会产生）');
  }

  // 10. 身份字段与密钥扫描
  // indexes/terms/* 的键是搜索词表（可含「token」等自然语言），只跑密钥正则，不扫字段名。
  for (const f of files) {
    const top = f.split('/')[0];
    if (BINARY_EXT.test(f)) continue;
    let text;
    try { text = readText(root, f); } catch { continue; }
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) err(f, `疑似 ${name}，禁止入库`);
    if ((MANAGED_DIRS.includes(top) || top === 'config') && f.endsWith('.json') && !f.startsWith('indexes/terms/')) {
      try { scanKeys(JSON.parse(text), '$', (p) => err(f, `禁止的身份/凭证字段 ${p}`)); } catch { /* 已报告 */ }
    }
  }

  const stats = {
    objects: objects.size,
    assets: { total: assets.length, active: assets.filter((a) => a.status === 'active').length, archived: assets.filter((a) => a.status === 'archived').length, tombstoned: assets.filter((a) => a.status === 'tombstoned').length },
    managedBytes,
    limits: { maxAssets: limits.maxAssets, maxManagedBytes: limits.maxManagedBytes },
  };
  return { errors, warnings, stats };
}

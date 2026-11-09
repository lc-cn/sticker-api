import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
// @ts-ignore vendored JS (tests only)
import { validateRepo } from '../vendor/sticker-assets/lib/validator.mjs';
import { bearer, createCtx, exportHeadTree, idem, META, TOKENS, upload } from './helpers.js';
import { jpegWithExif, makeGifFrames, makePng, makeSvgDisguise, makeWebp, pngHeaderOnly, pngWithChunk } from './fixtures.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('public reads need no login; fixture search/detail/content work', async () => {
  const ctx = await createCtx();
  try {
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/assets' });
    assert.equal(list.statusCode, 200, list.body);
    const body = list.json();
    assert.equal(body.n, 4, 'fixture has 4 active');
    assert.equal(body.items.length, 4);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(body.items[0].sources, undefined, 'list must not carry mirror arrays');
    // uploaded sort = recent first
    const times = body.items.map((i: any) => Date.parse(i.uploadedAt));
    assert.deepEqual([...times].sort((a, b) => b - a), times);
    assert.match(body.items[0].id, /^[0-9a-f]{12}$/);
    assert.match(body.items[0].url, /^\/v1\/asset\/[0-9a-f]{12}\.(png|jpg|gif)$/);

    const id = body.items[0].id;
    const det = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}` });
    assert.equal(det.statusCode, 200);
    const asset = det.json();
    assert.equal(det.headers.etag, `"${asset.rev}"`);
    assert.equal(asset.sources, undefined, 'detail must not carry mirror arrays');
    assert.match(asset.sha, /^sha256:[0-9a-f]{64}$/);

    const c = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content` });
    assert.equal(c.statusCode, 302);
    assert.equal(c.headers['cache-control'], 'no-store');
    assert.match(String(c.headers.location), new RegExp(`raw\.githubusercontent\.com/example-owner/sticker-assets/${ctx.gh.head()}/`));

    // Short public URL (canonical 12-hex docKey + real ext)
    assert.match(asset.url, /^\/v1\/asset\/[0-9a-f]{12}\.(png|jpg|gif)$/);
    const short = await ctx.app.inject({ method: 'GET', url: asset.url });
    assert.equal(short.statusCode, 302);
    assert.equal(short.headers.location, c.headers.location);
    assert.equal(short.headers['x-content-sha256'], asset.sha.replace(/^sha256:/, ''));
    // wrong ext → 404; too-short nonsense → 404
    const badExt = asset.url.replace(/\.(png|jpg|gif)$/, '.webp');
    assert.equal((await ctx.app.inject({ method: 'GET', url: badExt })).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/asset/deadbeef.png' })).statusCode, 404);

    const missing = await ctx.app.inject({ method: 'GET', url: `/v1/assets/sha256:${'0'.repeat(64)}` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not_found');
    assert.ok(missing.json().error.requestId);
    assert.equal(missing.json().error.retryable, false);
  } finally {
    await ctx.close();
  }
});

test('upload commits exactly one atomic commit that passes A validateRepo', async () => {
  const ctx = await createCtx();
  try {
    const before = ctx.gh.head();
    const png = makePng(3, 3);
    const res = await upload(ctx.app, png);
    assert.equal(res.statusCode, 201, res.body);
    const r = res.json();
    assert.equal(r.status, 'created');
    assert.equal(r.commit, ctx.gh.head());
    assert.deepEqual(ctx.gh.commits.get(r.commit)!.parents, [before], 'single parent = H');
    assert.match(ctx.gh.commits.get(r.commit)!.message, /^sticker: asset\.create [0-9a-f]{12}\n\nSticker-Operation: op_[0-9a-f]{32}\n$/);
    const id = `sha256:${sha(png)}`;
    assert.equal(r.asset.id, id);
    assert.equal(r.asset.rights.basis, 'self-created');
    assert.ok(ctx.gh.headFile(`objects/sha256/${sha(png).slice(0, 2)}/${sha(png)}.png`));
    assert.ok(ctx.gh.headFile(`events/${r.operationId.slice(3, 5)}/${r.operationId}.json`));
    const ev = ctx.gh.headJson(`events/${r.operationId.slice(3, 5)}/${r.operationId}.json`);
    assert.equal(ev.actorKind, 'machine');
    assert.ok(!JSON.stringify(ev).includes('xiaozhi'), 'no principal in public event');
    assert.ok(!JSON.stringify(ctx.gh.headPaths().map((p) => ctx.gh.headFile(p)!.toString('latin1'))).includes(TOKENS.xiaozhi));
    // searchable immediately at the new commit
    const s = await ctx.app.inject({ method: 'GET', url: `/v1/assets?q=${encodeURIComponent('测试图')}` });
    assert.equal(s.json().items[0].id, id.replace(/^sha256:/, '').slice(0, 12));
    // A's own full validator accepts the resulting tree (byte-identical indexes, budgets, schemas)
    const dir = exportHeadTree(ctx.gh);
    const v = validateRepo(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(v.errors, []);
  } finally {
    await ctx.close();
  }
});

test('idempotency: same key+body replays, same key+different body 409, new key same image = duplicate', async () => {
  const ctx = await createCtx();
  try {
    const png = makePng(4, 4);
    const key = idem();
    const a = await upload(ctx.app, png, { key });
    assert.equal(a.statusCode, 201);
    const commits = ctx.gh.commits.size;
    const b = await upload(ctx.app, png, { key });
    assert.equal(b.statusCode, 201, b.body);
    assert.equal(b.json().status, 'replayed');
    assert.equal(b.json().operationId, a.json().operationId);
    assert.equal(ctx.gh.commits.size, commits, 'replay creates no commit');
    const c = await upload(ctx.app, png, { key, meta: META({ title: '别的标题' }) });
    assert.equal(c.statusCode, 409);
    assert.equal(c.json().error.code, 'idempotency_conflict');
    const d = await upload(ctx.app, png, { key: idem(), meta: META({ title: '再传一次' }) });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().status, 'duplicate');
    assert.equal(d.json().asset.uploadedAt, a.json().asset.uploadedAt, 'uploadedAt never changes');
    assert.equal(d.json().asset.title, '测试哈哈');
    const noKey = await upload(ctx.app, makePng(5, 5), { key: '' });
    assert.equal(noKey.statusCode, 428);
    // operation lookup: owner with original key, other token forbidden, missing key forbidden
    const opId = a.json().operationId;
    const own = await ctx.app.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: { ...bearer(TOKENS.xiaozhi), 'idempotency-key': key } });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().event.type, 'asset.create');
    const other = await ctx.app.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: { ...bearer(TOKENS.writerB), 'idempotency-key': key } });
    assert.equal(other.statusCode, 403);
    const unknown = await ctx.app.inject({ method: 'GET', url: `/v1/operations/op_${'a'.repeat(32)}`, headers: { ...bearer(TOKENS.xiaozhi), 'idempotency-key': 'x'.repeat(20) } });
    assert.equal(unknown.statusCode, 403);
  } finally {
    await ctx.close();
  }
});

test('ref conflict: rebuilds on the new HEAD, keeps the concurrent writer\'s commit, never forces', async () => {
  const ctx = await createCtx();
  try {
    // Another writer lands a commit between our tree build and ref update (twice).
    let n = 0;
    const concurrent = () => {
      n++;
      ctx.gh.commitFiles({ [`licenses/README.md`]: `concurrent edit ${n}\n` }, 'other writer');
    };
    ctx.gh.beforeRefUpdate.push(concurrent, concurrent);
    const res = await upload(ctx.app, makePng(6, 6));
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(n, 2);
    assert.equal(ctx.gh.headFile('licenses/README.md')!.toString(), 'concurrent edit 2\n', 'other writer preserved');
    assert.ok(ctx.gh.isAncestor(ctx.gh.commits.get(res.json().commit)!.parents[0]!, res.json().commit));
    const patches = ctx.gh.calls.filter((c) => c.startsWith('PATCH /repos/example-owner/sticker-assets/git/refs/heads/main'));
    assert.equal(patches.length, 3);

    // persistent conflict → bounded retries, retryable 409
    ctx.gh.failRefUpdates = 10;
    const fail = await upload(ctx.app, makePng(7, 7));
    assert.equal(fail.statusCode, 409);
    assert.equal(fail.json().error.code, 'publish_conflict');
    assert.equal(fail.json().error.retryable, true);
    ctx.gh.failRefUpdates = 0;

    // concurrent different uploads both survive; same image concurrently → one asset
    const imgs = [makePng(8, 8), makePng(9, 9), makePng(10, 10)];
    const results = await Promise.all([...imgs.map((i) => upload(ctx.app, i)), upload(ctx.app, imgs[0]!)]);
    for (const r of results) assert.ok([200, 201].includes(r.statusCode), r.body);
    for (const i of imgs) assert.ok(ctx.gh.headFile(`objects/sha256/${sha(i).slice(0, 2)}/${sha(i)}.png`));
    assert.equal(results.filter((r) => r.json().status === 'created').length, 3);
    const budget = ctx.gh.headJson(`budgets/daily/${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())}.json`);
    assert.ok(budget.acceptedCount >= 4);
    const dir = exportHeadTree(ctx.gh);
    const v = validateRepo(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(v.errors, []);
  } finally {
    await ctx.close();
  }
});

test('upload validation: size, type, decode budget, metadata, privacy stripping', async () => {
  const ctx = await createCtx();
  try {
    const big = Buffer.concat([makePng(2, 2), Buffer.alloc(2 * 1024 * 1024)]);
    assert.equal((await upload(ctx.app, big)).statusCode, 413);
    const huge = Buffer.alloc(3 * 1024 * 1024 + 10);
    const r413 = await upload(ctx.app, huge);
    assert.equal(r413.statusCode, 413);
    assert.equal((await upload(ctx.app, makeSvgDisguise())).json().error.code, 'unsupported_type');
    assert.equal((await upload(ctx.app, makeWebp())).json().error.code, 'unsupported_type');
    assert.equal((await upload(ctx.app, pngWithChunk('acTL', Buffer.alloc(8)))).json().error.code, 'unsupported_type');
    assert.equal((await upload(ctx.app, pngHeaderOnly(3000, 10))).json().error.code, 'image_too_large');
    assert.equal((await upload(ctx.app, pngHeaderOnly(100, 100))).json().error.code, 'invalid_image', 'IDAT must decode to exact size');
    assert.equal((await upload(ctx.app, makeGifFrames(61))).json().error.code, 'too_many_frames');
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ shareable: false }) })).statusCode, 422);
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ rights: { basis: 'pending', licenseId: 'self-created-project' } }) })).json().error.code, 'rights_pending');
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ categories: ['nope'] }) })).statusCode, 400);
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ userId: 'qq123' }) })).statusCode, 400, 'unknown keys rejected');
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ rights: { basis: 'license', licenseId: 'self-created-project' } }) })).json().error.code, 'license_mismatch');
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ rights: { basis: 'self-created', licenseId: 'nope-x' } }) })).json().error.code, 'unknown_license');
    assert.equal((await upload(ctx.app, makePng(11, 11), { meta: META({ text: { ocr: '你好', ocrConfirmed: true } }) })).statusCode, 403, 'machine cannot confirm OCR');

    // privacy metadata is stripped before hashing/publishing; animation kept
    const gif = makeGifFrames(3, { comment: 'chat-group-123' });
    const g = await upload(ctx.app, gif);
    assert.equal(g.statusCode, 201, g.body);
    assert.equal(g.json().asset.object.frames, 3);
    assert.equal(g.json().asset.object.animated, true);
    assert.notEqual(g.json().asset.object.sha256, sha(gif));
    const stored = ctx.gh.headFile(`objects/sha256/${g.json().asset.object.sha256.slice(0, 2)}/${g.json().asset.object.sha256}.gif`)!;
    assert.ok(!stored.toString('latin1').includes('chat-group-123'));
    assert.ok(stored.toString('latin1').includes('NETSCAPE2.0'));
    const j = await upload(ctx.app, jpegWithExif());
    assert.equal(j.statusCode, 201, j.body);
    const jb = ctx.gh.headFile(`objects/sha256/${j.json().asset.object.sha256.slice(0, 2)}/${j.json().asset.object.sha256}.jpg`)!;
    assert.ok(!jb.toString('latin1').includes('GPS:'));
    const p = await upload(ctx.app, pngWithChunk('tEXt', Buffer.from('Comment\0secret', 'latin1'), 12, 12));
    assert.equal(p.statusCode, 201, p.body);
  } finally {
    await ctx.close();
  }
});

test('search: keyword, tag, category, sort=uploaded, pagination, bounded limit', async () => {
  const ctx = await createCtx();
  try {
    await upload(ctx.app, makePng(13, 13), { meta: META({ title: '打工人早安', categories: ['work', 'greeting'], tags: ['早安', '打工'] }) });
    await new Promise((r) => setTimeout(r, 1100)); // recent.json has 1-second resolution
    await upload(ctx.app, makePng(14, 14), { meta: META({ title: '打工好累', categories: ['work'], tags: ['打工'] }) });
    const q = await ctx.app.inject({ method: 'GET', url: `/v1/assets?q=${encodeURIComponent('打工')}` });
    assert.equal(q.json().items.length, 2);
    assert.ok(q.json().items.every((i: any) => i.sources === undefined && typeof i.url === 'string'));
    const cat = await ctx.app.inject({ method: 'GET', url: '/v1/assets?category=greeting' });
    assert.deepEqual(cat.json().items.map((i: any) => i.title), ['打工人早安']);
    const tag = await ctx.app.inject({ method: 'GET', url: `/v1/assets?tag=${encodeURIComponent('早安')}` });
    assert.equal(tag.json().items.length, 1);
    const both = await ctx.app.inject({ method: 'GET', url: `/v1/assets?q=${encodeURIComponent('打工')}&category=greeting` });
    assert.equal(both.json().items.length, 1);
    const up = await ctx.app.inject({ method: 'GET', url: `/v1/assets?q=${encodeURIComponent('打工')}&sort=uploaded` });
    assert.deepEqual(up.json().items.map((i: any) => i.title), ['打工好累', '打工人早安']);
    const p1 = await ctx.app.inject({ method: 'GET', url: '/v1/assets?limit=2' });
    assert.equal(p1.json().items.length, 2);
    assert.ok(p1.json().next);
    const p2 = await ctx.app.inject({ method: 'GET', url: `/v1/assets?limit=2&cursor=${p1.json().next}` });
    assert.notEqual(p2.json().items[0].id, p1.json().items[0].id);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/assets?limit=51' })).statusCode, 400);
    const none = await ctx.app.inject({ method: 'GET', url: `/v1/assets?q=${encodeURIComponent('不存在的词')}` });
    assert.equal(none.json().items.length, 0);
  } finally {
    await ctx.close();
  }
});

test('patch If-Match, tombstone: 410 everywhere, removed from tree/search, no resurrection', async () => {
  const ctx = await createCtx();
  try {
    const png = makePng(15, 15);
    const created = (await upload(ctx.app, png)).json();
    const id = created.asset.id;
    const mod = bearer(TOKENS.moderator);
    // xiaozhi (assets:write only) cannot moderate
    const denied = await ctx.app.inject({ method: 'DELETE', url: `/v1/assets/${id}`, headers: bearer(TOKENS.xiaozhi) });
    assert.equal(denied.statusCode, 403);
    assert.equal((await ctx.app.inject({ method: 'PATCH', url: `/v1/assets/${id}`, headers: mod, payload: { title: 'x' } })).statusCode, 428);
    const stale = await ctx.app.inject({ method: 'PATCH', url: `/v1/assets/${id}`, headers: { ...mod, 'if-match': '"9"' }, payload: { title: 'x' } });
    assert.equal(stale.statusCode, 412);
    const ok = await ctx.app.inject({ method: 'PATCH', url: `/v1/assets/${id}`, headers: { ...mod, 'if-match': '"1"' }, payload: { title: '改过的标题', tags: ['新标签'] } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().asset.revision, 2);
    assert.equal(ok.json().asset.uploadedAt, created.asset.uploadedAt);
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/v1/assets?tag=${encodeURIComponent('新标签')}` })).json().items.length, 1);
    const bad = await ctx.app.inject({ method: 'PATCH', url: `/v1/assets/${id}`, headers: { ...mod, 'if-match': '"2"' }, payload: { uploadedAt: '2020-01-01T00:00:00Z' } });
    assert.equal(bad.statusCode, 400);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/v1/assets/${id}?reason=rights`, headers: { ...mod, 'if-match': '"2"' } });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(del.json().status, 'tombstoned');
    const objPath = `objects/sha256/${created.asset.object.sha256.slice(0, 2)}/${created.asset.object.sha256}.png`;
    assert.equal(ctx.gh.headFile(objPath), null, 'object removed from current tree');
    const d = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}` });
    assert.equal(d.statusCode, 410);
    assert.equal(d.headers['cache-control'], 'no-store');
    const c = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content` });
    assert.equal(c.statusCode, 410);
    assert.equal(c.headers.location, undefined);
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/v1/assets?tag=${encodeURIComponent('新标签')}` })).json().items.length, 0);
    const again = await ctx.app.inject({ method: 'DELETE', url: `/v1/assets/${id}`, headers: mod });
    assert.equal(again.json().status, 'unchanged');
    const re = await upload(ctx.app, png, { key: idem() });
    assert.equal(re.statusCode, 409);
    assert.equal(re.json().error.code, 'asset_tombstoned');
    // archive through review
    const other = (await upload(ctx.app, makePng(16, 16))).json();
    const arch = await ctx.app.inject({ method: 'POST', url: `/v1/assets/${other.asset.id}/review`, headers: { ...mod, 'if-match': '"1"' }, payload: { status: 'archived' } });
    assert.equal(arch.statusCode, 200, arch.body);
    assert.equal(arch.json().asset.status, 'archived');
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/v1/assets/${other.asset.id}/content` })).statusCode, 302, 'archived still readable by id');
    const dir = exportHeadTree(ctx.gh);
    const v = validateRepo(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(v.errors, []);
  } finally {
    await ctx.close();
  }
});

test('mirrors: only A-enabled+verified AND B-allowlisted hosts; raw always kept as fallback', async () => {
  const ctx = await createCtx({ MIRROR_HOST_ALLOWLIST: 'gh-proxy.com' });
  try {
    const mirrors = ctx.gh.headJson('config/mirrors.json');
    mirrors.mirrors = mirrors.mirrors.map((m: any) => ({ ...m, enabled: true, verifiedAt: '2026-11-09T00:00:00Z' }));
    ctx.gh.commitFiles({ 'config/mirrors.json': JSON.stringify(mirrors, null, 2) + '\n' });
    await new Promise((r) => setTimeout(r, 1100));
    const list = (await ctx.app.inject({ method: 'GET', url: '/v1/assets?limit=1' })).json();
    assert.equal(list.items[0].sources, undefined);
    const id = list.items[0].id;
    const c = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content` });
    assert.match(c.headers.location as string, /^https:\/\/gh-proxy\.com\/https:\/\/raw\.githubusercontent\.com\/example-owner\/sticker-assets\/[0-9a-f]{40}\//);
    const raw = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content?source=github-raw` });
    assert.match(raw.headers.location as string, /^https:\/\/raw\.githubusercontent\.com\//);
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content?source=evil` })).statusCode, 400);
  } finally {
    await ctx.close();
  }
});

test('HEAD freshness: unverifiable state → 503; GitHub rate limit → 503 with Retry-After ≥60', async () => {
  const ctx = await createCtx();
  try {
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/assets' })).statusCode, 200);
    ctx.gh.apiDown = true;
    await new Promise((r) => setTimeout(r, 1100));
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/assets' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'state_unverifiable');
    assert.equal(r.json().error.retryable, true);
    ctx.gh.apiDown = false;
    ctx.gh.rateLimitNext = 5;
    const w = await upload(ctx.app, makePng(17, 17));
    assert.equal(w.statusCode, 503);
    assert.equal(w.json().error.code, 'upstream_rate_limited');
    assert.ok(Number(w.headers['retry-after']) >= 60);
    ctx.gh.rateLimitNext = 0;
  } finally {
    await ctx.close();
  }
});

test('kill switches and unsupported schema fail closed', async () => {
  const ctx = await createCtx({ WRITES_ENABLED: 'false', CONTENT_ENABLED: 'false' });
  try {
    assert.equal((await upload(ctx.app, makePng(18, 18))).json().error.code, 'writes_disabled');
    const id = (await ctx.app.inject({ method: 'GET', url: '/v1/assets?limit=1' })).json().items[0].id;
    assert.equal((await ctx.app.inject({ method: 'GET', url: `/v1/assets/${id}/content` })).statusCode, 503);
    ctx.gh.commitFiles({ 'sticker-assets.json': JSON.stringify({ format: 'sticker-assets', schemaVersion: 2, indexFormat: 1, tokenizer: 'zh-bigram-v1' }) });
    await new Promise((r) => setTimeout(r, 1100));
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/assets' });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'repo_schema_unsupported');
  } finally {
    await ctx.close();
  }
});

test('short /v1/asset/<hex>.<ext> accepts longer prefixes and keeps legacy content URL', async () => {
  const ctx = await createCtx();
  try {
    const item = (await ctx.app.inject({ method: 'GET', url: '/v1/assets?limit=1' })).json().items[0];
    const det = (await ctx.app.inject({ method: 'GET', url: `/v1/assets/${item.id}` })).json();
    const sha = det.sha.replace(/^sha256:/, '');
    const ext = item.url.split('.').pop();
    const full = await ctx.app.inject({ method: 'GET', url: `/v1/asset/${sha}.${ext}` });
    assert.equal(full.statusCode, 302);
    const legacy = await ctx.app.inject({ method: 'GET', url: `/v1/assets/${item.id}/content` });
    assert.equal(full.headers.location, legacy.headers.location);
    // 8-char prefix of a known fixture asset should resolve uniquely in the small fixture
    const eight = await ctx.app.inject({ method: 'GET', url: `/v1/asset/${sha.slice(0, 8)}.${ext}` });
    assert.equal(eight.statusCode, 302);
    assert.equal(eight.headers.location, legacy.headers.location);
  } finally {
    await ctx.close();
  }
});

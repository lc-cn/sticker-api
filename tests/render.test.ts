import assert from 'node:assert/strict';
import test from 'node:test';
import { bearer, createCtx, multipart, SYSTEM_CJK_FONT, TOKENS, upload } from './helpers.js';
import { makeGifFrames, makePng } from './fixtures.js';
import { layoutText } from '../src/render/renderer.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('templates list is public and reports renderability', async () => {
  const ctx = await createCtx();
  try {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/templates' });
    assert.equal(r.statusCode, 200);
    const t = r.json().templates.find((x: any) => x.id === 'caption-bar');
    assert.ok(t);
    assert.equal(t.version, 1);
    assert.equal(t.renderable, Boolean(SYSTEM_CJK_FONT));
  } finally {
    await ctx.close();
  }
  const nofont = await createCtx({ RENDER_FONTS: '' });
  try {
    const t = (await nofont.app.inject({ method: 'GET', url: '/v1/templates' })).json().templates[0];
    assert.equal(t.renderable, false);
    assert.match(t.unavailableReason, /font/);
    const r = await nofont.app.inject({ method: 'POST', url: '/v1/renders', headers: bearer(TOKENS.xiaozhi), payload: { template: 'caption-bar', texts: ['你好'] } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'template_unavailable');
  } finally {
    await nofont.close();
  }
});

test('render caption-bar (text, uploaded image, A asset) → PNG; input limits enforced', { skip: !SYSTEM_CJK_FONT && 'no CJK system font on this machine' }, async () => {
  const ctx = await createCtx();
  try {
    const anon = await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: { template: 'caption-bar', texts: ['你好'] } });
    assert.equal(anon.statusCode, 401);
    const h = bearer(TOKENS.renderOnly);
    const t0 = Date.now();
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['打工人打工魂，打工都是人上人'], params: { color: 'red' } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.rawPayload.subarray(0, 8).equals(PNG_SIG));
    assert.equal(r.rawPayload.readUInt32BE(16), 240);
    assert.equal(r.rawPayload.readUInt32BE(20), 240);
    assert.ok(Date.now() - t0 < 10_000);

    const mp = multipart([
      { name: 'request', value: JSON.stringify({ template: 'caption-bar', texts: ['配图'] }) },
      { name: 'image', file: makeGifFrames(2), filename: 'a.gif' },
    ]);
    const withImg = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: { ...h, 'content-type': mp.contentType }, payload: mp.payload });
    assert.equal(withImg.statusCode, 200, withImg.body);

    const id = (await upload(ctx.app, makePng(20, 20))).json().asset.id;
    const fromAsset = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['来自A'], assetIds: [id] } });
    assert.equal(fromAsset.statusCode, 200, fromAsset.body);

    const two = multipart([
      { name: 'request', value: JSON.stringify({ template: 'caption-bar', texts: ['x'] }) },
      { name: 'image', file: makePng(2, 2) },
      { name: 'image', file: makePng(3, 3) },
    ]);
    const tooMany = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: { ...h, 'content-type': two.contentType }, payload: two.payload });
    assert.equal(tooMany.statusCode, 400);
    assert.equal(tooMany.json().error.code, 'invalid_images');
    const big = multipart([
      { name: 'request', value: JSON.stringify({ template: 'caption-bar', texts: ['x'] }) },
      { name: 'image', file: Buffer.concat([makePng(2, 2), Buffer.alloc(1024 * 1024)]) },
    ]);
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: { ...h, 'content-type': big.contentType }, payload: big.payload })).statusCode, 413);
    const svg = multipart([
      { name: 'request', value: JSON.stringify({ template: 'caption-bar', texts: ['x'] }) },
      { name: 'image', file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>') },
    ]);
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: { ...h, 'content-type': svg.contentType }, payload: svg.payload })).statusCode, 415);
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'nope', texts: ['x'] } })).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: [] } })).json().error.code, 'invalid_texts');
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['长'.repeat(41)] } })).json().error.code, 'text_too_long');
    assert.equal((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['x'], params: { color: 'blue' } } })).json().error.code, 'invalid_params');
  } finally {
    await ctx.close();
  }
});

test('render rate limit and text layout helpers', async () => {
  const ctx = await createCtx({ RENDER_PER_MINUTE: '1', RENDER_FONTS: '' });
  try {
    const h = bearer(TOKENS.renderOnly);
    await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['x'] } });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: h, payload: { template: 'caption-bar', texts: ['x'] } });
    assert.equal(r.statusCode, 429);
    assert.equal(r.headers['retry-after'], '60');
  } finally {
    await ctx.close();
  }
  const l = layoutText('这是一段很长很长很长很长很长的中文字幕', { x: 0, y: 0, w: 100, h: 40 } as any, 32, 12, false);
  assert.ok(l.size >= 12 && l.size <= 32);
  assert.equal(l.lines.length, 1);
  assert.ok(l.lines[0]!.endsWith('…') || l.size < 32);
});

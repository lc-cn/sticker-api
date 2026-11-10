import assert from 'node:assert/strict';
import test from 'node:test';
import { bearer, createCtx, multipart, SYSTEM_CJK_FONT, TOKENS, upload } from './helpers.js';
import { makeGifFrames, makePng } from './fixtures.js';
import { layoutText } from '../src/render/renderer.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('templates list is public and only lists renderable templates', async () => {
  const ctx = await createCtx();
  try {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/templates' });
    assert.equal(r.statusCode, 200);
    const items = r.json().items;
    assert.ok(Array.isArray(items));
    const t = items.find((x: any) => x.id === 'caption-bar');
    if (SYSTEM_CJK_FONT) {
      assert.ok(t, 'caption-bar should be listed when fonts are available');
      assert.match(t.preview, /^\/v1\/templates\/caption-bar\/preview$/);
      assert.equal(t.sources, undefined);
      assert.equal(t.licenseIds, undefined);
    } else {
      assert.equal(t, undefined, 'unrenderable templates omitted from compact list');
    }
  } finally {
    await ctx.close();
  }
  const nofont = await createCtx({ RENDER_FONTS: '' });
  try {
    const items = (await nofont.app.inject({ method: 'GET', url: '/v1/templates' })).json().items;
    assert.ok(!items.some((x: any) => x.id === 'caption-bar'));
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

test('composeSvg supports slot-image rotate and circle clip', async () => {
  const { composeSvg } = await import('../src/render/renderer.js');
  const tiny = makePng(8, 8);
  const t: any = {
    id: 't', version: 1, title: 't', status: 'active', renderer: 'light-v1',
    inputs: { texts: { min: 0, max: 0, maxLength: 1 }, images: { min: 1, max: 1 } },
    params: [], output: { mime: 'image/png', animated: false, maxBytes: 2097152 },
    canvas: { width: 100, height: 100, background: '#ffffff' },
    layers: [
      { type: 'slot-image', slot: 0, box: { x: 10, y: 10, w: 40, h: 40 }, fit: 'cover', rotate: -10, clip: 'circle' },
    ],
    files: [], fonts: [{ id: 'default-sans', licenseId: 'ofl-1-1', providedBy: 'renderer' }],
    licenseIds: [], notice: '',
  };
  const svg = composeSvg(t, new Map(), [], [{ mime: 'image/png', bytes: tiny, width: 8, height: 8 } as any], new Map());
  assert.match(svg, /rotate\(-10 /);
  assert.match(svg, /<circle /);
  assert.match(svg, /clipPath/);
});

test('perspective warp maps corners into the bounding box', async () => {
  const { encodePngRgba } = await import('../src/render/pixels.js');
  const { decodeRaster } = await import('../src/render/pixels.js');
  const { perspectiveWarp } = await import('../src/render/warp.js');
  // 20x10 solid red
  const data = new Uint8Array(20 * 10 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; data[i + 3] = 255;
  }
  const src = { width: 20, height: 10, data };
  const { image, minX, minY } = perspectiveWarp(src, [[0, 5], [30, 0], [30, 20], [0, 15]]);
  assert.equal(minX, 0);
  assert.equal(minY, 0);
  assert.equal(image.width, 30);
  assert.equal(image.height, 20);
  // center pixel should be opaque-ish red
  const cx = (10 * image.width + 15) * 4;
  assert.ok(image.data[cx]! > 200);
  assert.equal(image.data[cx + 1], 0);
  const png = encodePngRgba(image);
  const back = decodeRaster('image/png', png);
  assert.equal(back.width, 30);
});

test('composeFrames + encodeGif emits a looping GIF', { skip: !SYSTEM_CJK_FONT && 'no CJK system font on this machine' }, async () => {
  const { composeFrames, Renderer, parseFonts } = await import('../src/render/renderer.js');
  const { encodeGif } = await import('../src/render/gif.js');
  const tiny = makePng(16, 16);
  const overlay = makePng(40, 40);
  const t: any = {
    id: 'pet', version: 1, title: 't', status: 'active', renderer: 'light-v1',
    inputs: { texts: { min: 0, max: 0, maxLength: 1 }, images: { min: 1, max: 1 } },
    params: [], output: { mime: 'image/gif', animated: true, maxBytes: 2097152 },
    canvas: { width: 40, height: 40, background: '#ffffff' },
    animation: { frameCount: 3, frameDurationMs: 80, loop: 0 },
    layers: [
      { type: 'slot-image', slot: 0, box: { x: 4, y: 4, w: 32, h: 32 }, fit: 'cover',
        keyframes: [
          { box: { x: 4, y: 4, w: 32, h: 32 } },
          { box: { x: 2, y: 8, w: 36, h: 24 } },
          { box: { x: 4, y: 4, w: 32, h: 32 } },
        ] },
      { type: 'image-sequence', files: ['0.png', '1.png', '2.png'], box: { x: 0, y: 0, w: 40, h: 40 } },
    ],
    files: [
      { path: '0.png', sha256: 'x', bytes: overlay.length, mime: 'image/png', role: 'frame' },
      { path: '1.png', sha256: 'x', bytes: overlay.length, mime: 'image/png', role: 'frame' },
      { path: '2.png', sha256: 'x', bytes: overlay.length, mime: 'image/png', role: 'frame' },
    ],
    fonts: [], licenseIds: [], notice: '',
  };
  const assets = new Map([['0.png', overlay], ['1.png', overlay], ['2.png', overlay]]);
  const images = [{ mime: 'image/png', bytes: tiny, width: 16, height: 16 } as any];
  const { svgs } = composeFrames(t, assets, [], images, new Map());
  assert.equal(svgs.length, 3);
  assert.match(svgs[1]!, /x="2"/);
  const fonts = parseFonts(process.env.RENDER_FONTS ?? '', process.cwd());
  // Renderer still works with empty font list
  const r = new Renderer(fonts, 8000);
  const pngs = await r.renderSvgs(svgs, []);
  assert.equal(pngs.length, 3);
  assert.ok(pngs[0]!.subarray(0, 8).equals(PNG_SIG));
  const gif = encodeGif(pngs, 80, 2097152, 0);
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(gif.length > 32);
});

test('resolveCanvas cover is fixed target; height mode clamps width', async () => {
  const { resolveCanvas } = await import('../src/render/renderer.js');
  const img = { mime: 'image/png', bytes: makePng(2, 2), width: 1000, height: 500 } as any;
  const cover = resolveCanvas({
    canvas: { width: 500, height: 500, background: '#fff', fit: { slot: 0, mode: 'cover', width: 500, height: 500 } },
  } as any, [img]);
  assert.deepEqual(cover, { width: 500, height: 500 });
  const height = resolveCanvas({
    canvas: { width: 1080, height: 1080, background: '#fff', fit: { slot: 0, mode: 'height', height: 1080, minWidth: 800, maxWidth: 1500 } },
  } as any, [img]);
  // 1000x500 → height 1080 → width 2160, then clamp to 1500 and rescale height
  assert.equal(height.width, 1500);
  assert.ok(height.height <= 1080);
});

test('composeSvg honors when/params and xFrom=right', async () => {
  const { composeSvg } = await import('../src/render/renderer.js');
  const overlay = makePng(10, 10);
  const t: any = {
    id: 't', version: 1, title: 't', status: 'active', renderer: 'light-v1',
    inputs: { texts: { min: 0, max: 0, maxLength: 1 }, images: { min: 1, max: 1 } },
    params: [{ name: 'position', type: 'enum', enum: ['left', 'right', 'both'], default: 'left' }],
    output: { mime: 'image/png', animated: false, maxBytes: 2097152 },
    canvas: { width: 100, height: 80, background: '#ffffff' },
    layers: [
      { type: 'image', file: 'g.png', box: { x: 0, y: 0, w: 40, h: 40 }, when: { param: 'position', in: ['left', 'both'] } },
      { type: 'image', file: 'g.png', box: { x: 0, y: 0, w: 40, h: 40 }, xFrom: 'right', when: { param: 'position', in: ['right', 'both'] } },
    ],
    files: [{ path: 'g.png', sha256: 'x', bytes: overlay.length, mime: 'image/png', role: 'overlay' }],
    fonts: [], licenseIds: [], notice: '',
  };
  const assets = new Map([['g.png', overlay]]);
  const left = composeSvg(t, assets, [], [], new Map(), { params: { position: 'left' } });
  assert.match(left, /x="0"/);
  assert.equal((left.match(/<image /g) || []).length, 1);
  const right = composeSvg(t, assets, [], [], new Map(), { params: { position: 'right' } });
  assert.match(right, /x="60"/); // 100 - 40 - 0
  assert.equal((right.match(/<image /g) || []).length, 1);
  const both = composeSvg(t, assets, [], [], new Map(), { params: { position: 'both' } });
  assert.equal((both.match(/<image /g) || []).length, 2);
});

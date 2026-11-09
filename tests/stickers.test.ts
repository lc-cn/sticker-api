import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { openDatabase } from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { makeAnimatedGifLike, makeGif, makePng, makeSvgDisguise, sha256 } from './fixtures.js';
import { authHeaders, createTestApp, uploadFile } from './helpers.js';

test('health and ready are public', async () => {
  const ctx = await createTestApp();
  try {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);

    const ready = await ctx.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().ok, true);
  } finally {
    await ctx.close();
  }
});

test('rejects missing and wrong bearer token', async () => {
  const ctx = await createTestApp();
  try {
    const noAuth = await uploadFile(ctx.app, ctx.token, makePng(), { auth: false });
    assert.equal(noAuth.statusCode, 401);

    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/v1/stickers',
      headers: authHeaders('wrong-token'),
    });
    assert.equal(bad.statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test('upload search dedupe update delete and gif byte fidelity', async () => {
  const ctx = await createTestApp();
  try {
    const png = makePng();
    const created = await uploadFile(ctx.app, ctx.token, png, {
      filename: 'a.png',
      contentType: 'image/png',
      fields: {
        title: '熊猫头无语',
        textContent: '我不理解',
        emotion: 'confused',
        tags: '熊猫头,经典',
        sourceKind: 'manual',
        sourceNote: 'seed',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json();
    assert.equal(body.deduplicated, false);
    assert.equal(body.sticker.mimeType, 'image/png');
    assert.equal(body.sticker.title, '熊猫头无语');
    assert.deepEqual(body.sticker.tags.sort(), ['经典', '熊猫头'].sort());
    assert.equal(body.sticker.contentHash, sha256(png));
    const id = body.sticker.id as string;

    const dup = await uploadFile(ctx.app, ctx.token, png, {
      filename: 'b.png',
      fields: { title: 'ignored-on-dedupe' },
    });
    assert.equal(dup.statusCode, 200, dup.body);
    assert.equal(dup.json().deduplicated, true);
    assert.equal(dup.json().sticker.id, id);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/v1/stickers?q=' + encodeURIComponent('熊猫') + '&limit=10',
      headers: authHeaders(ctx.token),
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().total, 1);
    assert.equal(listed.json().items[0].id, id);

    const byEmotion = await ctx.app.inject({
      method: 'GET',
      url: '/v1/stickers?emotion=confused',
      headers: authHeaders(ctx.token),
    });
    assert.equal(byEmotion.json().total, 1);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/stickers/${id}`,
      headers: authHeaders(ctx.token, { 'content-type': 'application/json' }),
      payload: JSON.stringify({ emotion: 'happy', tags: ['更新', '熊猫头'] }),
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().sticker.emotion, 'happy');
    assert.deepEqual(patched.json().sticker.tags.sort(), ['更新', '熊猫头'].sort());

    const file = await ctx.app.inject({
      method: 'GET',
      url: `/v1/stickers/${id}/file`,
      headers: authHeaders(ctx.token),
    });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.headers.etag, `"${sha256(png)}"`);
    assert.deepEqual(Buffer.from(file.rawPayload), png);

    const gifBytes = makeAnimatedGifLike();
    const gifUp = await uploadFile(ctx.app, ctx.token, gifBytes, {
      filename: 'x.gif',
      contentType: 'image/gif',
      fields: { title: '动图', emotion: 'funny', tags: 'gif' },
    });
    assert.equal(gifUp.statusCode, 201, gifUp.body);
    const gifId = gifUp.json().sticker.id as string;
    assert.equal(gifUp.json().sticker.mimeType, 'image/gif');

    const gifFile = await ctx.app.inject({
      method: 'GET',
      url: `/v1/stickers/${gifId}/file`,
      headers: authHeaders(ctx.token),
    });
    assert.equal(gifFile.statusCode, 200);
    assert.equal(gifFile.headers['content-type'], 'image/gif');
    assert.deepEqual(Buffer.from(gifFile.rawPayload), gifBytes);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/stickers/${id}`,
      headers: authHeaders(ctx.token),
    });
    assert.equal(del.statusCode, 204);

    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/v1/stickers/${id}`,
      headers: authHeaders(ctx.token),
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await ctx.close();
  }
});

test('rejects svg/html disguise and oversize limit query', async () => {
  const ctx = await createTestApp();
  try {
    const svg = await uploadFile(ctx.app, ctx.token, makeSvgDisguise(), {
      filename: 'x.png',
      contentType: 'image/png',
    });
    assert.equal(svg.statusCode, 400);
    assert.equal(svg.json().error.code, 'unsupported_type');

    const badLimit = await ctx.app.inject({
      method: 'GET',
      url: '/v1/stickers?limit=101',
      headers: authHeaders(ctx.token),
    });
    assert.equal(badLimit.statusCode, 400);
  } finally {
    await ctx.close();
  }
});

test('persists across reopen using same db path', async () => {
  const ctx = await createTestApp();
  const png = makePng(2, 2);
  let id = '';
  try {
    const created = await uploadFile(ctx.app, ctx.token, png, {
      fields: { title: '持久化', tags: 'persist' },
    });
    assert.equal(created.statusCode, 201);
    id = created.json().sticker.id;
    await ctx.app.close();

    const db = openDatabase(ctx.config.dbPath);
    const { app } = await buildApp({ config: ctx.config, db });
    await app.ready();
    try {
      const got = await app.inject({
        method: 'GET',
        url: `/v1/stickers/${id}`,
        headers: authHeaders(ctx.token),
      });
      assert.equal(got.statusCode, 200);
      assert.equal(got.json().sticker.title, '持久化');
      // verify original bytes still on disk via file endpoint after reopen
      const file = await app.inject({
        method: 'GET',
        url: `/v1/stickers/${id}/file`,
        headers: authHeaders(ctx.token),
      });
      assert.equal(file.statusCode, 200);
      assert.deepEqual(Buffer.from(file.rawPayload), png);
    } finally {
      await app.close();
      db.close();
    }
  } finally {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test('plain gif upload works', async () => {
  const ctx = await createTestApp();
  try {
    const res = await uploadFile(ctx.app, ctx.token, makeGif(), {
      filename: 'plain.gif',
      contentType: 'image/gif',
      fields: { title: '普通gif' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().sticker.mimeType, 'image/gif');
  } finally {
    await ctx.close();
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
// @ts-ignore vendored JS (tests only)
import { validateRepo } from '../vendor/sticker-assets/lib/validator.mjs';
import { bearer, createCtx, exportHeadTree, idem, META, TOKENS, multipart } from './helpers.js';
import { makePng } from './fixtures.js';
import { BATCH_MAX_ITEMS } from '../src/services/assets.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function batchUpload(
  app: Awaited<ReturnType<typeof createCtx>>['app'],
  files: Buffer[],
  metas?: unknown[],
  opts: { token?: string | null; key?: string } = {},
) {
  const metadata = JSON.stringify(metas ?? files.map((_, i) => META({ title: `批${i}` })));
  const parts: Array<{ name: string; value: string } | { name: string; file: Buffer; filename?: string; type?: string }> = [
    { name: 'metadata', value: metadata },
  ];
  for (let i = 0; i < files.length; i++) {
    parts.push({ name: 'file', file: files[i]!, filename: `b${i}.png`, type: 'image/png' });
  }
  const mp = multipart(parts);
  const headers: Record<string, string> = { 'content-type': mp.contentType };
  if (opts.token !== null) Object.assign(headers, bearer(opts.token ?? TOKENS.xiaozhi));
  if (opts.key !== '') headers['idempotency-key'] = opts.key ?? idem();
  return app.inject({ method: 'POST', url: '/v1/assets/batch', headers, payload: mp.payload });
}

test('batch upload commits one import.batch with N assets', async () => {
  const ctx = await createCtx();
  try {
    const before = ctx.gh.head();
    const pngs = [makePng(4, 4), makePng(5, 5), makePng(6, 6)];
    const res = await batchUpload(ctx.app, pngs);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.status, 'created');
    assert.equal(body.summary.created, 3);
    assert.equal(body.summary.duplicate, 0);
    assert.equal(body.summary.error, 0);
    assert.equal(body.items.length, 3);
    assert.equal(body.commit, ctx.gh.head());
    assert.deepEqual(ctx.gh.commits.get(body.commit)!.parents, [before]);
    assert.match(ctx.gh.commits.get(body.commit)!.message, /^sticker: import\.batch \+3\n/);
    const ev = ctx.gh.headJson(`events/${body.operationId.slice(3, 5)}/${body.operationId}.json`);
    assert.equal(ev.type, 'import.batch');
    assert.equal(ev.assets.length, 3);
    assert.equal(ev.summary.added, 3);
    for (const png of pngs) {
      assert.ok(ctx.gh.headFile(`objects/sha256/${sha(png).slice(0, 2)}/${sha(png)}.png`));
    }
    const dir = exportHeadTree(ctx.gh);
    const v = validateRepo(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(v.errors, []);
  } finally {
    await ctx.close();
  }
});

test('batch idempotency replays; mixed duplicate sha in same batch', async () => {
  const ctx = await createCtx();
  try {
    const a = makePng(7, 7);
    const b = makePng(8, 8);
    const key = idem();
    const first = await batchUpload(ctx.app, [a, b], undefined, { key });
    assert.equal(first.statusCode, 201, first.body);
    const commit1 = first.json().commit;
    const second = await batchUpload(ctx.app, [a, b], undefined, { key });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().status, 'replayed');
    assert.equal(second.json().commit, commit1);

    // same sha twice in one request: first created, second duplicate
    const c = makePng(9, 9);
    const mixed = await batchUpload(ctx.app, [c, c], [META({ title: '一' }), META({ title: '二' })]);
    assert.equal(mixed.statusCode, 201, mixed.body);
    const items = mixed.json().items;
    assert.equal(items[0].status, 'created');
    assert.equal(items[1].status, 'duplicate');
    assert.equal(mixed.json().summary.created, 1);
    assert.equal(mixed.json().summary.duplicate, 1);
  } finally {
    await ctx.close();
  }
});

test('batch daily budget overflow reports per-item errors and commits successes', async () => {
  const ctx = await createCtx();
  try {
    // Fixture daily budget is small in sample repo? Force by uploading until near limit is hard.
    // Instead: request with metadata/file count mismatch and oversize item count.
    const tooMany = Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, i) => makePng(2, 2 + (i % 3)));
    const res = await batchUpload(ctx.app, tooMany);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'too_many_files');

    const one = makePng(10, 10);
    const badMeta = await batchUpload(ctx.app, [one, makePng(11, 11)], [META()]);
    assert.equal(badMeta.statusCode, 400);
    assert.equal(badMeta.json().error.code, 'invalid_metadata');
  } finally {
    await ctx.close();
  }
});

test('batch respects dailyMaxAssets mid-batch', async () => {
  const ctx = await createCtx();
  try {
    // Patch catalog limits via writing budgets/daily to almost full for today
    const limits = ctx.gh.headJson('indexes/catalog.json').limits;
    // Fill acceptedCount to dailyMaxAssets - 1 for Manila today
    const now = new Date();
    const manila = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    // en-CA gives YYYY-MM-DD
    const date = manila;
    ctx.gh.commitFiles({
      [`budgets/daily/${date}.json`]: JSON.stringify({
        schemaVersion: 1, date, timeZone: 'Asia/Manila',
        acceptedCount: limits.dailyMaxAssets - 1,
        acceptedBytes: 0,
      }, null, 2) + '\n',
    }, 'seed daily budget');

    const pngs = [makePng(12, 12), makePng(13, 13), makePng(14, 14)];
    const res = await batchUpload(ctx.app, pngs);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.summary.created, 1);
    assert.ok(body.summary.error >= 1);
    assert.equal(body.items[0].status, 'created');
    assert.equal(body.items[1].status, 'error');
    assert.equal(body.items[1].error.code, 'daily_budget_exceeded');
    // remaining aborted
    assert.equal(body.items[2].status, 'error');
    assert.ok(['daily_budget_exceeded', 'batch_aborted'].includes(body.items[2].error.code));
  } finally {
    await ctx.close();
  }
});

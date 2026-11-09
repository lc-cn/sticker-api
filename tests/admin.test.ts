import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_ID, adminHeaders, bearer, cookiePair, createCtx, login, TOKENS, type Ctx } from './helpers.js';
import { createHash } from 'node:crypto';

const SOURCES = JSON.stringify({
  schemaVersion: 1,
  workflow: 'collect.yml',
  sources: [
    { id: 'bilibili', label: '哔哩哔哩（B站）', approved: false, description: '占位' },
    { id: 'weibo', label: '微博', approved: false, description: '占位' },
    { id: 'Bad ID', label: 'x' },
  ],
});

async function ctxWithSources(env: Record<string, string> = {}): Promise<Ctx> {
  const ctx = await createCtx(env);
  ctx.gh.commitFiles({ 'config/collect-sources.json': SOURCES }, 'collect sources');
  return ctx;
}

test('collect endpoints: 401 unauthenticated, 403 without scope, 403 without CSRF/Origin', async () => {
  const ctx = await ctxWithSources();
  try {
    for (const [method, url] of [['GET', '/v1/collect/sources'], ['GET', '/v1/collect-runs'], ['POST', '/v1/collect-runs']] as const) {
      const r = await ctx.app.inject({ method, url, payload: method === 'POST' ? { source: 'bilibili' } : undefined });
      assert.equal(r.statusCode, 401, `${method} ${url}`);
    }
    const noScope = await ctx.app.inject({ method: 'GET', url: '/v1/collect/sources', headers: bearer(TOKENS.renderOnly) });
    assert.equal(noScope.statusCode, 403);

    const { session } = await login(ctx);
    const h = await adminHeaders(ctx, session!);
    const noCsrf = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: { cookie: session!, origin: h.origin }, payload: { source: 'bilibili' } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, 'csrf_token');
    const noOrigin = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: { cookie: session!, 'x-csrf-token': h['x-csrf-token'] }, payload: { source: 'bilibili' } });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(noOrigin.json().error.code, 'csrf_origin');
    const evil = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: { ...h, origin: 'https://evil.example' }, payload: { source: 'bilibili' } });
    assert.equal(evil.statusCode, 403);
    assert.equal(ctx.gh.dispatches.length, 0, 'nothing dispatched on rejected requests');
  } finally {
    await ctx.close();
  }
});

test('non-admin GitHub login: legacy JSON 403, admin page flow redirects to friendly forbidden; no session either way', async () => {
  const ctx = await ctxWithSources();
  try {
    const legacy = await login(ctx, { id: 424242, login: 'stranger' });
    assert.equal(legacy.cb.statusCode, 403);
    assert.equal(legacy.session, null);

    const start = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start?next=admin' });
    const tx = cookiePair(start.headers['set-cookie'], '__Host-sticker_oauth')!;
    const { code, state } = ctx.gh.authorize(start.headers.location as string, { id: 424242, login: 'stranger' });
    const cb = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: tx } });
    assert.equal(cb.statusCode, 303);
    assert.equal(cb.headers.location, '/admin?login=forbidden');
    assert.equal(cookiePair(cb.headers['set-cookie'], '__Host-sticker_session'), null);

    // admin via the admin-page flow lands on /admin with a session
    const s2 = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start?next=admin' });
    const tx2 = cookiePair(s2.headers['set-cookie'], '__Host-sticker_oauth')!;
    const a = ctx.gh.authorize(s2.headers.location as string, { id: ADMIN_ID, login: 'fin' });
    const cb2 = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${a.code}&state=${a.state}`, headers: { cookie: tx2 } });
    assert.equal(cb2.statusCode, 303);
    assert.equal(cb2.headers.location, '/admin');
    const sess = cookiePair(cb2.headers['set-cookie'], '__Host-sticker_session')!;
    const info = (await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: sess } })).json();
    assert.equal(info.authenticated, true);
    assert.deepEqual(info.repo, { owner: 'example-owner', repo: 'sticker-assets' });
    // `next` is an enum, never an open redirect
    const s3 = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start?next=https://evil.example' });
    const tx3 = cookiePair(s3.headers['set-cookie'], '__Host-sticker_oauth')!;
    const b = ctx.gh.authorize(s3.headers.location as string, { id: ADMIN_ID, login: 'fin' });
    const cb3 = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${b.code}&state=${b.state}`, headers: { cookie: tx3 } });
    assert.equal(cb3.headers.location, '/v1/auth/session');
  } finally {
    await ctx.close();
  }
});

test('admin collect: sources from A, workflow_dispatch shape, cooldown 429, runs list, permission error', async () => {
  const ctx = await ctxWithSources({ COLLECT_COOLDOWN_SECONDS: '300' });
  try {
    const { session } = await login(ctx);
    const h = await adminHeaders(ctx, session!);
    const src = await ctx.app.inject({ method: 'GET', url: '/v1/collect/sources', headers: { cookie: session! } });
    assert.equal(src.statusCode, 200);
    assert.deepEqual(src.json().sources.map((s: any) => s.id), ['bilibili', 'weibo'], 'invalid ids dropped');
    assert.equal(src.json().workflow, 'collect.yml');

    const ok = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'bilibili' } });
    assert.equal(ok.statusCode, 202, ok.body);
    assert.equal(ok.json().dispatched, true);
    assert.equal(ok.json().dryRun, true);
    assert.deepEqual(ctx.gh.dispatches[0], { workflow: 'collect.yml', body: { ref: 'main', inputs: { source: 'bilibili', dry_run: 'true' } } });
    assert.ok(ctx.gh.calls.includes('POST /repos/example-owner/sticker-assets/actions/workflows/collect.yml/dispatches'));

    const again = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'bilibili' } });
    assert.equal(again.statusCode, 429);
    assert.ok(Number(again.headers['retry-after']) > 200);

    const unknown = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'douyin' } });
    assert.equal(unknown.statusCode, 404);
    const bad = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'weibo', extra: 1 } });
    assert.equal(bad.statusCode, 400);

    const runs = await ctx.app.inject({ method: 'GET', url: '/v1/collect-runs', headers: { cookie: session! } });
    assert.equal(runs.statusCode, 200);
    const r0 = runs.json().runs[0];
    assert.equal(r0.event, 'workflow_dispatch');
    assert.match(r0.url, /^https:\/\/github\.com\/example-owner\/sticker-assets\/actions\/runs\/\d+$/);

    // Missing "Actions" permission → clear 503; the failed dispatch does not consume the cooldown.
    ctx.gh.actionsForbidden = true;
    const denied = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'weibo', dryRun: false } });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().error.code, 'actions_permission');
    assert.match(denied.json().error.message, /Actions: Read and write/);
    const deniedRuns = await ctx.app.inject({ method: 'GET', url: '/v1/collect-runs', headers: { cookie: session! } });
    assert.equal(deniedRuns.json().error.code, 'actions_permission');
    ctx.gh.actionsForbidden = false;
    const retry = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: h, payload: { source: 'weibo', dryRun: false } });
    assert.equal(retry.statusCode, 202);
    assert.equal(ctx.gh.dispatches[1]!.body.inputs!.dry_run, 'false');
  } finally {
    await ctx.close();
  }
});

test('machine token with collect:trigger can dispatch (no CSRF needed for bearer)', async () => {
  const token = 'stk_collector_' + 'x'.repeat(32);
  const ctx = await ctxWithSources({
    MACHINE_TOKENS: JSON.stringify([{ id: 'collector', scopes: ['collect:trigger'], sha256: createHash('sha256').update(token).digest('hex') }]),
  });
  try {
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: bearer(token), payload: { source: 'weibo' } });
    assert.equal(r.statusCode, 202, r.body);
    assert.equal(ctx.gh.dispatches.length, 1);
  } finally {
    await ctx.close();
  }
});

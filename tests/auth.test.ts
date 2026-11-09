import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_ID, adminHeaders, bearer, cookiePair, createCtx, login, PUBLIC, TOKENS, upload } from './helpers.js';
import { makePng } from './fixtures.js';

test('machine tokens: 401 without/invalid, 403 on missing scope; tokens never stored in plaintext', async () => {
  const ctx = await createCtx();
  try {
    const none = await upload(ctx.app, makePng(2, 3), { token: null });
    assert.equal(none.statusCode, 401);
    assert.equal(none.json().error.code, 'unauthorized');
    const bad = await upload(ctx.app, makePng(2, 3), { token: 'stk_wrong_token_value_xxxxxxxxxxxxxxx' });
    assert.equal(bad.statusCode, 401);
    const noScope = await upload(ctx.app, makePng(2, 3), { token: TOKENS.renderOnly });
    assert.equal(noScope.statusCode, 403);
    assert.equal(noScope.json().error.code, 'forbidden');
    assert.ok(!JSON.stringify(ctx.config).includes(TOKENS.xiaozhi), 'config holds only hashes');
    const collect = await ctx.app.inject({ method: 'POST', url: '/v1/collect-runs', headers: bearer(TOKENS.xiaozhi) });
    assert.equal(collect.statusCode, 403);
  } finally {
    await ctx.close();
  }
});

test('GitHub one-click login: state+PKCE, admin allowlist by numeric id, short signed HttpOnly cookie', async () => {
  const ctx = await createCtx();
  try {
    const { start, cb, session } = await login(ctx);
    assert.equal(start.statusCode, 302);
    const loc = new URL(start.headers.location as string);
    assert.equal(loc.pathname, '/login/oauth/authorize');
    assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(loc.searchParams.get('redirect_uri'), `${PUBLIC}/v1/auth/github/callback`);
    assert.equal(loc.searchParams.get('scope'), null, 'no OAuth scopes requested');
    const txCookie = ([] as string[]).concat(start.headers['set-cookie'] as any).find((c) => c.startsWith('__Host-sticker_oauth='))!;
    assert.match(txCookie, /HttpOnly/);
    assert.match(txCookie, /Secure/);
    assert.match(txCookie, /SameSite=Lax/);
    assert.match(txCookie, /Path=\//);
    assert.doesNotMatch(txCookie, /Domain=/);

    assert.equal(cb.statusCode, 303, cb.body);
    assert.ok(session);
    const sc = ([] as string[]).concat(cb.headers['set-cookie'] as any).find((c) => c.startsWith('__Host-sticker_session=') && !c.startsWith('__Host-sticker_session=;'))!;
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /Max-Age=1800/);
    assert.equal(ctx.gh.revoked.length, 1, 'user access token revoked right after identity check');

    const me = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: session! } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().authenticated, true);
    assert.equal(me.json().admin.githubId, String(ADMIN_ID));
    assert.ok(me.json().csrfToken);
    assert.ok(!session!.includes('gho_'), 'GitHub token not in cookie');
  } finally {
    await ctx.close();
  }
});

test('non-admin GitHub user gets 403 and no session; bad state / replayed code rejected', async () => {
  const ctx = await createCtx();
  try {
    const { cb, session } = await login(ctx, { id: 2002, login: 'stranger' });
    assert.equal(cb.statusCode, 403);
    assert.equal(cb.json().error.code, 'forbidden');
    assert.equal(session, null);
    assert.ok(([] as string[]).concat(cb.headers['set-cookie'] as any).some((c) => /^__Host-sticker_session=;/.test(c) || /^__Host-sticker_session=.*Max-Age=0/.test(c)));

    const start = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start' });
    const tx = cookiePair(start.headers['set-cookie'], '__Host-sticker_oauth')!;
    const { code } = ctx.gh.authorize(start.headers.location as string, { id: ADMIN_ID, login: 'fin' });
    const wrong = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${code}&state=forged`, headers: { cookie: tx } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(cookiePair(wrong.headers['set-cookie'], '__Host-sticker_session'), null);
    const noTx = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${code}&state=x` });
    assert.equal(noTx.statusCode, 400);

    // PKCE: a valid code exchanged with the wrong verifier fails (fake checks S256)
    const start2 = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start' });
    const start3 = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start' });
    const a2 = ctx.gh.authorize(start2.headers.location as string, { id: ADMIN_ID, login: 'fin' });
    const tx3 = cookiePair(start3.headers['set-cookie'], '__Host-sticker_oauth')!;
    const swapped = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${a2.code}&state=${new URL(start3.headers.location as string).searchParams.get('state')}`, headers: { cookie: tx3 } });
    assert.notEqual(swapped.statusCode, 303);
    assert.equal(cookiePair(swapped.headers['set-cookie'], '__Host-sticker_session'), null);
  } finally {
    await ctx.close();
  }
});

test('admin writes need CSRF (Origin + token); tampered cookie 401; allowlist removal 403; logout', async () => {
  const ctx = await createCtx();
  try {
    const up = await upload(ctx.app, makePng(3, 2));
    const id = up.json().asset.id;
    const { session } = await login(ctx);
    const h = await adminHeaders(ctx, session!);
    const patch = (headers: Record<string, string>, rev = 1) =>
      ctx.app.inject({ method: 'PATCH', url: `/v1/assets/${id}`, headers: { ...headers, 'if-match': `"${rev}"` }, payload: { title: '管理员改的' } });

    assert.equal((await patch({ cookie: session! })).statusCode, 403, 'no Origin/CSRF');
    assert.equal((await patch({ ...h, origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await patch({ ...h, 'x-csrf-token': 'x'.repeat(64) })).statusCode, 403);
    const ok = await patch(h);
    assert.equal(ok.statusCode, 200, ok.body);
    const ev = ctx.gh.headJson(`events/${ok.json().operationId.slice(3, 5)}/${ok.json().operationId}.json`);
    assert.equal(ev.actorKind, 'admin');
    // admin may confirm OCR / upload (session principal has every scope)
    const ad = await upload(ctx.app, makePng(3, 4), { token: null, headers: h, meta: { title: '管理员', categories: ['laugh'], tags: [], rights: { basis: 'self-created', licenseId: 'self-created-project' }, shareable: true, text: { ocr: '好', ocrConfirmed: true } } });
    assert.equal(ad.statusCode, 201, ad.body);

    const [name, value] = session!.split('=');
    const tampered = `${name}=${value!.slice(0, -2)}${value!.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: tampered } })).json().authenticated, false);
    assert.equal((await patch({ ...h, cookie: tampered })).statusCode, 401);

    // remove the admin from the env allowlist → existing session immediately 403
    (ctx.config as any).adminGithubUserIds = new Set<string>();
    const removed = await patch(h, 2);
    assert.equal(removed.statusCode, 403);
    (ctx.config as any).adminGithubUserIds = new Set<string>([String(ADMIN_ID)]);

    const out = await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: h });
    assert.equal(out.statusCode, 204);
    assert.ok(([] as string[]).concat(out.headers['set-cookie'] as any).some((c) => c.startsWith('__Host-sticker_session=')));
    const outNoCsrf = await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: session! } });
    assert.equal(outNoCsrf.statusCode, 403);
  } finally {
    await ctx.close();
  }
});

test('session expiry and login disabled when admin allowlist misconfigured', async () => {
  const t = Date.now();
  const ctx = await createCtx({ SESSION_TTL_SECONDS: '60' });
  try {
    const realNow = Date.now;
    const { session } = await login(ctx);
    Date.now = () => t + 61_000;
    try {
      assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: session! } })).json().authenticated, false);
      assert.equal((await ctx.app.inject({ method: 'DELETE', url: `/v1/assets/sha256:${'0'.repeat(64)}`, headers: { cookie: session!, origin: PUBLIC } })).statusCode, 401);
    } finally {
      Date.now = realNow;
    }
  } finally {
    await ctx.close();
  }
  const bad = await createCtx({ ADMIN_GITHUB_USER_IDS: 'fin,1001' });
  try {
    assert.ok(bad.config.warnings.some((w) => /ADMIN_GITHUB_USER_IDS/.test(w)));
    const { cb } = await login(bad);
    assert.equal(cb.statusCode, 403, 'fail closed');
  } finally {
    await bad.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { bearer, createCtx, SYSTEM_CJK_FONT, TOKENS } from './helpers.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ARCHIVED = 'sha256:bda5ea3f997c08670eff49f503f16e27aa54a28543ae81a36b1a00200caf90c6';
const body = { template: 'caption-bar', texts: ['你好'] };

test('anonymous renders: disabled by default → 401 exactly as before', async () => {
  const ctx = await createCtx();
  try {
    assert.equal(ctx.config.publicRendersEnabled, false);
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: '203.0.113.1' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'unauthorized');
    assert.equal(r.headers['cache-control'], 'no-store');
    const h = (await ctx.app.inject({ method: 'GET', url: '/v1/health' })).json();
    assert.equal(h.publicRenders, false);
  } finally {
    await ctx.close();
  }
});

test('anonymous renders enabled → 200 PNG; archived assets refused; bad bearer still 401', { skip: !SYSTEM_CJK_FONT && 'no CJK system font on this machine' }, async () => {
  const ctx = await createCtx({ PUBLIC_RENDERS_ENABLED: 'true' });
  try {
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: '203.0.113.2' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.ok(r.rawPayload.subarray(0, 8).equals(PNG_SIG));
    const archived = await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: { ...body, assetIds: [ARCHIVED] }, remoteAddress: '203.0.113.2' });
    assert.equal(archived.statusCode, 404);
    // a machine token may still reference it (existing behaviour unchanged)
    const machine = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: bearer(TOKENS.renderOnly), payload: { ...body, assetIds: [ARCHIVED] } });
    assert.equal(machine.statusCode, 200, machine.body);
    const badToken = await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: bearer('stk_wrong_token_value_xxxxxxxxxxxxxxx'), payload: body });
    assert.equal(badToken.statusCode, 401);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/v1/health' })).json().publicRenders, true);
  } finally {
    await ctx.close();
  }
});

test('anonymous renders: per-IP 429 + Retry-After, IPs independent, XFF ignored unless trusted', async () => {
  // No font: renders fail with 503 after the limiter, which is enough to exercise the limiter itself.
  const ctx = await createCtx({ PUBLIC_RENDERS_ENABLED: '1', PUBLIC_RENDER_PER_MINUTE: '2', RENDER_FONTS: '', TRUST_PROXY_HEADERS: 'false' });
  const send = (ip: string, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: ip, headers });
  try {
    assert.notEqual((await send('198.51.100.1')).statusCode, 429);
    assert.notEqual((await send('198.51.100.1')).statusCode, 429);
    const limited = await send('198.51.100.1');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    const ra = Number(limited.headers['retry-after']);
    assert.ok(ra >= 1 && ra <= 60, `retry-after ${ra}`);
    assert.equal(limited.headers['cache-control'], 'no-store');
    // another IP has its own budget
    assert.notEqual((await send('198.51.100.2')).statusCode, 429);
    // spoofed forwarding headers are ignored when not behind a trusted proxy
    const spoof = await send('198.51.100.1', { 'x-forwarded-for': '192.0.2.77', 'x-real-ip': '192.0.2.78' });
    assert.equal(spoof.statusCode, 429);
    // token principals are not affected by the anonymous limiter
    assert.notEqual((await ctx.app.inject({ method: 'POST', url: '/v1/renders', headers: bearer(TOKENS.renderOnly), payload: body, remoteAddress: '198.51.100.1' })).statusCode, 429);
  } finally {
    await ctx.close();
  }

  const trusted = await createCtx({ PUBLIC_RENDERS_ENABLED: '1', PUBLIC_RENDER_PER_MINUTE: '1', RENDER_FONTS: '', TRUST_PROXY_HEADERS: '1' });
  const tsend = (headers: Record<string, string>) => trusted.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: '10.0.0.1', headers });
  try {
    assert.notEqual((await tsend({ 'x-forwarded-for': '192.0.2.1, 10.0.0.1' })).statusCode, 429);
    assert.equal((await tsend({ 'x-forwarded-for': '192.0.2.1' })).statusCode, 429);
    assert.notEqual((await tsend({ 'x-forwarded-for': '192.0.2.2' })).statusCode, 429, 'first XFF hop is the client on a trusted proxy');
    assert.notEqual((await tsend({ 'x-real-ip': '192.0.2.3', 'x-forwarded-for': '192.0.2.1' })).statusCode, 429, 'x-real-ip wins');
  } finally {
    await trusted.close();
  }
});

test('anonymous per-day limit', async () => {
  const ctx = await createCtx({ PUBLIC_RENDERS_ENABLED: '1', PUBLIC_RENDER_PER_MINUTE: '10', PUBLIC_RENDER_PER_DAY: '2', RENDER_FONTS: '' });
  try {
    for (let i = 0; i < 2; i++) await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: '198.51.100.9' });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/renders', payload: body, remoteAddress: '198.51.100.9' });
    assert.equal(r.statusCode, 429);
    assert.ok(Number(r.headers['retry-after']) > 60, 'day window → long retry-after');
  } finally {
    await ctx.close();
  }
});

test('homepage, docs, admin shell and static assets: CSP, caching, no traversal', async () => {
  const ctx = await createCtx({ MIRROR_HOST_ALLOWLIST: 'fastly.jsdelivr.net,gh-proxy.com' });
  try {
    const home = await ctx.app.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.match(String(home.headers['content-type']), /text\/html/);
    const csp = String(home.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /img-src 'self' blob: https:\/\/raw\.githubusercontent\.com https:\/\/fastly\.jsdelivr\.net https:\/\/gh-proxy\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(home.body, /小智表情包/);
    assert.doesNotMatch(home.body, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
    assert.doesNotMatch(home.body, /admin|\/v1\/assets.*POST/i, 'homepage exposes no admin/upload');
    assert.match(home.body, /MemeCrafters\/meme-generator/);
    assert.match(home.body, /github\.com\/lc-cn\/sticker-assets\/issues\/new/);

    const admin = await ctx.app.inject({ method: 'GET', url: '/admin' });
    assert.equal(admin.statusCode, 200);
    assert.equal(admin.headers['cache-control'], 'no-store');
    assert.ok(admin.headers['content-security-policy']);
    assert.doesNotMatch(admin.body, /csrf|sha256:/i, 'admin shell carries no data');

    assert.equal((await ctx.app.inject({ method: 'GET', url: '/docs' })).statusCode, 200);
    const js = await ctx.app.inject({ method: 'GET', url: '/assets/home.js' });
    assert.equal(js.statusCode, 200);
    assert.match(String(js.headers['content-type']), /javascript/);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/assets/..%2Fpackage.json' })).statusCode, 404);
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/assets/nope.exe' })).statusCode, 404);
    const spec = await ctx.app.inject({ method: 'GET', url: '/openapi.yaml' });
    assert.equal(spec.statusCode, 200);
    assert.match(spec.body, /PUBLIC_RENDERS_ENABLED|anonymous/i);
    // unknown routes keep the JSON 404
    assert.equal((await ctx.app.inject({ method: 'GET', url: '/nope' })).json().error.code, 'not_found');
  } finally {
    await ctx.close();
  }
});

test('templates expose preview sources; categories endpoint is public', async () => {
  const ctx = await createCtx();
  try {
    const t = (await ctx.app.inject({ method: 'GET', url: '/v1/templates' })).json().templates;
    assert.ok(t.length > 0);
    assert.ok(Array.isArray(t[0].preview));
    const c = await ctx.app.inject({ method: 'GET', url: '/v1/categories' });
    assert.equal(c.statusCode, 200);
    const cats = c.json().categories;
    assert.ok(cats.length >= 10);
    assert.ok(cats.every((x: any) => typeof x.slug === 'string' && typeof x.label === 'string'));
  } finally {
    await ctx.close();
  }
});

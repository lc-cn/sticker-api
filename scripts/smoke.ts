/**
 * End-to-end local smoke: in-memory fake GitHub (A repo seeded from A's fixtures) + the *Vercel handler*
 * served by node:http on an ephemeral loopback port. Everything is closed at the end (no lingering processes).
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeGitHub } from '../tests/fake-github.js';
import { readFixtureTree, SYSTEM_CJK_FONT, multipart } from '../tests/helpers.js';
import { makePng } from '../tests/fixtures.js';

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const token = `stk_smoke_${randomBytes(24).toString('base64url')}`;
const gh = new FakeGitHub({
  owner: 'example-owner',
  repo: 'sticker-assets',
  appId: '1',
  installationId: '2',
  appPublicKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  loginClientId: 'Iv1.smoke',
  loginClientSecret: 'smoke',
});
const ghBase = await gh.start();
gh.commitFiles(readFixtureTree(), 'seed');
const server = http.createServer();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
Object.assign(process.env, {
  STICKER_ALLOW_HTTP_LOOPBACK: '1',
  PUBLIC_BASE_URL: base,
  A_REPO_OWNER: 'example-owner',
  A_REPO_NAME: 'sticker-assets',
  GITHUB_API_BASE: ghBase,
  GITHUB_OAUTH_BASE: ghBase,
  A_RAW_BASE: `${ghBase}/raw`,
  GITHUB_APP_ID: '1',
  GITHUB_APP_INSTALLATION_ID: '2',
  GITHUB_APP_PRIVATE_KEY: Buffer.from(kp.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()).toString('base64'),
  MACHINE_TOKENS: JSON.stringify([{ id: 'smoke', scopes: ['assets:write', 'assets:moderate', 'render', 'operations:read'], sha256: createHash('sha256').update(token).digest('hex') }]),
  IDEMPOTENCY_HMAC_KEYS: `k1:${randomBytes(32).toString('base64')}`,
  ...(SYSTEM_CJK_FONT ? { RENDER_FONTS: `default-sans=Hiragino Sans GB@${SYSTEM_CJK_FONT}` } : {}),
});
const { default: handler } = await import('../src/vercel.js');
server.on('request', (req, res) => void handler(req, res));

const auth = { authorization: `Bearer ${token}` };
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed++;
};
try {
  const health = await fetch(`${base}/v1/health`);
  check('GET /v1/health', health.ok);
  const list = (await (await fetch(`${base}/v1/assets`)).json()) as any;
  check('GET /v1/assets (public, fixture)', list.items?.length === 4, `${list.items?.length} items @ ${String(list.commit).slice(0, 7)}`);

  const png = makePng(32, 32);
  const mp = multipart([
    { name: 'metadata', value: JSON.stringify({ title: '冒烟测试', categories: ['laugh'], tags: ['冒烟'], rights: { basis: 'self-created', licenseId: 'self-created-project' }, shareable: true }) },
    { name: 'file', file: png, filename: 's.png' },
  ]);
  const key = `smoke-${randomBytes(8).toString('hex')}`;
  const up = await fetch(`${base}/v1/assets`, { method: 'POST', headers: { ...auth, 'content-type': mp.contentType, 'idempotency-key': key }, body: mp.payload });
  const upj = (await up.json()) as any;
  check('POST /v1/assets → 201 + A commit', up.status === 201 && upj.commit === gh.head(), `${upj.asset?.id?.slice(0, 19)} commit ${String(upj.commit).slice(0, 7)}`);
  const again = await fetch(`${base}/v1/assets`, { method: 'POST', headers: { ...auth, 'content-type': mp.contentType, 'idempotency-key': key }, body: mp.payload });
  check('idempotent replay', ((await again.json()) as any).status === 'replayed');
  const s = (await (await fetch(`${base}/v1/assets?q=${encodeURIComponent('冒烟')}&sort=uploaded`)).json()) as any;
  check('search q+sort=uploaded', s.items?.[0]?.id === upj.asset.id);
  const c = await fetch(`${base}/v1/assets/${upj.asset.id}/content`, { redirect: 'manual' });
  check('content 302', c.status === 302 && /^https:\/\/raw\.githubusercontent\.com\/example-owner\/sticker-assets\/[0-9a-f]{40}\/objects\//.test(c.headers.get('location') ?? ''), c.headers.get('location') ?? '');
  const tpl = (await (await fetch(`${base}/v1/templates`)).json()) as any;
  check('GET /v1/templates', tpl.templates?.length >= 1);
  if (SYSTEM_CJK_FONT) {
    const r = await fetch(`${base}/v1/renders`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ template: 'caption-bar', texts: ['冒烟测试通过'], assetIds: [upj.asset.id] }) });
    const buf = Buffer.from(await r.arrayBuffer());
    check('POST /v1/renders → PNG', r.status === 200 && buf.subarray(1, 4).toString() === 'PNG', `${buf.length} bytes`);
    if (process.env.SMOKE_SAVE_RENDER) fs.writeFileSync(process.env.SMOKE_SAVE_RENDER, buf);
  } else console.log('skip render (no system CJK font)');
  const del = await fetch(`${base}/v1/assets/${upj.asset.id}?reason=other`, { method: 'DELETE', headers: auth });
  const delj = (await del.json()) as any;
  check('DELETE → tombstone', del.status === 200 && delj.status === 'tombstoned', del.status === 200 ? '' : JSON.stringify(delj));
  check('detail after tombstone → 410', (await fetch(`${base}/v1/assets/${upj.asset.id}`)).status === 410);
  const op = await fetch(`${base}/v1/operations/${upj.operationId}`, { headers: { ...auth, 'idempotency-key': key } });
  check('GET /v1/operations/:id (own key)', op.status === 200);
  check('unauthenticated write → 401', (await fetch(`${base}/v1/assets/${upj.asset.id}`, { method: 'DELETE' })).status === 401);
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.stop();
}
console.log(failed ? `SMOKE FAILED (${failed})` : 'SMOKE OK');
process.exitCode = failed ? 1 : 0;

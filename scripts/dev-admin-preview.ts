/**
 * LOCAL-ONLY preview of the admin console with a pre-minted admin session, for screenshots / UI work.
 * Not part of the deployed function (Vercel only runs api/index.js → dist/src/vercel.js), refuses to run on
 * Vercel or with a non-loopback bind, generates throwaway keys per run, and has writes disabled.
 *
 * Reads come from the LIVE public A repo (raw.githubusercontent.com) except `config/collect-sources.json`,
 * which can be overridden from a local A checkout (to preview an unpushed registry). GitHub API calls go to
 * a tiny local stub: HEAD sha (fetched once from the public API), installation token, and Actions
 * dispatch/runs (in-memory fake data, clearly labelled).
 *
 *   node dist/scripts/dev-admin-preview.js --port 8798 [--a-dir ../sticker-assets]
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { deriveSessionKeys, signPayload } from '../src/auth/crypto.js';
import { SESSION_COOKIE } from '../src/auth/cookies.js';
import { SESSION_PURPOSE, type SessionPayload } from '../src/auth/principal.js';

if (process.env.VERCEL) throw new Error('dev-admin-preview must never run on Vercel');
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('--port', '8798'));
const A_DIR = arg('--a-dir');
const OWNER = 'lc-cn';
const REPO = 'sticker-assets';

const headRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/ref/heads/main`, { headers: { 'user-agent': 'sticker-api-dev-preview' } });
const head = ((await headRes.json()) as { object?: { sha?: string } }).object?.sha;
if (!head) throw new Error('could not read live A HEAD');

const dispatches: Array<{ source: string; dry: string; at: string }> = [
  { source: 'bilibili', dry: 'true', at: new Date(Date.now() - 3600_000).toISOString() },
];
const send = (res: http.ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const stub = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const p = url.pathname;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
    return send(res, 201, { token: `ghs_preview_${randomBytes(8).toString('hex')}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (req.method === 'GET' && p === `/repos/${OWNER}/${REPO}/git/ref/heads/main`) return send(res, 200, { object: { sha: head, type: 'commit' } });
  if (req.method === 'POST' && p === `/repos/${OWNER}/${REPO}/actions/workflows/collect.yml/dispatches`) {
    dispatches.push({ source: body.inputs?.source, dry: body.inputs?.dry_run, at: new Date().toISOString() });
    return send(res, 204);
  }
  if (req.method === 'GET' && p === `/repos/${OWNER}/${REPO}/actions/workflows/collect.yml/runs`) {
    const runs = dispatches.map((d, i) => ({
      id: 9000 + i, run_number: i + 1, display_title: `collect-approved-sources · ${d.source}（本地预览假数据）`, event: 'workflow_dispatch',
      status: i === dispatches.length - 1 && i > 0 ? 'queued' : 'completed', conclusion: i === dispatches.length - 1 && i > 0 ? null : 'skipped',
      created_at: d.at, updated_at: d.at, html_url: `https://github.com/${OWNER}/${REPO}/actions/workflows/collect.yml`,
    })).reverse();
    return send(res, 200, { total_count: runs.length, workflow_runs: runs });
  }
  const raw = new RegExp(`^/raw/${OWNER}/${REPO}/([0-9a-f]{40})/(.+)$`).exec(p);
  if (req.method === 'GET' && raw) {
    if (A_DIR && raw[2] === 'config/collect-sources.json') {
      const f = path.resolve(A_DIR, 'config/collect-sources.json');
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(fs.readFileSync(f));
      }
    }
    const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${raw[1]}/${raw[2]}`);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  return send(res, 404, { message: 'Not Found (preview stub)' });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
const stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

const publicBase = `http://127.0.0.1:${PORT}`;
const sessionSecret = randomBytes(32);
const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = loadConfig(
  {
    PUBLIC_BASE_URL: publicBase,
    A_REPO_OWNER: OWNER,
    A_REPO_NAME: REPO,
    A_READ_SOURCE: 'raw',
    GITHUB_API_BASE: stubBase,
    GITHUB_OAUTH_BASE: stubBase,
    A_RAW_BASE: `${stubBase}/raw`,
    GITHUB_APP_ID: '1',
    GITHUB_APP_INSTALLATION_ID: '2',
    GITHUB_APP_PRIVATE_KEY: Buffer.from(kp.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()).toString('base64'),
    GITHUB_LOGIN_CLIENT_ID: 'Iv1.preview',
    GITHUB_LOGIN_CLIENT_SECRET: 'preview-not-secret',
    GITHUB_LOGIN_REDIRECT_URI: `${publicBase}/v1/auth/github/callback`,
    ADMIN_GITHUB_USER_IDS: '31359947',
    SESSION_SECRET: sessionSecret.toString('base64'),
    WRITES_ENABLED: 'false',
    MIRROR_HOST_ALLOWLIST: 'fastly.jsdelivr.net,cdn.jsdelivr.net,gh-proxy.com,ghfast.top',
    RENDER_FONTS: 'default-sans=Noto Sans SC@fonts/NotoSansSC-Regular.otf',
  },
  { allowHttpLoopback: true },
);
const { app } = await buildApp({ config });
await app.listen({ host: '127.0.0.1', port: 0 });
const appPort = (app.server.address() as AddressInfo).port;

const iat = Math.floor(Date.now() / 1000);
const payload: SessionPayload = { v: 1, aud: 'sticker-api-admin', sub: '31359947', login: 'lc-cn', iat, exp: iat + 1800, nonce: randomBytes(18).toString('base64url') };
const cookie = `${SESSION_COOKIE}=${signPayload(deriveSessionKeys(sessionSecret).sign, SESSION_PURPOSE, payload)}`;

// Front proxy: injects the preview admin cookie into every request (browser never sees it).
const front = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: { ...req.headers, cookie } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => send(res, 502, { message: 'upstream error' }));
  req.pipe(up);
});
await new Promise<void>((r) => front.listen(PORT, '127.0.0.1', r));
console.log(`admin preview (fake admin session, writes disabled, live A @${head.slice(0, 7)}): ${publicBase}/admin`);

const stop = async () => {
  front.close();
  await app.close();
  stub.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

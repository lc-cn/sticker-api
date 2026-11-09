import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, PROJECT_ROOT } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { FakeGitHub } from './fake-github.js';

export const FIXTURE_DIR = path.join(PROJECT_ROOT, 'vendor/sticker-assets/fixtures/sample-repo');
export const PUBLIC = 'http://127.0.0.1:8787';
export const ADMIN_ID = 1001;

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_PEM = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const APP_PUB = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

export const TOKENS = {
  xiaozhi: `stk_xiaozhi_${randomBytes(24).toString('base64url')}`,
  moderator: `stk_mod_${randomBytes(24).toString('base64url')}`,
  writerB: `stk_other_${randomBytes(24).toString('base64url')}`,
  renderOnly: `stk_render_${randomBytes(24).toString('base64url')}`,
};
const h = (t: string) => createHash('sha256').update(t).digest('hex');

export const SYSTEM_CJK_FONT = ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Light.ttc'].find((f) => fs.existsSync(f));

export function readFixtureTree(dir = FIXTURE_DIR): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full);
    }
  };
  walk(dir);
  return out;
}

export type Ctx = { app: FastifyInstance; gh: FakeGitHub; config: AppConfig; close: () => Promise<void> };

export async function createCtx(envOverrides: Record<string, string | undefined> = {}): Promise<Ctx> {
  const gh = new FakeGitHub({
    owner: 'example-owner',
    repo: 'sticker-assets',
    appId: '4242',
    installationId: '99',
    appPublicKeyPem: APP_PUB,
    loginClientId: 'Iv1.testlogin',
    loginClientSecret: 'test-login-secret',
  });
  const base = await gh.start();
  gh.commitFiles(readFixtureTree(), 'seed from A fixtures/sample-repo');
  const env: Record<string, string | undefined> = {
    PUBLIC_BASE_URL: PUBLIC,
    A_REPO_OWNER: 'example-owner',
    A_REPO_NAME: 'sticker-assets',
    GITHUB_API_BASE: base,
    GITHUB_OAUTH_BASE: base,
    A_RAW_BASE: `${base}/raw`,
    GITHUB_APP_ID: '4242',
    GITHUB_APP_INSTALLATION_ID: '99',
    GITHUB_APP_PRIVATE_KEY: Buffer.from(APP_PEM).toString('base64'),
    GITHUB_LOGIN_CLIENT_ID: 'Iv1.testlogin',
    GITHUB_LOGIN_CLIENT_SECRET: 'test-login-secret',
    GITHUB_LOGIN_REDIRECT_URI: `${PUBLIC}/v1/auth/github/callback`,
    ADMIN_GITHUB_USER_IDS: String(ADMIN_ID),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    MACHINE_TOKENS: JSON.stringify([
      { id: 'xiaozhi', scopes: ['assets:write', 'render', 'operations:read'], sha256: h(TOKENS.xiaozhi) },
      { id: 'moderator', scopes: ['assets:moderate'], sha256: h(TOKENS.moderator) },
      { id: 'other', scopes: ['assets:write', 'operations:read'], sha256: h(TOKENS.writerB) },
      { id: 'renderer', scopes: ['render'], sha256: h(TOKENS.renderOnly) },
    ]),
    IDEMPOTENCY_HMAC_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    HEAD_TTL_SECONDS: '1',
    HEAD_MAX_STALE_SECONDS: '1',
    MIRROR_HOST_ALLOWLIST: '',
    RENDER_FONTS: SYSTEM_CJK_FONT ? `default-sans=Hiragino Sans GB@${SYSTEM_CJK_FONT}` : undefined,
    ...envOverrides,
  };
  const config = loadConfig(env, { allowHttpLoopback: true });
  const { app } = await buildApp({ config });
  await app.ready();
  return {
    app: app as unknown as FastifyInstance,
    gh,
    config,
    close: async () => {
      await app.close();
      await gh.stop();
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
export const idem = () => `test-${randomBytes(12).toString('hex')}`;

export function multipart(parts: Array<{ name: string; value: string } | { name: string; file: Buffer; filename?: string; type?: string }>) {
  const boundary = `----sticker${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('file' in p) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename ?? 'a.bin'}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`));
      chunks.push(p.file, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const META = (over: Record<string, unknown> = {}) => ({
  title: '测试哈哈',
  categories: ['laugh'],
  tags: ['哈哈', '测试图'],
  rights: { basis: 'self-created', licenseId: 'self-created-project' },
  shareable: true,
  ...over,
});

export function upload(app: FastifyInstance, file: Buffer, opts: { token?: string | null; key?: string; meta?: unknown; headers?: Record<string, string> } = {}) {
  const mp = multipart([
    { name: 'metadata', value: JSON.stringify(opts.meta ?? META()) },
    { name: 'file', file, filename: 'x.png' },
  ]);
  const headers: Record<string, string> = { 'content-type': mp.contentType, ...(opts.headers ?? {}) };
  if (opts.token !== null) Object.assign(headers, bearer(opts.token ?? TOKENS.xiaozhi));
  if (opts.key !== '') headers['idempotency-key'] = opts.key ?? idem();
  return app.inject({ method: 'POST', url: '/v1/assets', headers, payload: mp.payload });
}

/** Full GitHub-login dance against the fake; returns the session cookie header (or the 403 response). */
export async function login(ctx: Ctx, user = { id: ADMIN_ID, login: 'fin' }) {
  const start = await ctx.app.inject({ method: 'GET', url: '/v1/auth/github/start' });
  const tx = cookiePair(start.headers['set-cookie'], '__Host-sticker_oauth')!;
  const { code, state } = ctx.gh.authorize(start.headers.location as string, user);
  const cb = await ctx.app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${code}&state=${state}`, headers: { cookie: tx } });
  const session = cookiePair(cb.headers['set-cookie'], '__Host-sticker_session');
  return { start, cb, session };
}

export function cookiePair(setCookie: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = list.filter((x) => x.startsWith(`${name}=`)).pop();
  if (!c) return null;
  const pair = c.split(';')[0]!;
  return pair.endsWith('=') ? null : pair;
}

export async function adminHeaders(ctx: Ctx, cookie: string) {
  const s = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
  return { cookie, origin: PUBLIC, 'x-csrf-token': s.json().csrfToken as string };
}

export function exportHeadTree(gh: FakeGitHub): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-a-head-'));
  for (const p of gh.headPaths()) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, gh.headFile(p)!);
  }
  return dir;
}

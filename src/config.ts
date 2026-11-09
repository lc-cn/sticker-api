/**
 * All configuration comes from environment variables (Vercel project env in prod,
 * .env / test overrides locally). Nothing here is persisted; the service is stateless.
 * Missing/invalid security config fails closed: the related capability is disabled,
 * never silently opened.
 */
export type MachineTokenConfig = {
  /** Short client id, e.g. "xiaozhi". Only used to derive an HMAC principal; never written to A. */
  id: string;
  scopes: Scope[];
  /** Lowercase hex SHA-256 of the full bearer token. The raw token is never stored. */
  sha256: string;
};

export const ALL_SCOPES = [
  'assets:write',
  'assets:moderate',
  'operations:read',
  'collect:trigger',
  'render',
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export type HmacKey = { keyId: string; secret: Buffer };

export type AppConfig = {
  publicBaseUrl: string;
  repo: { owner: string; repo: string; branch: string } | null;
  githubApiBase: string;
  githubOAuthBase: string;
  rawBase: string;
  readSource: 'raw' | 'api';
  githubApp: { appId: string; installationId: string; privateKeyPem: string } | null;
  login: { clientId: string; clientSecret: string; redirectUri: string } | null;
  adminGithubUserIds: Set<string>;
  sessionSecret: Buffer | null;
  sessionTtlSeconds: number;
  machineTokens: MachineTokenConfig[];
  idempotencyKeys: HmacKey[];
  mirrorHostAllowlist: Set<string>;
  headTtlMs: number;
  headMaxStaleMs: number;
  writesEnabled: boolean;
  rendersEnabled: boolean;
  contentEnabled: boolean;
  publishMaxAttempts: number;
  /** RENDER_FONTS raw spec; parsed by the renderer (id=Family@path;…). */
  renderFonts: string | undefined;
  renderTimeoutMs: number;
  renderPerMinute: number;
  /** Non-fatal config problems, surfaced on /v1/health for the operator (no secrets). */
  warnings: string[];
};

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Invalid ${name}: expected boolean`);
}

function httpsBase(raw: string, name: string, allowHttpLoopback: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid ${name}: not a URL`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowHttpLoopback && loopback && u.protocol === 'http:')) {
    throw new Error(`Invalid ${name}: must be https (http allowed only for loopback in local/test)`);
  }
  if (u.username || u.password || u.search || u.hash) throw new Error(`Invalid ${name}: no credentials/query/fragment`);
  return u.toString().replace(/\/$/, '');
}

export function parseAdminIds(raw: string | undefined, warnings: string[]): Set<string> {
  const out = new Set<string>();
  if (!raw) {
    warnings.push('ADMIN_GITHUB_USER_IDS not set: admin login will always be forbidden');
    return out;
  }
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (!p) continue;
    // Canonical decimal, no leading zeros, no sign. Usernames are NOT accepted.
    if (!/^[1-9][0-9]{0,19}$/.test(p)) {
      warnings.push('ADMIN_GITHUB_USER_IDS malformed: admin login disabled (fail closed)');
      return new Set();
    }
    out.add(p);
  }
  return out;
}

export function parseMachineTokens(raw: string | undefined, warnings: string[]): MachineTokenConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push('MACHINE_TOKENS is not valid JSON: machine auth disabled');
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnings.push('MACHINE_TOKENS must be a JSON array: machine auth disabled');
    return [];
  }
  const out: MachineTokenConfig[] = [];
  const ids = new Set<string>();
  for (const item of parsed) {
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const sha = typeof o.sha256 === 'string' ? o.sha256.toLowerCase() : '';
    const scopes = Array.isArray(o.scopes) ? o.scopes : [];
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || !/^[0-9a-f]{64}$/.test(sha) || ids.has(id)) {
      warnings.push('MACHINE_TOKENS entry invalid: machine auth disabled');
      return [];
    }
    const bad = scopes.filter((s) => !(ALL_SCOPES as readonly string[]).includes(String(s)));
    if (bad.length || scopes.length === 0) {
      warnings.push(`MACHINE_TOKENS entry ${id} has unknown/empty scopes: machine auth disabled`);
      return [];
    }
    ids.add(id);
    out.push({ id, sha256: sha, scopes: scopes as Scope[] });
  }
  return out;
}

/** "k2:<base64 secret>,k1:<old base64 secret>" — first entry is current. */
export function parseHmacKeys(raw: string | undefined, warnings: string[]): HmacKey[] {
  if (!raw) {
    warnings.push('IDEMPOTENCY_HMAC_KEYS not set: writes disabled');
    return [];
  }
  const out: HmacKey[] = [];
  for (const part of raw.split(',')) {
    const [keyId, b64] = part.trim().split(':');
    if (!keyId || !b64 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(keyId)) {
      warnings.push('IDEMPOTENCY_HMAC_KEYS malformed: writes disabled');
      return [];
    }
    const secret = Buffer.from(b64, 'base64');
    if (secret.length < 32) {
      warnings.push('IDEMPOTENCY_HMAC_KEYS secret shorter than 32 bytes: writes disabled');
      return [];
    }
    out.push({ keyId, secret });
  }
  return out;
}

function privateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  return Buffer.from(raw, 'base64').toString('utf8');
}

export function loadConfig(env: Env = process.env, opts: { allowHttpLoopback?: boolean } = {}): AppConfig {
  const warnings: string[] = [];
  const allowHttp = opts.allowHttpLoopback ?? env.STICKER_ALLOW_HTTP_LOOPBACK === '1';

  const publicBaseUrl = httpsBase(str(env, 'PUBLIC_BASE_URL') ?? 'http://127.0.0.1:8787', 'PUBLIC_BASE_URL', true);

  const owner = str(env, 'A_REPO_OWNER');
  const repoName = str(env, 'A_REPO_NAME');
  const nameRe = /^[A-Za-z0-9_.-]{1,100}$/;
  let repo: AppConfig['repo'] = null;
  if (owner && repoName && nameRe.test(owner) && nameRe.test(repoName)) {
    repo = { owner, repo: repoName, branch: str(env, 'A_REPO_BRANCH') ?? 'main' };
  } else {
    warnings.push('A_REPO_OWNER/A_REPO_NAME not set or invalid: all asset endpoints return 503');
  }

  const appId = str(env, 'GITHUB_APP_ID');
  const installationId = str(env, 'GITHUB_APP_INSTALLATION_ID');
  const pem = privateKey(str(env, 'GITHUB_APP_PRIVATE_KEY'));
  const githubApp =
    appId && installationId && pem && /^\d+$/.test(appId) && /^\d+$/.test(installationId)
      ? { appId, installationId, privateKeyPem: pem }
      : null;
  if (!githubApp) warnings.push('Writer GitHub App not configured: writes disabled, API reads unauthenticated');

  const clientId = str(env, 'GITHUB_LOGIN_CLIENT_ID');
  const clientSecret = str(env, 'GITHUB_LOGIN_CLIENT_SECRET');
  const redirectUri = str(env, 'GITHUB_LOGIN_REDIRECT_URI');
  let login: AppConfig['login'] = null;
  if (clientId && clientSecret && redirectUri) {
    const r = httpsBase(redirectUri, 'GITHUB_LOGIN_REDIRECT_URI', allowHttp);
    if (!r.startsWith(publicBaseUrl + '/')) throw new Error('GITHUB_LOGIN_REDIRECT_URI must live under PUBLIC_BASE_URL');
    login = { clientId, clientSecret, redirectUri: r };
  } else {
    warnings.push('GitHub login app not configured: admin login disabled');
  }

  const sessionRaw = str(env, 'SESSION_SECRET');
  let sessionSecret: Buffer | null = null;
  if (sessionRaw) {
    const b = Buffer.from(sessionRaw, 'base64');
    if (b.length >= 32) sessionSecret = b;
    else warnings.push('SESSION_SECRET shorter than 32 bytes (base64): admin sessions disabled');
  } else {
    warnings.push('SESSION_SECRET not set: admin sessions disabled');
  }

  const mirrorHostAllowlist = new Set(
    (str(env, 'MIRROR_HOST_ALLOWLIST') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const h of mirrorHostAllowlist) {
    if (!/^[a-z0-9.-]+$/.test(h)) throw new Error('MIRROR_HOST_ALLOWLIST: hostnames only');
  }

  const headTtl = int(env, 'HEAD_TTL_SECONDS', 15, 1, 30);
  const headStale = int(env, 'HEAD_MAX_STALE_SECONDS', 30, headTtl, 30);

  return {
    publicBaseUrl,
    repo,
    githubApiBase: httpsBase(str(env, 'GITHUB_API_BASE') ?? 'https://api.github.com', 'GITHUB_API_BASE', allowHttp),
    githubOAuthBase: httpsBase(str(env, 'GITHUB_OAUTH_BASE') ?? 'https://github.com', 'GITHUB_OAUTH_BASE', allowHttp),
    rawBase: httpsBase(str(env, 'A_RAW_BASE') ?? 'https://raw.githubusercontent.com', 'A_RAW_BASE', allowHttp),
    readSource: str(env, 'A_READ_SOURCE') === 'api' ? 'api' : 'raw',
    githubApp,
    login,
    adminGithubUserIds: parseAdminIds(str(env, 'ADMIN_GITHUB_USER_IDS'), warnings),
    sessionSecret,
    sessionTtlSeconds: int(env, 'SESSION_TTL_SECONDS', 1800, 60, 3600),
    machineTokens: parseMachineTokens(str(env, 'MACHINE_TOKENS'), warnings),
    idempotencyKeys: parseHmacKeys(str(env, 'IDEMPOTENCY_HMAC_KEYS'), warnings),
    mirrorHostAllowlist,
    headTtlMs: headTtl * 1000,
    headMaxStaleMs: headStale * 1000,
    writesEnabled: bool(env, 'WRITES_ENABLED', true),
    rendersEnabled: bool(env, 'RENDERS_ENABLED', true),
    contentEnabled: bool(env, 'CONTENT_ENABLED', true),
    publishMaxAttempts: int(env, 'PUBLISH_MAX_ATTEMPTS', 4, 1, 8),
    renderFonts: str(env, 'RENDER_FONTS'),
    renderTimeoutMs: int(env, 'RENDER_TIMEOUT_MS', 10000, 500, 10000),
    renderPerMinute: int(env, 'RENDER_PER_MINUTE', 30, 1, 600),
    warnings,
  };
}

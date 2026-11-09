import { createSign } from 'node:crypto';
import { AppError } from '../errors.js';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT for GitHub App authentication (valid ≤10 min per GitHub docs). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

type Cached = { token: string; expiresAtMs: number };

/**
 * Installation access token for the *writer* GitHub App (A repo only, Contents:write).
 * Kept only in function memory; never logged, never sent to raw/mirror hosts or the browser.
 */
export class InstallationTokenProvider {
  private cached: Cached | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly apiBase: string,
    private readonly app: { appId: string; installationId: string; privateKeyPem: string },
    private readonly repoName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - Date.now() > 5 * 60_000) return this.cached.token;
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const jwt = createAppJwt(this.app.appId, this.app.privateKeyPem);
    const res = await this.fetchImpl(
      `${this.apiBase}/app/installations/${encodeURIComponent(this.app.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'sticker-api',
          'content-type': 'application/json',
        },
        // Down-scope to the single A repo and contents:write even if the App has more.
        body: JSON.stringify({ repositories: [this.repoName], permissions: { contents: 'write' } }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new AppError(503, 'writer_auth_failed', 'Could not obtain GitHub App installation token', {
        retryable: true,
      });
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) throw new AppError(503, 'writer_auth_failed', 'Malformed installation token response');
    this.cached = { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
    return body.token;
  }
}

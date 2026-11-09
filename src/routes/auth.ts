import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { clearCookie, hostCookie, OAUTH_TX_COOKIE, parseCookies, SESSION_COOKIE } from '../auth/cookies.js';
import { randomToken, safeEqual, seal, signPayload, unseal, type SessionKeys } from '../auth/crypto.js';
import { assertCsrf, csrfTokenFor, readAdminSession, SESSION_PURPOSE, type SessionPayload } from '../auth/principal.js';

type OAuthTx = { state: string; verifier: string; exp: number };
const TX_AAD = 'oauth-tx.v1';
const TX_TTL = 300;

function noStore(reply: FastifyReply) {
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; keys: SessionKeys | null; fetchImpl?: typeof fetch },
): Promise<void> {
  const { config, keys } = deps;
  const f = deps.fetchImpl ?? fetch;

  const loginReady = () => {
    if (!config.login || !keys) throw new AppError(503, 'login_disabled', 'Admin login is not configured');
    return { login: config.login, keys };
  };

  app.get('/v1/auth/github/start', async (_req, reply) => {
    const { login, keys: k } = loginReady();
    noStore(reply);
    const state = randomToken(32);
    const verifier = randomToken(48); // 64 chars, RFC 7636 range 43..128
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const tx: OAuthTx = { state, verifier, exp: Math.floor(Date.now() / 1000) + TX_TTL };
    const url = new URL(`${config.githubOAuthBase}/login/oauth/authorize`);
    url.searchParams.set('client_id', login.clientId);
    url.searchParams.set('redirect_uri', login.redirectUri); // fixed, registered; never from the request
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'false');
    // No `scope`: GitHub App user tokens carry only the (empty) app permissions; we only need GET /user.
    reply.header('set-cookie', [hostCookie(OAUTH_TX_COOKIE, seal(k.enc, TX_AAD, tx), TX_TTL)]);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/v1/auth/github/callback', async (req, reply) => {
    const { login, keys: k } = loginReady();
    noStore(reply);
    const q = req.query as Record<string, string | undefined>;
    const cookies = parseCookies(req.headers.cookie);
    const tx = unseal<OAuthTx>(k.enc, TX_AAD, cookies[OAUTH_TX_COOKIE]);
    // Always burn the transaction cookie and any previous admin session (no cross-account residue).
    reply.header('set-cookie', [clearCookie(OAUTH_TX_COOKIE), clearCookie(SESSION_COOKIE)]);
    if (q.error) throw new AppError(401, 'oauth_denied', 'GitHub authorization was not granted');
    const now = Math.floor(Date.now() / 1000);
    if (!tx || !(tx.exp > now) || typeof q.state !== 'string' || !safeEqual(q.state, tx.state)) {
      throw new AppError(400, 'oauth_state_invalid', 'Login state invalid or expired; start again');
    }
    if (typeof q.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(q.code)) {
      throw new AppError(400, 'oauth_code_invalid', 'Missing authorization code');
    }

    let accessToken: string | undefined;
    try {
      const tokRes = await f(`${config.githubOAuthBase}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'sticker-api' },
        body: JSON.stringify({
          client_id: login.clientId,
          client_secret: login.clientSecret,
          code: q.code,
          redirect_uri: login.redirectUri,
          code_verifier: tx.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tok = (await tokRes.json().catch(() => ({}))) as { access_token?: string };
      accessToken = tokRes.ok ? tok.access_token : undefined;
    } catch {
      throw new AppError(503, 'oauth_upstream', 'GitHub login temporarily unavailable', { retryable: true });
    }
    if (!accessToken) throw new AppError(401, 'oauth_exchange_failed', 'GitHub rejected the authorization code');

    let user: { id?: unknown; login?: unknown };
    try {
      const userRes = await f(`${config.githubApiBase}/user`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'sticker-api',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!userRes.ok) throw new Error('user');
      user = (await userRes.json()) as typeof user;
    } catch {
      throw new AppError(503, 'oauth_upstream', 'Could not verify GitHub identity', { retryable: true });
    } finally {
      // Revoke (awaited, bounded, failure ignored): the user token is only needed for this one GET /user,
      // and serverless instances may freeze right after the response, so do not fire-and-forget.
      await f(`${config.githubApiBase}/applications/${encodeURIComponent(login.clientId)}/token`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${login.clientId}:${login.clientSecret}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'sticker-api',
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }

    const id = typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
    if (!id) throw new AppError(503, 'oauth_upstream', 'Malformed GitHub identity');
    if (!config.adminGithubUserIds.has(id)) {
      throw new AppError(403, 'forbidden', 'This GitHub account is not an administrator');
    }
    const iat = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      v: 1,
      aud: 'sticker-api-admin',
      sub: id,
      login: typeof user.login === 'string' ? user.login.slice(0, 39) : '',
      iat,
      exp: iat + config.sessionTtlSeconds,
      nonce: randomToken(18),
    };
    reply.header('set-cookie', [
      clearCookie(OAUTH_TX_COOKIE),
      hostCookie(SESSION_COOKIE, signPayload(k.sign, SESSION_PURPOSE, payload), config.sessionTtlSeconds),
    ]);
    return reply.redirect('/v1/auth/session', 303);
  });

  app.get('/v1/auth/session', async (req, reply) => {
    noStore(reply);
    const admin = readAdminSession(req, config, keys);
    if (!admin) return { authenticated: false, loginUrl: '/v1/auth/github/start' };
    return {
      authenticated: true,
      admin: { githubId: admin.githubId, login: admin.login },
      expiresAt: new Date(admin.exp * 1000).toISOString(),
      csrfToken: csrfTokenFor(keys!, admin.nonce),
    };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    noStore(reply);
    const admin = readAdminSession(req, config, keys);
    if (admin) assertCsrf(req, config, keys!, admin);
    reply.header('set-cookie', [clearCookie(SESSION_COOKIE), clearCookie(OAUTH_TX_COOKIE)]);
    return reply.code(204).send();
  });
}

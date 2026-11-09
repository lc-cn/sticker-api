import type { FastifyRequest } from 'fastify';
import type { AppConfig, MachineTokenConfig, Scope } from '../config.js';
import { ALL_SCOPES } from '../config.js';
import { AppError } from '../errors.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';
import { hmacHex, safeEqual, sha256Hex, verifyPayload, type SessionKeys } from './crypto.js';

export type AdminPrincipal = { kind: 'admin'; githubId: string; login: string; nonce: string; exp: number };
export type MachinePrincipal = { kind: 'machine'; id: string; scopes: Scope[] };
export type Principal = AdminPrincipal | MachinePrincipal;

export type SessionPayload = { v: 1; aud: 'sticker-api-admin'; sub: string; login: string; iat: number; exp: number; nonce: string };

export const SESSION_PURPOSE = 'session.v1';

/** Stable scope string for idempotency / operation ownership (never written to A in clear). */
export const principalScope = (p: Principal) => (p.kind === 'admin' ? `admin:${p.githubId}` : `machine:${p.id}`);

export function principalHasScope(p: Principal, scope: Scope): boolean {
  return p.kind === 'admin' ? (ALL_SCOPES as readonly string[]).includes(scope) : p.scopes.includes(scope);
}

export function csrfTokenFor(keys: SessionKeys, nonce: string): string {
  return hmacHex(keys.csrf, `csrf:${nonce}`);
}

export function findMachine(tokens: MachineTokenConfig[], bearer: string): MachineTokenConfig | null {
  const h = sha256Hex(bearer);
  let found: MachineTokenConfig | null = null;
  for (const t of tokens) if (safeEqual(t.sha256, h)) found = t; // constant work across entries
  return found;
}

/** Valid, unexpired session whose GitHub id is *currently* in the allowlist; otherwise null. */
export function readAdminSession(req: FastifyRequest, config: AppConfig, keys: SessionKeys | null): AdminPrincipal | null {
  if (!keys) return null;
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const s = verifyPayload<SessionPayload>(keys.sign, SESSION_PURPOSE, raw);
  if (!s || s.v !== 1 || s.aud !== 'sticker-api-admin' || typeof s.sub !== 'string' || typeof s.nonce !== 'string') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!(s.exp > now) || s.exp - s.iat > config.sessionTtlSeconds) return null;
  if (!config.adminGithubUserIds.has(s.sub)) return null; // re-checked every request
  return { kind: 'admin', githubId: s.sub, login: s.login, nonce: s.nonce, exp: s.exp };
}

/**
 * Authenticate a write-capable request.
 * - `Authorization: Bearer` → machine token (scoped, hash-only).
 * - otherwise admin cookie session + same-origin `Origin` + `X-CSRF-Token`.
 * 401 = not authenticated, 403 = authenticated but not allowed.
 */
export function requirePrincipal(req: FastifyRequest, config: AppConfig, keys: SessionKeys | null, scope: Scope): Principal {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(auth);
    const machine = m ? findMachine(config.machineTokens, m[1]!) : null;
    if (!machine) throw new AppError(401, 'unauthorized', 'Invalid bearer token');
    if (!machine.scopes.includes(scope)) throw new AppError(403, 'forbidden', `Token lacks scope ${scope}`);
    return { kind: 'machine', id: machine.id, scopes: machine.scopes };
  }
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) throw new AppError(401, 'unauthorized', 'Login required');
  const admin = readAdminSession(req, config, keys);
  if (!admin) {
    // Signed but no longer allow-listed → 403; bad/expired cookie → 401.
    const s = keys ? verifyPayload<SessionPayload>(keys.sign, SESSION_PURPOSE, raw) : null;
    if (s && s.exp > Math.floor(Date.now() / 1000) && !config.adminGithubUserIds.has(String(s.sub))) {
      throw new AppError(403, 'forbidden', 'Not an administrator');
    }
    throw new AppError(401, 'unauthorized', 'Session invalid or expired');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') assertCsrf(req, config, keys!, admin);
  return admin;
}

export function assertCsrf(req: FastifyRequest, config: AppConfig, keys: SessionKeys, admin: AdminPrincipal): void {
  const origin = req.headers.origin;
  if (!origin || origin !== new URL(config.publicBaseUrl).origin) {
    throw new AppError(403, 'csrf_origin', 'Cross-origin or missing Origin for cookie-authenticated write');
  }
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || !safeEqual(token, csrfTokenFor(keys, admin.nonce))) {
    throw new AppError(403, 'csrf_token', 'Missing or invalid X-CSRF-Token');
  }
}

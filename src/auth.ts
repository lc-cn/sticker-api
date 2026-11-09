import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still do a compare to reduce trivial timing branch on length alone for equal-length secrets
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function createAuthHook(expectedToken: string) {
  return async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError(401, 'unauthorized', 'Missing or invalid Authorization bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token || !safeEqualString(token, expectedToken)) {
      throw new AppError(401, 'unauthorized', 'Invalid bearer token');
    }
  };
}

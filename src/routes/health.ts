import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { FileStorage } from '../services/storage.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseSync; storage: FileStorage },
): Promise<void> {
  app.get('/health', async () => ({ ok: true, service: 'sticker-api' }));

  app.get('/ready', async (_req, reply) => {
    try {
      deps.db.prepare('SELECT 1 AS ok').get();
      await deps.storage.ensureReady();
      return { ok: true };
    } catch (err) {
      requestLog(err);
      return reply.code(503).send({ ok: false, error: { code: 'not_ready', message: 'Service not ready' } });
    }
  });
}

function requestLog(err: unknown): void {
  // Keep readiness failures visible in process logs without leaking paths to clients.
  console.error('[ready] check failed', err instanceof Error ? err.message : err);
}

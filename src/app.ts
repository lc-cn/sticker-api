import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type { DatabaseSync } from 'node:sqlite';
import { createAuthHook } from './auth.js';
import type { AppConfig } from './config.js';
import { isAppError } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStickerRoutes } from './routes/stickers.js';
import { FileStorage } from './services/storage.js';
import { StickerService } from './services/stickers.js';

export type AppDeps = {
  config: AppConfig;
  db: DatabaseSync;
};

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: false,
    bodyLimit: deps.config.maxUploadBytes + 1024 * 64,
  });

  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: deps.config.maxUploadBytes,
      fields: 16,
      fieldSize: 16 * 1024,
    },
  });

  const storage = new FileStorage(deps.config.stickersDir);
  await storage.ensureReady();
  const stickers = new StickerService(
    deps.db,
    storage,
    deps.config.maxUploadBytes,
    deps.config.maxImageDimension,
  );

  app.setErrorHandler((err, _request, reply) => {
    if (isAppError(err)) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? undefined },
      });
    }

    // @fastify/multipart file size errors
    const anyErr = err as { code?: string; statusCode?: number; message?: string };
    if (anyErr.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: {
          code: 'payload_too_large',
          message: `File exceeds max size of ${deps.config.maxUploadBytes} bytes`,
        },
      });
    }

    console.error('[error]', anyErr?.message ?? err);
    return reply.code(anyErr.statusCode && anyErr.statusCode >= 400 ? anyErr.statusCode : 500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  await registerHealthRoutes(app, { db: deps.db, storage });

  await app.register(async (scoped) => {
    scoped.addHook('preHandler', createAuthHook(deps.config.token));
    await registerStickerRoutes(scoped, {
      stickers,
      maxUploadBytes: deps.config.maxUploadBytes,
    });
  });

  return { app, stickers, storage };
}

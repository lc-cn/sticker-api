/**
 * Vercel Node.js function adapter. One Fastify instance per warm function instance; no
 * background work, no local persistence — all state lives in the A repo (stateless service).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

let ready: Promise<FastifyInstance> | null = null;

function instance(): Promise<FastifyInstance> {
  if (!ready) {
    const p: Promise<FastifyInstance> = (async () => {
      const config = loadConfig(process.env);
      for (const w of config.warnings) console.warn(`[config] ${w}`);
      const { app } = await buildApp({ config });
      await app.ready();
      return app as unknown as FastifyInstance;
    })();
    p.catch(() => {
      ready = null; // retry config/boot on the next request instead of caching a failure
    });
    ready = p;
  }
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await instance();
  app.server.emit('request', req, res);
}

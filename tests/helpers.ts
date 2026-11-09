import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/client.js';
import type { AppConfig } from '../src/config.js';

export type TestCtx = {
  app: FastifyInstance;
  config: AppConfig;
  dataDir: string;
  token: string;
  close: () => Promise<void>;
};

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestCtx> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-api-'));
  const stickersDir = path.join(dataDir, 'stickers');
  const dbPath = path.join(dataDir, 'stickers.db');
  const token = 'test-token-local-only';
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir,
    stickersDir,
    dbPath,
    maxUploadBytes: 1024 * 1024,
    maxImageDimension: 4096,
    fileCacheTtlSeconds: 60,
    rootDir: process.cwd(),
    ...overrides,
  };
  const db = openDatabase(config.dbPath);
  const { app } = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    config,
    dataDir,
    token,
    close: async () => {
      await app.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

export function buildMultipart(
  file: Buffer,
  filename: string,
  contentType: string,
  fields: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const boundary = '----stickerapitestboundary7MA4YWxkTrZu0gW';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function uploadFile(
  app: FastifyInstance,
  token: string,
  file: Buffer,
  opts: {
    filename?: string;
    contentType?: string;
    fields?: Record<string, string>;
    auth?: boolean;
  } = {},
) {
  const multip = buildMultipart(
    file,
    opts.filename ?? 'sticker.png',
    opts.contentType ?? 'application/octet-stream',
    opts.fields ?? {},
  );
  const headers: Record<string, string> = {
    'content-type': multip.contentType,
  };
  if (opts.auth !== false) Object.assign(headers, authHeaders(token));
  return app.inject({
    method: 'POST',
    url: '/v1/stickers',
    headers,
    payload: multip.payload,
  });
}

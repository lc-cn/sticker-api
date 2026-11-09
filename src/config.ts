import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envString(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid integer env ${name}: ${raw}`);
  }
  return n;
}

function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export type AppConfig = {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  stickersDir: string;
  dbPath: string;
  maxUploadBytes: number;
  maxImageDimension: number;
  fileCacheTtlSeconds: number;
  rootDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // Allow override for advanced setups, but default docs insist on loopback.
    // No hard block — operator may know what they are doing — but warn via comment in README.
  }

  const dataDir = resolveFromCwd(env.DATA_DIR ?? './data');
  const stickersDir = resolveFromCwd(env.STICKERS_DIR ?? path.join(dataDir, 'stickers'));
  const dbPath = resolveFromCwd(env.DB_PATH ?? path.join(dataDir, 'stickers.db'));

  const token = env.STICKER_API_TOKEN;
  if (!token) {
    throw new Error('STICKER_API_TOKEN is required');
  }
  if (token === 'replace-with-a-long-random-secret' && env.ALLOW_INSECURE_TOKEN !== '1') {
    throw new Error('STICKER_API_TOKEN still uses the example placeholder; set a real secret (or ALLOW_INSECURE_TOKEN=1 for local smoke only)');
  }

  return {
    host,
    port: envInt('PORT', 8787),
    token,
    dataDir,
    stickersDir,
    dbPath,
    maxUploadBytes: envInt('MAX_UPLOAD_BYTES', 5 * 1024 * 1024),
    maxImageDimension: envInt('MAX_IMAGE_DIMENSION', 4096),
    fileCacheTtlSeconds: envInt('FILE_CACHE_TTL_SECONDS', 60),
    rootDir,
  };
}

export { rootDir };

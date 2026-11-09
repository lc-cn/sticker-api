import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { app } = await buildApp({ config, db });

  await app.listen({ host: config.host, port: config.port });
  console.log(`sticker-api listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('fatal', err instanceof Error ? err.message : err);
  process.exit(1);
});

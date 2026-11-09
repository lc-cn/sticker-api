/** Local dev server (loopback only). Not used on Vercel. */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
for (const w of config.warnings) console.warn(`[config] ${w}`);
const { app } = await buildApp({ config });
const port = Number(process.env.PORT ?? 8787);
await app.listen({ host: '127.0.0.1', port });
console.log(`sticker-api listening on http://127.0.0.1:${port}`);

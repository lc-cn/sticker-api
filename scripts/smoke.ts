import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { makeAnimatedGifLike, makePng } from '../tests/fixtures.js';

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-api-smoke-'));
  process.env.HOST = '127.0.0.1';
    process.env.STICKER_API_TOKEN = 'smoke-token-local-only';
  process.env.DATA_DIR = dataDir;
  process.env.STICKERS_DIR = path.join(dataDir, 'stickers');
  process.env.DB_PATH = path.join(dataDir, 'stickers.db');
  process.env.ALLOW_INSECURE_TOKEN = '1';

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { app } = await buildApp({ config, db });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const token = config.token;

  try {
    const health = await fetch(`${base}/health`);
    if (!health.ok) throw new Error('health failed');

    const png = makePng();
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(png)], { type: 'image/png' }), 'smoke.png');
    form.append('title', 'smoke-熊猫');
    form.append('tags', 'smoke,测试');
    form.append('emotion', 'neutral');

    const up = await fetch(`${base}/v1/stickers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
    const created = (await up.json()) as any;
    const id = created.sticker.id as string;

    const gif = makeAnimatedGifLike();
    const gform = new FormData();
    gform.append('file', new Blob([Uint8Array.from(gif)], { type: 'image/gif' }), 'smoke.gif');
    gform.append('title', 'smoke-gif');
    const gup = await fetch(`${base}/v1/stickers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: gform,
    });
    if (!gup.ok) throw new Error(`gif upload failed: ${gup.status} ${await gup.text()}`);
    const gid = ((await gup.json()) as any).sticker.id as string;

    const file = await fetch(`${base}/v1/stickers/${gid}/file`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!file.ok) throw new Error('gif download failed');
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.equals(gif)) throw new Error('gif bytes mismatch');

    const del = await fetch(`${base}/v1/stickers/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (del.status !== 204) throw new Error('delete failed');

    console.log(`smoke ok on ${base}`);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('smoke failed', err);
  process.exit(1);
});

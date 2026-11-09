// tsc only emits .mjs/.ts; copy vendored A schemas + fixture data next to the compiled vendor libs.
import fs from 'node:fs';
for (const d of ['schemas', 'fixtures', 'config']) {
  const src = `vendor/sticker-assets/${d}`;
  if (fs.existsSync(src)) fs.cpSync(src, `dist/vendor/sticker-assets/${d}`, { recursive: true });
}

// Copy resvg's wasm into dist/ (real file, not pnpm symlink) for the Vercel function bundle.
import { createRequire } from 'node:module';
fs.mkdirSync('dist/wasm', { recursive: true });
fs.copyFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'), 'dist/wasm/resvg.wasm');

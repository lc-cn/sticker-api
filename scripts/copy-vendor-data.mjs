// tsc only emits .mjs/.ts; copy vendored A schemas + fixture data next to the compiled vendor libs.
import fs from 'node:fs';
for (const d of ['schemas', 'fixtures', 'config']) {
  const src = `vendor/sticker-assets/${d}`;
  if (fs.existsSync(src)) fs.cpSync(src, `dist/vendor/sticker-assets/${d}`, { recursive: true });
}

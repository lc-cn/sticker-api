/** Render worker: one or more SVGs → PNGs with resvg-wasm. One wasm init per job; caller hard-kills on timeout. */
import { parentPort, workerData } from 'node:worker_threads';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

type Job = { wasm: WebAssembly.Module; svgs?: string[]; svg?: string; fonts: Uint8Array[]; defaultFamily: string | undefined };

const job = workerData as Job;
(async () => {
  try {
    await initWasm(job.wasm);
    const svgs = job.svgs ?? (job.svg ? [job.svg] : []);
    const pngs: Uint8Array[] = [];
    for (const svg of svgs) {
      const r = new Resvg(svg, {
        font: { fontBuffers: job.fonts, defaultFontFamily: job.defaultFamily, sansSerifFamily: job.defaultFamily },
        fitTo: { mode: 'original' },
        imageRendering: 0,
      });
      pngs.push(r.render().asPng());
    }
    parentPort!.postMessage({ ok: true, pngs }, pngs.map((p) => p.buffer as ArrayBuffer));
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
})();

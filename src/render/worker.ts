/** Render worker: one SVG → PNG with resvg-wasm. Runs in a worker so the caller can hard-kill it on timeout. */
import { parentPort, workerData } from 'node:worker_threads';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

type Job = { wasm: WebAssembly.Module; svg: string; fonts: Uint8Array[]; defaultFamily: string | undefined };

const job = workerData as Job;
(async () => {
  try {
    await initWasm(job.wasm);
    const r = new Resvg(job.svg, {
      font: { fontBuffers: job.fonts, defaultFontFamily: job.defaultFamily, sansSerifFamily: job.defaultFamily },
      fitTo: { mode: 'original' },
      imageRendering: 0,
    });
    const png = r.render().asPng();
    parentPort!.postMessage({ ok: true, png }, [png.buffer as ArrayBuffer]);
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
})();

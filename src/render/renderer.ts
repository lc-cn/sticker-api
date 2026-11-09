import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AppError } from '../errors.js';
import type { ValidatedImage } from '../domain/image.js';

export type FontSpec = { id: string; family: string; file: string };

/** RENDER_FONTS="default-sans=Noto Sans SC@fonts/NotoSansSC-Regular.otf;other=…" (paths relative to project root). */
export function parseFonts(raw: string | undefined, root: string): FontSpec[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^([a-z0-9][a-z0-9-]{0,47})=([^@]{1,80})@(.+)$/.exec(entry);
      if (!m) throw new Error('RENDER_FONTS entry must be id=Family Name@path');
      const file = path.isAbsolute(m[3]!) ? m[3]! : path.join(root, m[3]!);
      return { id: m[1]!, family: m[2]!.trim(), file };
    });
}

export type LightTemplate = {
  id: string;
  version: number;
  title: string;
  status: string;
  renderer: string;
  inputs: { texts: { min: number; max: number; maxLength: number }; images: { min: number; max: number } };
  params: Array<{ name: string; type: string; default: string | number | boolean; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number }>;
  output: { mime: string; animated: boolean; maxBytes: number };
  canvas: { width: number; height: number; background: string | null };
  layers: Array<
    | { type: 'image'; file: string; box: Box }
    | { type: 'slot-image'; slot: number; box: Box; fit: 'contain' | 'cover' }
    | { type: 'text'; slot: number; box: Box; font: string; fontSize: number; minFontSize: number; color: string; stroke: { color: string; width: number } | null; align: 'left' | 'center' | 'right'; valign: 'top' | 'middle' | 'bottom'; wrap: boolean }
  >;
  files: Array<{ path: string; sha256: string; bytes: number; mime: string; role: string }>;
  fonts: Array<{ id: string; licenseId: string; providedBy: string }>;
  licenseIds: string[];
  notice: string;
};
type Box = { x: number; y: number; w: number; h: number };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const dataUri = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

/** Conservative advance estimate (em): CJK/fullwidth 1.0, ASCII ~0.6, space 0.33. */
function charEm(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c === 0x20) return 0.33;
  if (c < 0x80) return 0.62;
  if ((c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || c >= 0x1f000) return 1.0;
  return 0.8;
}

export function layoutText(text: string, box: Box, size0: number, minSize: number, wrap: boolean): { size: number; lines: string[] } {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  for (let size = size0; size >= minSize; size -= 1) {
    const maxW = box.w;
    const lines: string[] = [];
    let cur = '';
    let w = 0;
    for (const ch of chars) {
      const cw = charEm(ch) * size;
      if (wrap && w + cw > maxW && cur) {
        lines.push(cur.trimEnd());
        cur = ch === ' ' ? '' : ch;
        w = ch === ' ' ? 0 : cw;
      } else {
        cur += ch;
        w += cw;
      }
    }
    if (cur) lines.push(cur);
    const widest = Math.max(0, ...lines.map((l) => [...l].reduce((s, c) => s + charEm(c) * size, 0)));
    if (lines.length * size * 1.2 <= box.h && widest <= maxW) return { size, lines };
  }
  // Still too long at minFontSize: truncate with an ellipsis to the lines that fit.
  const size = minSize;
  const perLine = Math.max(1, Math.floor(box.w / (size * 1.0)));
  const maxLines = Math.max(1, Math.floor(box.h / (size * 1.2)));
  const lines: string[] = [];
  for (let i = 0; i < maxLines && i * perLine < chars.length; i++) lines.push(chars.slice(i * perLine, (i + 1) * perLine).join(''));
  if (maxLines * perLine < chars.length) lines[lines.length - 1] = [...lines[lines.length - 1]!].slice(0, -1).join('') + '…';
  return { size, lines: wrap ? lines : [lines[0]!] };
}

export function composeSvg(t: LightTemplate, assets: Map<string, Buffer>, texts: string[], images: ValidatedImage[], fonts: Map<string, FontSpec>): string {
  const { width: W, height: H, background } = t.canvas;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  if (background) out.push(`<rect width="${W}" height="${H}" fill="${background}"/>`);
  t.layers.forEach((l, i) => {
    const b = l.box;
    if (l.type === 'image') {
      const f = t.files.find((x) => x.path === l.file)!;
      out.push(`<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="none" href="${dataUri(f.mime, assets.get(l.file)!)}"/>`);
    } else if (l.type === 'slot-image') {
      const img = images[l.slot];
      if (!img) return;
      out.push(`<clipPath id="c${i}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/></clipPath>`);
      out.push(`<image clip-path="url(#c${i})" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid ${l.fit === 'cover' ? 'slice' : 'meet'}" href="${dataUri(img.mime, img.bytes)}"/>`);
    } else {
      const txt = texts[l.slot];
      if (!txt) return;
      const font = fonts.get(l.font)!;
      const { size, lines } = layoutText(txt, b, l.fontSize, l.minFontSize, l.wrap);
      const lh = size * 1.2;
      const blockH = lines.length * lh;
      const top = l.valign === 'top' ? b.y : l.valign === 'bottom' ? b.y + b.h - blockH : b.y + (b.h - blockH) / 2;
      const x = l.align === 'left' ? b.x : l.align === 'right' ? b.x + b.w : b.x + b.w / 2;
      const anchor = l.align === 'left' ? 'start' : l.align === 'right' ? 'end' : 'middle';
      const stroke = l.stroke ? ` stroke="${l.stroke.color}" stroke-width="${l.stroke.width * 2}" stroke-linejoin="round" paint-order="stroke"` : '';
      lines.forEach((line, k) => {
        const y = (top + k * lh + size * 0.92).toFixed(1);
        out.push(`<text x="${x}" y="${y}" font-family="${esc(font.family)}" font-size="${size}" fill="${l.color}" text-anchor="${anchor}"${stroke}>${esc(line)}</text>`);
      });
    }
  });
  out.push('</svg>');
  return out.join('');
}

export class Renderer {
  private wasm: Promise<WebAssembly.Module> | null = null;
  private fontBytes = new Map<string, Uint8Array>();
  readonly fonts: Map<string, FontSpec>;

  constructor(fonts: FontSpec[], private readonly timeoutMs: number) {
    this.fonts = new Map(fonts.map((f) => [f.id, f]));
  }

  hasFont(id: string) {
    return this.fonts.has(id) && fs.existsSync(this.fonts.get(id)!.file);
  }

  private module(): Promise<WebAssembly.Module> {
    if (!this.wasm) {
      // Prefer the copy emitted by `pnpm build` (dist/wasm/) so Vercel never has to bundle pnpm's symlinked node_modules.
      const bundled = fileURLToPath(new URL('../../wasm/resvg.wasm', import.meta.url));
      const file = fs.existsSync(bundled)
        ? bundled
        : createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
      this.wasm = WebAssembly.compile(fs.readFileSync(file));
    }
    return this.wasm;
  }

  private font(id: string): Uint8Array {
    let b = this.fontBytes.get(id);
    if (!b) {
      b = new Uint8Array(fs.readFileSync(this.fonts.get(id)!.file));
      this.fontBytes.set(id, b);
    }
    return b;
  }

  /** Render in a short-lived worker; terminate on the hard deadline (plan §8: 10 s). */
  async render(svg: string, fontIds: string[]): Promise<Buffer> {
    const wasm = await this.module();
    const fonts = [...new Set(fontIds)].map((id) => this.font(id));
    const defaultFamily = fontIds[0] ? this.fonts.get(fontIds[0])!.family : undefined;
    const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
    return new Promise((resolve, reject) => {
      const w = new Worker(workerFile, { workerData: { wasm, svg, fonts, defaultFamily }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const timer = setTimeout(() => {
        void w.terminate();
        reject(new AppError(503, 'render_timeout', 'Render exceeded the hard time limit', { retryable: false }));
      }, this.timeoutMs);
      w.once('message', (m: { ok: boolean; png?: Uint8Array; error?: string }) => {
        clearTimeout(timer);
        void w.terminate();
        if (m.ok && m.png) resolve(Buffer.from(m.png));
        else reject(new AppError(422, 'render_failed', 'Template could not be rendered'));
      });
      w.once('error', () => {
        clearTimeout(timer);
        reject(new AppError(503, 'render_failed', 'Renderer crashed', { retryable: false }));
      });
    });
  }
}

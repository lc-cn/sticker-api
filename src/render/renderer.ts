import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AppError } from '../errors.js';
import type { ValidatedImage } from '../domain/image.js';
import { circleClip, decodeRaster, encodePngRgba, fitRgba, flipRgba, squareCrop, type RgbaImage } from './pixels.js';
import { warpToLocalQuad, type Quad as WarpQuad } from './warp.js';
import { encodeGif } from './gif.js';

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

export type Box = { x: number; y: number; w: number; h: number };
export type Quad = [[number, number], [number, number], [number, number], [number, number]];
export type When = { param: string; in: Array<string | number | boolean> };
export type Flip = 'horizontal' | 'vertical' | 'both';
export type Keyframe = { box?: Box; rotate?: number; quad?: Quad; visible?: boolean } | null;
export type LayerCommon = {
  frame?: number;
  flip?: Flip;
  when?: When;
  xFrom?: 'left' | 'right';
  yFrom?: 'top' | 'bottom';
  fill?: boolean;
};
export type ImageLayer = LayerCommon & { type: 'image'; file: string; box: Box };
export type ImageSequenceLayer = LayerCommon & { type: 'image-sequence'; files: string[]; box: Box };
export type SlotImageLayer = LayerCommon & {
  type: 'slot-image';
  slot: number;
  box: Box;
  fit: 'contain' | 'cover';
  rotate?: number;
  clip?: 'rect' | 'circle';
  quad?: Quad;
  keyframes?: Keyframe[];
};
export type TextLayer = LayerCommon & {
  type: 'text';
  slot: number;
  box: Box;
  font: string;
  fontSize: number;
  minFontSize: number;
  color: string;
  stroke: { color: string; width: number } | null;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  rotate?: number;
};
export type Layer = ImageLayer | ImageSequenceLayer | SlotImageLayer | TextLayer;
export type CanvasFit = {
  slot: number;
  mode: 'contain' | 'cover' | 'width' | 'height';
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
};
export type LightTemplate = {
  id: string;
  version: number;
  title: string;
  description?: string;
  status: string;
  renderer: string;
  inputs: { texts: { min: number; max: number; maxLength: number }; images: { min: number; max: number } };
  params: Array<{ name: string; type: string; default: string | number | boolean; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number }>;
  output: { mime: string; animated: boolean; maxBytes: number };
  canvas: { width: number; height: number; background: string | null; fit?: CanvasFit };
  animation?: { frameCount: number; frameDurationMs: number; loop?: number };
  layers: Layer[];
  files: Array<{ path: string; sha256: string; bytes: number; mime: string; role: string }>;
  fonts: Array<{ id: string; licenseId: string; providedBy: string }>;
  licenseIds: string[];
  notice: string;
};

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

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function resolveCanvas(t: LightTemplate, images: ValidatedImage[]): { width: number; height: number } {
  const fit = t.canvas.fit;
  if (!fit) return { width: t.canvas.width, height: t.canvas.height };
  const img = images[fit.slot];
  const tw = fit.width ?? t.canvas.width;
  const th = fit.height ?? t.canvas.height;
  if (!img) return { width: tw, height: th };
  if (fit.mode === 'cover' || fit.mode === 'contain') {
    // pil-utils resize(keep_ratio) then resize_canvas: result is exactly the target size.
    return { width: tw, height: th };
  }
  let w: number;
  let h: number;
  if (fit.mode === 'width') {
    w = tw;
    h = Math.max(1, Math.round(img.height * (w / img.width)));
  } else {
    h = th;
    w = Math.max(1, Math.round(img.width * (h / img.height)));
  }
  const minW = fit.minWidth ?? 1;
  const maxW = fit.maxWidth ?? 2048;
  const minH = fit.minHeight ?? 1;
  const maxH = fit.maxHeight ?? 2048;
  if (w > maxW) {
    h = Math.max(1, Math.round((h * maxW) / w));
    w = maxW;
  } else if (w < minW) {
    h = Math.max(1, Math.round((h * minW) / w));
    w = minW;
  }
  if (h > maxH) {
    w = Math.max(1, Math.round((w * maxH) / h));
    h = maxH;
  } else if (h < minH) {
    w = Math.max(1, Math.round((w * minH) / h));
    h = minH;
  }
  return { width: clamp(w, 1, 2048), height: clamp(h, 1, 2048) };
}

export function resolvedParams(t: LightTemplate, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of t.params) out[p.name] = input[p.name] !== undefined ? input[p.name] : p.default;
  return out;
}

function layerVisible(l: Layer, frame: number | undefined, params: Record<string, unknown>): boolean {
  if (l.when) {
    const v = params[l.when.param];
    if (!l.when.in.some((x) => x === v)) return false;
  }
  if (typeof l.frame === 'number' && frame !== undefined && l.frame !== frame) return false;
  if (l.type === 'slot-image' && l.keyframes && frame !== undefined) {
    const kf = l.keyframes[frame];
    if (kf === undefined || kf === null || kf.visible === false) return false;
  }
  return true;
}

function placedBox(box: Box, canvas: { width: number; height: number }, l: LayerCommon): Box {
  if (l.fill) return { x: 0, y: 0, w: canvas.width, h: canvas.height };
  let x = box.x;
  let y = box.y;
  if (l.xFrom === 'right') x = canvas.width - box.w - box.x;
  if (l.yFrom === 'bottom') y = canvas.height - box.h - box.y;
  return { x, y, w: box.w, h: box.h };
}

function flipTransform(flip: Flip | undefined, x: number, y: number, w: number, h: number): string {
  if (!flip) return '';
  const cx = x + w / 2;
  const cy = y + h / 2;
  const sx = flip === 'vertical' ? 1 : -1;
  const sy = flip === 'horizontal' ? 1 : -1;
  return ` transform="translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})"`;
}

export type ComposeOpts = {
  frame?: number;
  params?: Record<string, unknown>;
  canvas?: { width: number; height: number };
  /** Pre-rendered slot images (after warp/circle) keyed by `${slot}@${frame ?? 'all'}`. */
  slotHref?: Map<string, { mime: string; bytes: Buffer; x: number; y: number; w: number; h: number }>;
};

export function composeSvg(
  t: LightTemplate,
  assets: Map<string, Buffer>,
  texts: string[],
  images: ValidatedImage[],
  fonts: Map<string, FontSpec>,
  opts: ComposeOpts = {},
): string {
  const canvas = opts.canvas ?? resolveCanvas(t, images);
  const { width: W, height: H } = canvas;
  const background = t.canvas.background;
  const params = opts.params ?? resolvedParams(t, {});
  const frame = opts.frame;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  if (background) out.push(`<rect width="${W}" height="${H}" fill="${background}"/>`);
  t.layers.forEach((l, i) => {
    if (!layerVisible(l, frame, params)) return;
    if (l.type === 'image' || l.type === 'image-sequence') {
      const file = l.type === 'image-sequence' ? l.files[frame ?? 0] : l.file;
      if (!file) return;
      const buf = assets.get(file);
      if (!buf) return;
      const f = t.files.find((x) => x.path === file);
      const b = placedBox(l.box, canvas, l);
      const flip = flipTransform(l.flip, b.x, b.y, b.w, b.h);
      out.push(`<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="none" href="${dataUri(f?.mime ?? 'image/png', buf)}"${flip}/>`);
      return;
    }
    if (l.type === 'slot-image') {
      const img = images[l.slot];
      if (!img) return;
      const kf = typeof frame === 'number' && l.keyframes ? l.keyframes[frame] : undefined;
      const box = (kf && kf.box) || l.box;
      const rotate = (kf && typeof kf.rotate === 'number' ? kf.rotate : l.rotate) ?? 0;
      const pre = opts.slotHref?.get(`${l.slot}@${frame ?? 'all'}`) ?? opts.slotHref?.get(`${l.slot}@all`);
      if (pre) {
        const flip = flipTransform(l.flip, pre.x, pre.y, pre.w, pre.h);
        const rot = rotate !== 0 ? ` transform="rotate(${rotate} ${pre.x + pre.w / 2} ${pre.y + pre.h / 2})"` : flip;
        out.push(`<image x="${pre.x}" y="${pre.y}" width="${pre.w}" height="${pre.h}" preserveAspectRatio="none" href="${dataUri(pre.mime, pre.bytes)}"${rot}/>`);
        return;
      }
      const b = placedBox(box, canvas, l);
      const clip = l.clip === 'circle'
        ? `<circle cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" r="${Math.min(b.w, b.h) / 2}"/>`
        : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
      out.push(`<clipPath id="c${i}">${clip}</clipPath>`);
      const flip = flipTransform(l.flip, b.x, b.y, b.w, b.h);
      const rot = rotate !== 0 ? ` transform="rotate(${rotate} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : flip;
      out.push(`<g${rot}><image clip-path="url(#c${i})" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid ${l.fit === 'cover' ? 'slice' : 'meet'}" href="${dataUri(img.mime, img.bytes)}"/></g>`);
      return;
    }
    const txt = texts[l.slot];
    if (!txt) return;
    const font = fonts.get(l.font);
    if (!font) return;
    const b = placedBox(l.box, canvas, l);
    const { size, lines } = layoutText(txt, b, l.fontSize, l.minFontSize, l.wrap);
    const lh = size * 1.2;
    const blockH = lines.length * lh;
    const top = l.valign === 'top' ? b.y : l.valign === 'bottom' ? b.y + b.h - blockH : b.y + (b.h - blockH) / 2;
    const x = l.align === 'left' ? b.x : l.align === 'right' ? b.x + b.w : b.x + b.w / 2;
    const anchor = l.align === 'left' ? 'start' : l.align === 'right' ? 'end' : 'middle';
    const stroke = l.stroke ? ` stroke="${l.stroke.color}" stroke-width="${l.stroke.width * 2}" stroke-linejoin="round" paint-order="stroke"` : '';
    const rot = typeof l.rotate === 'number' && l.rotate !== 0 ? ` transform="rotate(${l.rotate} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : '';
    out.push(`<g${rot}>`);
    lines.forEach((line, k) => {
      const y = (top + k * lh + size * 0.92).toFixed(1);
      out.push(`<text x="${x}" y="${y}" font-family="${esc(font.family)}" font-size="${size}" fill="${l.color}" text-anchor="${anchor}"${stroke}>${esc(line)}</text>`);
    });
    out.push('</g>');
  });
  out.push('</svg>');
  return out.join('');
}

function tryDecode(img: ValidatedImage): RgbaImage | null {
  try {
    return decodeRaster(img.mime, img.bytes);
  } catch {
    return null;
  }
}

/** Pre-warp / circle-crop slot images that need pixel operations (perspective quads). */
export function prepareSlotHrefs(t: LightTemplate, images: ValidatedImage[], canvas: { width: number; height: number }, params: Record<string, unknown>): Map<string, { mime: string; bytes: Buffer; x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { mime: string; bytes: Buffer; x: number; y: number; w: number; h: number }>();
  const frames = t.animation?.frameCount;
  for (const l of t.layers) {
    if (l.type !== 'slot-image' || (!l.quad && !l.keyframes?.some((k) => k && k.quad))) continue;
    const srcImg = images[l.slot];
    if (!srcImg) continue;
    const decoded = tryDecode(srcImg);
    if (!decoded) continue;
    const apply = (frame: number | undefined, box: Box, quad: Quad | undefined, clip: SlotImageLayer['clip']) => {
      if (!quad) return;
      let src = decoded;
      if (clip === 'circle') src = circleClip(fitRgba(squareCrop(src), box.w, box.h, l.fit));
      else src = fitRgba(src, box.w, box.h, l.fit);
      if (l.flip) src = flipRgba(src, l.flip);
      const { image, x, y } = warpToLocalQuad(src, quad as WarpQuad, box.x, box.y);
      const bytes = encodePngRgba(image);
      const key = `${l.slot}@${frame ?? 'all'}`;
      out.set(key, { mime: 'image/png', bytes, x, y, w: image.width, h: image.height });
    };
    if (frames && l.keyframes) {
      for (let i = 0; i < frames; i++) {
        if (!layerVisible(l, i, params)) continue;
        const kf = l.keyframes[i];
        const box = placedBox((kf && kf.box) || l.box, canvas, l);
        apply(i, box, (kf && kf.quad) || l.quad, l.clip);
      }
    } else if (l.quad) {
      apply(undefined, placedBox(l.box, canvas, l), l.quad, l.clip);
    }
  }
  return out;
}

export function composeFrames(
  t: LightTemplate,
  assets: Map<string, Buffer>,
  texts: string[],
  images: ValidatedImage[],
  fonts: Map<string, FontSpec>,
  params: Record<string, unknown> = {},
): { svgs: string[]; canvas: { width: number; height: number }; fontIds: string[] } {
  const canvas = resolveCanvas(t, images);
  const p = resolvedParams(t, params);
  const slotHref = prepareSlotHrefs(t, images, canvas, p);
  const fontIds = [...new Set(t.layers.filter((l): l is TextLayer => l.type === 'text' && !!texts[l.slot]).map((l) => l.font))];
  const n = t.animation?.frameCount ?? 1;
  const svgs: string[] = [];
  for (let i = 0; i < n; i++) {
    svgs.push(composeSvg(t, assets, texts, images, fonts, { frame: t.animation ? i : undefined, params: p, canvas, slotHref }));
  }
  return { svgs, canvas, fontIds };
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

  /** Render one or more SVGs in a short-lived worker (one wasm init). Hard deadline: timeoutMs. */
  async renderSvgs(svgs: string[], fontIds: string[]): Promise<Buffer[]> {
    if (!svgs.length) throw new AppError(422, 'render_failed', 'Template could not be rendered');
    const wasm = await this.module();
    const fonts = [...new Set(fontIds)].map((id) => this.font(id));
    const defaultFamily = fontIds[0] ? this.fonts.get(fontIds[0])!.family : undefined;
    const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
    return new Promise((resolve, reject) => {
      const w = new Worker(workerFile, { workerData: { wasm, svgs, fonts, defaultFamily }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      const timer = setTimeout(() => {
        void w.terminate();
        reject(new AppError(503, 'render_timeout', 'Render exceeded the hard time limit', { retryable: false }));
      }, this.timeoutMs);
      w.once('message', (m: { ok: boolean; pngs?: Uint8Array[]; error?: string }) => {
        clearTimeout(timer);
        void w.terminate();
        if (m.ok && m.pngs?.length === svgs.length) resolve(m.pngs.map((p) => Buffer.from(p)));
        else reject(new AppError(422, 'render_failed', 'Template could not be rendered'));
      });
      w.once('error', () => {
        clearTimeout(timer);
        reject(new AppError(503, 'render_failed', 'Renderer crashed', { retryable: false }));
      });
    });
  }

  async render(svg: string, fontIds: string[]): Promise<Buffer> {
    const [png] = await this.renderSvgs([svg], fontIds);
    return png!;
  }

  async renderTemplate(
    t: LightTemplate,
    assets: Map<string, Buffer>,
    texts: string[],
    images: ValidatedImage[],
    params: Record<string, unknown> = {},
  ): Promise<{ bytes: Buffer; mime: 'image/png' | 'image/gif' }> {
    const { svgs, fontIds } = composeFrames(t, assets, texts, images, this.fonts, params);
    const pngs = await this.renderSvgs(svgs, fontIds);
    if (t.animation || t.output.mime === 'image/gif' || t.output.animated) {
      const delay = t.animation?.frameDurationMs ?? 70;
      const loop = t.animation?.loop ?? 0;
      const bytes = encodeGif(pngs, delay, Math.min(t.output.maxBytes, 2 * 1024 * 1024), loop);
      return { bytes, mime: 'image/gif' };
    }
    return { bytes: pngs[0]!, mime: 'image/png' };
  }
}

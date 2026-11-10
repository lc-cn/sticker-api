import { createRequire } from 'node:module';
import { decode as decodePng } from 'fast-png';

const require = createRequire(import.meta.url);
const gifenc = require('gifenc') as {
  GIFEncoder: (opts?: { initialCapacity?: number }) => {
    writeFrame: (index: Uint8Array, width: number, height: number, opts: Record<string, unknown>) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  };
  quantize: (rgba: Uint8Array, maxColors: number, opts?: Record<string, unknown>) => number[][];
  applyPalette: (rgba: Uint8Array, palette: number[][], format?: string) => Uint8Array;
};
const { GIFEncoder, quantize, applyPalette } = gifenc;

const GIF_MAX_ATTEMPTS = 6;

function toRgba(width: number, height: number, data: Uint8Array | Uint8ClampedArray, channels: number): Uint8Array {
  if (channels === 4) return data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(width * height * 4);
  if (channels === 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      out[j] = data[i]!;
      out[j + 1] = data[i + 1]!;
      out[j + 2] = data[i + 2]!;
      out[j + 3] = 255;
    }
    return out;
  }
  throw new Error(`GIF encode expected RGB/RGBA PNG frames, got ${channels} channels`);
}

function scaleRgba(data: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.round((y + 0.5) * h / nh - 0.5));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.round((x + 0.5) * w / nw - 0.5));
      const si = (sy * w + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = data[si]!;
      out[di + 1] = data[si + 1]!;
      out[di + 2] = data[si + 2]!;
      out[di + 3] = data[si + 3]!;
    }
  }
  return out;
}

function hasAlpha(data: Uint8Array): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 128) return true;
  return false;
}

function encodeOnce(frames: { data: Uint8Array; width: number; height: number }[], delayMs: number, loop: number): Buffer {
  const gif = GIFEncoder();
  const format = frames.some((f) => hasAlpha(f.data)) ? 'rgba4444' : 'rgb565';
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const palette = quantize(f.data, 256, { format, oneBitAlpha: format === 'rgba4444', clearAlpha: true, clearAlphaThreshold: 127 });
    let transparentIndex = -1;
    if (format === 'rgba4444') {
      transparentIndex = palette.findIndex((c) => (c[3] ?? 255) < 128);
      if (transparentIndex < 0) {
        if (palette.length < 256) {
          palette.push([0, 0, 0, 0]);
          transparentIndex = palette.length - 1;
        } else {
          transparentIndex = 0;
        }
      }
    }
    const index = applyPalette(f.data, palette, format);
    gif.writeFrame(index, f.width, f.height, {
      palette,
      delay: delayMs,
      repeat: i === 0 ? loop : undefined,
      dispose: 2,
      transparent: transparentIndex >= 0,
      transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Encode PNG (from resvg) frames as a looping GIF. If the result exceeds `maxBytes`,
 * shrink spatial size (and eventually drop frames) like meme-generator.save_gif.
 */
export function encodeGif(pngFrames: Buffer[], delayMs: number, maxBytes: number, loop = 0): Buffer {
  if (!pngFrames.length) throw new Error('no frames');
  let decoded = pngFrames.map((b) => {
    const d = decodePng(b);
    return { width: d.width, height: d.height, data: toRgba(d.width, d.height, Uint8Array.from(d.data as ArrayLike<number>), d.channels) };
  });
  let delay = Math.max(20, delayMs);
  for (let attempt = 0; attempt < GIF_MAX_ATTEMPTS; attempt++) {
    const buf = encodeOnce(decoded, delay, loop);
    if (buf.length <= maxBytes) return buf;
    if (decoded.length > 8 && attempt >= 2) {
      const keep = Math.max(8, Math.ceil(decoded.length * 0.75));
      const ratio = decoded.length / keep;
      decoded = Array.from({ length: keep }, (_, i) => decoded[Math.min(decoded.length - 1, Math.floor(i * ratio))]!);
      delay = Math.round(delay * ratio);
      continue;
    }
    const w = Math.max(16, Math.round(decoded[0]!.width * 0.9));
    const h = Math.max(16, Math.round(decoded[0]!.height * 0.9));
    decoded = decoded.map((f) => ({ width: w, height: h, data: scaleRgba(f.data, f.width, f.height, w, h) }));
  }
  const last = encodeOnce(decoded, delay, loop);
  if (last.length > maxBytes) throw new Error('gif_too_large');
  return last;
}

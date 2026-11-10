import { decode as decodePng, encode as encodePng } from 'fast-png';
import { decode as decodeJpeg } from 'jpeg-js';

export type RgbaImage = { width: number; height: number; data: Uint8Array };

function toRgba(width: number, height: number, data: Uint8Array | Uint8ClampedArray, channels: number): RgbaImage {
  if (channels === 4) return { width, height, data: data instanceof Uint8Array && !(data instanceof Uint8ClampedArray) ? data : new Uint8Array(data) };
  const out = new Uint8Array(width * height * 4);
  if (channels === 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      out[j] = data[i]!;
      out[j + 1] = data[i + 1]!;
      out[j + 2] = data[i + 2]!;
      out[j + 3] = 255;
    }
  } else if (channels === 1) {
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      const v = data[i]!;
      out[j] = v;
      out[j + 1] = v;
      out[j + 2] = v;
      out[j + 3] = 255;
    }
  } else if (channels === 2) {
    for (let i = 0, j = 0; i < data.length; i += 2, j += 4) {
      const v = data[i]!;
      out[j] = v;
      out[j + 1] = v;
      out[j + 2] = v;
      out[j + 3] = data[i + 1]!;
    }
  } else {
    throw new Error(`unsupported channel count ${channels}`);
  }
  return { width, height, data: out };
}

export function decodeRaster(mime: string, bytes: Buffer | Uint8Array): RgbaImage {
  if (mime === 'image/png') {
    const d = decodePng(bytes);
    return toRgba(d.width, d.height, Uint8Array.from(d.data as ArrayLike<number>), d.channels);
  }
  if (mime === 'image/jpeg') {
    const d = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: d.width, height: d.height, data: d.data instanceof Uint8Array ? new Uint8Array(d.data) : new Uint8Array(d.data) };
  }
  // GIF / others: cannot cheaply decode here; callers should rasterize via resvg or skip warp.
  throw new Error(`cannot decode ${mime} to pixels`);
}

export function encodePngRgba(img: RgbaImage): Buffer {
  const out = encodePng({ width: img.width, height: img.height, data: img.data, channels: 4, depth: 8 });
  return Buffer.from(out);
}

export function sampleBilinear(src: RgbaImage, x: number, y: number, out: Uint8Array, oi: number): void {
  const { width: w, height: h, data } = src;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) {
    out[oi] = out[oi + 1] = out[oi + 2] = out[oi + 3] = 0;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const a = data[i00 + c]! * (1 - tx) + data[i10 + c]! * tx;
    const b = data[i01 + c]! * (1 - tx) + data[i11 + c]! * tx;
    out[oi + c] = Math.round(a * (1 - ty) + b * ty);
  }
}

/** Cover or contain-fit `src` into `dw x dh`. Contain pads with transparent pixels. */
export function fitRgba(src: RgbaImage, dw: number, dh: number, mode: 'cover' | 'contain'): RgbaImage {
  const sw = src.width;
  const sh = src.height;
  const scale = mode === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const rw = sw * scale;
  const rh = sh * scale;
  const ox = (dw - rw) / 2;
  const oy = (dh - rh) / 2;
  const data = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      sampleBilinear(src, (x - ox) / scale, (y - oy) / scale, data, (y * dw + x) * 4);
    }
  }
  return { width: dw, height: dh, data };
}

export function squareCrop(src: RgbaImage): RgbaImage {
  const side = Math.min(src.width, src.height);
  const x0 = Math.floor((src.width - side) / 2);
  const y0 = Math.floor((src.height - side) / 2);
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    data.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + side) * 4), y * side * 4);
  }
  return { width: side, height: side, data };
}

export function circleClip(src: RgbaImage): RgbaImage {
  const { width: w, height: h, data: srcData } = src;
  const data = new Uint8Array(srcData);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r = Math.min(w, h) / 2;
  const r2 = r * r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) data[(y * w + x) * 4 + 3] = 0;
    }
  }
  return { width: w, height: h, data };
}

export function flipRgba(src: RgbaImage, mode: 'horizontal' | 'vertical' | 'both'): RgbaImage {
  const { width: w, height: h, data: s } = src;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = mode === 'horizontal' ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const sx = mode === 'vertical' ? x : w - 1 - x;
      const si = (sy * w + sx) * 4;
      const di = (y * w + x) * 4;
      data[di] = s[si]!;
      data[di + 1] = s[si + 1]!;
      data[di + 2] = s[si + 2]!;
      data[di + 3] = s[si + 3]!;
    }
  }
  return { width: w, height: h, data };
}

import { inflateSync } from 'node:zlib';
import { AppError } from '../errors.js';

/**
 * Structural validation + privacy metadata stripping for PNG / JPEG / GIF.
 * Contract v1: only png|jpg|gif are publishable; WebP/APNG/SVG are rejected.
 * The returned `bytes` are the publish bytes; their SHA-256 is the asset id.
 */
export type ImageLimits = {
  maxBytes: number;
  maxLongEdge: number;
  maxCanvasPixels: number;
  maxFrames: number;
  maxTotalFramePixels: number;
  maxAnimationMs: number;
};

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxLongEdge: 2048,
  maxCanvasPixels: 4_000_000,
  maxFrames: 60,
  maxTotalFramePixels: 24_000_000,
  maxAnimationMs: 60_000,
};

export type Mime = 'image/png' | 'image/jpeg' | 'image/gif';
export type ValidatedImage = {
  bytes: Buffer;
  mime: Mime;
  ext: 'png' | 'jpg' | 'gif';
  width: number;
  height: number;
  frames: number;
  animated: boolean;
  /** true when privacy metadata was removed (publish bytes differ from input). */
  stripped: boolean;
};

const invalid = (msg: string, code = 'invalid_image') => new AppError(400, code, msg);

function checkCanvas(w: number, h: number, frames: number, l: ImageLimits): void {
  if (!(w > 0 && h > 0)) throw invalid('Image dimensions are invalid');
  if (Math.max(w, h) > l.maxLongEdge) throw new AppError(400, 'image_too_large', `Long edge exceeds ${l.maxLongEdge}px`, { details: { width: w, height: h } });
  if (w * h > l.maxCanvasPixels) throw new AppError(400, 'image_too_large', `Canvas exceeds ${l.maxCanvasPixels} pixels`);
  if (frames > l.maxFrames) throw new AppError(400, 'too_many_frames', `More than ${l.maxFrames} frames`);
  // Count full canvas per frame: partial GIF frames still composite onto the whole canvas.
  if (frames * w * h > l.maxTotalFramePixels) throw new AppError(400, 'animation_too_large', 'frames × canvas exceeds budget');
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_STRIP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
const PNG_APNG = new Set(['acTL', 'fcTL', 'fdAT']);

function pngExpectedRawBytes(w: number, h: number, bitDepth: number, colorType: number, interlace: number): number {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const validDepth: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!channels || !validDepth[colorType]!.includes(bitDepth)) throw invalid('Unsupported PNG color type/bit depth');
  const bpp = channels * bitDepth;
  const row = (pw: number) => Math.ceil((pw * bpp) / 8) + 1;
  if (interlace === 0) return h * row(w);
  if (interlace !== 1) throw invalid('Invalid PNG interlace method');
  const passes = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ] as const;
  let total = 0;
  for (const [xs, ys, xst, yst] of passes) {
    const pw = Math.ceil((w - xs) / xst);
    const ph = Math.ceil((h - ys) / yst);
    if (pw > 0 && ph > 0) total += ph * row(pw);
  }
  return total;
}

function validatePng(buf: Buffer, l: ImageLimits): ValidatedImage {
  let off = 8;
  const kept: Buffer[] = [PNG_SIG];
  const idat: Buffer[] = [];
  let ihdr: Buffer | null = null;
  let sawEnd = false;
  let stripped = false;
  let first = true;
  while (off < buf.length) {
    if (off + 12 > buf.length) throw invalid('Truncated PNG chunk');
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (len > 0x7fffffff || off + 12 + len > buf.length) throw invalid('Truncated PNG chunk');
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid('Invalid PNG chunk type');
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw invalid('PNG CRC mismatch');
    const whole = buf.subarray(off, off + 12 + len);
    off += 12 + len;
    if (first && type !== 'IHDR') throw invalid('PNG must start with IHDR');
    first = false;
    if (PNG_APNG.has(type)) throw new AppError(415, 'unsupported_type', 'APNG is not accepted in v1');
    if (type === 'IHDR') {
      if (len !== 13 || ihdr) throw invalid('Invalid IHDR');
      ihdr = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      kept.push(whole);
      sawEnd = true;
      break;
    }
    if (PNG_STRIP.has(type)) {
      stripped = true;
      continue;
    }
    if (type !== 'IEND') kept.push(whole);
  }
  if (!ihdr || !sawEnd || idat.length === 0) throw invalid('PNG missing IHDR/IDAT/IEND');
  if (off !== buf.length) stripped = true; // trailing bytes after IEND are dropped
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  checkCanvas(w, h, 1, l);
  const expected = pngExpectedRawBytes(w, h, ihdr[8]!, ihdr[9]!, ihdr[12]!);
  if (ihdr[10] !== 0 || ihdr[11] !== 0) throw invalid('Invalid PNG compression/filter method');
  let raw: Buffer;
  try {
    // Bounded inflate: a decompression bomb aborts at expected+1 bytes.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    throw invalid('PNG image data does not decode within budget');
  }
  if (raw.length !== expected) throw invalid('PNG image data size mismatch');
  return { bytes: stripped ? Buffer.concat(kept) : buf, mime: 'image/png', ext: 'png', width: w, height: h, frames: 1, animated: false, stripped };
}

// ---------- JPEG ----------
function validateJpeg(buf: Buffer, l: ImageLimits): ValidatedImage {
  let off = 2;
  const kept: Buffer[] = [buf.subarray(0, 2)];
  let stripped = false;
  let size: { w: number; h: number } | null = null;
  for (;;) {
    if (off + 4 > buf.length) throw invalid('Truncated JPEG');
    if (buf[off] !== 0xff) throw invalid('Invalid JPEG marker');
    const marker = buf[off + 1]!;
    if (marker === 0xff) {
      off += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) throw invalid('Unexpected JPEG marker before scan');
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) throw invalid('Truncated JPEG segment');
    const seg = buf.subarray(off, off + 2 + len);
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8) throw invalid('Invalid JPEG SOF');
      size = { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    if (marker === 0xda) {
      if (!size) throw invalid('JPEG scan before frame header');
      // Entropy-coded data + any further scans until EOI; must end with EOI.
      const rest = buf.subarray(off);
      let end = rest.length;
      while (end > 2 && rest[end - 1] === 0x00) end--; // tolerate zero padding
      if (rest[end - 2] !== 0xff || rest[end - 1] !== 0xd9) throw invalid('JPEG missing EOI');
      if (end !== rest.length) stripped = true;
      kept.push(rest.subarray(0, end));
      break;
    }
    // APP1 (Exif/XMP), APP13 (IPTC/Photoshop), COM carry privacy-sensitive metadata.
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      stripped = true;
    } else {
      kept.push(seg);
    }
    off += 2 + len;
  }
  checkCanvas(size.w, size.h, 1, l);
  return { bytes: stripped ? Buffer.concat(kept) : buf, mime: 'image/jpeg', ext: 'jpg', width: size.w, height: size.h, frames: 1, animated: false, stripped };
}

// ---------- GIF ----------
function validateGif(buf: Buffer, l: ImageLimits): ValidatedImage {
  if (buf.length < 14) throw invalid('Truncated GIF');
  const w = buf.readUInt16LE(6);
  const h = buf.readUInt16LE(8);
  checkCanvas(w, h, 1, l);
  const packed = buf[10]!;
  let off = 13;
  if (packed & 0x80) off += 3 * (1 << ((packed & 0x07) + 1));
  if (off > buf.length) throw invalid('Truncated GIF color table');
  const kept: Buffer[] = [buf.subarray(0, off)];
  let frames = 0;
  let totalDelayCs = 0;
  let pendingDelay = 0;
  let stripped = false;
  let sawTrailer = false;
  const readSubBlocks = (start: number): number => {
    let p = start;
    for (;;) {
      if (p >= buf.length) throw invalid('Truncated GIF data');
      const n = buf[p]!;
      p += 1;
      if (n === 0) return p;
      p += n;
    }
  };
  while (off < buf.length) {
    const intro = buf[off]!;
    if (intro === 0x3b) {
      kept.push(buf.subarray(off, off + 1));
      sawTrailer = true;
      off += 1;
      break;
    }
    if (intro === 0x21) {
      if (off + 2 > buf.length) throw invalid('Truncated GIF extension');
      const label = buf[off + 1]!;
      const end = readSubBlocks(off + 2);
      const block = buf.subarray(off, end);
      if (label === 0xf9) {
        if (buf[off + 2] !== 4) throw invalid('Invalid GIF graphic control extension');
        pendingDelay = buf.readUInt16LE(off + 4);
        kept.push(block);
      } else if (label === 0xfe) {
        stripped = true; // comment extension: may hold arbitrary text
      } else if (label === 0xff) {
        const appId = buf.toString('latin1', off + 3, off + 3 + Math.min(11, buf[off + 2] ?? 0));
        if (appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0') kept.push(block);
        else stripped = true; // XMP and other application data
      } else {
        kept.push(block);
      }
      off = end;
      continue;
    }
    if (intro === 0x2c) {
      if (off + 10 > buf.length) throw invalid('Truncated GIF image descriptor');
      const fx = buf.readUInt16LE(off + 1);
      const fy = buf.readUInt16LE(off + 3);
      const fw = buf.readUInt16LE(off + 5);
      const fh = buf.readUInt16LE(off + 7);
      const fp = buf[off + 9]!;
      if (fw === 0 || fh === 0 || fx + fw > w || fy + fh > h) throw invalid('GIF frame outside logical screen');
      let p = off + 10;
      if (fp & 0x80) p += 3 * (1 << ((fp & 0x07) + 1));
      if (p >= buf.length) throw invalid('Truncated GIF frame');
      const minCode = buf[p]!;
      if (minCode < 1 || minCode > 11) throw invalid('Invalid GIF LZW code size');
      const end = readSubBlocks(p + 1);
      kept.push(buf.subarray(off, end));
      frames += 1;
      totalDelayCs += pendingDelay;
      pendingDelay = 0;
      if (frames > l.maxFrames) throw new AppError(400, 'too_many_frames', `More than ${l.maxFrames} frames`);
      off = end;
      continue;
    }
    throw invalid('Invalid GIF block');
  }
  if (!sawTrailer || frames === 0) throw invalid('GIF missing frames or trailer');
  if (off !== buf.length) stripped = true;
  checkCanvas(w, h, frames, l);
  if (totalDelayCs * 10 > l.maxAnimationMs) throw new AppError(400, 'animation_too_long', 'Animation duration exceeds budget');
  return { bytes: stripped ? Buffer.concat(kept) : buf, mime: 'image/gif', ext: 'gif', width: w, height: h, frames, animated: frames > 1, stripped };
}

export function validateImage(input: Buffer, limits: ImageLimits = DEFAULT_IMAGE_LIMITS): ValidatedImage {
  if (!input || input.length < 14) throw invalid('File is too small or empty to be a supported image');
  if (input.length > limits.maxBytes) throw new AppError(413, 'payload_too_large', `Image exceeds ${limits.maxBytes} bytes`);
  const head = input.subarray(0, 256).toString('utf8').toLowerCase();
  if (head.includes('<svg') || head.includes('<!doctype') || head.includes('<html') || head.includes('<?xml')) {
    throw new AppError(415, 'unsupported_type', 'SVG/HTML/XML uploads are not allowed');
  }
  let out: ValidatedImage;
  if (input.subarray(0, 8).equals(PNG_SIG)) out = validatePng(input, limits);
  else if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) out = validateJpeg(input, limits);
  else if (/^GIF8[79]a$/.test(input.toString('latin1', 0, 6))) out = validateGif(input, limits);
  else throw new AppError(415, 'unsupported_type', 'Only PNG, JPEG and GIF are accepted (contract v1)');
  if (out.bytes.length > limits.maxBytes) throw new AppError(413, 'payload_too_large', `Image exceeds ${limits.maxBytes} bytes`);
  return out;
}

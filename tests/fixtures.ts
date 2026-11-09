import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Minimal valid 1x1 PNG (opaque red-ish). */
export function makePng(width = 1, height = 1): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.alloc((1 + width * 3) * height, 0);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  const idat = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Minimal 1x1 GIF87a/89a. */
export function makeGif(): Buffer {
  // GIF89a 1x1 single black pixel
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x01, 0x00, 0x01, 0x00, // 1x1
    0x00, 0x00, 0x00, // global color table flag off
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // graphic control
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
    0x02, 0x02, 0x44, 0x01, 0x00, // image data
    0x3b, // trailer
  ]);
}

/** Tiny animated-looking GIF bytes (still valid GIF89a; fidelity test compares exact bytes). */
export function makeAnimatedGifLike(): Buffer {
  // Two-frame-ish GIF with Netscape loop extension; kept tiny.
  return Buffer.from(
    '47494638396101000100F00000FFFFFF00000021FF0B4E45545343415045320201000021F90409000000002C000000000100010000020144010021F90409000000002C00000000010001000002014401003B',
    'hex',
  );
}

export function makeJpeg(): Buffer {
  // Minimal 1x1 JPEG
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z',
    'base64',
  );
}

export function makeWebp(): Buffer {
  // VP8X 1x1 canvas white-ish minimal RIFF/WEBP
  const riff = Buffer.alloc(30);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(22, 4);
  riff.write('WEBP', 8);
  riff.write('VP8X', 12);
  riff.writeUInt32LE(10, 16);
  riff[20] = 0x00; // flags
  riff.writeUInt32LE(0, 21); // reserved-ish / canvas
  // width-1 and height-1 as 24-bit little endian starting at 24
  riff[24] = 0x00;
  riff[25] = 0x00;
  riff[26] = 0x00; // width-1 = 0 => 1
  riff[27] = 0x00;
  riff[28] = 0x00;
  riff[29] = 0x00; // height-1 = 0 => 1
  return riff;
}

export function makeSvgDisguise(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', 'utf8');
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

import { AppError } from '../errors.js';

export type DetectedImage = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: 'png' | 'jpg' | 'gif' | 'webp';
  width: number | null;
  height: number | null;
};

function readUInt32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readUInt24LE(buf: Buffer, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16);
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  return { width: readUInt32BE(buf, 16), height: readUInt32BE(buf, 20) };
}

function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  return { width: readUInt16LE(buf, 6), height: readUInt16LE(buf, 8) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buf.length) return null;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X' && buf.length >= 30) {
    const width = 1 + readUInt24LE(buf, 24);
    const height = 1 + readUInt24LE(buf, 27);
    return { width, height };
  }
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    // Lossy bitstream start code check optional; dimensions at fixed offsets in frame header
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}

export function detectImage(buffer: Buffer, maxDimension: number): DetectedImage {
  if (!buffer || buffer.length < 12) {
    throw new AppError(400, 'invalid_image', 'File is too small or empty to be a supported image');
  }

  // Reject obvious text/html/svg disguises early
  const head = buffer.subarray(0, Math.min(256, buffer.length)).toString('utf8').toLowerCase();
  if (
    head.includes('<svg') ||
    head.includes('<!doctype html') ||
    head.includes('<html') ||
    head.includes('<?xml')
  ) {
    throw new AppError(400, 'unsupported_type', 'SVG/HTML/XML uploads are not allowed');
  }

  let detected: DetectedImage | null = null;

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    const size = pngSize(buffer);
    detected = { mimeType: 'image/png', extension: 'png', width: size?.width ?? null, height: size?.height ?? null };
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const size = jpegSize(buffer);
    detected = { mimeType: 'image/jpeg', extension: 'jpg', width: size?.width ?? null, height: size?.height ?? null };
  } else if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x39 || buffer[4] === 0x37) &&
    buffer[5] === 0x61
  ) {
    const size = gifSize(buffer);
    detected = { mimeType: 'image/gif', extension: 'gif', width: size?.width ?? null, height: size?.height ?? null };
  } else if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const size = webpSize(buffer);
    detected = { mimeType: 'image/webp', extension: 'webp', width: size?.width ?? null, height: size?.height ?? null };
  }

  if (!detected) {
    throw new AppError(400, 'unsupported_type', 'Only PNG, JPEG, GIF, and WebP images are allowed');
  }

  if (detected.width !== null && detected.height !== null) {
    if (detected.width <= 0 || detected.height <= 0) {
      throw new AppError(400, 'invalid_image', 'Image dimensions are invalid');
    }
    if (detected.width > maxDimension || detected.height > maxDimension) {
      throw new AppError(
        400,
        'image_too_large',
        `Image dimension exceeds limit of ${maxDimension}px`,
        { width: detected.width, height: detected.height },
      );
    }
  }

  return detected;
}

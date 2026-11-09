// 发布字节检查（零依赖，只解析容器结构，不解码像素）：
// mime/尺寸/帧数/动画、元数据块（EXIF/XMP/文本）与 v1 不支持格式（APNG 等）。
import { crc32 } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export function inspectImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return inspectPng(buf);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return inspectJpeg(buf);
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return inspectGif(buf);
  return { mime: null, problems: ['不支持或无法识别的格式（v1 仅 PNG/JPEG/GIF；拒绝 SVG/WebP/HTML 等）'], metadata: [] };
}

function inspectPng(buf) {
  const r = { mime: 'image/png', width: 0, height: 0, frames: 1, animated: false, metadata: [], problems: [] };
  let off = 8, sawIhdr = false, sawEnd = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (off + 12 + len > buf.length) { r.problems.push(`PNG 块 ${type} 越界`); return r; }
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if ((crc32(buf.subarray(off + 4, off + 8 + len)) >>> 0) !== crc) r.problems.push(`PNG 块 ${type} CRC 错误`);
    if (!sawIhdr && type !== 'IHDR') r.problems.push('PNG 首块不是 IHDR');
    if (type === 'IHDR') { sawIhdr = true; r.width = data.readUInt32BE(0); r.height = data.readUInt32BE(4); }
    if (type === 'acTL') r.problems.push('APNG 动画 v1 未验收，拒绝');
    if (['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) r.metadata.push(`png:${type}`);
    off += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) r.problems.push('PNG 缺少 IEND');
  if (off !== buf.length) r.problems.push('PNG IEND 之后有多余字节');
  return r;
}

function inspectJpeg(buf) {
  const r = { mime: 'image/jpeg', width: 0, height: 0, frames: 1, animated: false, metadata: [], problems: [] };
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) { r.problems.push('JPEG 段标记错误'); return r; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { off += marker === 0xff ? 1 : 2; continue; }
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(off + 2);
    if (off + 2 + len > buf.length) { r.problems.push('JPEG 段越界'); return r; }
    const seg = buf.subarray(off + 4, off + 2 + len);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      r.height = seg.readUInt16BE(1); r.width = seg.readUInt16BE(3);
    }
    if (marker === 0xe1) {
      const head = seg.subarray(0, 40).toString('latin1');
      if (head.startsWith('Exif\0')) r.metadata.push('jpeg:exif');
      else if (head.startsWith('http://ns.adobe.com/xap')) r.metadata.push('jpeg:xmp');
      else r.metadata.push('jpeg:app1');
    }
    if (marker === 0xed) r.metadata.push('jpeg:iptc');
    if (marker === 0xfe) r.metadata.push('jpeg:comment');
    if (marker === 0xda) { // SOS：之后是熵编码数据，检查以 EOI 结尾
      if (!(buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)) r.problems.push('JPEG 未以 EOI 结尾');
      break;
    }
    off += 2 + len;
  }
  if (!r.width || !r.height) r.problems.push('JPEG 缺少 SOF 尺寸');
  return r;
}

function skipSubBlocks(buf, off) {
  while (off < buf.length) {
    const n = buf[off];
    off += 1;
    if (n === 0) return off;
    off += n;
  }
  return -1;
}

function inspectGif(buf) {
  const r = { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames: 0, animated: false, metadata: [], problems: [] };
  const packed = buf[10];
  let off = 13;
  if (packed & 0x80) off += 3 * (1 << ((packed & 7) + 1));
  let sawTrailer = false;
  while (off < buf.length) {
    const b = buf[off];
    if (b === 0x3b) { sawTrailer = true; off += 1; break; }
    if (b === 0x21) {
      const label = buf[off + 1];
      if (label === 0xfe) r.metadata.push('gif:comment');
      if (label === 0xff) {
        const app = buf.subarray(off + 3, off + 14).toString('latin1');
        if (app.startsWith('XMP Data')) r.metadata.push('gif:xmp');
      }
      off = skipSubBlocks(buf, off + 2);
      if (off < 0) { r.problems.push('GIF 扩展块越界'); return r; }
      continue;
    }
    if (b === 0x2c) {
      if (off + 10 > buf.length) { r.problems.push('GIF 图像描述符越界'); return r; }
      const x = buf.readUInt16LE(off + 1), y = buf.readUInt16LE(off + 3);
      const w = buf.readUInt16LE(off + 5), h = buf.readUInt16LE(off + 7);
      if (x + w > r.width || y + h > r.height) r.problems.push('GIF 帧超出逻辑画布');
      const lp = buf[off + 9];
      off += 10;
      if (lp & 0x80) off += 3 * (1 << ((lp & 7) + 1));
      off += 1; // LZW 最小码长
      off = skipSubBlocks(buf, off);
      if (off < 0) { r.problems.push('GIF 图像数据越界'); return r; }
      r.frames++;
      continue;
    }
    r.problems.push(`GIF 未知块 0x${b.toString(16)}`);
    return r;
  }
  if (!sawTrailer) r.problems.push('GIF 缺少结尾 0x3B');
  if (off !== buf.length) r.problems.push('GIF 结尾之后有多余字节');
  if (r.frames === 0) r.problems.push('GIF 没有图像帧');
  r.animated = r.frames > 1;
  return r;
}

/** 按 limits 检查解码预算（以逻辑画布计，不按局部小帧面积相加） */
export function budgetProblems(info, limits) {
  const p = [];
  const { width: w, height: h, frames } = info;
  if (Math.max(w, h) > limits.maxLongEdge) p.push(`长边 ${Math.max(w, h)} > ${limits.maxLongEdge}`);
  if (w * h > limits.maxCanvasPixels) p.push(`画布 ${w * h} 像素 > ${limits.maxCanvasPixels}`);
  if (frames > limits.maxFrames) p.push(`帧数 ${frames} > ${limits.maxFrames}`);
  if (w * h * frames > limits.maxTotalFramePixels) p.push(`累计合成像素 ${w * h * frames} > ${limits.maxTotalFramePixels}`);
  return p;
}

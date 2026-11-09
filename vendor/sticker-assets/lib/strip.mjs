// 无损结构级元数据剥离（不重新编码像素）：PNG 去 eXIf/tEXt/iTXt/zTXt/tIME；
// JPEG 去 APP1(EXIF/XMP)/APP13(IPTC)/COM；GIF 去注释扩展与 XMP 应用扩展，保留 NETSCAPE 循环与全部帧。
// 返回新 Buffer；无法安全解析时抛错（调用方应拒绝该图，而不是放行）。
import { inspectImage } from './image.mjs';

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

export function stripMetadata(buf) {
  const info = inspectImage(buf);
  if (!info.mime || info.problems.length) throw new Error(`无法安全剥离：${info.problems.join('; ') || '未知格式'}`);
  let out;
  if (info.mime === 'image/png') out = stripPng(buf);
  else if (info.mime === 'image/jpeg') out = stripJpeg(buf);
  else out = stripGif(buf);
  const after = inspectImage(out);
  if (after.problems.length || after.metadata.length || after.frames !== info.frames || after.width !== info.width || after.height !== info.height) {
    throw new Error('剥离后结构校验失败（帧数/尺寸改变或仍有元数据），拒绝');
  }
  return out;
}

function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const end = off + 12 + len;
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(off, end));
    off = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

function stripJpeg(buf) {
  const parts = [buf.subarray(0, 2)];
  let off = 2;
  while (off < buf.length) {
    const marker = buf[off + 1];
    if (marker === 0xda) { parts.push(buf.subarray(off)); break; }
    const len = buf.readUInt16BE(off + 2);
    const end = off + 2 + len;
    if (!(marker === 0xe1 || marker === 0xed || marker === 0xfe)) parts.push(buf.subarray(off, end));
    off = end;
  }
  return Buffer.concat(parts);
}

function skip(buf, off) { while (buf[off] !== 0) off += buf[off] + 1; return off + 1; }

function stripGif(buf) {
  const packed = buf[10];
  let off = 13;
  if (packed & 0x80) off += 3 * (1 << ((packed & 7) + 1));
  const parts = [buf.subarray(0, off)];
  while (off < buf.length) {
    const b = buf[off];
    if (b === 0x3b) { parts.push(buf.subarray(off, off + 1)); break; }
    if (b === 0x21) {
      const label = buf[off + 1];
      const end = skip(buf, off + 2);
      const app = label === 0xff ? buf.subarray(off + 3, off + 14).toString('latin1') : '';
      const drop = label === 0xfe || (label === 0xff && app.startsWith('XMP Data'));
      if (!drop) parts.push(buf.subarray(off, end));
      off = end;
      continue;
    }
    // 0x2c 图像描述符
    const lp = buf[off + 9];
    let end = off + 10;
    if (lp & 0x80) end += 3 * (1 << ((lp & 7) + 1));
    end = skip(buf, end + 1);
    parts.push(buf.subarray(off, end));
    off = end;
  }
  return Buffer.concat(parts);
}

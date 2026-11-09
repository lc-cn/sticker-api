// 规范 JSON 格式：人工可读文件 pretty，索引 compact。
export const pretty = (v) => JSON.stringify(v, null, 2) + '\n';
export const compact = (v) => JSON.stringify(v) + '\n';

/** 按 UTF-16 码元比较（与 Array.prototype.sort 默认一致），保证跨实现稳定 */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort(cmp)) out[k] = obj[k];
  return out;
}

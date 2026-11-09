// 时间工具：存储一律 UTC Z；按 Asia/Manila 自然日做每日预算。
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });

/** UTC 时间串 → Asia/Manila 日期 YYYY-MM-DD */
export function manilaDate(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间: ${utc}`);
  return fmt.format(d);
}

export const toMillis = (utc) => (utc ? Date.parse(utc) : 0);

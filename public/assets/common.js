// Shared helpers. All API text is inserted with textContent / attributes — never innerHTML.

/** el('div', {class: 'x', onclick: fn}, 'text', child) */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** Only http(s) URLs from the API are used as image/link targets. */
export function safeUrl(u) {
  try {
    const x = new URL(u, location.origin);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts });
  } catch {
    throw new ApiError(0, 'network', '网络连接失败，请稍后再试');
  }
  if (res.ok) {
    const ct = res.headers.get('content-type') || '';
    if (res.status === 204) return null;
    if (ct.includes('application/json')) return res.json();
    return res.blob();
  }
  let code = 'http_' + res.status;
  let message = `请求失败（${res.status}）`;
  try {
    const j = await res.json();
    if (j?.error) {
      code = String(j.error.code || code);
      message = String(j.error.message || message);
    }
  } catch {}
  throw new ApiError(res.status, code, message, Number(res.headers.get('retry-after')) || null);
}

/** Try each source URL in order; on error fall back to the next one. */
export function imgFromSources(sources, alt = '', { lazy = true, cls } = {}) {
  const urls = (sources || []).map((s) => safeUrl(typeof s === 'string' ? s : s.url)).filter(Boolean);
  const img = el('img', { alt, class: cls, decoding: 'async', loading: lazy ? 'lazy' : 'eager', referrerpolicy: 'no-referrer' });
  let i = 0;
  img.addEventListener('error', () => {
    i += 1;
    if (i < urls.length) img.src = urls[i];
    else img.parentElement?.classList.add('broken');
  });
  if (urls.length) img.src = urls[0];
  return img;
}

const fmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${fmt.format(d)}（北京时间）`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

let toastTimer;
export function toast(msg) {
  let t = $('.toast');
  if (!t) {
    t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

export async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    toast('已复制到剪贴板');
  } catch {
    window.prompt('复制下面的链接：', s);
  }
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Fetch a remote image (CORS-enabled mirror) to save it with a filename; fall back to opening it. */
export async function downloadFromSources(sources, filename) {
  for (const s of sources || []) {
    const u = safeUrl(s.url || s);
    if (!u) continue;
    try {
      const r = await fetch(u, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (r.ok) return saveBlob(await r.blob(), filename);
    } catch {}
  }
  const first = safeUrl(sources?.[0]?.url || sources?.[0]);
  if (first) window.open(first, '_blank', 'noopener');
}

export async function copyImageBlob(blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    toast('图片已复制');
  } catch {
    toast('当前浏览器不支持复制图片，请使用下载');
  }
}

export function extFor(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] || 'png';
}

/** Random Idempotency-Key: 32 chars of [A-Za-z0-9_-]. */
export function idemKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function errorText(e) {
  if (e instanceof ApiError) {
    if (e.status === 429) return `操作太频繁了，请 ${e.retryAfter ? e.retryAfter + ' 秒' : '稍等一会儿'}后再试。`;
    if (e.status === 0) return e.message;
    const map = {
      renders_disabled: '在线制图暂时关闭了，请稍后再来。',
      template_not_found: '这个模板不存在或已下线。',
      template_unavailable: '这个模板暂时不能生成。',
      text_too_long: '文字太长了，请缩短一些。',
      invalid_texts: '请把文字填完整。',
      invalid_images: '图片数量不对，请按要求上传。',
      payload_too_large: '图片太大了，请换一张小一点的。',
      unsupported_media_type: '不支持这种图片格式，请使用 PNG / JPG / GIF / WebP。',
      unauthorized: '在线制图暂未对访客开放。',
      state_unverifiable: '服务暂时无法连接素材仓库，请稍后再试。',
    };
    return map[e.code] || `${e.message}（${e.code}）`;
  }
  return String(e?.message || e);
}

import {
  $, el, api, ApiError, imgFromSources, fmtTime, fmtBytes, copyText, saveBlob,
  downloadFromSources, copyImageBlob, extFor, errorText, safeUrl,
} from './common.js';

// ---------------------------------------------------------------- stickers
const state = { q: '', category: '', cursor: null, loading: false, labels: new Map(), total: 0 };
const grid = $('#grid');
const moreBtn = $('#more');

async function loadCategories() {
  const box = $('#categories');
  const chip = (slug, label, count) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.category === slug), dataset: { slug } },
      label, count ? el('span', { class: 'count' }, count) : null);
    b.addEventListener('click', () => {
      state.category = slug;
      for (const c of box.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c.dataset.slug === slug));
      search(true);
    });
    return b;
  };
  try {
    const { categories } = await api('/v1/categories');
    box.replaceChildren(chip('', '全部'), ...categories.map((c) => {
      state.labels.set(c.slug, c.label);
      return chip(c.slug, c.label, c.count);
    }));
  } catch {
    box.replaceChildren(chip('', '全部'));
  }
}

function card(item) {
  const thumb = el('div', { class: 'thumb' }, imgFromSources(item.sources, item.title));
  const b = el('button', { type: 'button', class: 'card', title: item.title }, thumb,
    el('div', { class: 'meta' }, item.title || '未命名', item.animated ? el('span', { class: 'badge' }, ' · 动图') : null));
  b.addEventListener('click', () => openDetail(item));
  return b;
}

async function search(reset) {
  if (state.loading) return;
  state.loading = true;
  moreBtn.disabled = true;
  $('#grid-error').classList.add('hidden');
  if (reset) state.cursor = null;
  const p = new URLSearchParams({ limit: '30' });
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.cursor) p.set('cursor', state.cursor);
  try {
    const r = await api(`/v1/assets?${p}`);
    if (reset) grid.replaceChildren();
    grid.append(...r.items.map(card));
    state.cursor = r.nextCursor;
    state.total = r.total;
    moreBtn.classList.toggle('hidden', !r.nextCursor);
    const none = grid.children.length === 0;
    $('#empty').classList.toggle('hidden', !none);
    $('#empty-text').textContent = state.q
      ? `没有找到和「${state.q}」相关的表情。`
      : '表情还在路上，这个分类暂时空空的。';
    $('#result-count').textContent = none ? '' : `共 ${r.total}${r.truncated ? '+' : ''} 张`;
  } catch (e) {
    const box = $('#grid-error');
    box.textContent = `加载失败：${errorText(e)}`;
    box.classList.remove('hidden');
  } finally {
    state.loading = false;
    moreBtn.disabled = false;
  }
}

$('#search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  state.q = $('#q').value.trim().slice(0, 64);
  search(true);
});
moreBtn.addEventListener('click', () => search(false));

// detail dialog
const dlg = $('#detail');
let current = null;
function openDetail(item) {
  current = item;
  $('#detail-title').textContent = item.title || '未命名';
  $('#detail-img').replaceChildren(imgFromSources(item.sources, item.title, { lazy: false }));
  $('#detail-cats').replaceChildren(...(item.categories || []).map((c) => el('span', { class: 'tag' }, state.labels.get(c) || c)));
  const tags = item.tags || [];
  $('#detail-tags').replaceChildren(...(tags.length ? tags.map((t) => el('span', { class: 'tag' }, t)) : ['—']));
  $('#detail-time').textContent = fmtTime(item.uploadedAt);
  $('#detail-size').textContent = `${item.width ?? '?'}×${item.height ?? '?'} · ${fmtBytes(item.bytes)} · ${String(item.mime || '').replace('image/', '').toUpperCase()}`;
  const first = safeUrl(item.sources?.[0]?.url);
  const open = $('#detail-open');
  if (first) open.setAttribute('href', first); else open.removeAttribute('href');
  dlg.showModal();
}
$('#detail-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
$('#detail-copy').addEventListener('click', () => {
  const u = safeUrl(current?.sources?.[0]?.url);
  if (u) copyText(u);
});
$('#detail-dl').addEventListener('click', () => {
  if (!current) return;
  downloadFromSources(current.sources, `${(current.title || 'sticker').slice(0, 40)}.${extFor(current.mime)}`);
});

// ---------------------------------------------------------------- maker
const MAX_PICK = 2 * 1024 * 1024; // what the visitor may pick
const SERVER_MAX = 1024 * 1024; // what the server accepts per image (bigger picks are re-encoded here)
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let templates = [];
let selected = null;
let resultBlob = null;
let publicRenders = true;

async function loadTemplates() {
  const box = $('#templates');
  try {
    const [t, h] = await Promise.all([api('/v1/templates'), api('/v1/health').catch(() => null)]);
    publicRenders = !h || h.publicRenders !== false;
    templates = t.templates.filter((x) => x.renderable);
    if (!templates.length) {
      box.replaceChildren(el('div', { class: 'empty' }, '暂时没有可用的模板。'));
      return;
    }
    box.replaceChildren(...templates.map((tpl) => {
      const kind = tpl.inputs.images.max > 0 ? `放 ${tpl.inputs.images.max} 张图` : `${tpl.inputs.texts.max} 段文字`;
      const b = el('button', { type: 'button', class: 'tpl', 'aria-pressed': 'false', title: tpl.title, dataset: { id: tpl.id } },
        el('div', { class: 'thumb' }, imgFromSources(tpl.preview, tpl.title)),
        el('div', { class: 'name' }, tpl.title),
        el('div', { class: 'kind' }, kind));
      b.addEventListener('click', () => pick(tpl));
      return b;
    }));
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
    const pre = templates.find((x) => x.id === fromHash);
    if (pre) pick(pre, false);
  } catch (e) {
    const err = $('#tpl-error');
    err.textContent = `模板加载失败：${errorText(e)}`;
    err.classList.remove('hidden');
  }
}

function msg(kind, text) {
  const m = $('#maker-msg');
  m.className = `alert ${kind}`;
  m.textContent = text;
  m.classList.toggle('hidden', !text);
}

function pick(tpl, scroll = true) {
  selected = tpl;
  for (const b of $('#templates').querySelectorAll('.tpl')) b.setAttribute('aria-pressed', String(b.dataset.id === tpl.id));
  $('#maker-empty').classList.add('hidden');
  $('#maker-form').classList.remove('hidden');
  $('#result').classList.add('hidden');
  $('#tpl-title').textContent = tpl.title;
  const parts = [];
  if (tpl.inputs.texts.max) parts.push(`${tpl.inputs.texts.max} 段文字，每段最多 ${tpl.inputs.texts.maxLength} 字`);
  if (tpl.inputs.images.max) parts.push(`${tpl.inputs.images.max} 张图片（PNG/JPG/GIF/WebP，单张 ≤2MB）`);
  $('#tpl-desc').textContent = `需要：${parts.join('，') || '无输入'}`;
  $('#tpl-notice').textContent = tpl.notice || '';
  const fields = [];
  for (let i = 0; i < tpl.inputs.texts.max; i++) {
    const id = `txt-${i}`;
    fields.push(el('div', { class: 'field' },
      el('label', { for: id }, tpl.inputs.texts.max > 1 ? `第 ${i + 1} 段文字` : '文字'),
      el('input', { id, type: 'text', name: id, maxlength: tpl.inputs.texts.maxLength, required: i < tpl.inputs.texts.min, placeholder: i === 0 ? '在这里输入要写的内容' : '' })));
  }
  for (let i = 0; i < tpl.inputs.images.max; i++) {
    const id = `img-${i}`;
    fields.push(el('div', { class: 'field' },
      el('label', { for: id }, tpl.inputs.images.max > 1 ? `第 ${i + 1} 张图片` : '图片'),
      el('input', { id, type: 'file', name: id, accept: TYPES.join(','), required: i < tpl.inputs.images.min }),
      el('span', { class: 'hint' }, '只在生成时发送给服务器，不会保存。')));
  }
  $('#tpl-fields').replaceChildren(...fields);
  msg('info', publicRenders ? '' : '在线制图暂未对访客开放，生成可能会失败。');
  history.replaceState(null, '', `#t=${encodeURIComponent(tpl.id)}`);
  if (scroll && window.matchMedia('(max-width: 760px)').matches) $('#maker-panel').scrollIntoView({ behavior: 'smooth' });
}

/** Re-encode big images in the browser so they fit the server's 1MB-per-image limit. */
async function fitImage(file) {
  if (file.size <= SERVER_MAX) return file;
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    if (blob && blob.size <= SERVER_MAX) return new File([blob], 'image.jpg', { type: 'image/jpeg' });
    scale *= 0.75;
  }
  throw new Error('图片压缩后仍然太大，请换一张小一点的图片。');
}

$('#maker-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!selected) return;
  const tpl = selected;
  const texts = [];
  for (let i = 0; i < tpl.inputs.texts.max; i++) {
    const v = $(`#txt-${i}`).value.trim();
    if (!v && i < tpl.inputs.texts.min) return msg('error', tpl.inputs.texts.max > 1 ? `请填写第 ${i + 1} 段文字。` : '请先填写文字。');
    if ([...v].length > tpl.inputs.texts.maxLength) return msg('error', `第 ${i + 1} 段文字超过 ${tpl.inputs.texts.maxLength} 字了。`);
    texts.push(v);
  }
  while (texts.length > tpl.inputs.texts.min && texts[texts.length - 1] === '') texts.pop();
  const files = [];
  for (let i = 0; i < tpl.inputs.images.max; i++) {
    const f = $(`#img-${i}`).files?.[0];
    if (!f) {
      if (i < tpl.inputs.images.min) return msg('error', tpl.inputs.images.max > 1 ? `请选择第 ${i + 1} 张图片。` : '请先选择一张图片。');
      continue;
    }
    if (!TYPES.includes(f.type)) return msg('error', '只支持 PNG / JPG / GIF / WebP 图片。');
    if (f.size > MAX_PICK) return msg('error', `图片「${f.name}」超过 2MB 了，请换一张小一点的。`);
    files.push(f);
  }
  const btn = $('#gen');
  btn.disabled = true;
  btn.textContent = '生成中…';
  msg('info', '正在生成，通常需要几秒钟…');
  try {
    const body = { template: tpl.id, version: tpl.version, texts };
    let init;
    if (files.length) {
      const fd = new FormData();
      fd.append('request', JSON.stringify(body));
      for (const f of files) fd.append('image', await fitImage(f));
      init = { method: 'POST', body: fd };
    } else {
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }
    // credentials omitted: homepage renders are always anonymous, even for a logged-in admin.
    const blob = await api('/v1/renders', { ...init, credentials: 'omit' });
    if (!(blob instanceof Blob)) throw new Error('服务器返回的不是图片');
    resultBlob = blob;
    const img = $('#result-img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
    $('#result').classList.remove('hidden');
    msg('ok', '生成好啦！可以下载或复制。');
  } catch (e) {
    msg('error', e instanceof ApiError ? errorText(e) : String(e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '生成梗图';
  }
});
$('#result-dl').addEventListener('click', () => resultBlob && saveBlob(resultBlob, `${selected?.id || 'meme'}.png`));
$('#result-copy').addEventListener('click', () => resultBlob && copyImageBlob(resultBlob));

loadCategories();
search(true);
loadTemplates();

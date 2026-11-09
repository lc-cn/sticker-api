import {
  $, el, api, ApiError, imgFromUrl, fmtTime, fmtBytes, copyText, saveBlob,
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
  const thumb = el('div', { class: 'thumb' }, imgFromUrl(item.url, item.title));
  const b = el('button', { type: 'button', class: 'card', title: item.title }, thumb,
    el('div', { class: 'meta' }, item.title || '未命名', item.anim ? el('span', { class: 'badge' }, ' · 动图') : null));
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
    state.cursor = r.next || null;
    state.total = r.n ?? 0;
    moreBtn.classList.toggle('hidden', !r.next);
    const none = grid.children.length === 0;
    $('#empty').classList.toggle('hidden', !none);
    $('#empty-text').textContent = state.q
      ? `没有找到和「${state.q}」相关的表情。`
      : '表情还在路上，这个分类暂时空空的。';
    $('#result-count').textContent = none ? '' : `共 ${r.n}${r.trunc || r.next ? '+' : ''} 张`;
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
  $('#detail-img').replaceChildren(imgFromUrl(item.url, item.title, { lazy: false }));
  $('#detail-cats').replaceChildren(...(item.cats || item.categories || []).map((c) => el('span', { class: 'tag' }, state.labels.get(c) || c)));
  const tags = item.tags || [];
  $('#detail-tags').replaceChildren(...(tags.length ? tags.map((t) => el('span', { class: 'tag' }, t)) : ['—']));
  $('#detail-time').textContent = fmtTime(item.uploadedAt);
  $('#detail-size').textContent = `${item.w ?? item.width ?? '?'}×${item.h ?? item.height ?? '?'} · ${fmtBytes(item.bytes)} · ${String(item.mime || '').replace('image/', '').toUpperCase()}`;
  const short = item.url ? `${location.origin}${item.url}` : null;
  const open = $('#detail-open');
  if (short) { open.setAttribute('href', short); open.textContent = '打开短链'; }
  else { open.removeAttribute('href'); }
  dlg.showModal();
}
$('#detail-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
$('#detail-copy').addEventListener('click', () => {
  const u = current?.url ? `${location.origin}${current.url}` : null;
  if (u) copyText(u);
});
$('#detail-dl').addEventListener('click', () => {
  if (!current?.url) return;
  downloadFromSources(current.url, `${(current.title || 'sticker').slice(0, 40)}.${extFor(current.mime)}`);
});

// ---------------------------------------------------------------- maker
const MAX_PICK = 2 * 1024 * 1024; // what the visitor may pick
const SERVER_MAX = 1024 * 1024; // what the server accepts per image (bigger picks are re-encoded here)
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
let templates = [];
let selected = null;
let publicRenders = false;
let resultBlob = null;
/** @type {Array<{ file: File|null, url: string, preview: string|null, error: string }>} */
let slots = [];

async function loadTemplates() {
  const box = $('#templates');
  try {
    const [t, h] = await Promise.all([api('/v1/templates'), api('/v1/health').catch(() => null)]);
    publicRenders = !!(h && h.publicRenders);
    templates = t.items || t.templates || [];
    if (!templates.length) {
      box.replaceChildren(el('div', { class: 'muted' }, '暂时没有可用的模板。'));
      return;
    }
    box.replaceChildren(...templates.map((tpl) => {
      const kind = tpl.inputs.images.max > 0 ? `放 ${tpl.inputs.images.max} 张图` : `${tpl.inputs.texts.max} 段文字`;
      const btn = el('button', { type: 'button', class: 'tpl', dataset: { id: tpl.id }, 'aria-pressed': 'false', onclick: () => pick(tpl) },
        el('div', { class: 'thumb' }, imgFromUrl(tpl.preview, tpl.title)),
        el('div', { class: 'meta' },
          el('div', { class: 'name' }, tpl.title),
          el('div', { class: 'sub' }, kind)));
      return btn;
    }));
    const fromHash = decodeURIComponent((location.hash.match(/[#&]t=([^&]+)/) || [])[1] || '');
    const pre = templates.find((x) => x.id === fromHash);
    if (pre) pick(pre, false);
  } catch (e) {
    $('#tpl-error').textContent = e instanceof ApiError ? errorText(e) : String(e.message || e);
    $('#tpl-error').classList.remove('hidden');
  }
}

function msg(kind, text) {
  const m = $('#maker-msg');
  m.className = `alert ${kind}`;
  m.textContent = text;
  m.classList.toggle('hidden', !text);
}

function revokeSlot(i) {
  const s = slots[i];
  if (s?.preview) URL.revokeObjectURL(s.preview);
}

function clearSlot(i, { keepUrl = false } = {}) {
  revokeSlot(i);
  slots[i] = { file: null, url: keepUrl ? (slots[i]?.url || '') : '', preview: null, error: '' };
}

function setSlotFile(i, file) {
  if (!TYPES.includes(file.type)) {
    slots[i].error = '只支持 PNG / JPG / GIF / WebP';
    slots[i].file = null;
    revokeSlot(i);
    slots[i].preview = null;
    return renderSlot(i);
  }
  if (file.size > MAX_PICK) {
    slots[i].error = `超过 2MB（${fmtBytes(file.size)}）`;
    slots[i].file = null;
    revokeSlot(i);
    slots[i].preview = null;
    return renderSlot(i);
  }
  revokeSlot(i);
  slots[i] = { file, url: '', preview: URL.createObjectURL(file), error: '' };
  renderSlot(i);
}

async function setSlotUrl(i, raw) {
  const url = (raw || '').trim();
  slots[i].url = url;
  slots[i].error = '';
  if (!url) {
    if (!slots[i].file) clearSlot(i);
    return renderSlot(i);
  }
  const safe = safeUrl(url);
  if (!safe || !/^https?:/i.test(safe)) {
    slots[i].error = '请输入 http(s) 图片链接';
    return renderSlot(i);
  }
  // Try browser fetch first (blob preview). CORS failures → keep URL for server-side fetch.
  try {
    const res = await fetch(safe, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!TYPES.includes(blob.type) && !blob.type.startsWith('image/')) throw new Error('not image');
    const file = new File([blob], 'from-url.' + (blob.type.split('/')[1] || 'img'), { type: blob.type || 'image/jpeg' });
    if (file.size > MAX_PICK) throw new Error('too large');
    revokeSlot(i);
    slots[i] = { file, url: safe, preview: URL.createObjectURL(file), error: '' };
  } catch {
    revokeSlot(i);
    slots[i].file = null;
    slots[i].preview = null;
    slots[i].url = safe;
    slots[i].error = ''; // server will fetch; show URL chip without preview
  }
  renderSlot(i);
}

function renderSlot(i) {
  const host = $(`#slot-${i}`);
  if (!host) return;
  const s = slots[i];
  const tpl = selected;
  const label = tpl.inputs.images.max > 1 ? `第 ${i + 1} 张图片` : '图片';
  const required = i < tpl.inputs.images.min;
  const fileId = `img-file-${i}`;

  const kids = [el('div', { class: 'slot-label' }, label, required ? el('span', { class: 'req' }, ' *') : null)];

  if (s.preview || (s.url && !s.file)) {
    const preview = el('div', { class: 'drop-preview' });
    if (s.preview) {
      preview.append(el('img', { src: s.preview, alt: '预览' }));
    } else {
      preview.append(el('div', { class: 'drop-url-only' },
        el('div', { class: 'drop-url-badge' }, '将由服务器代取'),
        el('div', { class: 'drop-url-text', title: s.url }, s.url)));
    }
    const meta = el('div', { class: 'drop-meta' });
    if (s.file) meta.append(el('div', { class: 'drop-name' }, s.file.name), el('div', { class: 'drop-size' }, fmtBytes(s.file.size)));
    else if (s.url) meta.append(el('div', { class: 'drop-name' }, '网络图片'));
    const actions = el('div', { class: 'drop-actions' },
      el('button', { type: 'button', class: 'btn sm', onclick: () => $(`#${fileId}`).click() }, '替换'),
      el('button', { type: 'button', class: 'btn sm danger', onclick: () => { clearSlot(i); renderSlot(i); } }, '移除'));
    kids.push(el('div', { class: 'drop-filled' }, preview, el('div', { class: 'drop-side' }, meta, actions)));
  } else {
    const zone = el('div', {
      class: 'drop-zone',
      tabindex: '0',
      role: 'button',
      'aria-label': `${label}：拖拽、点击或粘贴图片`,
      onclick: (ev) => { if (ev.target.closest('input,button,a')) return; $(`#${fileId}`).click(); },
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $(`#${fileId}`).click(); }
      },
    },
      el('div', { class: 'drop-icon', 'aria-hidden': 'true' }, '⇧'),
      el('div', { class: 'drop-title' }, '拖拽图片到这里'),
      el('div', { class: 'drop-hint' }, '或点击选择 · 支持 Ctrl/⌘+V 粘贴'),
      el('button', { type: 'button', class: 'btn sm primary drop-pick', onclick: (ev) => { ev.stopPropagation(); $(`#${fileId}`).click(); } }, '选择图片'));
    zone.addEventListener('dragenter', (ev) => { ev.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', (ev) => { if (!zone.contains(ev.relatedTarget)) zone.classList.remove('dragover'); });
    zone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      zone.classList.remove('dragover');
      const f = ev.dataTransfer?.files?.[0];
      if (f) setSlotFile(i, f);
    });
    kids.push(zone);
  }

  kids.push(el('input', {
    id: fileId, type: 'file', class: 'sr-only', accept: TYPES.join(','),
    'aria-label': `选择${label}文件`,
    onchange: (ev) => { const f = ev.target.files?.[0]; if (f) setSlotFile(i, f); ev.target.value = ''; },
  }));

  const urlRow = el('div', { class: 'drop-url-row' },
    el('label', { class: 'sr-only', for: `img-url-${i}` }, `${label}链接`),
    el('input', {
      id: `img-url-${i}`, type: 'url', inputmode: 'url', autocomplete: 'off',
      placeholder: '或粘贴图片 http(s) 链接',
      value: s.url || '',
      onchange: (ev) => setSlotUrl(i, ev.target.value),
      onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); setSlotUrl(i, ev.target.value); } },
    }),
    el('button', { type: 'button', class: 'btn sm', onclick: () => setSlotUrl(i, $(`#img-url-${i}`).value) }, '使用链接'));
  kids.push(urlRow);

  if (s.error) kids.push(el('div', { class: 'drop-error', role: 'alert' }, s.error));
  else kids.push(el('div', { class: 'hint' }, '图片只在生成时发送，不会保存到表情库。'));

  host.replaceChildren(...kids);
}

function onPasteImage(ev) {
  if (!selected || !selected.inputs.images.max) return;
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (!f) continue;
      ev.preventDefault();
      // Prefer empty required slot, else first empty, else slot 0
      let idx = slots.findIndex((s, i) => i < selected.inputs.images.min && !s.file && !s.url);
      if (idx < 0) idx = slots.findIndex((s) => !s.file && !s.url);
      if (idx < 0) idx = 0;
      setSlotFile(idx, f);
      return;
    }
  }
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
  if (tpl.inputs.images.max) parts.push(`${tpl.inputs.images.max} 张图片（拖拽 / 点击 / 链接 / 粘贴）`);
  const desc = (tpl.description || '').trim();
  $('#tpl-desc').textContent = desc ? desc : `需要：${parts.join('，') || '无输入'}`;
  // Do not show long provenance notice — description is enough; legal lives in A licenses/.
  $('#tpl-notice').textContent = '';
  $('#tpl-notice').classList.add('hidden');

  slots.forEach((_, i) => revokeSlot(i));
  slots = Array.from({ length: tpl.inputs.images.max }, () => ({ file: null, url: '', preview: null, error: '' }));

  const fields = [];
  for (let i = 0; i < tpl.inputs.texts.max; i++) {
    const id = `txt-${i}`;
    fields.push(el('div', { class: 'field' },
      el('label', { for: id }, tpl.inputs.texts.max > 1 ? `第 ${i + 1} 段文字` : '文字'),
      el('input', { id, type: 'text', name: id, maxlength: tpl.inputs.texts.maxLength, required: i < tpl.inputs.texts.min, placeholder: i === 0 ? '在这里输入要写的内容' : '' })));
  }
  for (let i = 0; i < tpl.inputs.images.max; i++) {
    fields.push(el('div', { class: 'field slot-field', id: `slot-${i}` }));
  }
  $('#tpl-fields').replaceChildren(...fields);
  for (let i = 0; i < tpl.inputs.images.max; i++) renderSlot(i);

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

  const imageUrls = [];
  const files = [];
  for (let i = 0; i < tpl.inputs.images.max; i++) {
    const s = slots[i];
    if (s.file) {
      imageUrls.push(null);
      files.push(s.file);
    } else if (s.url) {
      imageUrls.push(s.url);
    } else if (i < tpl.inputs.images.min) {
      return msg('error', tpl.inputs.images.max > 1 ? `请为第 ${i + 1} 张图片选择文件或填写链接。` : '请先拖入、选择或粘贴一张图片，也可填链接。');
    } else {
      imageUrls.push(null);
    }
  }

  const btn = $('#gen');
  btn.disabled = true;
  btn.textContent = '生成中…';
  msg('info', '正在生成，通常需要几秒钟…');
  try {
    const body = { template: tpl.id, version: tpl.version, texts };
    if (imageUrls.some(Boolean)) body.imageUrls = imageUrls;
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

document.addEventListener('paste', onPasteImage);

loadCategories();
search(true);
loadTemplates();

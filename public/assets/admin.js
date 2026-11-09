import { $, el, api, ApiError, imgFromUrl, fmtTime, toast, idemKey, safeUrl, copyText } from './common.js';

const app = $('#app');
let session = null; // { admin, csrfToken, repo }
let categories = [];
const receipts = [];

const TONES = [['neutral', '中性'], ['positive', '正面'], ['negative', '负面'], ['sarcastic', '嘲讽']];
const RATINGS = [['general', '普通'], ['mild', '轻微'], ['sensitive', '敏感']];
const BASES = [['self-created', '自制'], ['license', '开放许可'], ['creator-permission', '作者授权']];
const REASONS = [['rights', '版权问题'], ['privacy', '隐私'], ['quality', '质量差'], ['duplicate', '重复'], ['policy', '违反规则'], ['other', '其他']];
const STATUS_LABEL = { active: '公开', archived: '已归档', tombstoned: '已删除' };

// ------------------------------------------------------------------ auth
function loginView(kind) {
  $('#user-box').classList.add('hidden');
  const text = {
    forbidden: ['(｀・ω・´)', '这个 GitHub 账号不是管理员', '只有管理员白名单里的账号可以进入后台。如果你是管理员，请换个账号登录。'],
    denied: ['(・_・;)', '你取消了 GitHub 授权', '需要授权才能确认你的身份。'],
    expired: ['(-_-)zzz', '登录已过期', '为了安全，后台登录 30 分钟后自动失效，请重新登录。'],
    out: ['(・ω・)ノ', '管理员登录', '使用 GitHub 账号登录，登录后会校验是否是管理员。'],
  }[kind] || ['(・ω・)ノ', '管理员登录', ''];
  app.replaceChildren(el('div', { class: 'center-card panel' },
    el('div', { class: 'face', 'aria-hidden': 'true' }, text[0]),
    el('h2', {}, text[1]),
    el('p', { class: 'muted' }, text[2]),
    el('a', { class: 'btn primary', href: '/v1/auth/github/start?next=admin' }, '使用 GitHub 登录'),
    el('p', { class: 'small muted' }, el('a', { href: '/' }, '← 返回首页'))));
}

function handleAuthError(e) {
  if (e instanceof ApiError && e.status === 401) {
    session = null;
    loginView('expired');
    return true;
  }
  if (e instanceof ApiError && e.status === 403 && e.code === 'forbidden') {
    session = null;
    loginView('forbidden');
    return true;
  }
  return false;
}

function errText(e) {
  if (e instanceof ApiError) {
    if (e.status === 429) return `太频繁了，${e.retryAfter ? e.retryAfter + ' 秒' : '稍等一会儿'}后再试。`;
    if (e.code === 'actions_permission') return '写入用的 GitHub App 没有 Actions 权限：请在 App 设置里给 Repository permissions 加上「Actions: Read and write」，并在安装页确认新权限。';
    if (e.code === 'revision_mismatch') return '这张表情刚被别人改过，请刷新后再试。';
    return `${e.message}（${e.code}）`;
  }
  return String(e?.message || e);
}

/** Every mutation: CSRF token + fresh Idempotency-Key (+ If-Match when given). */
async function mutate(method, path, { json, form, ifMatch, idempotent = true } = {}) {
  const headers = { 'x-csrf-token': session.csrfToken };
  if (idempotent) headers['idempotency-key'] = idemKey();
  if (ifMatch !== undefined) headers['if-match'] = String(ifMatch);
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  return api(path, { method, headers, body });
}

function commitLink(sha) {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !session?.repo) return document.createTextNode(sha || '—');
  return el('a', { href: `https://github.com/${session.repo.owner}/${session.repo.repo}/commit/${sha}`, target: '_blank', rel: 'noopener noreferrer' }, sha.slice(0, 7));
}

function addReceipt(action, r) {
  receipts.unshift({ at: new Date().toISOString(), action, status: r?.status, op: r?.operationId, commit: r?.commit, id: r?.asset?.id });
  renderReceipts();
}

function renderReceipts() {
  const box = $('#receipts');
  if (!box) return;
  if (!receipts.length) return box.replaceChildren(el('div', { class: 'muted small' }, '本次登录还没有操作。'));
  box.replaceChildren(...receipts.slice(0, 20).map((r) => el('div', { class: 'receipt' },
    el('strong', {}, r.action), ' · ', el('span', { class: 'status' }, r.status || '—'), ' · 提交 ', commitLink(r.commit),
    el('div', { class: 'muted' }, `${fmtTime(r.at)} · 操作 ${r.op || '—'}${r.id ? ' · ' + r.id.slice(0, 19) + '…' : ''}`))));
}

// ------------------------------------------------------------------ shell
async function boot() {
  const params = new URLSearchParams(location.search);
  const flag = params.get('login');
  if (flag) history.replaceState(null, '', '/admin');
  let s;
  try {
    s = await api('/v1/auth/session', { cache: 'no-store' });
  } catch (e) {
    app.replaceChildren(el('div', { class: 'center-card panel' }, el('p', {}, `无法连接服务：${errText(e)}`)));
    return;
  }
  if (!s.authenticated) return loginView(flag === 'forbidden' ? 'forbidden' : flag === 'denied' ? 'denied' : 'out');
  session = s;
  $('#user-name').textContent = `@${s.admin.login || s.admin.githubId}`;
  $('#user-box').classList.remove('hidden');
  try {
    categories = (await api('/v1/categories')).categories;
  } catch {
    categories = [];
  }
  renderShell();
}

$('#logout').addEventListener('click', async () => {
  try {
    await mutate('POST', '/v1/auth/logout', { idempotent: false });
  } catch {}
  session = null;
  loginView('out');
});

function renderShell() {
  const tabs = [['assets', '表情管理'], ['upload', '上传'], ['collect', '采集']];
  const views = {};
  const tabBar = el('div', { class: 'tabs', role: 'tablist' });
  const holder = el('div');
  const show = (key) => {
    for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.dataset.key === key));
    holder.replaceChildren(views[key] ||= { assets: assetsView, upload: uploadView, collect: collectView }[key]());
    history.replaceState(null, '', `#${key}`);
  };
  for (const [key, label] of tabs) {
    tabBar.append(el('button', { type: 'button', role: 'tab', dataset: { key }, onclick: () => show(key) }, label));
  }
  app.replaceChildren(
    el('div', { class: 'hero' }, el('h1', {}, '管理后台'), el('p', {}, '所有修改都会在 sticker-assets 仓库里生成一次提交。')),
    tabBar, holder,
    el('section', { class: 'block' }, el('div', { class: 'section-head' }, el('h2', {}, '操作回执')), el('div', { class: 'receipts', id: 'receipts' })));
  renderReceipts();
  const initial = location.hash.slice(1);
  show(tabs.some(([k]) => k === initial) ? initial : 'assets');
}

// ------------------------------------------------------------------ assets
function catChecks(name, selected = []) {
  return el('div', { class: 'checks' }, ...categories.map((c) => el('label', {},
    el('input', { type: 'checkbox', name, value: c.slug, checked: selected.includes(c.slug) }), c.label)));
}
const checked = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
const splitTags = (s) => s.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
const options = (pairs, value) => pairs.map(([v, l]) => el('option', { value: v, selected: v === value }, l));

function assetsView() {
  const q = el('input', { type: 'search', placeholder: '搜索标题 / 标签', maxlength: 64, 'aria-label': '搜索' });
  const cat = el('select', { 'aria-label': '分类' }, el('option', { value: '' }, '全部分类'), ...categories.map((c) => el('option', { value: c.slug }, c.label)));
  const idInput = el('input', { type: 'text', placeholder: '按 ID 查看（含已归档）sha256:…', 'aria-label': '按 ID 查看' });
  const tbody = el('tbody');
  const msgBox = el('div', { class: 'alert error hidden' });
  const more = el('button', { class: 'btn hidden', type: 'button' }, '加载更多');
  let cursor = null;

  const row = (a) => el('tr', {},
    el('td', {}, el('div', {}, imgFromUrl(a.url, a.title, { cls: 'mini' }))),
    el('td', {}, el('div', {}, a.title || '未命名'), el('div', { class: 'muted small' }, (a.tags || []).join('、'))),
    el('td', { class: 'hide-sm' }, (a.cats || a.categories || []).map((c) => categories.find((x) => x.slug === c)?.label || c).join('、')),
    el('td', { class: 'hide-sm small' }, fmtTime(a.uploadedAt)),
    el('td', {}, el('span', { class: `status ${a.status || 'active'}` }, STATUS_LABEL[a.status || 'active'] || a.status), el('div', { class: 'muted small' }, `r${a.rev ?? a.revision ?? '?'}`)),
    el('td', {}, el('div', { class: 'ops' },
      a.url ? el('button', { class: 'btn sm', type: 'button', title: a.url, onclick: () => copyText(`${location.origin}${a.url}`) }, '复制短链') : null,
      el('button', { class: 'btn sm', type: 'button', onclick: () => editDialog(a.sha || a.id, reload) }, '编辑'),
      el('button', { class: 'btn sm', type: 'button', onclick: () => reviewDialog(a.sha || a.id, reload) }, '审核'),
      el('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteDialog(a.sha || a.id, reload) }, '删除'))));

  async function load(reset) {
    msgBox.classList.add('hidden');
    if (reset) cursor = null;
    const p = new URLSearchParams({ limit: '30' });
    if (q.value.trim()) p.set('q', q.value.trim());
    if (cat.value) p.set('category', cat.value);
    if (cursor) p.set('cursor', cursor);
    try {
      const r = await api(`/v1/assets?${p}`);
      if (reset) tbody.replaceChildren();
      tbody.append(...r.items.map((a) => row({ ...a, status: 'active' })));
      if (!tbody.children.length) tbody.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, '没有找到表情。')));
      cursor = r.next || null;
      more.classList.toggle('hidden', !cursor);
    } catch (e) {
      if (handleAuthError(e)) return;
      msgBox.textContent = errText(e);
      msgBox.classList.remove('hidden');
    }
  }
  async function byId() {
    const id = idInput.value.trim();
    if (!id) return;
    try {
      const asset = await api(`/v1/assets/${encodeURIComponent(id)}?view=full`);
      tbody.replaceChildren(row(asset));
      more.classList.add('hidden');
    } catch (e) {
      msgBox.textContent = e instanceof ApiError && e.status === 410 ? '这张表情已经被删除（墓碑）。' : errText(e);
      msgBox.classList.remove('hidden');
    }
  }
  const reload = () => load(true);
  more.addEventListener('click', () => load(false));
  const form = el('form', { class: 'toolbar', onsubmit: (ev) => { ev.preventDefault(); load(true); } },
    q, cat, el('button', { class: 'btn primary', type: 'submit' }, '搜索'));
  const idForm = el('form', { class: 'toolbar', onsubmit: (ev) => { ev.preventDefault(); byId(); } },
    idInput, el('button', { class: 'btn', type: 'submit' }, '查看'));
  load(true);
  return el('div', {}, form, idForm,
    el('p', { class: 'muted small' }, '列表只含公开表情（搜索索引）；已归档的请按 ID 查看。'),
    msgBox,
    el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, el('th', {}, '图'), el('th', {}, '标题 / 标签'), el('th', { class: 'hide-sm' }, '分类'), el('th', { class: 'hide-sm' }, '上传时间'), el('th', {}, '状态'), el('th', {}, '操作'))),
      tbody)),
    el('div', { class: 'load-more' }, more));
}

function modal(title, body, onSubmit, submitLabel = '保存', danger = false) {
  const err = el('div', { class: 'alert error hidden' });
  const submit = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit' }, submitLabel);
  const dlg = el('dialog', {});
  const form = el('form', { class: 'dialog-body' },
    el('div', { class: 'dialog-head' }, el('h3', {}, title), el('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => dlg.close() }, '×')),
    body, err, el('div', { class: 'actions' }, submit, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, '取消')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    err.classList.add('hidden');
    try {
      await onSubmit(form);
      dlg.close();
    } catch (e) {
      if (handleAuthError(e)) return dlg.close();
      err.textContent = errText(e);
      err.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

async function fresh(id) {
  try {
    return await api(`/v1/assets/${encodeURIComponent(id)}?view=full`);
  } catch (e) {
    if (!handleAuthError(e)) toast(errText(e));
    return null;
  }
}

async function editDialog(id, done) {
  const a = await fresh(id);
  if (!a) return;
  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, '标题'), el('input', { name: 'title', value: a.title, maxlength: 80, required: true })),
    el('div', { class: 'field' }, el('label', {}, '分类（1–5 个）'), catChecks('cat', a.cats || a.categories || [])),
    el('div', { class: 'field' }, el('label', {}, '标签（逗号或空格分隔）'), el('input', { name: 'tags', value: (a.tags || []).join('，') })),
    el('div', { class: 'field' }, el('label', {}, '语气'), el('select', { name: 'tone' }, ...options(TONES, a.tone))),
    el('div', { class: 'field' }, el('label', {}, '内容分级'), el('select', { name: 'rating' }, ...options(RATINGS, a.safety?.rating))),
    el('p', { class: 'muted small' }, `当前版本 r${a.rev ?? a.revision}，保存时会校验版本（If-Match）。`));
  modal('编辑表情', body, async (f) => {
    const patch = {
      title: f.title.value.trim(),
      categories: checked(f, 'cat'),
      tags: splitTags(f.tags.value),
      tone: f.tone.value,
      safety: { rating: f.rating.value, offensive: !!a.safety?.offensive },
    };
    const assetId = a.sha || a.id;
    const r = await mutate('PATCH', `/v1/assets/${encodeURIComponent(assetId)}`, { json: patch, ifMatch: a.rev ?? a.revision });
    addReceipt('编辑', r);
    toast('已保存');
    done();
  });
}

async function reviewDialog(id, done) {
  const a = await fresh(id);
  if (!a) return;
  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, '审核动作'), el('select', { name: 'action' },
      el('option', { value: 'rights' }, '确认/更新版权信息'), el('option', { value: 'archive' }, '归档（从搜索中下架，保留记录）'))),
    el('div', { class: 'field' }, el('label', {}, '版权依据'), el('select', { name: 'basis' }, ...options(BASES, a.rights?.basis))),
    el('div', { class: 'field' }, el('label', {}, '许可 ID（A 仓库 licenses/ 下的文件名）'), el('input', { name: 'licenseId', value: a.rights?.licenseId || 'self-created-project', list: 'license-ids' })),
    licenseList(),
    el('p', { class: 'muted small' }, `当前状态：${STATUS_LABEL[a.status] || a.status}，版本 r${a.rev ?? a.revision}。`));
  modal('审核表情', body, async (f) => {
    const json = f.action.value === 'archive' ? { status: 'archived' } : { rights: { basis: f.basis.value, licenseId: f.licenseId.value.trim() } };
    const assetId = a.sha || a.id;
    const r = await mutate('POST', `/v1/assets/${encodeURIComponent(assetId)}/review`, { json, ifMatch: a.rev ?? a.revision });
    addReceipt(f.action.value === 'archive' ? '归档' : '审核', r);
    toast('已提交');
    done();
  }, '提交');
}

async function deleteDialog(id, done) {
  const a = await fresh(id);
  if (!a) return;
  const body = el('div', {},
    el('p', {}, '确定要删除「', a.title, '」吗？删除会在仓库里留下一条删除记录（墓碑），图片不再对外提供。'),
    el('div', { class: 'field' }, el('label', {}, '删除原因'), el('select', { name: 'reason' }, ...options(REASONS, 'other'))),
    el('p', { class: 'muted small' }, '注意：jsDelivr 等镜像上按提交固定的旧链接可能还会缓存一段时间。'));
  modal('删除表情', body, async (f) => {
    const assetId = a.sha || a.id;
    const r = await mutate('DELETE', `/v1/assets/${encodeURIComponent(assetId)}?reason=${encodeURIComponent(f.reason.value)}`, { ifMatch: a.rev ?? a.revision });
    addReceipt('删除', r);
    toast('已删除');
    done();
  }, '确认删除', true);
}

function licenseList() {
  return el('datalist', { id: 'license-ids' }, ...['self-created-project', 'meme-generator-mit', 'ofl-1-1'].map((v) => el('option', { value: v })));
}

// ------------------------------------------------------------------ upload
function uploadView() {
  const preview = el('div', { class: 'detail-img' }, el('span', { class: 'muted small' }, '选择图片后在这里预览'));
  const result = el('div', { class: 'alert hidden' });
  const file = el('input', { type: 'file', name: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', required: true });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    const img = el('img', { alt: '预览' });
    img.src = URL.createObjectURL(f);
    preview.replaceChildren(img);
  });
  const form = el('form', { class: 'panel' },
    el('div', { class: 'field' }, el('label', {}, '图片（PNG/JPG/GIF/WebP，≤2MB）'), file),
    preview,
    el('div', { class: 'field' }, el('label', {}, '标题'), el('input', { name: 'title', maxlength: 80, required: true, placeholder: '比如：打工人下班' })),
    el('div', { class: 'field' }, el('label', {}, '分类（1–5 个）'), catChecks('cat')),
    el('div', { class: 'field' }, el('label', {}, '标签（逗号或空格分隔）'), el('input', { name: 'tags', placeholder: '下班，开心' })),
    el('div', { class: 'field' }, el('label', {}, '版权依据'), el('select', { name: 'basis' }, ...options(BASES, 'self-created'))),
    el('div', { class: 'field' }, el('label', {}, '许可 ID'), el('input', { name: 'licenseId', value: 'self-created-project', list: 'license-ids' })),
    licenseList(),
    el('div', { class: 'field' }, el('label', {}, el('input', { type: 'checkbox', name: 'shareable', checked: true }), ' 我确认这张图可以公开分发（sticker-assets 是公开仓库）')),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'submit' }, '上传')),
    result);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = file.files?.[0];
    const show = (kind, t) => { result.className = `alert ${kind}`; result.textContent = t; };
    if (!f) return show('error', '请选择图片。');
    if (f.size > 2 * 1024 * 1024) return show('error', '图片超过 2MB。');
    const cats = checked(form, 'cat');
    if (cats.length < 1 || cats.length > 5) return show('error', '请选择 1–5 个分类。');
    if (!form.shareable.checked) return show('error', '必须确认可以公开分发。');
    const meta = {
      title: form.title.value.trim(), categories: cats, tags: splitTags(form.tags.value),
      rights: { basis: form.basis.value, licenseId: form.licenseId.value.trim() }, shareable: true,
    };
    const fd = new FormData();
    fd.append('metadata', JSON.stringify(meta));
    fd.append('file', f);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    show('info', '上传中…');
    try {
      const r = await mutate('POST', '/v1/assets', { form: fd });
      addReceipt(r.status === 'duplicate' ? '上传（重复）' : '上传', r);
      show('ok', r.status === 'duplicate' ? '这张图已经存在，没有重复提交。' : '上传成功，已提交到 sticker-assets。');
      form.reset();
      preview.replaceChildren(el('span', { class: 'muted small' }, '选择图片后在这里预览'));
    } catch (e) {
      if (!handleAuthError(e)) show('error', errText(e));
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

// ------------------------------------------------------------------ collect
function collectView() {
  const list = el('div', { class: 'source-list' }, el('div', { class: 'muted' }, '加载中…'));
  const runsBox = el('div', {}, el('div', { class: 'muted' }, '加载中…'));
  const top = el('div', { class: 'alert hidden' });
  const RUN_STATUS = { queued: '排队中', in_progress: '运行中', completed: '已完成', waiting: '等待中', requested: '已请求', pending: '等待中' };
  const CONCLUSION = { success: '成功', failure: '失败', skipped: '已跳过', cancelled: '已取消', neutral: '中性', timed_out: '超时', action_required: '需处理' };

  async function loadRuns() {
    try {
      const r = await api('/v1/collect-runs', { cache: 'no-store' });
      if (!r.runs.length) return runsBox.replaceChildren(el('div', { class: 'muted' }, '还没有运行记录。'), el('a', { href: safeUrl(r.runsUrl), target: '_blank', rel: 'noopener noreferrer' }, '在 GitHub 查看'));
      runsBox.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, '标题'), el('th', {}, '状态'), el('th', { class: 'hide-sm' }, '触发'), el('th', {}, '时间'))),
        el('tbody', {}, ...r.runs.map((x) => el('tr', {},
          el('td', {}, x.url ? el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, `#${x.runNumber ?? '?'}`) : `#${x.runNumber ?? '?'}`),
          el('td', {}, x.title || '—'),
          el('td', {}, el('span', { class: `status ${x.conclusion || x.status}` }, x.conclusion ? CONCLUSION[x.conclusion] || x.conclusion : RUN_STATUS[x.status] || x.status)),
          el('td', { class: 'hide-sm' }, x.event),
          el('td', { class: 'small' }, fmtTime(x.createdAt))))))));
    } catch (e) {
      if (handleAuthError(e)) return;
      runsBox.replaceChildren(el('div', { class: 'alert error' }, errText(e)));
    }
  }

  async function trigger(src, dry, btn) {
    btn.disabled = true;
    try {
      const r = await mutate('POST', '/v1/collect-runs', { json: { source: src.id, dryRun: dry }, idempotent: true });
      top.className = 'alert ok';
      top.textContent = `已触发「${src.label}」采集（${r.dryRun ? '试运行' : '正式'}）。GitHub 可能需要几秒钟才出现新的运行记录。`;
      setTimeout(loadRuns, 4000);
    } catch (e) {
      if (handleAuthError(e)) return;
      top.className = 'alert error';
      top.textContent = errText(e);
    } finally {
      btn.disabled = false;
    }
  }

  (async () => {
    try {
      const r = await api('/v1/collect/sources', { cache: 'no-store' });
      if (!r.sources.length) {
        list.replaceChildren(el('div', { class: 'empty' }, 'A 仓库还没有登记采集来源（config/collect-sources.json）。'));
      } else {
        list.replaceChildren(...r.sources.map((s) => {
          const dry = el('input', { type: 'checkbox', checked: true });
          const btn = el('button', { class: 'btn primary sm', type: 'button' }, '开始采集');
          btn.addEventListener('click', () => trigger(s, dry.checked, btn));
          return el('div', { class: 'panel' },
            el('h3', {}, s.label),
            el('div', { class: 'small muted' }, s.id, ' · ', el('span', { class: `status ${s.approved ? 'active' : 'archived'}` }, s.approved ? '已批准' : '占位（未批准）')),
            el('p', { class: 'small' }, s.description || ''),
            el('div', { class: 'actions' }, btn, el('label', { class: 'small' }, dry, ' 试运行（只列候选，不提交）')));
        }));
      }
    } catch (e) {
      if (handleAuthError(e)) return;
      list.replaceChildren(el('div', { class: 'alert error' }, errText(e)));
    }
  })();
  loadRuns();
  return el('div', {},
    el('p', { class: 'muted small' }, '「开始采集」会触发 sticker-assets 的 collect.yml 工作流（workflow_dispatch）。未批准的来源只跑占位脚本，不联网也不写仓库；同一来源 5 分钟内只能触发一次。'),
    top, list,
    el('section', { class: 'block' },
      el('div', { class: 'section-head' }, el('h2', {}, '最近运行'), el('button', { class: 'btn sm', type: 'button', onclick: loadRuns }, '刷新')),
      runsBox));
}

boot();

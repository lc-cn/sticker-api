// 镜像/源站 URL 组装：只允许完整 40 位 commit + 固定受管路径；不接受客户端传入的任意 proxy。
const COMMIT = /^[0-9a-f]{40}$/;
const PATH = /^(objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpg|gif)|templates\/[a-z0-9-]+\/[0-9]+\/[a-z0-9_-]+\.(png|jpg|gif|json)|indexes\/[a-z0-9/_-]+\.json|manifests\/[0-9a-f]{2}\.json)$/;

function fill(template, { owner, repo, commit, path }) {
  return template.replace('{owner}', owner).replace('{repo}', repo).replace('{commit}', commit).replace('{path}', path);
}

/** 返回有序候选 [{id, url}]：已启用且已验收的镜像在前，GitHub raw 源站最后（始终保留作回退）。 */
export function candidateUrls({ commit, path }, cfg) {
  if (!COMMIT.test(commit || '')) throw new Error('commit 必须是完整 40 位小写 SHA，不能用分支名');
  if (!PATH.test(path || '') || path.includes('..')) throw new Error(`非受管路径: ${path}`);
  if (!cfg.owner || !cfg.repo) throw new Error('mirrors.owner/repo 未配置（远程仓库尚未创建）');
  const allowed = new Set(cfg.allowedHosts);
  const vars = { owner: cfg.owner, repo: cfg.repo, commit, path };
  const list = [];
  for (const m of cfg.mirrors) {
    if (!m.enabled || !m.verifiedAt) continue;
    const url = fill(m.template, vars);
    if (!allowed.has(new URL(url).host)) throw new Error(`镜像 host 不在 allowlist: ${m.id}`);
    list.push({ id: m.id, url });
  }
  const origin = fill(cfg.origin.template, vars);
  if (!allowed.has(new URL(origin).host)) throw new Error('raw host 不在 allowlist');
  list.push({ id: cfg.origin.id, url: origin });
  return list;
}

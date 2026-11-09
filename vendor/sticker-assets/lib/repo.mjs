// 读取一个 A 树（I/O 层）。validator 与 build-index 共用。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256Hex } from './hash.mjs';
import { cmp } from './canonical.mjs';

export const MANAGED_DIRS = ['objects', 'manifests', 'events', 'indexes', 'templates', 'licenses', 'budgets'];

export function walk(root, dir = root, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort(cmp)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

export const readText = (root, p) => readFileSync(join(root, p), 'utf8');
export const readBuf = (root, p) => readFileSync(join(root, p));
export const sizeOf = (root, p) => statSync(join(root, p)).size;

/** 读取构建索引所需的状态；解析错误抛出（validator 会先单独报告） */
export function loadState(root) {
  const files = walk(root);
  const assets = [];
  for (const p of files.filter((f) => /^manifests\/[0-9a-f]{2}\.json$/.test(f))) assets.push(...JSON.parse(readText(root, p)).assets);
  assets.sort((a, b) => cmp(a.id, b.id));
  const templates = files
    .filter((f) => /^templates\/[a-z0-9-]+\/[0-9]+\/template\.json$/.test(f))
    .map((path) => ({ path, template: JSON.parse(readText(root, path)) }));
  const synBuf = readBuf(root, 'config/synonyms.json');
  return {
    files,
    assets,
    templates,
    synonyms: JSON.parse(synBuf.toString('utf8')),
    synonymsSha256: sha256Hex(synBuf),
    limits: JSON.parse(readText(root, 'config/limits.json')),
  };
}

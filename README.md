# sticker-api（B：API 服务）

小智表情服务的 **无状态 API**，部署形态为 **单个 Vercel 函数**。唯一权威数据在 **A 仓库 `sticker-assets`**：
B 不持有数据库、不写本地盘，所有读都钉在 A 的某个 commit 上，所有写都是对 A 的一次原子提交。

- A 契约：`vendor/sticker-assets/CONTRACT.md`（由 `pnpm vendor:a` 从 A 固定 commit 原样复制，见 `vendor/sticker-assets/VERSION.json`）
- B 直接调用 A 的 `lib/`（commit-plan / search / indexer / validator / schemas），保证与 A 的构建/校验字节一致

## 结构

```
api/index.js            Vercel 函数入口 → dist/src/vercel.js
vercel.json             构建、函数(30s)、includeFiles(dist/字体/web/静态资源/openapi)、/assets 缓存头、全路径 rewrite
web/                    首页 index.html、API 文档 docs.html、管理后台壳 admin.html（由函数输出，带 CSP）
public/assets/          首页/后台的 CSS、原生 ES module JS（无构建链）、favicon；Vercel 直接静态分发
src/app.ts              Fastify 组装：错误格式、no-store、multipart 原始体收集
src/config.ts           环境变量解析（fail closed + warnings）
src/auth/               机器 token(仅存 sha256)、管理员 GitHub 登录会话、CSRF、Cookie
src/routes/             /v1 路由（api.ts / auth.ts）+ 页面路由 web.ts（/、/docs、/admin、/openapi.yaml、/assets/*）
src/services/collect.ts 采集来源（A config/collect-sources.json）、触发 A collect.yml（workflow_dispatch）、运行列表
src/http/               client-ip（可信代理才读转发头）、rate-limit（内存滑动窗口）
src/repo/               HEAD 缓存、Snapshot(单 commit + 读预算 + LRU)、sync-read 适配、Publisher(Git Data API)
src/services/assets.ts  读/搜/内容 302/上传/修改/审核/墓碑/操作回执 + 幂等
src/services/renders.ts 轻量模板渲染（A 的 light-v1 模板 → SVG → resvg-wasm，worker 硬超时）
src/domain/             图片校验与隐私元数据剥离、元数据解析、幂等键
src/github/             App JWT → installation token（仅 A 仓库、contents:write）、仓库客户端
vendor/sticker-assets/  A 的 lib/schemas/config/fixtures/CONTRACT（只读副本，不手改）
tests/                  fake GitHub（本地 127.0.0.1:0）+ 28 个测试；scripts/smoke.ts 端到端冒烟
```

## API 摘要（详见 openapi.yaml）

公开（无需登录，`Cache-Control: no-store`，响应带 `commit`）：
- `GET /v1/assets?q=&category=&tag=&sort=relevance|uploaded&limit=1..50&cursor=`
- `GET /v1/assets/{id}`（ETag = revision；墓碑 410）
- `GET /v1/assets/{id}/content[?source=<mirrorId>]` → 302 到 A 镜像候选或 raw（钉 commit）；墓碑 410
- `GET /v1/categories`（分类 + 数量）
- `GET /v1/templates`（含 `preview`：底图镜像链接，作缩略图）
- `GET /v1/health`（含 `publicRenders`）
- `POST /v1/renders` 匿名：仅当 `PUBLIC_RENDERS_ENABLED=true`，且请求**不带** Authorization 和管理员 Cookie 时生效

写（`Authorization: Bearer <machine token>` 或 管理员会话 + `Origin` + `X-CSRF-Token`）：
- `POST /v1/assets`（`assets:write`，必须 `Idempotency-Key`，multipart：`file` + `metadata` JSON）→ 201 created / 200 duplicate
- `PATCH /v1/assets/{id}`、`POST /v1/assets/{id}/review`（`assets:moderate`，必须 `If-Match`）
- `DELETE /v1/assets/{id}?reason=rights|privacy|quality|duplicate|policy|other`（`assets:moderate`，墓碑）
- `GET /v1/operations/{op}`（`operations:read`，机器需带原 `Idempotency-Key`）
- `POST /v1/renders`（`render`，JSON 或 multipart `request` + `image`）→ image/png
- `GET /v1/collect/sources`、`GET /v1/collect-runs`、`POST /v1/collect-runs`（`collect:trigger` 或管理员会话 + CSRF）
  → 触发 A 的 `collect.yml`（workflow_dispatch，输入 `source`、`dry_run`），列出最近运行；同一来源冷却 `COLLECT_COOLDOWN_SECONDS`（默认 300 秒）

管理员登录：`GET /v1/auth/github/start` → GitHub → `/v1/auth/github/callback`；非白名单数字 id 一律 403、不发会话。
`GET /v1/auth/session` 返回 csrfToken；`POST /v1/auth/logout`。

## 首页与管理后台

- `/`：公开首页（搜索、分类、详情、在线制图）。纯 HTML + CSS + 原生 ES module，无打包、无内联脚本。
- `/admin`：管理后台壳，**不含任何数据**；登录走 `/v1/auth/github/start?next=admin`，非管理员回到 `/admin?login=forbidden`。
  表情增删改查、审核、上传、采集触发全部调用带会话的 `/v1` 接口，每次修改都带 `X-CSRF-Token` 与新的 `Idempotency-Key`。
- `/docs`：简要 API 文档；`/openapi.yaml`：完整定义。
- 页面 CSP：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: raw.githubusercontent.com + MIRROR_HOST_ALLOWLIST`，
  `connect-src` 同上（下载按钮需要 fetch 镜像图片），`frame-ancestors 'none'`。
- 路由：`vercel.json` 仍是全路径 rewrite 到函数。Vercel 先查静态文件再走 rewrite，所以 `/assets/*` 由静态输出直接返回，
  `/`、`/docs`、`/admin`、`/openapi.yaml`、`/v1/*` 进函数（HTML 由函数输出，以便 CSP 跟随 `MIRROR_HOST_ALLOWLIST`）。
  函数内也有 `/assets/*` 路由，保证本地开发一致。

### 匿名制图限流（重要说明）

按客户端 IP 限流（每分钟 `PUBLIC_RENDER_PER_MINUTE`=6、每天 `PUBLIC_RENDER_PER_DAY`=100，IPv6 按 /64 归并），超出返回 429 + `Retry-After`。
计数器**在每个 Vercel 实例的内存里**，不是全局配额：多个热实例各算各的，实例回收后清零。v1 够用；要精确全局配额需要 KV/D1。
客户端 IP 只在可信代理后（Vercel，`VERCEL=1` 或 `TRUST_PROXY_HEADERS=true`）才取 `x-real-ip` / `x-forwarded-for` 第一跳，否则用 TCP 对端地址。
匿名请求只能引用公开（active）的 assetIds，其余尺寸/超时限制与令牌调用一致。

### 本地预览后台（仅开发用）

`node dist/scripts/dev-admin-preview.js --port 8798 --a-dir ../sticker-assets`：读线上公开 A，GitHub API 用本地假桩，
注入一次性的假管理员会话、写入关闭。只在本机回环运行，拒绝在 Vercel 上运行，也不会被部署的函数引用。

## 本地运行

```bash
pnpm install
pnpm typecheck
pnpm test        # build + 28 个测试（fake GitHub，无网络、无真实写）
pnpm smoke       # build + 用 Vercel handler 跑完整流程，结束即退出
pnpm vendor:a    # 从 ../sticker-assets 重新复制 A 契约（A 升级时）
pnpm token:new xiaozhi assets:write,render,operations:read
# 连接真实 A 本地试跑：cp .env.example .env 填好后 `pnpm build && node --env-file=.env dist/src/server.js`
```

## 上线前 Fin 需要做的事

见本次交付报告；`.env.example` 列出了全部变量与两个 GitHub App 的建法。

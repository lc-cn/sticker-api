# sticker-api（B：API 服务）

小智表情服务的 **无状态 API**，部署形态为 **单个 Vercel 函数**。唯一权威数据在 **A 仓库 `sticker-assets`**：
B 不持有数据库、不写本地盘，所有读都钉在 A 的某个 commit 上，所有写都是对 A 的一次原子提交。

- A 契约：`vendor/sticker-assets/CONTRACT.md`（由 `pnpm vendor:a` 从 A 固定 commit 原样复制，见 `vendor/sticker-assets/VERSION.json`）
- B 直接调用 A 的 `lib/`（commit-plan / search / indexer / validator / schemas），保证与 A 的构建/校验字节一致

## 结构

```
api/index.js            Vercel 函数入口 → dist/src/vercel.js
vercel.json             构建、函数(30s/1024MB)、includeFiles(wasm/字体)、全路径 rewrite
src/app.ts              Fastify 组装：错误格式、no-store、multipart 原始体收集
src/config.ts           环境变量解析（fail closed + warnings）
src/auth/               机器 token(仅存 sha256)、管理员 GitHub 登录会话、CSRF、Cookie
src/routes/             /v1 路由（api.ts / auth.ts）
src/repo/               HEAD 缓存、Snapshot(单 commit + 读预算 + LRU)、sync-read 适配、Publisher(Git Data API)
src/services/assets.ts  读/搜/内容 302/上传/修改/审核/墓碑/操作回执 + 幂等
src/services/renders.ts 轻量模板渲染（A 的 light-v1 模板 → SVG → resvg-wasm，worker 硬超时）
src/domain/             图片校验与隐私元数据剥离、元数据解析、幂等键
src/github/             App JWT → installation token（仅 A 仓库、contents:write）、仓库客户端
vendor/sticker-assets/  A 的 lib/schemas/config/fixtures/CONTRACT（只读副本，不手改）
tests/                  fake GitHub（本地 127.0.0.1:0）+ 18 个测试；scripts/smoke.ts 端到端冒烟
```

## API 摘要（详见 openapi.yaml）

公开（无需登录，`Cache-Control: no-store`，响应带 `commit`）：
- `GET /v1/assets?q=&category=&tag=&sort=relevance|uploaded&limit=1..50&cursor=`
- `GET /v1/assets/{id}`（ETag = revision；墓碑 410）
- `GET /v1/assets/{id}/content[?source=<mirrorId>]` → 302 到 A 镜像候选或 raw（钉 commit）；墓碑 410
- `GET /v1/templates`
- `GET /v1/health`

写（`Authorization: Bearer <machine token>` 或 管理员会话 + `Origin` + `X-CSRF-Token`）：
- `POST /v1/assets`（`assets:write`，必须 `Idempotency-Key`，multipart：`file` + `metadata` JSON）→ 201 created / 200 duplicate
- `PATCH /v1/assets/{id}`、`POST /v1/assets/{id}/review`（`assets:moderate`，必须 `If-Match`）
- `DELETE /v1/assets/{id}?reason=rights|privacy|quality|duplicate|policy|other`（`assets:moderate`，墓碑）
- `GET /v1/operations/{op}`（`operations:read`，机器需带原 `Idempotency-Key`）
- `POST /v1/renders`（`render`，JSON 或 multipart `request` + `image`）→ image/png
- `POST /v1/collect-runs` → 501（采集在 A Actions 中进行）

管理员登录：`GET /v1/auth/github/start` → GitHub → `/v1/auth/github/callback`；非白名单数字 id 一律 403、不发会话。
`GET /v1/auth/session` 返回 csrfToken；`POST /v1/auth/logout`。

## 本地运行

```bash
pnpm install
pnpm typecheck
pnpm test        # build + 18 个测试（fake GitHub，无网络、无真实写）
pnpm smoke       # build + 用 Vercel handler 跑完整流程，结束即退出
pnpm vendor:a    # 从 ../sticker-assets 重新复制 A 契约（A 升级时）
pnpm token:new xiaozhi assets:write,render,operations:read
# 连接真实 A 本地试跑：cp .env.example .env 填好后 `pnpm build && node --env-file=.env dist/src/server.js`
```

## 上线前 Fin 需要做的事

见本次交付报告；`.env.example` 列出了全部变量与两个 GitHub App 的建法。

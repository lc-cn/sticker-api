# sticker-api

小智表情包独立基础服务（本地优先）。

当前版本只提供：**上传 / 内容哈希去重 / 中文元数据检索 / 取原图 / 删除**。  
不连接聊天、不自动采集、不抓任意 URL、不做 OCR / 语义检索（仅预留字段与扩展点）。

## 设计要点

- 默认只监听 `127.0.0.1`（loopback），不主动开公网端口
- Token 鉴权：`Authorization: Bearer <STICKER_API_TOKEN>`
- 只接受真实图片魔数：`PNG / JPEG / GIF / WebP`
- 拒绝 SVG / HTML / XML 伪装
- 按文件内容 SHA-256 去重；重复上传幂等返回已有记录
- GIF / WebP **原字节原样存储与返回**，保留动画数据
- SQLite 存元数据，本地目录存原图；缓存若启用只作用于响应，**不会静默删除已收藏正本**
- 不存发图人身份，不存聊天原文；`sourceKind` / `sourceNote` 仅可选非身份来源说明
- `createdAt` 是首次收录时间，不是热度，也不是梗流行时间

## 环境要求

- Node.js >= 22（本机验证用过 Node 24，内置 `node:sqlite`）
- pnpm 或 npm

## 快速开始

```bash
cd /Users/liuchunlang/IdeaProjects/sticker-api
cp .env.example .env
# 编辑 .env，把 STICKER_API_TOKEN 换成你自己的长随机串（不要用示例值）

pnpm install
pnpm typecheck
pnpm test
pnpm build

# 载入环境变量后启动（示例）
set -a && source .env && set +a
pnpm start
```

服务默认地址：`http://127.0.0.1:8787`

健康检查：

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready
```

## API 摘要

完整契约见 [openapi.yaml](./openapi.yaml)。

### 上传

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/stickers" \
  -H "Authorization: Bearer $STICKER_API_TOKEN" \
  -F "file=@/path/to/sticker.gif;type=image/gif" \
  -F "title=熊猫头无语" \
  -F "textContent=我不理解" \
  -F "emotion=confused" \
  -F "tags=熊猫头,经典" \
  -F "sourceKind=manual" \
  -F "sourceNote=seed"
```

重复上传同一文件内容会返回 `200` + `deduplicated: true`。

### 搜索

```bash
curl -sS "http://127.0.0.1:8787/v1/stickers?q=熊猫&limit=20" \
  -H "Authorization: Bearer $STICKER_API_TOKEN"
```

### 元数据 / 修改 / 删除

```bash
curl -sS "http://127.0.0.1:8787/v1/stickers/<id>" \
  -H "Authorization: Bearer $STICKER_API_TOKEN"

curl -sS -X PATCH "http://127.0.0.1:8787/v1/stickers/<id>" \
  -H "Authorization: Bearer $STICKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"emotion":"happy","tags":["更新","熊猫头"]}'

curl -sS -X DELETE "http://127.0.0.1:8787/v1/stickers/<id>" \
  -H "Authorization: Bearer $STICKER_API_TOKEN"
```

### 取原图

```bash
curl -sS "http://127.0.0.1:8787/v1/stickers/<id>/file" \
  -H "Authorization: Bearer $STICKER_API_TOKEN" \
  -o out.gif
```

响应带正确 `Content-Type` 与 `ETag`（内容哈希）。

## 开发命令

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
```

## 目录

- `src/` 服务实现
- `tests/` 集成测试（上传、去重、鉴权、删除、重启持久、动图字节保真）
- `data/` 本地数据目录（默认 gitignore；正本图与 SQLite）
- `openapi.yaml` API 文档

## 明确未做（后续）

- 群聊自动采集 / 小智工具对接
- 任意 URL 抓取（避免 SSRF，延期）
- OCR、embedding 语义检索、LLM 自动打标
- 公网部署、鉴权体系统一到 zhin
- UI

## Docker（可选）

仓库附带轻量 `Dockerfile`，**默认不需要构建**。本地直接用 Node 即可。

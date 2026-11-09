# A ↔ B 共享契约（sticker-assets ⇄ sticker-api）

> 状态：**v1，A 侧已实现并本地测试通过**（2026-11-09，Asia/Manila）。A 是唯一图库权威；B 只能按本契约读写 A。
> 字段/格式如需改动：在本文件末尾“变更记录”追加一条，并同步改 `schemas/v1/*` 与 `lib/*`，A 的校验会拦截不一致。
> 本仓库无第三方依赖；`lib/*.mjs` 是纯 ESM、无 I/O 副作用，B 可按固定 A commit **原样拷贝（vendoring）**，不要自行重写分词/分片算法，否则 A 的 `check-index` 会判定索引陈旧。

## 0. 版本标识

- 仓库根 `sticker-assets.json`：`{"format":"sticker-assets","schemaVersion":1,"indexFormat":1,"tokenizer":"zh-bigram-v1"}`。
  B 读到未知的 `schemaVersion`/`indexFormat` 必须**停止写入并拒绝出图（fail closed）**，不得猜测。
- Schema（JSON Schema 2020-12，`$id` 为 `urn:sticker-assets:v1:<name>`）：

| 文件 | `$id` | 用途 |
|---|---|---|
| `schemas/v1/asset.schema.json` | `urn:sticker-assets:v1:asset` | 单个资产记录 |
| `schemas/v1/manifest-shard.schema.json` | `urn:sticker-assets:v1:manifest-shard` | `manifests/<hh>.json` |
| `schemas/v1/event.schema.json` | `urn:sticker-assets:v1:event` | `events/<hh>/<operationId>.json` |
| `schemas/v1/template.schema.json` | `urn:sticker-assets:v1:template` | `templates/<id>/<version>/template.json` |
| `schemas/v1/license.schema.json` | `urn:sticker-assets:v1:license` | `licenses/<licenseId>.json` |
| `schemas/v1/budget.schema.json` | `urn:sticker-assets:v1:budget` | `budgets/daily/<YYYY-MM-DD>.json` |
| `schemas/v1/index-catalog.schema.json` | `urn:sticker-assets:v1:index-catalog` | `indexes/catalog.json` |
| `schemas/v1/index-terms.schema.json` | `urn:sticker-assets:v1:index-terms` | `indexes/terms/<tt>.json` |
| `schemas/v1/index-docs.schema.json` | `urn:sticker-assets:v1:index-docs` | `indexes/docs/<hhh>.json` |
| `schemas/v1/index-recent.schema.json` | `urn:sticker-assets:v1:index-recent` | `indexes/recent.json` |
| `schemas/v1/mirrors.schema.json` | `urn:sticker-assets:v1:mirrors` | `config/mirrors.json` |

- 分类枚举唯一来源：`config/taxonomy.json`（schema 里 `$defs.category.enum` 必须与之一致，校验脚本会比对）。

## 1. 目录与路径（全部小写，无用户可控文件名）

```text
sticker-assets.json                      # 版本标识
objects/sha256/<hh>/<sha256>.<ext>       # 发布字节；hh=sha256前2位；ext ∈ png|jpg|gif
manifests/<hh>.json                      # 该前缀下全部资产记录（含 archived/tombstoned），按 id 升序
events/<oo>/<operationId>.json           # oo = operationId 去掉 "op_" 后前2位
templates/<templateId>/<version>/template.json (+ 该目录内素材)
licenses/<licenseId>.json                # 公开许可/授权说明；私密证据不入A
budgets/daily/<YYYY-MM-DD>.json          # Asia/Manila 自然日的成功发布量
indexes/catalog.json | recent.json | terms/<tt>.json | docs/<hhh>.json   # 派生物，可重建
config/taxonomy.json | synonyms.json | limits.json | mirrors.json
fixtures/sample-repo/                    # 自制小图组成的完整迷你A树，供 B 测试直接使用
```

- `sha256` = **发布字节**的 SHA-256（小写64位hex）。`id = "sha256:" + sha256`。
- `ext`：`image/png→png`，`image/jpeg→jpg`，`image/gif→gif`。v1 拒绝 SVG/WebP/APNG/动画WebP/其它。
- 对象路径正则：`^objects/sha256/([0-9a-f]{2})/(\1[0-9a-f]{62})\.(png|jpg|gif)$`。
- 文件格式：除 `objects/` 与模板二进制素材外，JSON 统一 UTF-8、`JSON.stringify(v, null, 2) + "\n"`（manifests/events/licenses/templates/budgets/config）；`indexes/**` 用紧凑 `JSON.stringify(v) + "\n"`。校验会拒绝非规范格式。

## 2. 资产记录（`asset.schema.json` 要点）

```jsonc
{
  "id": "sha256:<64hex>",
  "revision": 1,                       // 每次元数据/状态变化 +1；PATCH If-Match 用它
  "status": "active",                  // active | archived | tombstoned
  "object": { "sha256": "…", "path": "objects/sha256/ab/….png", "mime": "image/png",
              "bytes": 1234, "width": 64, "height": 64, "frames": 1, "animated": false },
  "originalSha256": null,              // 处理前(剥EXIF前)hash，可空；不同于发布hash时才填
  "title": "≤80字",
  "categories": ["laugh"],             // 1..5，枚举见 config/taxonomy.json
  "tags": ["哈哈"],                    // 0..20，单个≤24字符，规范化后唯一
  "aliases": [],                       // 0..20，同上
  "language": "zh-CN",
  "tone": "positive",                  // positive|neutral|negative|sarcastic
  "safety": { "rating": "general", "offensive": false },   // rating: general|mild|sensitive
  "text": { "ocr": null, "ocrSource": null, "ocrConfirmed": false },  // 仅 ocrConfirmed=true 进索引
  "uploadedAt": "2026-11-09T03:28:00Z", // UTC，服务端首次接纳时写一次，之后永不改
  "firstSeenAt": null,                 // 可空；仅“允许范围内首次观察”
  "source": { "kind": "self-created", "adapter": null, "url": null, "itemId": null,
              "publishedAt": null, "confidence": "none" },
  "rights": { "basis": "self-created", "licenseId": "self-created-fin", "reviewedAt": "…Z", "publicUrl": null },
  "updatedAt": "…Z",
  "lastOperationId": "op_<32hex>",     // 可空（手工维护提交）
  "archivedAt": null,
  "deletedAt": null,
  "tombstone": null                    // tombstoned 时 {"reason": rights|privacy|quality|duplicate|policy|other}
}
```

- 时间一律 `YYYY-MM-DDTHH:MM:SS(.sss)?Z`（UTC）。展示层转 Asia/Manila。
- `source.kind`：`self-created | manual-collection | approved-list | adapter | import`；`confidence`：`none|low|medium|high`；未知发布时间填 `null`。
- `rights.basis`：schema 允许 `self-created | license | creator-permission | pending`，**但 A 的校验拒绝 `pending`**（待定图留在 Mac 私密候选区，不进 A）。`licenseId` 必须对应 `licenses/<id>.json`。
- 生命周期规则（校验强制）：
  - `active`/`archived`：对象文件必须存在，hash/大小/宽高/帧数与实际字节一致。
  - `archived`：可按 id 读取，**不进搜索索引**，`archivedAt` 必填。
  - `tombstoned`：对象文件**必须已从当前树删除**；记录保留（含 sha256）以阻止同 hash 重传复活；`deletedAt`、`tombstone.reason` 必填。恢复只能由独立管理员审核操作（新 revision、新事件）。
  - 不允许孤儿对象（有文件无记录）。
- 禁止出现的键（任意层级，校验拦截）：`principal, userId, userName, login, email, groupId, chatId, qq, token, accessToken, refreshToken, cookie, idempotencyKey, password, secret, privateEvidence`。

## 3. 事件（`event.schema.json` 要点）

```jsonc
{
  "schemaVersion": 1,
  "operationId": "op_<32hex>",
  "type": "asset.create",   // asset.create|asset.update|asset.archive|asset.tombstone|asset.restore|asset.review|template.publish|index.rebuild|import.batch
  "occurredAt": "…Z",
  "actorKind": "admin",     // admin|machine|actions —— 不记录具体是谁
  "idempotency": { "keyId": "k1", "keyHmac": "<64hex>" } ,      // 可空；HMAC(服务端密钥, scope+"\n"+客户端key)
  "requestFingerprint": { "keyId": "k1", "hmac": "<64hex>" },   // 可空；同key异体→409 用
  "assets": [ { "id": "sha256:…", "revision": 1 } ],
  "summary": { "added": 1, "addedBytes": 1234 }
}
```

- 建议（B 决定）：有 Idempotency-Key 时 `operationId = "op_" + HMAC_SHA256(secret[keyId], "sticker-op/v1\n"+scope+"\n"+key).hex[0:32]`，这样重试天然同 ID，且查询只需 `events/<oo>/<operationId>.json` 是否存在；密钥轮换窗口内逐个 keyId 尝试。无 key 时随机 128bit。
- 事件里只放高熵ID/HMAC和公开资源引用，不放 principal、原始 key、聊天/举报原文。

## 4. 原子提交协议（B 写 A 时）

一次逻辑操作 = **一个** commit，唯一 parent = 读取时的 HEAD `H`，包含且仅包含：
1. 新对象 blob（`asset.create`），或删除对象文件（`asset.tombstone`）；
2. 受影响的 `manifests/<hh>.json`（规范格式，assets 按 id 升序）；
3. 用 `lib/indexer.mjs` 的 `applyAssetChange()` 增量更新得到的受影响索引文件（catalog、recent、terms/*、docs/*）——结果必须与全量 `buildIndex()` 逐字节一致；
4. `events/<oo>/<operationId>.json`；
5. 当天 `budgets/daily/<date>.json`（create 时）。

Git 流程：GET ref → 固定 H 读受影响 manifest/索引/预算/tombstone → create blobs → create tree（`base_tree=H` 的 tree）→ create commit（parents=[H]）→ update ref `force:false`。冲突（非快进）→ 重读新 HEAD 与 tombstone/预算/幂等/revision 后重建，有限重试；**绝不 force，绝不复用旧 tree**。
建议 commit message：`sticker: <type> <sha256前12位> ` + 空行 + trailer `Sticker-Operation: op_…`。

发布前 B 必须自检（与 A CI 相同的规则）：hash/路径/尺寸/帧数/体积、分类/标签上限、rights≠pending、tombstone 不复活、容量与当日预算。

## 5. 限额（`config/limits.json`，校验强制；B 读同一文件）

| 项 | 值 |
|---|---|
| 资产数（active+archived） | ≤ 3000 |
| 仓库当前树受管字节（objects+templates+manifests+indexes+events+budgets+licenses） | ≤ 500 MiB；≥ 250 MiB 告警 |
| 单对象 | ≤ 2 MiB；长边 ≤ 2048；单帧画布 ≤ 4 MP；帧 ≤ 60；帧数×画布 ≤ 24 MP |
| 每日成功发布 | ≤ 100 张、≤ 40 MiB（Asia/Manila 自然日） |
| catalog ≤ 256 KiB；任一 manifest/terms/docs 分片 ≤ 128 KiB；recent ≤ 128 KiB |
| tags/aliases ≤ 20，单个 ≤ 24 字符；title ≤ 80；categories 1..5 |

元数据含 PNG `eXIf`/`tEXt`/`iTXt`/`zTXt`、JPEG `APP1 Exif/XMP` 的对象会被拒绝（发布前须剥离且不得破坏 GIF 动画）。

## 6. 搜索索引格式（indexFormat 1，tokenizer `zh-bigram-v1`）

只索引 `status=active`。读取一次查询时**固定一个 commit**，所有文件都从该 commit 取。

- `indexes/catalog.json`：`counts{active,archived,tombstoned}`、`bytes{objects,templates}`（planCreate 用 objects+templates 近似检查 500MiB；完整受管字节由 CI 校验）、`categories{slug:activeCount}`、`termShardCount`(=128，来自 limits)、`docShardPrefixLength`(=3)、`termShards[]`/`docShards[]`（非空分片ID列表；不在列表里=空，不要请求）、`templates[]`（`{id,version,path,title,status}`，供 `GET /templates`）、`synonymsSha256`、`limits`。无时间戳，保证可重建一致。
- `indexes/recent.json`：`{"items":[[docKey, uploadedAtUnix秒]…]}`，按时间降序、同时刻 key 升序；用于无关键词浏览，以及检索排序的 uploadedAt 二级键（不必读全部 docs 分片）。
- `indexes/terms/<tt>.json`：`{"terms":{"<term>":[["<docKey>",<weight>],…]}}`；postings 按 weight 降序、key 升序。
  - `tt = fnv1a32(utf8(term)) % termShardCount`，两位小写hex（当前 `00`..`7f`）。
  - `docKey` = sha256 前 12 位 hex（校验保证唯一）。
  - 特殊词：`cat:<slug>`（分类过滤）、`tag:<规范化tag>`（精确标签）。
- `indexes/docs/<hhh>.json`：`{"docs":{"<docKey>":{id,path,mime,bytes,width,height,frames,animated,title,categories,tags,tone,safety,uploadedAt,publishedAt,revision}}}`，`hhh`=sha256前**3**位（比 manifests 细，便于每页只读少量小文件）。

**分词 `zh-bigram-v1`（索引与查询共用 `lib/tokenize.mjs`）**：NFKC → 小写 → 标点/符号转空格 → 按空白切段；每段：整段作为词（≤24字符）；段内连续汉字/假名 run 产生相邻二字 gram（run 长 1 时取单字）；拉丁/数字 run 作为整词。
**索引权重**（同 term 同 doc 取和，上限 100）：tag 整词 10、alias 整词 8、title 整词 6、同义词扩展 5、确认OCR 整词 3、tag/alias 二字 3、title 二字 2、OCR 二字 1；`cat:`=1，`tag:`=10。同义词在**索引时**按 `config/synonyms.json` 扩展，查询时不扩展。
**查询算法**：参考实现 `lib/search.mjs#search(read, {q, category, tag, limit, offset})`：`queryTerms(q)` → 按 term 求 shard → 只读 catalog 列出的 shard → 按 docKey 累加 weight（category/tag 作为 `cat:`/`tag:` 过滤集合）→ 排序（score 降序、uploadedAt 降序、key 升序）→ 截前 200 候选 → 分页最多 50 → 只读页内 docs 分片。出图前 B 仍须再确认当前状态（tombstone）。fixture 上一次查询读入约 2–4 KB；`scripts/capacity-sim.mjs 3000` 用 3000 条合成元数据实测：最大 terms 分片约 66KB、docs 分片约 3KB、recent 约 84KB、catalog 约 14KB，每页 50 的最坏查询读入约 274KB（< 512KiB 门槛）。该模拟已加入 CI。

## 6.1 `lib/` 模块（零依赖，B 按固定 A commit 原样拷贝 `lib/` + `schemas/` + `config/` 即可）

| 模块 | 用途 |
|---|---|
| `tokenize.mjs` | `normalize`、`analyze`、`queryTerms`（zh-bigram-v1） |
| `indexer.mjs` | `buildIndex(ctx)` 全量；`applyAssetChange(read, before, after, ctx)` 增量；`docKey`/`termShard`/`paths` |
| `commit-plan.mjs` | `planCreate / planUpdate / planArchive / planTombstone(read, …, ctx)` → `{changes: Map(path→Buffer|string|null)}`，即**一个原子 commit 的完整文件变更**；`PlanError.code`：`unsupported_media_type, invalid_image, metadata_not_stripped, payload_too_large, decode_budget_exceeded, tombstoned, invalid_metadata, unknown_license, repo_not_initialized, capacity_exceeded, daily_budget_exceeded, not_found, precondition_failed, conflict, gone`；重复图返回 `{kind:'duplicate', asset}`（不改 uploadedAt） |
| `search.mjs` | 参考检索 |
| `urls.mjs` | `candidateUrls({commit, path}, mirrorsConfig)` |
| `image.mjs` / `strip.mjs` | 结构检查（mime/尺寸/帧/元数据/APNG）与无损元数据剥离（GIF 帧数不变，失败即拒绝） |
| `validator.mjs` | `validateRepo(root)`（I/O，CI 与本地用） |
| `jsonschema.mjs` | 零依赖 2020-12 子集校验器；`loadSchemas()` 在 validator 中 |

`ctx = { synonyms, limits, registry? }`；`read(path)` 必须只读同一个 commit H 的内容（文本返回 string，图片可返回 Buffer）。`planCreate` 的 `op = { bytes, meta, uploadedAt, operationId, actorKind, idempotency?, requestFingerprint?, originalSha256? }`；更新类 `op = { at, operationId, actorKind, expectedRevision, patch? | reason? }`。
可修改字段（PATCH）：`title, categories, tags, aliases, language, tone, safety, text, firstSeenAt, source, rights`；`uploadedAt/object/id` 不可改。恢复 tombstone（asset.restore）首版未实现，需独立管理员流程。

## 6.2 fixture

`fixtures/sample-repo/` 是完整迷你 A 树（自绘图，无网络图片）：4 active（PNG×2、GIF 3帧动画、JPEG）、1 archived、1 tombstoned、1 模板 `caption-bar@1`、9 个事件、3 天预算。`config/mirrors.json` 的 owner/repo 是占位 `example-owner/sticker-assets`。B 的测试可用 `read = p => fs.readFileSync('fixtures/sample-repo/'+p)` 直接驱动 `search`/`planCreate`。

## 7. 镜像 URL（`config/mirrors.json` + `lib/urls.mjs`）

- 只能用 **完整 40 位 commit + 固定 path** 拼接，不用分支名、不用 Contents API 的临时 download_url。
- 源站模板：`https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{path}`（始终保留作回退）。
- 候选（默认 **disabled**，验收通过并填写 `verifiedAt` 才可启用）：
  - `https://gh-proxy.com/https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{path}`
  - `https://ghfast.top/https://raw.githubusercontent.com/{owner}/{repo}/{commit}/{path}`
- `lib/urls.mjs` 的 `candidateUrls({commit, path}, mirrorsConfig)` 返回有序列表：启用的镜像 → raw。客户端不能传任意 proxy；取图后必须校验 sha256。`owner/repo` 目前为 `null`（远程仓库未创建，需 Fin 另行授权）。

## 8. Actions 边界

A 内 workflow：`validate.yml`（push/PR，只读）、`rebuild-index.yml`（仅手动，contents:write，同 run 内校验后非 force 推送）、`collect.yml`（采集占位，**默认关闭**：需仓库变量 `COLLECT_ENABLED=true` 且仅 `workflow_dispatch`，当前无任何已批准适配器、不联网）。
用户触发的在线作业（上传、搜索、制图、删除）**只走 B**，不得 dispatch Actions 等结果。

## 变更记录

- 2026-11-09 v1 草案（A 侧 executor）。
- 2026-11-09 v1.1：容量模拟发现 64 terms 分片 + 2位 docs 分片在 3000 条、每页 50 时最坏查询读入 586KB > 512KiB；改为 termShardCount=128、docs 按 sha256 前3位分片，catalog 新增 `docShardPrefixLength`。
- 2026-11-09 v1：recent.json 改为 `items:[[key, unixSec]]`；新增 §6.1 lib 模块说明（commit-plan/search/strip）与 §6.2 fixture；本地测试 35 项通过。

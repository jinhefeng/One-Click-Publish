# Delivery Plan: Cloudflare-first One-Click Publish

## Contract register

### Contract C-001 — Publish Bundle

- Status: frozen
- Producer: CMP-001 / WP-002
- Consumers: CMP-004 / WP-003, CMP-005 / WP-005
- Owner: WP-001
- Inputs: 编译器接收 `sourcePath`、`title`、Markdown 文本和可选资源
- Outputs: `PublishBundle`，包含版本号、站点标题、页面列表和资源列表
- Compatibility: `formatVersion` 当前为 `1`；路径必须是相对 POSIX 路径且不能包含 `..`；HTML/资源内容不得携带本地绝对路径；页面中的标题区可使用原生 `<details>/<summary>` 静态折叠，不依赖脚本；代码块复制由发布页 shell 的委托事件处理
- Verification: `tests/publish-flow.test.ts` 的 bundle shape 和路径断言
- Change rule: 变更必须更新 fixture、消费者和本文件；破坏性变更提升 `formatVersion`

### Contract C-002 — Publish API

- Status: extended
- Producer: CMP-004 / WP-003
- Consumers: CMP-003 / WP-004
- Owner: WP-001
- Inputs: `PublishRequest { siteId?, idempotencyKey, bundle }`
- Outputs: `PublishResult { siteId, url, revision, uploadedPaths }`
- Compatibility: API 前缀 `/v1`；成功返回 200/201；发布会话首次可省略 `siteId`；重复 `idempotencyKey` 返回同一结果；非法请求返回安全的 `{ error, code }`；未授权返回 401；单次请求超过 Worker 边界返回 413 `QUOTA_EXCEEDED`；不设置账户级内容配额或发布 Note 数量上限。
- Verification: 本地内存服务测试；接入 Worker 后补充 HTTP fixture
- Change rule: 修改请求/响应、状态码或错误格式前，必须通知 WP-002/WP-004 并更新契约测试

### Contract C-005 — Queued Publish Upload

- Status: changed — protocol v2
- Producer: CMP-003 / WP-004
- Consumers: CMP-004 / WP-003
- Owner: WP-001
- Inputs: `POST /v1/sites/uploads` 接收 `siteId?`、`idempotencyKey`、`formatVersion: 1`、`chunkProtocolVersion: 2`、`sourcePath`、`title`、`chunkCount`、`objectCount`、`totalBytes`；chunk 接收 `kind`、`path`、`contentType`、`encoding`、`chunkIndex`、`chunkCount`、`byteLength` 和 `body`。
- Outputs: 开始上传返回 `{ uploadId, siteId, revision }`；块上传返回接收状态；提交返回 C-002 的 `PublishResult`
- Compatibility: 每个页面 UTF-8 chunk 直接拼接；每个二进制资源 chunk 是独立 base64 串，服务端收到后立即解码并以原始 bytes 写入官方 R2 或个人 D1 BLOB；个人路径使用 1 MB chunk、20 MB 单对象上限；重复块必须幂等；只有全部对象完整且 bundle 校验通过后才切换 current revision；分片或提交失败不得影响旧 revision；每个请求只承载一个小块；`PublishBundle.formatVersion` 仍为 1。
- Verification: `tests/publish-flow.test.ts` 和 `tests/cloudflare-core.test.ts` 的分片组装、独立二进制解码、HTTP 生命周期、重复提交和不完整上传保旧版本断言
- Change rule: 分片字段、上传会话状态或提交时机变更必须同步插件、发布服务和契约测试；生产 Worker 需要保留同样的原子提交语义

### Contract C-006 — Account and device authorization

- Status: implemented locally
- Producer: CMP-010 / WP-CF-1
- Consumers: CMP-003 / WP-CF-3, CMP-011 / WP-CF-5, CMP-012 / WP-CF-6
- Inputs: `/v1/auth/register|login|logout|device/start|device/poll|device/approve`, `/v1/account/recover`；Session cookie 和 `pn_` Publish Token。
- Outputs: 一次性恢复码、10 分钟单次设备码、一次性 Publish Token、Token metadata 和安全错误码。
- Compatibility: Token 仅 scope `publish:write`；数据库只保存哈希；恢复会撤销已有 sessions/tokens；错误不泄露邮箱、Token 或站点归属。
- Verification: `tests/cloudflare-core.test.ts`；真实官方和自部署环境待凭据接入。

### Contract C-007 — Cloudflare deployment and storage

- Status: implemented locally / remote pending
- Producer: CMP-013 / WP-CF-2, WP-CF-4
- Consumers: Worker, console, release validation
- Inputs: `wrangler.jsonc`、D1 migration、可选官方 R2 binding、`BOOTSTRAP_SECRET`、可选 `PUBLIC_BASE_URL`。
- Outputs: personal D1 BLOB chunks or official private R2 chunks、D1 tenant metadata、`/s/{siteId}` current viewer、cron cleanup。
- Compatibility: 缺少 `CONTENTS` binding 时使用 D1-only；官方 R2 key 使用 tenant/site/revision/object/chunk 前缀；D1 batch 才能更新 current；默认 workers.dev，PUBLIC_BASE_URL 可覆盖分享域名；Worker 通过自定义域名访问时以当前请求 origin 生成分享链接。
- Verification: migration/schema checks、Node Worker import、`wrangler dev`/staging/production smoke。

### Contract C-008 — Desktop-direct personal Cloudflare provisioning

- Status: implemented locally / remote pending
- Producer: CMP-016 / WP-CF-7
- Consumers: CMP-003 / WP-CF-5, CMP-015 / WP-CF-4, release validation
- Inputs: Cloudflare Authorization Code callback `code/state` on `http://127.0.0.1:8976/oauth/callback`, S256 PKCE verifier, Cloudflare REST API, embedded Worker bundle and migration
- Outputs: `{ serviceUrl, workerName, publishToken }`; the plugin saves the Worker origin, active publish URL, and scoped Publish Token
- Compatibility: public OAuth Client has no client secret and requests only account-read, Workers Scripts write, and D1 write scopes for deployment; callback is loopback-only, state-checked, single-use and time-limited; access token stays in memory and is revoked after success/failure; only Worker/D1 conflicts are checked and never overwritten; target initialization accepts only one-time bootstrap secret plus short-lived HMAC claim; no R2 bucket is created; `server/provisioner` is not in the new personal path. Existing personal Worker/D1 pairs can be refreshed in place from a newer embedded artifact without replacing the Worker URL, D1 data, or active custom domain. The Worker reports the deployed plugin version through `/healthz`; the settings page warns on a historical or unverifiable version, and publishing stops until a manual update succeeds. A later custom-domain action uses a separate temporary OAuth scope for Workers custom domains and Zone Read, stores no management token, and keeps workers.dev as the fallback origin.
- Verification: `tests/plugin-cloudflare.test.ts` covers PKCE, direct resource creation, revoke, mobile guard and name conflicts; `tests/provisioning.test.ts` remains a legacy control-plane regression; real desktop/Cloudflare smoke remains pending
- Change rule: resource names, OAuth scopes, artifact version, callback lifetime or target initialization claim changes require plugin, Worker artifact, build and security tests together

### Contract C-009 — Obsidian plugin release artifacts

- Status: frozen for 0.3.1
- Producer: CMP-017 / WP-005
- Consumers: Obsidian Community directory, GitHub Release, local Obsidian Vault
- Owner: T5
- Inputs: hand-maintained `plugin/manifest.json` and self-contained `plugin/main.js`; optional `plugin/styles.css`
- Outputs: root `manifest.json`/`main.js` mirrors, `dist/obsidian-release/` assets, and Vault `.obsidian/plugins/one-click-publish/` runtime files
- Compatibility: `plugin/manifest.json` is the sole version authority; all generated manifest and runtime copies must be byte-identical to their source; Release tag must equal the `x.y.z` manifest version; `plugin/compiler.js`, source directories, and test files are never Release assets
- Verification: `scripts/package-plugin.mjs`, `npm run check:plugin`, `npm run update:plugin`, and `.github/workflows/plugin-release.yml`
- Change rule: changing the source/target mapping, allowed Release files, or version authority requires updating the packaging script, parity check, README pairs, AGENTS.md, and release workflow together

### Contract C-010 — Personal custom domain binding

- Status: implemented locally / remote pending
- Producer: CMP-016 / WP-CF-8
- Consumers: Obsidian settings, personal Worker viewer and publish client
- Owner: T4
- Inputs: root domain or subdomain, single-account Cloudflare OAuth authorization, existing personal Worker name
- Outputs: active custom-domain URL, custom-domain metadata, and request-origin-based `/s/{siteId}` links; unbind restores the workers.dev URL
- Compatibility: the hostname must belong to an active Zone in the authorized account; root domains and subdomains are accepted; v1 allows one primary custom domain per Worker; root-domain binding requires explicit confirmation; management access tokens remain memory-only and are revoked after the operation; workers.dev remains the fallback when no custom domain is active
- Verification: `tests/plugin-cloudflare.test.ts` covers bind/unbind, PKCE scope, zone lookup and token revoke; `tests/cloudflare-core.test.ts` covers request-origin URL generation; real Cloudflare domain/certificate smoke remains pending
- Change rule: changing domain ownership, OAuth scopes, active URL semantics, or one-domain policy requires updating plugin, Worker route, tests, README pairs, ADR-007 and this contract

### Contract C-003 — Site Metadata and revision rules

- Status: frozen
- Producer: CMP-004 / WP-003
- Consumers: CMP-005 / WP-005, CMP-006 / WP-003
- Owner: WP-003
- Inputs: `siteId`, `revision`, `sourcePath`, `title`, `currentRevision`
- Outputs: 当前站点记录和 revision 资源索引
- Compatibility: 同一站点 revision 单调递增；只有资源全部校验成功后才更新 current；失败重试不得改变 current；成功更新后只保留 current revision，旧索引及官方 R2 对象或个人 D1 BLOB 清理。
- Verification: update、idempotency 和 failed-commit tests
- Change rule: 任何 current 指针或 revision 语义变更必须更新 ADR 和回滚验证

### Contract C-004 — Site URL and path mapping

- Status: frozen
- Producer: CMP-006 / WP-003
- Consumers: Plugin, browser, integration tests
- Owner: WP-003
- Inputs: `siteId` 和浏览器路径 `/s/{siteId}/{path}`
- Outputs: current revision 中对应的站点内页面或资源；无路径时使用 `index.html`；HTML 页面必须恢复可滚动的普通文档流
- Compatibility: 根页面固定为 `index.html`；引用页面在同一站点目录下使用 `page-N.html`，编号按规范化源路径排序并在重复引用时只保留一个页面；新站点使用不可预测的随机 siteId，更新时保持不变；MVP 产品域名由部署配置提供；不存在站点返回 404
- Verification: local viewer tests and later deployed smoke test
- Change rule: URL 形态变更需同时更新插件复制链接行为和 README 示例

## Work packages

### WP-001 — Foundation and local vertical slice

- `package_id`: WP-001
- `goal`: 建立可运行的共享契约、最小编译器、内存发布服务和 viewer 测试
- `owner`: Codex
- `scope`: `src/shared`, `src/compiler`, `src/publish`, `scripts/local-publish-server.ts`, `start.sh`, `tests`, `.engineering`
- `non_goals`: 真实 Cloudflare、Obsidian API、完整 Markdown 语义
- `dependencies`: none
- `acceptance`: `node --experimental-strip-types --test tests/publish-flow.test.ts` 通过；首发、重复发布、更新和 viewer 读取均有断言
- `status`: complete
- `task_refs`: T1, T1.1, T1.2, T1.3
- `validation`: `npm test` passed on 2026-09-15; 25 tests passed, including queued upload assembly, atomic commit, auth/recovery/device pairing, account isolation, migration coverage, linked-page depth boundaries, and external-link preservation.

### WP-002 — Content compiler

- `package_id`: WP-002
- `goal`: 支持单笔记入口及可选引用页面的 Obsidian 内容编译
- `owner`: Codex
- `scope`: `src/compiler`
- `non_goals`: 发布 API、用户设置、Cloudflare 认证
- `dependencies`: C-001, WP-001
- `acceptance`: fixture 覆盖 Markdown 基础语法、WikiLink、相对 Markdown 文档链接、图片、Callout、代码块复制、表格、标题折叠和页面导航
- `status`: active
- `task_refs`: T2
- `validation`: `npm test` passed on 2026-09-15; compiler fixtures cover note rendering, referenced assets, moved-target relative links, site-local deduplication, independent site addresses, root/related-page navigation, heading folding, scroll-safe page layout, depth 0/1/2/3 traversal, and external-link preservation. The specified Vault note measures 1/5/11/22 reachable pages at depths 0/1/2/3; fresh Obsidian linked-page content smoke remains open.

### WP-003 — Cloudflare publish service

- `package_id`: WP-003
- `goal`: 用 Worker + D1 替换内存服务，并让官方环境可选私有 R2
- `owner`: Codex
- `scope`: `server/worker`, deployment configuration
- `non_goals`: GitLab、Cloudflare Pages、团队、计费、分析统计和历史 revision UI
- `dependencies`: C-001, C-002, C-003, C-004, C-005, WP-001
- `acceptance`: 发布/更新/访问/失败恢复在 Cloudflare 环境通过；个人部署不需要 R2，官方 R2 不公开暴露
- `status`: active — local core and Worker implementation complete; real Cloudflare environment pending
- `task_refs`: T3

### WP-004 — Obsidian plugin UX

- `package_id`: WP-004
- `goal`: 在 Obsidian 中完成配置、发布、更新和复制链接
- `owner`: Codex
- `scope`: `plugin/`
- `non_goals`: 模板市场、账号注册、站点管理后台
- `dependencies`: C-001, C-002, C-004, C-005, C-006, WP-001
- `acceptance`: 只有当前笔记能触发发布；引用深度默认 `1` 且可设为 `0` 或任意更大整数；新站点使用随机不透明目录，根页面为 `index.html`；默认优先使用 Obsidian 原生渲染快照；原生渲染失败可回退；页面和附件通过 C-005 小块队列上传并在最后原子提交；发布成功显示并复制稳定链接；公开页代码块可复制；错误可见且不丢失旧链接
- `status`: active — Cloudflare connection wizard and token migration implemented; real service smoke pending
- `task_refs`: T4
- `validation`: `npm run check:plugin` and `npm test` passed; real Obsidian current-note first publish and update both passed on 2026-09-14; native snapshot path, dynamic-block wait, basic Tasks snapshot fallback, original filename paths, CSS/typography snapshot, scroll-safe page layout, hover-only heading folding, code-block copy interaction, root/related-page entry, local asset collection, depth-limited traversal, sequential chunk upload, and external-link bypass are implemented, pending fresh Obsidian plugin-content smoke.

### WP-005 — Integration and release validation

- `package_id`: WP-005
- `goal`: 验证插件、发布服务和 viewer 的完整 MVP 链路
- `owner`: Codex
- `scope`: `tests`, smoke scripts, release docs, `scripts/package-plugin.mjs`, root plugin mirrors, `LICENSE`, and `.github/workflows/plugin-release.yml`
- `non_goals`: 生产运营、计费、内容审核平台
- `dependencies`: WP-002, WP-003, WP-004, C-003, C-004
- `acceptance`: 首发、更新、幂等重试、失败回滚、链接访问和资源路径检查全部有证据；插件源文件可生成一致的根目录镜像、Release 暂存包和 Vault runtime；社区提交要求的 manifest、README、LICENSE、版本 tag 和 Release assets 可校验
- `status`: active — plugin distribution synchronization implemented locally; remote main/release/community submission pending
- `task_refs`: T5

### WP-CF-1 — Portable Cloudflare service core

- `package_id`: WP-CF-1
- `goal`: 建立 Worker-compatible 的认证、设备授权、Token、上传、提交和 Viewer 核心，并保留请求/滥用边界。
- `scope`: `server/core`, `server/worker/routes.ts`, `server/console`, C-005 v2 tests
- `dependencies`: C-001, C-005
- `acceptance`: Node mock 可完成注册、恢复、device pairing、Token、上传、提交和 viewer；本地内存服务继续作为测试替身，并验证超过原账户内容配额后仍可提交。
- `status`: complete locally
- `validation`: `npm test` 22 tests passed; `npm run check:worker` passed.

### WP-CF-2 — Official R2/D1 and personal D1-only storage adapter

- `package_id`: WP-CF-2
- `goal`: 建立 D1 migration、官方 R2 immutable chunk key、个人 D1 BLOB chunk、batch current switch、old revision and expired upload cleanup。
- `scope`: `server/storage/cloudflare-d1-r2`, `server/storage/migrations`
- `dependencies`: C-003, C-005, C-007
- `acceptance`: incomplete upload cannot change current; update only leaves current metadata; viewer lazily streams official R2 or personal D1 BLOB chunks。
- `status`: implemented locally; `wrangler dev` pending

### WP-CF-3 — Official hosted multi-tenant service

- `package_id`: WP-CF-3
- `goal`: 用共享 D1/R2 和产品域名提供官方托管模式。
- `scope`: production Worker environment, account isolation, request/abuse limits
- `dependencies`: WP-CF-1, WP-CF-2, C-006, C-007
- `acceptance`: two accounts cannot read/update each other; official service can complete real Obsidian publish/update/delete.
- `status`: blocked on production Cloudflare credentials/domain, code ready

### WP-CF-4 — Self-deploy Worker

- `package_id`: WP-CF-4
- `goal`: 提供个人 Worker 的目标运行时和高级手动部署备用方案。
- `scope`: `wrangler.jsonc`, `.dev.vars.example`, target Worker bundle/migration, root README deployment guide
- `dependencies`: WP-CF-2, WP-CF-3 contract shape
- `acceptance`: new Cloudflare account can deploy, migrate, set bootstrap secret, initialize once, connect plugin, and publish.
- `status`: target runtime ready; Deploy Button/Wrangler/manual `/setup` are advanced fallbacks, desktop plugin direct provisioning is the ordinary path

### WP-CF-5 — Obsidian connection wizard

- `package_id`: WP-CF-5
- `goal`: 浏览器设备授权后自动保存 Publish Token，用户无需复制 Cloudflare Token。
- `scope`: `plugin/main.js`, plugin README
- `dependencies`: C-006, WP-CF-1
- `acceptance`: start/open/poll/stop flow works for official and custom Worker URL; token is not in frontmatter.
- `status`: implemented locally; real browser/Obsidian smoke pending

### WP-CF-6 — Console and integration evidence

- `package_id`: WP-CF-6
- `goal`: 完成 Token、usage、sites 控制台和真实环境验收证据。
- `scope`: `server/console`, `tests`, `.engineering/integration-checklist.md`
- `dependencies`: WP-CF-3, WP-CF-4, WP-CF-5
- `acceptance`: auth failure, request-size handling, delete, recovery, Worker failure, official and self-deploy paths all have evidence.
- `status`: console implemented; remote evidence pending

### WP-CF-7 — Desktop-direct personal Cloudflare deployment

- `package_id`: WP-CF-7
- `goal`: 让 Obsidian 桌面版通过公开 Cloudflare OAuth + PKCE 直接创建 Worker/D1、上传内嵌 artifact、初始化首个账户并保存 Publish Token。
- `scope`: `plugin/main.js`, `scripts/build-plugin.mjs`, `scripts/build-target-worker.mjs`, plugin deployment settings, direct OAuth/API tests; `server/provisioner` and provisioning D1 are compatibility-only
- `dependencies`: WP-CF-2, WP-CF-4, WP-CF-5, C-008
- `acceptance`: Node mock 可完成 loopback callback → token exchange → account/resource checks → resource creation → target initialization → bootstrap secret deletion → OAuth revoke；重复/冲突/中途失败不覆盖既有资源，移动端禁用部署但可使用同步后的 Worker 配置
- `status`: implemented locally; public OAuth client injection and real desktop/Cloudflare smoke pending

### WP-CF-8 — Personal custom domain binding

- `package_id`: WP-CF-8
- `goal`: 在设置页用一次短流程把当前个人 Worker 绑定到同一 Cloudflare 账户中的根域名或子域名，并可安全解绑。
- `scope`: `plugin/main.js`, `server/core/service.ts`, `server/worker/routes.ts`, plugin/Worker tests, README pairs and engineering contracts
- `dependencies`: C-004, C-007, C-008, C-010
- `acceptance`: Node mock 可完成 PKCE 授权、账户/Zone 查询、已有域名检查、Custom Domain attach/detach、OAuth revoke；Worker 从自定义域名访问时返回当前域名链接；workers.dev fallback、移动端 guard、根域名确认和一 Worker 一主域名均有断言
- `status`: implemented locally; real Cloudflare custom-domain/certificate smoke pending
- `task_refs`: T4.3.1, T5.1

## Parallelism and ownership review

| Boundary | Owner | Current write scope | Parallel rule |
|---|---|---|---|
| Shared contracts | WP-001 | `src/shared`, contract docs | WP-002/WP-003/WP-004 依赖冻结版本，不直接修改 |
| Compiler | WP-002 | `src/compiler` | 可与 WP-003 并行；契约变更需回到 WP-001 |
| Publish service | WP-003 | `server/core`, `server/worker` | 可与 WP-002/WP-004 并行；只消费 C-001/C-002/C-004 |
| Plugin | WP-004 | `plugin` | 依赖 C-002/C-004/C-008/C-010；不修改 compiler 内部实现 |
| Integration | WP-005 | `tests`, release docs | 只在依赖包形成可运行版本后执行 |

当前没有重叠写入范围；WP-001 完成后才开放真正的并行实现。

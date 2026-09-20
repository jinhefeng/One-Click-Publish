# Architecture Baseline: Cloudflare-first One-Click Publish

## Context

- Objective: 将一篇 Obsidian 笔记作为分享入口发布为稳定的公开网站，并按选项携带引用页面。
- In scope: 官方托管与用户自部署 Worker、官方服务控制面、桌面插件直连 Cloudflare OAuth/API 的个人部署、个人 Worker 的根域名/子域名绑定、单页入口、引用页面遍历、本地内容编译、随机不透明 siteId、发布包契约、账户/设备授权/Publish Token、官方 D1/R2 与个人 D1-only 站点存储、网页访问和失败安全切换。
- Out of scope: GitLab、Cloudflare Pages、本机插件 Web 服务、收费、搜索、统计、评论、密码保护、团队、历史 revision 回滚和主题市场。
- Evidence:
  - 当前仓库已有本地编译器、内存发布器、Worker core、D1/R2 adapter 和契约测试。
  - 已确认参考 `obsidian-htmlto-link` 的 Obsidian 交互，但不沿用其中心化服务实现。
  - 已确认 MVP 采用官方托管 + 用户自部署双模式，产品域名和 workers.dev/custom domain 均由部署配置决定。
  - 已完成本地编译器首轮 fixture 和真实 Obsidian 当前笔记首发/更新 smoke；插件已接入 Obsidian 原生渲染快照，最新引用页面内容 smoke 待执行。

## Boundaries

| Boundary | Responsibility | Owner | Depends on | Exposes |
|---|---|---|---|---|
| Obsidian Plugin | 读取当前笔记、按深度遍历可选的引用页面、提供命令/设置、优先调用 Obsidian 原生 Markdown/plugin renderer、采集引用资源、按小块队列调用发布服务、保存 siteId | T4 | Obsidian API, Compiler fallback, Publish API | 用户交互 |
| Content Compiler | 将根 Markdown、引用页面和本地资源转换为确定性的 PublishBundle，作为原生渲染不可用时的回退 | T2 | Shared contracts | `PublishBundle` |
| Worker HTTP Router | 解析 HTTP、JSON/form、Cookie/Bearer、控制台和公开 Viewer 路由 | T3 | Portable core | C-002/C-004 |
| Portable Publish/Auth Core | 账户、恢复码、设备授权、Token、上传会话、提交和 viewer 查询 | T3 | `PublishStorage`, Web Crypto | service API |
| Storage | 保存 revision 资源和站点元数据，支持原子 current 指针 | T3 | 官方 R2/D1、个人 D1 BLOB 或本地适配器 | `PublishStorage` |
| Console | 登录、注册、setup、Token、用量和站点删除的最小 HTML 页面 | T3 | Worker Router, Core | Browser UI |
| Viewer | 解析 `/s/{siteId}/{path}`，经 Worker 流式返回 current revision 的 HTML/asset | T3 | Storage | C-004 |
| Official Publish Control Plane | 官方托管路径的账户、设备授权、Publish Token、配额、租户隔离和站点管理 | T3 | Official Worker, D1/R2 | C-006/C-007 |
| Personal Desktop Provisioner | 桌面插件通过 Authorization Code + PKCE、loopback callback 和 Cloudflare API 创建个人 Worker/D1，执行 migration/初始化、绑定同账户 Zone 中的自定义域名并保存发布配置 | T4 | Cloudflare OAuth/API, embedded Worker artifact, target Worker | C-008/C-010 |
| Plugin Distribution and Release Packaging | 从 `plugin/` 唯一源生成根目录镜像、Release 暂存包和 Vault runtime，并校验版本/内容一致性 | T5 | Plugin artifact, manifest, Obsidian release rules | C-009 |
| Target Worker Bootstrap Boundary | 新建 Worker 接收一次性 bootstrap secret + HMAC claim，创建首个账户和 Publish Token；不依赖外部 provisioning control plane | T3/T4 | Target Worker, Personal Desktop Provisioner | C-008 |
| Legacy Provisioning Control Plane | 旧版 start/poll/ack 实现，仅为兼容窗口保留，不属于新的个人部署主链路 | T3 | `server/provisioner`, provisioning D1 | historical C-008 |

## Dependency direction

```text
Worker HTTP Router
        ↓
Portable Publish/Auth Core ───> Web Crypto / Web APIs
        ↓
PublishStorage
        ├──> MemoryStorage (tests)
        └──> CloudflareD1R2Storage ───> official: D1 + private R2
                                       └──> personal: D1 BLOB chunks

Obsidian Plugin ──── official mode ───> Official Worker control/publish API
Obsidian Desktop ─── personal mode ──> Cloudflare OAuth/API ──> Target Worker bootstrap
Obsidian Plugin ───> PublishBundle + C-005 ───> Any selected Worker HTTP Router
Plugin sources ───> Distribution Packaging ───> Community root / GitHub Release / Vault runtime
Browser ───────────> Console / Viewer ───────> Worker HTTP Router
```

Compiler 不依赖 Obsidian UI 或 Cloudflare SDK；发布服务不解析 Markdown。插件 artifact 当前内嵌 compiler runtime，开发参考保留在 `plugin/compiler.js`，后续正式构建时再收敛为单一产物来源。跨边界数据只通过 `.engineering/delivery-plan.md` 中的契约流动。

## Constraints and risks

- Constraint: 官方 R2 对象保持私有，所有站点访问经过 Viewer/Worker；个人 Worker 不绑定 R2，内容分片保存到 D1 BLOB。
- Constraint: 页面资源使用稳定相对路径，避免把本地 vault 路径泄漏到公开网站。
- Constraint: 每次新站点使用不可预测的随机 siteId；根页面固定为 `index.html`，引用页面直接使用同一站点目录下的 `page-N.html`。
- Risk: Obsidian Markdown 语义远大于第一版编译器；通过 T2 的 fixture 阶段逐项扩展。
- Risk: 原生渲染结果包含临时 DOM、插件样式或事件监听器；发布前必须做资源/链接规范化，交互先按静态快照处理。
- Risk: 主题 CSS 依赖 Obsidian 运行时的变量和字体资源；发布时复制已加载样式、主题类和内容计算字体，无法获得的本地字体仍可能回退。
- Risk: Obsidian 工作区 CSS 对 `body` 使用固定高度、`overflow: clip` 和 `contain: strict`；公开页必须剥离工作区类并显式恢复普通文档流，否则内容虽完整输出却不可滚动。
- Risk: 插件可能依赖 Obsidian API、Vault 索引或任意 JavaScript；不承诺任意插件自动获得公开站点运行时。
- Risk: 上传中断可能造成半成品；通过 revision 前缀和最后切换 current 指针规避。
- Constraint: C-005 protocol v2 对 UTF-8 页面按文本片拼接，对 base64 二进制资源要求每片独立解码；Worker 不接收完整大 bundle。
- Constraint: 不设置账户级当前内容配额，也不限制 Note 数量；更新仍受分片、单次请求和单个对象的平台边界约束。
- Constraint: 分片上传会留下未提交会话；Worker 24 小时过期并由 cron 删除临时 R2 对象或 D1 BLOB 行。
- Risk: 发布 API 若没有明确幂等键，会因重试产生重复 revision 或重复站点；C-002 强制要求幂等键。
- Risk: 引用页面递归发布会同时携带大量附件，JSON base64 会放大请求体；本地服务默认上限为 100,000,000 字节，并以 413 明确报告超限，生产服务需要按部署平台限制实现分片或压缩上传。
- Constraint: 外部 URL、`mailto:`、锚点和外部资源只原样输出，不参与本地页面解析、路径重写或引用页面遍历。
- Risk: 随机 siteId 只是能力链接，不等于访问控制；真正的私密分享仍需后续密码或身份认证能力。
- Constraint: 个人部署只在 Obsidian 桌面版执行；插件使用公开 OAuth Client + S256 PKCE 和固定 `http://127.0.0.1:8976/oauth/callback`，不携带 client secret。
- Constraint: Cloudflare OAuth access token 仅在插件部署调用栈内存中存在，部署成功/失败后都尝试 revoke；Vault、日志和 frontmatter 只保存 Worker URL 与受限 Publish Token。
- Constraint: 个人部署由插件直接执行固定的账户检查、Worker/D1 创建、Worker 上传、D1 migration 和一次性初始化，不提供任意 Cloudflare API 代理；资源冲突不覆盖已有 Worker 或 D1，也不创建 R2。
- Constraint: 自定义域名绑定只允许当前 Cloudflare 账户中处于 active 状态的 Zone；根域名和子域名均可用，但 v1 每个个人 Worker 只允许一个主域名，并在绑定根域名前明确提示可能影响整个 Zone 的请求路由。
- Constraint: 自定义域名绑定/解绑使用独立的临时 OAuth 权限；管理 access token 只存在于内存并在操作结束后尝试 revoke；插件只持久化域名、Zone 和 Worker origin，不保存 Cloudflare 管理 Token。
- Compatibility requirement: 发布请求通过自定义域名到达 Worker 时，Worker 使用当前请求 origin 生成分享链接；解绑或未绑定时继续使用 workers.dev origin。
- Constraint: `plugin/manifest.json` 和 `plugin/main.js` 是插件发布源；根目录镜像、Release 暂存包和 Vault runtime 必须由同一同步流程生成，不能手工维护漂移副本。
- Constraint: Obsidian Release 只允许 `main.js`、`manifest.json` 和可选 `styles.css`；`src/`、`server/`、`plugin/`、`plugin/compiler.js` 和测试文件不属于安装资产。
- Constraint: 个人 D1-only 上传按 1 MB 分片，单个对象最大 20 MB；这是 D1 BLOB 2 MB 上限与 Workers Free 每次调用 D1 查询上限下的保守边界。
- Compatibility requirement: `server/provisioner`、`wrangler.provisioner.jsonc` 和 provisioning D1 仅作为旧安装的兼容/高级运维代码，不得成为插件默认路径。
- Compatibility requirement: `PublishBundle.formatVersion` 和 API `/v1` 在 MVP 内保持兼容；契约变更必须更新 fixture 和受影响工作包。

## Delivery seams

- Seam: Compiler → Publish API
  - Contract needed: C-001 Publish Bundle
  - Work packages affected: WP-002, WP-003, WP-004
- Seam: Plugin → Publish API
  - Contract needed: C-002 Publish API
  - Work packages affected: WP-003, WP-004
- Seam: Plugin → Publish API queued upload
  - Contract needed: C-005 Queued Publish Upload
  - Work packages affected: WP-003, WP-004, WP-005
- Seam: Publish API → official D1/R2 or personal D1-only
  - Contract needed: C-003 Site Metadata and revision rules
  - Work packages affected: WP-003, WP-005
- Seam: Viewer → browser
  - Contract needed: C-004 Site URL and path mapping
  - Work packages affected: WP-003, WP-005
- Seam: Plugin source → Obsidian distribution
  - Contract needed: C-009 Obsidian plugin release artifacts
  - Work packages affected: WP-004, WP-005
- Seam: Plugin → Cloudflare custom-domain API → personal Worker
  - Contract needed: C-010 Personal custom domain binding
  - Work packages affected: WP-CF-8, WP-CF-7, WP-CF-3

## Open decisions

- ADR-001: `.engineering/decisions/ADR-001-hosted-cloud-publishing.md` — 官方托管与自部署共用 Worker 核心。
- ADR-002: `.engineering/decisions/ADR-002-current-revision-only.md` — 只保留 current revision。
- ADR-003: `.engineering/decisions/ADR-003-device-bootstrap-auth.md` — 设备授权和一次性 bootstrap secret。
- ADR-004: `.engineering/decisions/ADR-004-quota-policy.md` — 历史 50MB 内容配额已被 0.3.8 取消。
- ADR-006: `.engineering/decisions/ADR-006-obsidian-release-artifacts.md` — 插件源文件、根目录镜像、Release 资产和 Vault runtime 的同步边界。
- ADR-007: `.engineering/decisions/ADR-007-personal-custom-domain.md` — 个人 Worker 使用 Cloudflare Custom Domains 支持根域名和子域名，v1 保留一个主域名并以 workers.dev 作为 fallback。
- Pending: 官方生产域名、Cloudflare account、官方 D1/R2 bindings 与个人 D1-only 的真实 Obsidian/Worker smoke 仍需环境凭据；不阻塞本地实现和契约测试。

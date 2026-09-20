# Task Constitution

## 1. Mission

把 Obsidian 中的一篇笔记，以尽可能少的操作发布成稳定、可访问的公开分享网站；默认自动携带它引用的笔记。

首个 MVP 当前聚焦个人 Cloudflare 路径：个人 Worker 由 Obsidian 桌面插件通过 Cloudflare OAuth/API 直接创建自己的 Worker/D1，并以 D1 BLOB 保存内容，不要求 R2。官方托管 Worker 与 One-Click Publish 控制面保留为后续规划，不在当前插件设置页提供连接入口。插件本地编译内容，只保存 Worker URL 和 One-Click Publish Token；本地内存服务仅作为测试替身。Deploy Button、手动 `/setup` 和 migration 仅保留为高级备用路径。

## 2. Success Criteria

- [ ] 一篇 Markdown 笔记可以从本地编译为可访问的 HTML 网站资源。
- [ ] 插件或本地发布客户端可以上传一个发布包，并获得稳定的账户 Worker 主机名与 `/s/{siteId}` 链接；断开后重新部署会复用可识别的历史 One-Click Publish D1/Worker，缺失资源按需补建。
- [ ] 同一站点再次发布时复用原链接，并以新 revision 原子切换内容。
- [ ] Worker 通过私有存储提供网页访问；官方 R2 不直接暴露，个人 D1-only 不创建 R2 bucket。
- [ ] WikiLink、图片、基础 Markdown、原生 Obsidian 渲染快照、文件名标题、字体样式和引用页面发布满足 MVP 验收样例。
- [ ] 发布失败不会破坏上一版可访问内容；本地、契约和端到端验证均有证据。
- [ ] 个人 Worker 完成认证、分片、current revision 和 Viewer 核心；个人 D1-only 不创建 R2；个人部署仅在桌面插件内直连 Cloudflare，部署完成后移动版可通过同步配置发布。官方 Worker/控制面作为后续规划保留。
- [ ] 不设置账户级当前内容配额或 Note 数量上限；恢复码、设备授权、Token 撤销和删除站点有验证证据，单次请求/单个对象的平台边界有明确提示。

## 3. Task Tree

### T1 — 工程基线与发布契约
- Status: 已完成
- Objective: 建立模块边界、最小契约、开发骨架和第一条本地竖切链路
- Acceptance: 工程文档存在；契约有固定样例；Markdown → 发布 → 访问测试通过

#### T1.1 — 基线文档与契约
- Status: 已完成
- Objective: 建立架构、组件、工作包、集成门槛和 ADR
- Acceptance: `.engineering/` 下的交付文档存在，C-001–C-004 有 owner、兼容性和验证方式
- Evidence: `.engineering/architecture-baseline.md`, `.engineering/delivery-plan.md`

#### T1.2 — 本地发布适配器
- Status: 已完成
- Objective: 提供与未来 Worker/R2/D1 语义一致的内存发布服务和 viewer
- Acceptance: 首发、revision、幂等键、稳定 URL、当前内容读取和路径校验可运行
- Evidence: `src/publish/in-memory-publisher.ts`, `src/publish/local-viewer.ts`

#### T1.3 — 第一条竖切测试
- Status: 已完成
- Objective: 验证 Markdown → PublishBundle → Publish → Viewer 的最小链路
- Acceptance: 三个本地测试通过，demo 返回 HTTP 200
- Evidence: `npm test`, `npm run demo`, `tests/publish-flow.test.ts`

### T2 — Obsidian 内容编译器
- Status: 进行中
- Objective: 将单个根笔记及可选引用页面转换为确定性的多页面网站资源，并为原生渲染不可用时提供纯编译回退
- Acceptance: 基础 Markdown、WikiLink、相对 Markdown 文档链接、图片、Callout、代码块、表格和引用页面导航有测试覆盖
- Evidence: `src/compiler/markdown-renderer.ts`、`src/compiler/site-compiler.ts` 已实现；`npm test` 的测试覆盖资源路径、移动目标后的相对链接、站点内重复引用去重、独立站点地址、引用页面链接、标题折叠、公开页滚动布局、超大发布请求处理、分片上传、原子提交、深度 0/1/2/3 边界、循环引用去重、外部链接原样保留，以及 Worker core 的账户、恢复码、设备授权、超过原 50MB 配额后的提交、隔离和 migration。
- Children: 在 T1 通过后展开

### T3 — Cloudflare 发布服务
- Status: 进行中
- Objective: 完成个人部署所需的 Worker、D1-only 适配器、认证、控制台和 current-only 存储；官方托管 Worker/D1/R2 与控制面作为后续规划保留
- Acceptance: Node mock 完成发布、更新、读取、失败保护、幂等、请求大小边界和账户隔离；真实 Cloudflare 验收在凭据接入后完成
- Children: T3.1 旧 Provisioning Control Plane 兼容记录；现有 Deploy Button 方案降为高级备用路径

#### T3.1 — Legacy Provisioning Control Plane
- Status: 已实现，降级为旧安装兼容代码
- Objective: 保留旧版 start/callback/poll/ack 的历史证据；官方控制面由 `server/worker` 提供，个人部署不再依赖此模块
- Acceptance: legacy 回归测试继续通过；新插件默认流程、README 和验收路径不引用该控制面
- Evidence: `server/provisioner/`, `server/provisioner/migrations/0001_provisioning.sql`, `tests/provisioning.test.ts`, `.engineering/decisions/ADR-005-cloudflare-oauth-plugin-provisioning.md`

### T4 — Obsidian 插件交互
- Status: 进行中
- Objective: 提供设置、右键菜单、命令面板、发布状态和复制链接体验
- Acceptance: 用户完成一次浏览器连接后可从当前笔记触发发布，并按选项自动携带引用页面得到结果；不需要复制 Cloudflare 管理 Token

#### T4.1 — 本地可安装插件
- Status: 已完成
- Objective: 提供 Obsidian 能加载的 manifest、main.js 和 compiler runtime
- Acceptance: `plugin/` 可直接复制到 vault 的 `.obsidian/plugins/one-click-publish/`，artifact 检查通过
- Evidence: `npm run check:plugin`, `plugin/manifest.json`

#### T4.2 — 发布当前笔记
- Status: 已完成
- Objective: 从当前笔记读取 Markdown，调用 C-002 并保存稳定 siteId
- Acceptance: 真实 Obsidian vault 中完成一次首发和一次更新
- Evidence: `Share Publisher Test` 在真实 Obsidian vault 中首发和再次发布均成功；两次复用同一 siteId，页面返回 HTTP 200。随机 siteId 与引用页面递归发布已由本地测试覆盖，最新插件内容 smoke 待执行

#### T4.3 — 设置与结果反馈
- Status: 进行中
- Objective: 提供个人 Cloudflare 部署入口、自定义域名绑定/解绑、取消连接、发布 Notice、复制链接、打开链接和可控的脱敏调试诊断；官方连接入口保留为规划
- Acceptance: 设置页只展示“部署到我的 Cloudflare”入口，并在已有个人 Worker 后提供根域名/子域名绑定；已有连接时可以取消当前 Vault 的连接；成功/失败状态可见；发布链接自动复制；开启调试模式后可复制部署与发布请求详情，关闭时不展示日志，且日志不包含凭证、请求正文或笔记内容；Debug 模式行位于项目仓库之前
- Evidence: 插件 0.3.9 在 0.3.8 的连接边界上补充解绑事务标记、远程/本地结果分离、失败恢复入口、操作 ID 和日志清除；四份中英文 README 已同步说明自定义域名边界、恢复态、OAuth scope 和日志操作；0.3.5 已拆分原始 Worker、当前发布地址与自定义域名状态，0.3.4/0.3.3 已覆盖 OAuth scope/拒绝诊断；自动化回归已补充

#### T4.3.1 — 个人自定义域名绑定
- Status: 已实现本地代码，待真实 Cloudflare 域名验收
- Objective: 在设置页通过一次 Cloudflare OAuth/API 操作，将个人 Worker 绑定到同账户中的根域名或子域名，并支持解绑后恢复 workers.dev。
- Acceptance: 输入校验、根域名确认、active Zone 查询、一 Worker 一主域名、Custom Domain attach/detach、临时管理权限 revoke、移动端 guard 和自定义域名发布链接均有 Node mock 证据；失败不覆盖原 Worker URL/Token。
- Evidence: `plugin/main.js` 的 `bindCustomDomain`/`unbindCustomDomain`/`recoverCustomDomainTransition`，`server/worker/routes.ts` 的 request-origin commit，`tests/plugin-cloudflare.test.ts` 与 `tests/cloudflare-core.test.ts`；契约见 C-010 和 ADR-007；0.3.9 覆盖远程删除后本地保存失败时保留主连接和可恢复标记

#### T4.4 — Obsidian 原生渲染快照
- Status: 已实现，待真实插件内容 smoke
- Objective: 优先调用 Obsidian MarkdownRenderer 和已注册的 Markdown 插件处理器，再提取 HTML 快照发布
- Acceptance: 原生渲染失败时自动回退；内部链接、引用资源和复选框经过发布侧规范化；公开页不继承 Obsidian 工作区的固定高度/裁切规则；Markdown 标题悬停显示折叠符号并可点击折叠；代码块复制按钮可用；可切换原生/回退渲染
- Evidence: `plugin/main.js` 的 `renderNativeMarkdown`、`compileShareWithNative`；`npm run check:plugin`、`npm test` 通过

#### T4.5 — Cloudflare 账户连接向导
- Status: 规划中；当前插件设置页不提供官方连接入口
- Objective: 保留官方控制面方案说明，后续再接入“连接到官方 Cloudflare”并提供设备授权、Publish Token、配额和租户隔离
- Acceptance: 官方模式无需填写服务地址或 Token；Token 不进入 frontmatter，认证/配额/Worker 失败有明确 Notice；接入后与个人部署模式互斥
- Evidence: 现有 `plugin/main.js` 的 `connectAccount` 和 C-006 core tests 作为兼容/历史实现保留；0.2.14 不从设置页暴露该操作

#### T4.6 — 插件直连 Cloudflare 的个人部署
- Status: 进行中；已有 Worker/D1 和有效 Token，待全新 Vault 与移动端验收
- Objective: 让 Obsidian 桌面插件通过公开 OAuth + PKCE 直接创建 Worker/D1、上传内嵌 artifact、初始化目标 Worker 和保存 Token；个人路径不请求或创建 R2
- Acceptance: 桌面端完成 loopback callback、资源创建、migration、一次性初始化、secret 删除和 OAuth revoke；移动端禁用部署但可使用同步后的 Worker；失败不覆盖既有可用配置；不请求 provisioning control plane
- Evidence: `plugin/main.js` 的 `provisionPersonalCloudflare`/`runDirectCloudflareDeployment`、`scripts/build-plugin.mjs`、`tests/plugin-cloudflare.test.ts`; 0.2.21 检查 D1 表结构并复用历史 One-Click Publish 数据库与 Worker，通过 reconnect 为原账户签发新 Token；Worker 或 D1 缺失时仅补建缺失资源

### T5 — 集成验证与 MVP 交付
- Status: 进行中
- Objective: 完成真实插件、个人 Worker、console 和 viewer 的集成验收；官方控制面与官方 Worker 保留为后续规划
- Acceptance: 发布、更新、失败恢复、请求大小边界、删除、恢复、权限隔离和桌面直连 OAuth 部署路径全部有证据；官方设备授权不属于当前插件验收路径；Deploy Button 仅作为高级备用路径
- Children: T5.1, T5.2, T5.3

#### T5.1 — 桌面直连个人部署真实验收
- Status: 进行中；已修复并部署 D1 commit 500，且修复原生 CSS 资产 400，待真实插件首发/更新复验
- Objective: 用公开 OAuth Client 和真实 Cloudflare 账户验证插件设置页直接完成 Worker/D1-only 部署、发布、更新和删除
- Acceptance: 全新桌面 Vault 不填服务地址/Token，授权后仅出现 Worker、D1，插件可直接 One-Click Publish；完成部署后可绑定同账户根域名或子域名并通过自定义域名返回分享链接；移动端同步配置后可发布；重复/冲突/失败/拒绝路径有证据
- Evidence: 用户日志确认上传会话及三次分片均 200，但 commit 因原生 CSS 使用 utf8 被 Worker 正确拒绝；0.2.11 修复 D1 数组 BLOB，0.2.13 改为 base64 资产；现有个人 Worker 首发成功；0.3.5 新增自定义域名与主 Cloudflare 连接隔离、账户外域名拦截和解绑失败保护回归，0.3.4 新增自定义域名 OAuth scope 配置提示，0.3.3 新增自定义域名 OAuth 拒绝诊断回归，真实 Cloudflare 域名/证书 smoke 待 staging 凭据；详见 `.engineering/manual-test-findings.md`

#### T5.2 — Obsidian 发布产物自动同步
- Status: 已完成；0.3.1 已移除 manifest 描述中的 Obsidian 禁用词，产物已重建、同步并通过 parity check
- Objective: 让 `plugin/` 成为唯一插件源目录，并自动同步根目录、Release 暂存目录和 Vault 安装目录
- Acceptance: `plugin/manifest.json` 与 `plugin/main.js` 经过构建后生成根目录 `manifest.json`/`main.js`、`dist/obsidian-release/` 中的精确发布文件以及 Vault runtime；parity check 能拒绝过期或多余文件；`compiler.js`、`src/`、`server/` 不进入 Release
- Evidence: `scripts/package-plugin.mjs`, `npm run update:plugin`, `npm run check:plugin`, `LICENSE`, `manifest.json`, `main.js`

#### T5.3 — GitHub Release 与社区目录交付
- Status: 进行中；0.3.1 已推送并创建匹配 Release，社区目录仍需按 `one-click-publish` 作为新条目提交
- Objective: 让每个版本以准确的 manifest 版本生成 GitHub Release，并满足 Obsidian Community 根目录校验
- Acceptance: 根目录有 manifest、README、LICENSE；Release tag 与 `plugin/manifest.json` 版本一致；Release 仅包含 `main.js`、`manifest.json` 和可选 `styles.css`；main push/tag workflow 在镜像漂移时失败
- Evidence: `.github/workflows/plugin-release.yml`, `package-lock.json`, `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh-CN.md`, `LICENSE`; workflow 已接入 locked install 与 release asset provenance attestation；官方规则以 `https://docs.obsidian.md/plugins/releasing/submit-plugin` 为准

### T6 — 零星项目 / Miscellaneous
- Status: 未开始
- Objective: 收纳与主工作流无直接归属的小型独立事项
- Acceptance: 每个事项都有来源、状态、下一动作和去向
- Children: none

## 4. Current Focus

- Task: T4.3.1 → T5.1
- Parent path: T5
- Objective: 完成个人自定义域名绑定的本地契约、插件产物同步，并准备真实 Cloudflare 域名验收
- Next action: 用 staging 域名验证 root/subdomain、DNS/证书、跨设备配置及恢复态 UI

## 5. Decision Log

| Date | Decision | Rationale | Impact |
|---|---|---|---|
| 2026-09-14 | MVP 采用官方托管发布服务 | 用户无需理解 Cloudflare，发布体验最短 | 需要 Worker、R2、D1 和发布 API |
| 2026-09-14 | 内容在插件侧先编译为发布包 | 降低服务端耦合，便于本地验证和未来自托管 | 编译器与发布 API 之间需要稳定契约 |
| 2026-09-14 | 默认使用产品域名，不做自定义域名 | 自定义域名会引入 DNS、TLS 和域名验证复杂度 | 自定义域名列入后续范围 |
| 2026-09-14 | 插件优先使用 Obsidian 原生渲染并发布 HTML 快照，纯编译器保留为回退 | 复用 Obsidian 及已安装 Markdown 插件的渲染能力，减少重复实现 | 动态交互先以快照交付；回写与完整客户端运行时后置 |
| 2026-09-18 | 设置页当前只提供“部署到我的 Cloudflare”，官方连接入口改为规划中 | 聚焦个人直连 Cloudflare 的当前交付路径，避免把尚未准备好的官方控制面作为可用功能 | 官方旧配置保留读取兼容；正常设置页不再展示官方连接动作 |
| 2026-09-17 | 官方托管保留控制面，个人部署改为桌面插件直连 Cloudflare OAuth/API | 控制面只承担官方账户、设备、Token、配额和租户隔离；个人资源归用户且不依赖项目方 provisioning 服务 | T3.1 降级为 legacy；T4.6 使用 PKCE/loopback/内存 token；移动版仅消费同步后的个人配置 |
| 2026-09-18 | 个人部署收敛为 D1-only | 用户不应为了发布笔记开通 R2；D1 Free 的限制是可预期的硬限制 | 个人 OAuth 移除 R2 scope，创建资源只剩 Worker/D1，内容按 1 MB BLOB 分片；单文件上限 20 MB |
| 2026-09-18 | 新增“取消连接” | 用户需要停止当前 Vault 发布，但不应误删 Cloudflare Worker、D1、已发布网站或其他设备连接 | 只清除本地 Worker 地址、Publish Token 和兼容字段；执行前确认；重新连接仍需重新完成部署 |
| 2026-09-18 | 插件升级至 0.2.19，个人部署优先使用固定 Worker 名称 `publish-note` | D1 与 Worker 属于不同 Cloudflare 命名空间，D1 同名不应导致分享域名变化 | 仅在 Worker 名称冲突时使用可预测账户后缀；已有旧地址继续有效 |
| 2026-09-18 | 插件升级至 0.2.20，重部署前检查 D1 表结构并复用历史 Publish Note 数据库 | 断开连接只清除 Vault 中的连接，不能让历史站点内容随新部署分裂到新库 | 识别历史库后跳过重复 bootstrap，复用原账户并重新签发 Publish Token；多库歧义时安全停止 |
| 2026-09-20 | 采用 Cloudflare Custom Domains 为个人 Worker 增加根域名/子域名绑定；v1 每个 Worker 保留一个主域名，管理 OAuth token 仅内存使用并 revoke，workers.dev 作为 fallback | 设置页保持短流程，同时保留已有链接和失败回退；根域名绑定前明确提示可能影响整个域名请求路由 | T4.3, T4.3.1, T4.6, T5.1 |

## 6. Knowledge Context

- Constraints: 海外托管优先；官方 R2 保持私有，个人部署不使用 R2；MVP 暂不包含账号、收费、统计、搜索、评论、密码保护和主题市场。
- Dependencies: Obsidian Plugin API；Cloudflare Worker、D1，以及官方服务可选 R2；产品域名和部署凭据将在 T3/T5 接入。
- Repository handoff: `origin` 将切换并推送至 `https://github.com/jinhefeng/One-Click-Publish.git`；GitHub 远程项目重命名后保留历史。
- Agent handoff: 长期项目要求集中记录在 `AGENTS.md`，后续代理进入项目时先读取该文件。
- Relevant files, links, or prior agreements:
  - 参考项目: https://github.com/licc168/obsidian-htmlto-link/
  - 工程契约: `.engineering/delivery-plan.md`
  - 架构基线: `.engineering/architecture-baseline.md`

## 7. Change History

| Date | Change | Reason | Affected tasks |
|---|---|---|---|
| 2026-09-14 | 创建初始任务树，确定 T1–T5 主工作流和 Miscellaneous 分类 | 用户确认按架构化交付提案开工 | T1–T6 |
| 2026-09-14 | 完成 T1 工程基线与本地竖切链路 | `npm test` 通过，3 个测试覆盖首发、幂等更新和路径安全 | T1 |
| 2026-09-14 | 开始 T4，本地插件与开发发布服务加入仓库 | 用户要求在 Obsidian 中实际测试 | T4, T3 |
| 2026-09-14 | 完成 T4.1，并验证本地 API smoke test | 插件 artifact 可加载，发布 API 返回 200，viewer 返回 HTML | T4.1, T4.2, T4.3 |
| 2026-09-14 | 修正 Obsidian 入口导出与本地依赖，完成真实笔记首发/更新验证 | 插件在 Vault 中成功加载；`Share Publisher Test` 首发与更新复用同一链接，页面 HTTP 200 | T4.1, T4.2, T4.3 |
| 2026-09-14 | 完成 T2 第一轮编译器能力，并将文件夹发布入口接入插件 artifact | 5 个本地测试通过；插件支持文件夹命令/右键、WikiLink 页面映射和引用资源采集，待真实 Obsidian smoke | T2, T4 |
| 2026-09-14 | 接入 Obsidian 原生渲染快照，失败自动回退并提供设置开关 | 让 Tasks、Dataview 等已安装插件有机会参与发布，同时保留确定性回退路径 | T2, T4 |
| 2026-09-14 | 为异步 Tasks 查询增加等待和基础 Vault 任务快照回退 | `site-0006` 的原生 Tasks 容器在提取时为空，需要确保全库任务页先可用 | T4, T5 |
| 2026-09-14 | 增加 `npm run sync:plugin` 固定同步流程 | 确保工作区代码和实际 Obsidian Vault 中的插件入口始终同步 | T4 |
| 2026-09-14 | 页面统一增加文件名标题，保留原始文件名路径并发布主题/字体 CSS 快照 | 修复页面缺少标题、链接路径不直观和字体样式未还原的问题 | T2, T4, T5 |
| 2026-09-14 | 修复原生 CSS 快照导致的公开页不可滚动，并将 Markdown 标题转换为默认展开的嵌套折叠区 | Obsidian 工作区规则把页面设为固定高度并裁切内容；用户要求按标题折叠 | T2, T4, T5 |
| 2026-09-15 | 将折叠符号改为标题悬停时显示，并在发布页 shell 中补齐代码块复制事件 | 原生快照只保留 HTML，不保留 Obsidian 的按钮监听器；用户要求折叠提示按需出现且复制按钮可用 | T2, T4, T5 |
| 2026-09-15 | 编译器按当前源文件路径解析相对 Markdown 文档链接，并增加文档移动后的回归测试 | 文件移动后 `../文档.md` 不能继续按旧页面位置解释；发布时应依据最新 Vault 文件索引重建链接 | T2, T4, T5 |
| 2026-09-15 | 将产品范围收敛为单页面分享：根页面固定为 `index.html`，siteId 改为随机不透明目录，引用页面默认递归发布到 `pages/`（后续由同目录 `page-N.html` 方案替代） | 降低入口猜测风险，符合“分享一页即可访问其上下文”的预期；文件夹不再作为分享入口 | T2, T4, T5 |
| 2026-09-15 | 确定站点内页面去重与独立地址策略：根页面为 `index.html`，引用页按规范化路径排序为同目录 `page-N.html`；不同站点不共享页面地址 | 避免同一站点重复生成被多页引用的文档，同时保持不同分享边界的隐私隔离 | T2, T4, T5 |
| 2026-09-15 | 实现站点内页面去重、同目录 `page-N.html` 路由、未包含引用的无死链降级和设置默认值修复；补充 400 错误详情诊断；插件升级至 0.1.2 并同步 Vault | `npm test` 10/10、插件检查和语法检查通过；等待真实 Obsidian 重新加载后的内容 smoke | T2, T4, T5 |
| 2026-09-15 | 定位指定笔记的超限来源：递归引用链包含 46 篇笔记、66 个附件，附件原始总量约 40.8 MB；本地发布服务上限提升至 100,000,000 字节并增加 413 契约测试，重启 8787 服务 | 11/11 测试通过；11 MB 有效发布包返回 200；等待真实 Obsidian 重新加载后用指定笔记完成约 55 MB 请求 smoke | T1.2, T2, T4, T5 |
| 2026-09-15 | 将大发布改为上传会话、约 1 MB 对象分片队列和最后原子 commit；新增 `Linked page depth`，默认 1 层，0 层表示只发布根页面 | 15/15 测试通过；HTTP 上传生命周期、分片重组、不完整上传保旧版本和深度规范化均有断言；插件升级至 0.1.3，待真实 Obsidian smoke | T1.2, T2, T4, T5 |
| 2026-09-15 | 统一插件对外文案为 Obsidian Share，补齐作者信息、作者链接、发布/打开/复制按钮和设置说明；插件升级至 0.1.4 | 清理开发占位文案，确保名称、操作入口和反馈消息在 manifest、设置页、命令面板、右键菜单、功能区和文档中一致 | T4, T5 |
| 2026-09-15 | 按用户确认将产品名改为 Publish Note，作者统一为 Jin Hefeng；设置页按钮改为明确的 Publish current note / 发布当前笔记；README、设置和项目链接改为中英文双语 | 消除按钮用途歧义，统一插件名称与作者信息，并为后续 GitHub 项目交付预留固定仓库地址 | T4, T5 |
| 2026-09-15 | 初始化本地 Git main 分支并提交 `c76bb06`；配置 `origin` 为 `jinhefeng/Obsidian-Publish-Note`，但 GitHub 返回 Repository not found | 本地交付已完成，远程创建等待 GitHub 认证恢复 | T5 |
| 2026-09-15 | GitHub 登录恢复后创建 `jinhefeng/Obsidian-Publish-Note` 并推送 `main`；README 改为英文默认、中文独立页面和顶部语言切换；设置页新增默认英文/中文切换器 | README 不再并排重复两种语言，设置页可按用户选择显示单一语言 | T4, T5 |
| 2026-09-15 | 精简设置页：移除发布当前笔记和最近发布链接区块，将详细工具介绍置顶，并把项目仓库移到最底部；插件升级至 0.1.6 | 设置页聚焦服务与内容配置，避免与命令面板和右键菜单重复 | T4 |
| 2026-09-15 | 创建项目根目录 `AGENTS.md`，整理 Publish Note 的长期产品、交互、双语文档、Git、验证和兼容性要求 | 将本会话形成的跨文件约束沉淀为后续代理可直接执行的工程规范 | T4, T5 |
| 2026-09-15 | 完成分片发布、可配置引用深度和外部链接旁路；插件升级至 0.1.7 | 解决大发布请求体超限；默认深度 1，支持 0/1/2+；外部 URL、`mailto:`、锚点和外部资源不遍历、不改写 | T1.2, T2, T4, T5 |
| 2026-09-15 | 新增可重复执行的 `start.sh` 服务启动器，并让 `npm run dev:server` 统一使用它；`start` 改为强制清理目标端口后重启 | 处理已运行服务、端口冲突、残留 PID、启动失败、日志和 stop/restart 生命周期；按用户要求不复用旧服务 | T1.2, T5 |
| 2026-09-15 | Cloudflare 方案收敛为官方托管 + 用户自部署双模式，共用 Worker-compatible core；新增 C-005 protocol v2 | 让官方用户零 Cloudflare 配置，让数据主权用户通过 Deploy to Cloudflare 自部署；避免 Worker 一次性接收 50MB bundle | T3, T4, T5 |
| 2026-09-15 | 采用 D1/R2 当前 revision-only、一次性恢复码、10 分钟 device code、一次性 BOOTSTRAP_SECRET，以及 50MB/10 Note 配额 | 降低首版运维和用户操作，避免历史对象重复占用与首次访问抢管理员风险 | T3, T4, T5 |
| 2026-09-15 | Worker core、D1/R2 adapter、控制台、自部署 `wrangler.jsonc` 和 Publish Note 0.2.0 已实现；插件 artifact 已同步到开发 Vault | 形成可执行的 Cloudflare-first 代码闭环；真实 Cloudflare 与 Obsidian 云端 smoke 等待外部凭据 | T3, T4, T5 |
| 2026-09-16 | 将自部署主流程从 Deploy Button 调整为插件设置页 OAuth provisioning；新增控制面、目标 Worker 自动初始化、一次性结果 ack 和安全资源冲突处理 | 将用户操作压缩为“插件按钮 + Cloudflare 授权”，同时不把 Cloudflare 管理凭据交给插件 | T3, T4.6, T5.1 |
| 2026-09-17 | 将个人部署从外部 provisioning control plane 改为桌面插件直连 Cloudflare OAuth/API；控制面仅保留官方托管职责 | 消除个人部署对项目方控制面的运行时依赖；access token 只在内存中使用并在部署结束后撤销；bundle/migration 随插件版本注入 | T3.1, T4.6, T5.1 |
| 2026-09-18 | 个人 Worker 存储改为 D1-only，新增 BLOB migration 和 20 MB 单对象限制 | 真实 OAuth 流程提示 R2 未开通；用户确认不使用 R2，避免订阅与超额风险 | T3, T4.6, T5.1 |
| 2026-09-18 | 真实桌面测试确认 OAuth 会回调到 `127.0.0.1:8976`；该地址由插件临时监听，不是部署的 Web 服务；修正账户分页上限并让插件测试串行运行 | 排除 loopback 回调误判，避免 Cloudflare `per_page=100` 兼容性错误和固定端口测试互相干扰；provisioning 阶段仍待真实复验 | T4.6, T5.1 |
| 2026-09-18 | 插件升级至 0.2.10，新增可选 Debug mode；部署与发布请求记录阶段、脱敏路由、状态码、内外部错误、重试和耗时，并支持一键复制 | 用户需要区分 Worker 地址在线、D1/Token/接口实际失败；默认不记录详细请求，开启后仍不保存 Token、请求正文或笔记内容 | T4.3, T4.6, T5.1 |
| 2026-09-18 | 0.2.11 修复 D1 BLOB 数组读取，回归通过并更新现有 Worker | 定位到 commit 500；细节见手工验收记录 | T3, T4.6, T5.1 |
| 2026-09-18 | 插件升级至 0.2.12，补充 statusless requestUrl 网络错误诊断 | 06:20 两次发布请求在 HTTP 前超时，旧日志无法区分 DNS/TLS/代理/客户端超时 | T4.3, T5.1 |
| 2026-09-18 | 插件升级至 0.2.13，修复原生 Obsidian CSS 快照以 utf8 作为 asset 导致 commit 400 | 上传和鉴权均已成功，Worker 在 commit 阶段按契约拒绝非 base64 资产；生成 CSS 现在按 UTF-8 字节编码为 base64 | T4.2, T4.3, T5.1 |
| 2026-09-18 | 插件升级至 0.2.14，移除设置页的官方 Cloudflare 连接入口；Debug 关闭时隐藏日志，并将 Debug 行移到项目仓库之前 | 当前交付聚焦个人 Cloudflare 部署，日志按需展示且设置顺序更便于排查 | T4.3, T4.5 |
| 2026-09-18 | 插件升级至 0.2.15，新增“取消连接”按钮和中英文说明 | 允许只解绑当前 Vault，同时保留 Cloudflare 资源和已发布内容 | T4.3, T4.6 |
| 2026-09-18 | 插件升级至 0.2.16，将“已连接”和“取消连接”合并到同一个 Cloudflare 设置块 | 让连接状态、说明和解除操作在同一处呈现，减少用户对两个独立设置项的误解 | T4.3 |
| 2026-09-18 | 插件升级至 0.2.17，按当前个人 Cloudflare/D1-only 实现重写设置与中英文 README 文案 | 移除设置页能力误解，明确当前笔记、链接深度、本地资源、分片提交、frontmatter 回写、OAuth/调试和 R2 边界 | T4.3, T5.1 |
| 2026-09-18 | 插件升级至 0.2.18，精简解绑与仓库访问按钮文案 | 降低设置页操作区的排版复杂度，并使用更直接的“Visit/访问”按钮文本 | T4.3 |
| 2026-09-18 | 插件升级至 0.2.19，稳定个人 Worker 主机名选择并同步中英文文档 | 避免无关 D1 名称冲突让分享域名出现账户片段 | T4.3, T4.6 |
| 2026-09-18 | 插件升级至 0.2.20，加入历史 D1 识别、复用和 reconnect Token 流程并同步中英文说明 | 解决断开后重新部署导致旧站点内容留在原 D1、新内容写入新 D1 的问题 | T4.3, T4.6 |
| 2026-09-18 | 插件升级至 0.2.21，复用历史 Publish Note D1 与 Worker，并改为设置页内确认取消连接、合并重复刷新 | 断开后重部署保留原分享域名与内容；避免原生确认框抢占设置页焦点，确保取消操作不会关闭设置弹窗或重绘两次 | T4.3, T4.6 |
| 2026-09-19 | 插件升级至 0.2.22，优化取消连接确认态 | 点击取消连接后隐藏已连接按钮，仅显示确认和取消；取消恢复原状，确认才执行解绑 | T4.3 |
| 2026-09-19 | 插件升级至 0.2.23，建立 Obsidian 社区发布产物同步边界并加入 MIT License | 统一 `plugin/` 源文件到根目录镜像、Release 暂存包和 Vault 的自动同步，避免版本更新漏传 manifest 或 main.js | T5.2, T5.3 |
| 2026-09-19 | 插件升级至 0.2.24，并将 Obsidian 插件 ID 从 `share-publisher` 切换为 `publish-note` | 修复社区提交时 manifest 身份与目标安装目录不一致，并为匹配 manifest 的无 `v` GitHub Release 做准备；旧目录不自动删除 | T4.1, T5.2, T5.3 |
| 2026-09-19 | 插件升级至 0.2.25，并将 Obsidian 插件 ID 恢复为 `share-publisher` | 保持已存在的 Obsidian 插件身份和更新目录稳定；README、打包与 Vault 同步目标恢复一致 | T4.1, T5.2, T5.3 |
| 2026-09-19 | 将根目录和 `plugin/` README 重定位为插件用户文档，并新增中英文 `CONTRIBUTING` 开发指南 | 避免用户 README 混入本地服务、测试、架构和 Release 实现细节；保留维护者所需的工程流程 | T5.3 |
| 2026-09-19 | 按用户确认将产品改名为 One-Click Publish，插件 ID 改为 `one-click-publish`，目标仓库改为 `jinhefeng/One-Click-Publish`，版本提升至 0.3.0 | 新身份突出一次 Cloudflare 连接后的单击发布体验；旧 `share-publisher` 安装和 `publish-note` Cloudflare 内部资源不自动删除，保留历史内容与资源兼容性 | T4.1, T5.2, T5.3 |
| 2026-09-19 | 提交 `ebc81d5` 并推送 `0.3.0` 标签；GitHub Actions 验证通过并创建含 `main.js`、`manifest.json` 的 Release | 确保新插件身份、manifest 版本和 Release 标签完全匹配，满足 Obsidian 发布资产边界 | T5.2, T5.3 |
| 2026-09-20 | 插件升级至 0.3.2，设置页新增个人 Cloudflare 自定义域名 bind/unbind，Worker commit 改为使用请求 origin 生成分享链接 | 完成本地 root/subdomain、Zone 查询、attach/detach、revoke、workers.dev fallback 契约；真实域名/证书 smoke 仍待 staging | T4.3, T4.3.1, T5.1 |
| 2026-09-20 | 插件升级至 0.3.3，修复自定义域名 OAuth 拒绝后的日志归属、拒绝码记录和设置页诊断显示 | 绑定失败后可直接看到 `OAUTH_DENIED`、`access_denied` 和脱敏拒绝说明；完整 Debug 请求日志仍受 Debug 模式控制 | T4.3, T4.3.1, T5.1 |
| 2026-09-20 | 插件升级至 0.3.4，识别自定义域名 OAuth `invalid_scope` 并给出 OAuth Client 配置提示 | 不再建议错误地删除 `workers-routes.write`；明确需由应用维护者在 Cloudflare OAuth Client 中启用该 scope，保留详细诊断日志 | T4.3, T4.3.1, T5.1 |
| 2026-09-20 | 插件升级至 0.3.5，取消每个账户最多 10 篇已发布 Note 的数量限制 | 当时继续保留 50MB 当前内容配额；发布数量不再阻止新站点创建；补充超过 10 篇的 core 回归测试并同步 Worker/插件产物 | T3, T4, T5 |
| 2026-09-20 | 插件升级至 0.3.6，新增“更新 Cloudflare Worker”流程 | 已有个人 Worker 可复用原 Worker/D1 原地上传新 artifact；保留已发布数据、Worker URL 和自定义域名，解决旧 Worker 继续返回 10 篇上限的问题 | T4, T5.1 |
| 2026-09-21 | 插件升级至 0.3.7，增加 Worker 版本兼容性检查 | Worker `/healthz` 返回部署版本；设置页提示历史/未知版本并允许手动更新；每次发布前校验版本，不匹配或无法确认时暂停发布，避免旧 Worker 继续执行历史限制 | T4, T5.1 |
| 2026-09-21 | 插件升级至 0.3.8，取消账户级 50MB 当前内容配额 | `startUpload`/`commitUpload` 不再按账户累计内容拒绝；保留分片、单次请求和单个对象的平台边界；补充超过原配额的 core 回归并同步 Worker/插件产物 | T3, T4, T5 |
| 2026-09-21 | 插件升级至 0.4.1，设置页仅在 Worker 需要更新时显示更新操作 | 当前版本隐藏更新按钮，首次检查显示检查状态；旧版本、无法验证或不可达时显示更新操作；保留发布前版本阻断和自定义域名下的原始 Worker 检查 | T4, T5.1 |
| 2026-09-20 | 插件升级至 0.3.5，分离主 Cloudflare 连接与自定义域名状态，改用设置页内确认操作 | 绑定后保留原始 Worker 和 Publish Token；解绑失败不再清除主连接；账户外域名在 PUT 前拒绝；绑定后当前发布地址和最近链接切换到新域名 | T4.3, T4.3.1, T5.1 |
| 2026-09-21 | 插件升级至 0.3.9，修复自定义域名解绑的远程/本地事务边界，并补齐技术详情、部署日志和调试日志清除 | 远程删除成功但本地保存失败时保留原始错误、远程结果和恢复标记；操作 ID 避免日志串线；清除操作同步清理持久化与内存日志 | T4.3, T4.3.1, T5.1 |

## 8. Detail Pointers

- Format: v1 single-file
- Active branch detail: `.engineering/delivery-plan.md`
- History: none

## 9. Current Round

- Round: R1
- Frontier: T2, T3, T4, T5
- Granularity target: objective + output + acceptance + dependency
- Exit condition: 每个前沿任务都有第一份结果或明确阻塞；T1 已完成并保留证据
- Status: in progress

## 10. Technical Debt Queue

| ID | Discovered in | Debt | Why deferred | Trigger / target round | Priority | Status |
|---|---|---|---|---|---|---|
| TD-001 | T1 | 将当前最小 Markdown 编译器升级为完整 Obsidian Markdown 语义 | 不阻塞第一条发布竖切链路 | T2 | P1 | queued |
| TD-002 | T1 | 引入正式 TypeScript 构建与 Obsidian 打包工具链 | 当前运行时可直接执行 TypeScript，先验证契约 | T4 | P1 | queued |
| TD-003 | T3 | 官方 production 域名、Cloudflare 账户、staging/production 观测与真实 smoke | 需要部署凭据和产品域名，不阻塞本地实现 | T5 | P0 | blocked-on-environment |
| TD-004 | T3 | GitLab、Cloudflare Pages 和本机插件 Web 服务发布路径 | 本轮全力攻坚 Cloudflare Worker；保留为后续路线 | 后续 | P2 | queued |
| TD-005 | T3 | 已有安装的“重新部署”token rotation/upgrade 协议 | 当前重复部署安全返回 `ALREADY_PROVISIONED`，不覆盖资源；首轮先保证首次开通和失败恢复 | T5.1 | P1 | queued |

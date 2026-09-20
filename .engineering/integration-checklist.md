# Integration Checklist: Cloudflare-first One-Click Publish

## Contract gate

- [x] 必要契约已列出并指定 owner；C-006/C-007 已加入账户授权和 Cloudflare 部署边界。
- [x] Publish Bundle 有固定版本和路径约束。
- [x] 发布 API 的成功、错误、幂等和更新行为已记录。
- [x] revision/current 指针和 current-only 语义已记录。
- [x] 大发布包使用 C-005 protocol v2：页面 UTF-8 拼接、二进制 chunk 独立 base64 解码、最后原子提交；分片/提交失败不会切换旧 revision。
- [x] C-009 发布产物契约已冻结：`plugin/` 源文件生成根目录镜像、Release 暂存包和 Vault runtime，版本与内容必须一致。
- [x] C-010 个人自定义域名契约已冻结：同一 Cloudflare 账户的 active Zone 支持根域名/子域名，每个 Worker 一个主域名，workers.dev 保留为 fallback。

## Work-package gate

- [x] 每个已完成工作包都有验收证据。
- [x] WP-001 的本地契约和竖切测试通过。
- [x] WP-CF-1 portable core、Worker 路由、控制台和 MemoryStorage 已实现并通过 Node mock。
- [x] WP-CF-2 D1 migration、官方 R2 key layout 和个人 D1-only BLOB adapter 已实现。
- [ ] 真实官方 Cloudflare Worker/D1/R2 与个人 Worker/D1-only 工作包需要账号、域名和部署凭据。
- [x] 当前工作包之间没有未解决的写入冲突。
- [x] 根目录 `manifest.json`、`main.js` 和 MIT `LICENSE` 已生成/存在；Release 暂存包只包含允许的插件资产。

## Migration and compatibility gate

- [x] 本地内存存储与生产存储之间使用同一最小适配器语义。
- [x] revision 提交要求资源完整后再切换 current。
- [x] 重复幂等键不会创建新的站点结果。
- [x] D1 batch current switch、旧 revision 删除和 cron cleanup 代码已登记。
- [ ] 官方 R2/D1 与个人 D1-only 的真实写入、观测、停止条件和恢复证据待 WP-CF-3/WP-CF-6。

## Cross-package gate

- [x] Compiler → Publish API 的 bundle shape 有测试。
- [x] Plugin → Publish API 的上传会话、分片、commit HTTP 生命周期有测试。
- [x] 编译器 fixtures 覆盖 callout、table、task、WikiLink、相对 Markdown 文档链接、图片资源和引用页面导航。
- [x] 同一分享站点内重复引用只生成一个 `page-N.html`，不同站点各自维护页面地址。
- [x] 编译器 fixture 覆盖标题折叠结构、悬停折叠符号、代码块复制按钮和公开页可滚动布局。
- [x] 外部 URL、`mailto:`、锚点、带 `.md` 后缀的外部链接和外部资源保持原样，不进入引用页面队列。
- [x] C-005 v2 对二进制资源逐片解码；大文件 Viewer 使用 Worker `ReadableStream` 逐 chunk 输出。
- [x] 账户恢复码只消费一次；恢复后既有 session 和 Publish Token 全部撤销。
- [x] device code 10 分钟过期、单次消费；插件不保存 Cloudflare 管理 Token。
- [x] 账户级内容配额已取消；超过原 50MB 的内容、无限制 Note 数量、更新替换占用、删除站点和安全错误 code 有 core 测试。
- [x] D1 migration 包含 accounts、sessions、tokens、sites、revisions、objects、object_chunks、uploads、upload_objects、device_authorizations、recovery_codes，以及个人 D1-only 的 BLOB 列。
- [x] 深度 0/1/2/3 的插件遍历边界和循环引用去重有测试；指定大型笔记的只读统计为 1/5/11/22 篇。
- [x] Publish API → Viewer 的随机 siteId/path 关系有测试，根页面使用 `index.html`。
- [x] 引用页面直接位于站点目录下，页面编号按规范化源路径排序。
- [x] Worker HTTP 路由在 Node Request/Response mock 中验证健康检查、未授权 JSON 错误和流式 Viewer。
- [x] 个人部署在 Node mock 中验证 PKCE、OAuth state、拒绝、loopback callback、唯一账户、Worker/D1 创建顺序、目标初始化、bootstrap secret 清理、OAuth revoke 和失败清理；断言个人路径不请求 R2。
- [x] 个人自定义域名在 Node mock 中验证 PKCE 临时 scope、账户/Zone 查询、同 Worker 已有域名检查、根域名与子域名输入、attach/detach、OAuth revoke，以及解绑后恢复 workers.dev。
- [x] 已有个人 Worker 可在插件更新后原地刷新 Worker artifact，复用 D1、保留 Worker URL/自定义域名且不删除既有资源；`/healthz` 返回 Worker 版本，设置页和发布前会拦截历史/无法确认版本并提示手动更新。
- [x] Worker 通过自定义域名访问时使用请求 origin 生成分享链接；未绑定或解绑后继续使用 Worker origin。
- [x] 插件设置页提供“部署到我的 Cloudflare”，桌面版直接调用 Cloudflare OAuth/API 并保存 Worker URL/Publish Token；插件源码不包含 Cloudflare 管理 Token 或 client secret，也不请求 provisioning control plane。
- [x] Computer Use 手工验证 Obsidian 1.13.7 设置页：当前只保留“部署到我的 Cloudflare”入口；移动端部署按钮禁用并显示“请先在桌面版完成部署”，Debug 关闭时不展示日志；官方连接入口保留为规划，不在当前设置页提供。
- [x] 设置页提供“取消连接”：仅清除当前 Vault 的 Worker 地址和 Publish Token，保留 Cloudflare 资源、已发布网站和其他设备连接，并在执行前确认。
- [x] 目标 Worker 提供一次性签名初始化接口，不要求用户填写邮箱、密码、恢复码或 Bootstrap Secret；初始化后删除 Worker secret。
- [ ] 公开 OAuth Client ID 注入正式插件构建、Cloudflare API 资源创建和桌面端真实部署待 staging 凭据。
- [ ] 真实 Cloudflare Custom Domain 绑定、DNS/证书生效、根域名既有路由冲突和跨设备同步待 staging 域名凭据。
- [ ] `wrangler dev` + 本地 D1-only 模拟待安装 Wrangler 后执行；官方 R2 binding smoke 单独执行。
- [x] Obsidian Plugin 已接入本地测试服务。
- [x] 本地插件 artifact 包含自包含的 `manifest.json` 和 `main.js` runtime；`compiler.js` 仅保留为开发参考，不进入安装包。
- [x] `npm run update:plugin` 已验证会重新构建、生成根目录镜像、准备 Release 暂存包、运行 parity check 并同步 Vault。
- [x] GitHub Actions 已加入 main/tag 校验；tag 必须匹配 manifest 版本，Release 仅上传生成的插件资产，并使用 `package-lock.json` 与 GitHub artifact attestation 验证构建来源。
- [x] 真实 Obsidian vault 中的加载、当前笔记首发/更新和 frontmatter 回写已验证。

## Regression and recovery gate

- [x] 本地首发、重复发布、更新和 viewer 读取纳入测试。
- [x] 纯编译器页面布局回归覆盖工作区 CSS 快照的固定高度/overflow 冲突；标题折叠不依赖脚本，代码块复制由页面 shell 事件处理。
- [ ] 真实 Obsidian 原生快照重新发布后，确认长页面可滚动且标题折叠可用。
- [x] 本地 HTTP 发布接口和 `/s/{siteId}/` viewer smoke test 通过。
- [x] 小块队列上传和不完整上传保留旧 revision 的测试通过。
- [x] Worker core 不完整上传不会更新 current；重复 chunk/commit 设计为幂等。
- [x] 个人部署使用 Worker 入口、D1 migration 和控制台；个人使用 D1-only；官方托管及其控制面作为后续规划保留，个人部署不依赖它。
- [x] 本地启动器支持重复启动时强制清理目标端口、精确 PID 处理、`start/stop/restart/status/logs` 和启动日志。
- [ ] 失败提交保留旧 revision 的测试待补充异常注入后完成。
- [ ] 真实官方 Worker 部署、失败恢复和高级 Deploy Button/Wrangler/`/setup` 步骤待 WP-CF-3/WP-CF-4/WP-CF-6。
- [ ] 真实桌面直连部署、跨账户/无账户 OAuth、资源冲突、远端 migration、更新和删除待 WP-CF-7/WP-CF-6；需同时验证控制面不可用时已有个人 Worker 仍可发布。
- [x] 自定义域名失败/解绑保留原 workers.dev 发布入口；域名绑定失败不会覆盖已有 Worker URL 或 Publish Token。

## Evidence

- Local contract/e2e fixture: `tests/publish-flow.test.ts`
- Runtime implementation: `src/compiler/site-compiler.ts`, `src/publish/in-memory-publisher.ts`, `src/publish/local-viewer.ts`, `server/core`, `server/worker`, `server/storage`
- Compiler renderer: `src/compiler/markdown-renderer.ts`
- Obsidian smoke note: `Share Publisher Test.md`（真实 Vault，已验证当前笔记首发/更新；最新随机 siteId 和引用页面默认开关待重新 smoke）
- Manual findings: `.engineering/manual-test-findings.md`

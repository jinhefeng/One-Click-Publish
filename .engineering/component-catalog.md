# Component Catalog: Cloudflare-first One-Click Publish

| `component_id` | Capability | Owner | Consumers | Public interface | Maturity | Decision | Migration |
|---|---|---|---|---|---|---|---|
| CMP-001 | Markdown → HTML 编译 | T2 | Obsidian Plugin, local tests | `compileShare(input): PublishBundle`, `compileNote(input): PublishBundle` | validated local | create | `compileShare` 接收根笔记和可选引用页面，站点内去重后输出 `index.html` 与同目录 `page-N.html` 路由；`src/compiler/markdown-renderer.ts` 保持纯函数；插件 artifact 暂以自包含 runtime mirror，后续接入正式构建 |
| CMP-002 | 发布包契约 | T1 | Compiler, Publish API, tests | `PublishBundle`, `PublishRequest`, `PublishResult` | frozen for MVP | create | 使用 `formatVersion: 1`；破坏性变更需新版本 |
| CMP-003 | 发布客户端 | T4 | Obsidian Plugin | `connectAccount()`, `createUploadChunks()`, `/v1/auth/device/*` and C-005 | implemented locally | change | 官方模式通过官方控制面设备授权；个人 Worker 使用已保存的 Worker URL/Publish Token；插件仅保存发布配置 |
| CMP-004 | 发布服务 | T3 | Plugin, Viewer | `/v1/sites/uploads`, `/v1/uploads/*`, `/healthz` | implemented locally | create | Worker router delegates to portable core; local Node server remains a test substitute |
| CMP-005 | 资源存储适配器 | T3 | Publish API, Viewer | `PublishStorage` | implemented locally | reuse | MemoryStorage and CloudflareD1R2Storage share an async interface; official Workers use private R2 chunks plus D1 metadata, personal Workers use D1 BLOB chunks |
| CMP-006 | 站点 Viewer | T3 | Browser, integration tests | `GET /s/{siteId}/{path}` | implemented locally | create | local viewer validates route rules; Worker streams current R2 chunks in official mode or D1 BLOB chunks in personal mode |
| CMP-007 | Obsidian 交互层 | T4 | Obsidian users | commands, menus, settings | proposed | create | 参考 `obsidian-htmlto-link` 的交互，不复制其服务耦合 |
| CMP-008 | Obsidian 原生渲染快照 | T4 | Obsidian Plugin, Publish API | `renderNativeMarkdown(plugin, markdown, sourcePath, context): Promise<{html, styles}>` | first implementation | create | 在隐藏容器中调用 `MarkdownRenderer`，等待动态块，提取 HTML、主题/插件 CSS 和计算字体样式，规范化链接/资源/复选框，剥离工作区布局类并将标题组织为原生 `<details>/<summary>` 后发布；发布页 shell 负责标题悬停折叠符号和代码块复制事件；失败回退 CMP-001 |
| CMP-009 | 发布上传队列 | T4 | Obsidian Plugin, Publish API | `createUploadChunks(bundle): PublishUploadChunk[]`; `/v1/sites/uploads`, `/v1/uploads/{uploadId}/chunks`, `/commit` | protocol v2 | change | 页面按 UTF-8 字节预算切片；二进制资源每片独立 base64；服务端立即解码并写入官方 R2 或个人 D1 BLOB |
| CMP-010 | Portable Publish/Auth Core | T3 | Worker Router, console, tests | `PublishService`, `PublishStorage` | implemented locally | create | Web API/Web Crypto only；包含注册、登录、恢复、device pairing、token、upload/commit/viewer |
| CMP-011 | Device authorization | T3/T4 | Plugin, console | `/v1/auth/device/start|poll|approve`, `/connect` | implemented locally | create | 10 分钟单次 device code；浏览器批准后 poll 只返回一次 `pn_` token |
| CMP-012 | Minimal web console | T3 | Browser, plugin connection | `/login`, `/register`, `/recover`, `/setup`, `/account/*` | implemented locally | create | 登录/注册/一次性恢复码/Token/usage/sites/delete；不做团队、计费和历史版本 |
| CMP-013 | Cloudflare storage adapter and deployment template | T3 | Worker, advanced operators | `wrangler.jsonc`, D1 migration, optional private R2 key layout | implemented locally | create | `wrangler.jsonc` is D1-only for personal deployment; official operators may add private R2; Deploy Button/manual `/setup` remains advanced fallback |
| CMP-014 | Legacy Provisioning Control Plane | T3 | legacy plugin/service | `/v1/cloudflare/provision/start|poll|ack`, `/oauth/cloudflare/callback` | implemented locally / deprecated | retain | 仅为旧版已部署实例和兼容窗口保留；不得出现在新插件默认流程、README 或验收路径 |
| CMP-015 | Target Worker automated initialization | T3/T4 | Personal Desktop Provisioner, legacy control plane | `POST /__internal/provision/initialize` | implemented locally | extend | 一次性 secret + 10 分钟 HMAC claim 创建单用户空间和 Publish Token；初始化后失效；新主链路由桌面插件直接调用 |
| CMP-016 | Personal Desktop Cloudflare Provisioner | T4 | Obsidian desktop plugin | Authorization Code + PKCE, loopback callback, Cloudflare REST API, embedded Worker/migration and Custom Domains | implemented locally / remote pending | extend | 唯一账户检查、Worker/D1 冲突保护、固定 D1-only 资源流程、bootstrap 初始化、同账户 Zone 查询、域名绑定/解绑、失败清理和 OAuth revoke；不申请 R2 scope，access token 只在内存中存在 |
| CMP-017 | Obsidian Distribution and Release Packaging | T5 | Obsidian Community directory, GitHub Release, local Vault | `npm run update:plugin`, root mirrors, `dist/obsidian-release/`, parity check | implemented locally / remote pending | create | `plugin/manifest.json` 和 `plugin/main.js` 是唯一源；生成根目录镜像、精确 Release assets 和 Vault runtime；`compiler.js` 仅为开发参考 |
| CMP-018 | Personal custom domain binding | T4 | Obsidian settings, personal Worker, Cloudflare Custom Domains API | bind/unbind root or subdomain, active publish URL, request-origin site URL | implemented locally / remote pending | create | 仅允许授权账户的 active Zone；v1 每个 Worker 一个主域名；使用临时 OAuth scope，管理 token 不落盘，workers.dev 作为 fallback |

## Reuse decisions

- `obsidian-htmlto-link` 的 UI 交互属于外部参考，不直接复制代码；当前仓库为空，也没有可合法复用的内部组件。
- 编译器、发布服务和存储适配器分别拥有不同生命周期，因此不抽取为一个“大而全”的共享模块。
- `src/compiler/markdown-renderer.ts` 是根笔记/引用页面编译共享的纯渲染核心；`site-compiler.ts` 负责 bundle 组装、页面路径和导航。
- `plugin/main.js` 当前保持自包含，避免 Obsidian 对本地 sibling runtime 的加载差异；`plugin/compiler.js` 作为可读参考，二者必须通过同一组 fixtures 校验。两者都使用 `compileShare`，不再提供文件夹分享入口。
- CMP-017 复用 `plugin/` 的自包含 runtime，不把编译器、服务端或源码目录复制进 Obsidian Release；根目录镜像和 Release 暂存包由同步脚本生成，CI 负责拒绝漂移。
- 内存存储不是生产组件，而是 C-003 的验证替身；它的接口刻意与官方 R2/D1 和个人 D1-only 适配器一致，减少集成风险。
- 原生渲染是插件内的运行时能力，不改变 C-001；其输出仍需包装成 `PublishBundle`，并将动态行为按快照处理。
- 官方托管与自部署不复制发布业务逻辑：官方路径增加控制面做账户/设备/Token/租户管理，个人路径由 CMP-016 在桌面端直接创建并初始化独立 Worker；两者仍共享 Worker-compatible core，发布核心不设置账户级内容配额。
- 控制台使用服务端生成的最小 HTML，避免引入前端构建链和额外的用户操作；插件设备授权和 Cloudflare JSON API 通过 Obsidian `requestUrl`，不依赖浏览器 CORS，Worker multipart 上传保留受控的桌面网络调用。
- `server/provisioner` 与 provisioning D1 是 legacy compatibility surface，不再作为个人部署的默认依赖；Deploy Button、Wrangler 和 `/setup` 只支持高级备用路径。

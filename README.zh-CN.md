# One-Click Publish

**语言 / Language:** 中文 | [English](README.md)

完成一次 Cloudflare 账户连接后，只需一次点击即可将当前 Obsidian Markdown 笔记发布为可分享的网站。One-Click Publish 可以携带链接笔记、上传引用的本地资源，并在再次发布时保持稳定链接。

## 插件功能

- 将当前笔记发布为稳定 `/s/{siteId}` 网站的根页面。
- 根据**引用页面深度**携带链接的 Markdown 笔记。
- 支持 WikiLink、相对 Markdown 链接、图片、Callout、代码块、表格和任务列表。
- 上传引用的本地图片及其他支持的本地资源。
- 外部 URL、锚点、`mailto:` 链接和外部资源保持原样。
- 自动复制发布链接，并在根笔记 frontmatter 中写入 `share_site_id`、`share_link` 和 `share_updated`。
- 支持 Obsidian 原生渲染；原生渲染不可用时使用确定性回退渲染器。
- 可从当前连接的 Cloudflare 账户绑定一个根域名或子域名，并保留原 Worker 地址作为备用地址。

## 安装

### 社区插件

在 Obsidian 中打开**设置 → 社区插件 → 浏览**，搜索 **One-Click Publish**，安装后启用。

### 手动安装

从[最新 GitHub Release](https://github.com/jinhefeng/One-Click-Publish/releases/latest)下载 `manifest.json` 和 `main.js`，将两个文件放入：

```text
.obsidian/plugins/one-click-publish/
```

然后打开**设置 → 社区插件**，启用 **One-Click Publish**。

## 快速开始

1. 在 Obsidian 桌面版打开**设置 → 社区插件 → One-Click Publish**。
2. 点击**部署到我的 Cloudflare**，完成一次 Cloudflare 授权。
3. 打开要发布的 Markdown 笔记。
4. 可选：在**自定义域名**设置中填写同一 Cloudflare 账户内的根域名或子域名，然后点击**绑定域名**。
5. 从命令面板、功能区或笔记右键菜单选择 **One-Click Publish**。
6. 打开自动复制的链接，或在笔记 frontmatter 中查看链接。

首次部署会在你的 Cloudflare 账户中创建私有 Worker 和 D1 数据库。部署完成后，插件只在 Vault 中保存 Worker 地址和受限的 Publish Token；Cloudflare access token 只在内存中使用，完成部署后会撤销。

部署完成后，如果要在其他设备使用，请在同步 Vault 时同时同步本插件设置。只同步笔记不会同步发布连接。

自定义域名同时支持 `example.com` 和 `notes.example.com`，但域名所在的 active Zone 必须属于当前连接的 Cloudflare 账户。Cloudflare 会负责 Worker 域名记录和证书；原来的 `workers.dev` 地址仍可作为备用地址。绑定根域名可能影响该域名已有的路由。

Cloudflare 主连接和自定义域名绑定是两套独立设置。解绑自定义域名只会移除该自定义域名绑定，并将发布切回 Worker 地址，不会取消已保存的 Cloudflare Worker 或 Publish Token。**取消连接**是单独的本地连接操作，不能代替自定义域名解绑。

如果 Cloudflare 已完成域名删除，但 Obsidian 保存新的本地设置失败，插件会保留主连接并在设置页显示恢复操作。请点击**恢复自定义域名状态**，让本地状态与 Cloudflare 重新对齐后再进行下一次域名操作。

## 链接笔记与资源

**引用页面深度**决定 One-Click Publish 跟随链接的范围：

- `0`：只发布当前笔记。
- `1`：包含当前笔记直接链接的页面。
- 更大的值：继续包含更深层的链接页面。

当前笔记始终是分享根页面。本地图片和支持的本地资源会随页面一起上传；外部资源不会被下载或改写。

## 设置

- **语言**：默认英文，也可以切换为中文。
- **引用页面深度**：控制链接笔记的遍历范围。
- **使用 Obsidian 渲染器**：在支持时保留 Obsidian 的渲染效果。
- **自定义域名**：可选绑定当前 Cloudflare 账户内的一个根域名或子域名。
- **更新 Cloudflare Worker**：插件更新后刷新已有个人 Worker，不替换已发布的数据。
- **Worker 兼容性检查**：在设置页和每次发布前比较线上 Worker 与插件版本；历史版本或无法确认版本的 Worker 必须先更新。
- **调试模式**：排查问题时显示脱敏后的部署和发布诊断信息。

普通设置页不会要求填写服务地址或 Publish Token。官方托管连接仍在规划中；当前支持的路径是部署到你自己的 Cloudflare 账户。

## 限制与隐私

- 个人发布使用 Cloudflare Workers 和 D1，不会创建或要求 R2。
- 不设置账户级当前发布内容配额，也不限制已发布笔记的数量。
- 单个文件上限为 20 MB。
- 内容会分片上传，以符合 Cloudflare 请求限制；单次请求和单个文件的平台边界仍然适用。
- 调试日志不会记录凭证、请求正文或笔记内容。

## 更新已发布笔记

One-Click Publish 会在根笔记 frontmatter 中保存站点 ID。再次发布同一个根笔记时，会更新原有网站，而不是创建新的链接。

## 常见问题

- 安装或更新插件后，请重新加载社区插件。
- 发布失败时，开启**调试模式**，重试一次并查看可复制的调试日志。
- 部署失败时，确认 Obsidian 桌面版可以打开 Cloudflare 授权流程，并且账户允许修改 Worker 和 D1。
- 如果自定义域名解绑提示 Cloudflare 已完成变更但本地设置保存失败，请重新打开设置页并点击**恢复自定义域名状态**。恢复完成前不要取消主 Cloudflare 连接。
- 手动安装时，确认 `manifest.json` 和 `main.js` 直接位于 `.obsidian/plugins/one-click-publish/` 中。

## 相关链接

- [GitHub 仓库](https://github.com/jinhefeng/One-Click-Publish)
- [最新 Release](https://github.com/jinhefeng/One-Click-Publish/releases/latest)
- [作者：Jin Hefeng](https://github.com/jinhefeng)
- [MIT License](LICENSE)

开发、测试、打包和发布说明请参阅[贡献指南](CONTRIBUTING.zh-CN.md)。

# One-Click Publish 插件

**语言 / Language:** 中文 | [English](README.md)

完成一次 Cloudflare 账户连接后，One-Click Publish 只需一次点击即可将当前 Obsidian Markdown 笔记发布为可分享的网站。插件可以携带链接笔记、上传引用的本地资源、复制发布链接，并在更新笔记时保持原链接不变。

## 手动安装

从[最新 Release](https://github.com/jinhefeng/One-Click-Publish/releases/latest)下载 `manifest.json` 和 `main.js`，将两个文件直接放入：

```text
.obsidian/plugins/one-click-publish/
```

然后在**设置 → 社区插件**中启用 **One-Click Publish**。

## 使用插件

1. 打开**设置 → 社区插件 → One-Click Publish**。
2. 在桌面版点击**部署到我的 Cloudflare**并完成一次 Cloudflare 授权。
3. 可选：在**自定义域名**中填写同一 Cloudflare 账户内的一个根域名或子域名，然后点击**绑定域名**。
4. 打开 Markdown 笔记，从命令面板、功能区或笔记右键菜单选择 **One-Click Publish**。
5. 如需携带链接笔记，调整**引用页面深度**。

当前笔记是分享根页面。One-Click Publish 支持 WikiLink、相对链接、图片、Callout、代码块、表格、任务列表和引用的本地资源；外部 URL 和资源保持原样。

部署完成后，插件会保存 Worker 地址、可选的自定义域名和受限的 Publish Token。插件不会创建或要求 R2，普通设置页也不会要求填写服务地址或 Token。自定义域名必须属于当前连接的 Cloudflare 账户，Worker 地址仍会保留为备用地址。设置页和发布流程会比较线上 Worker 与插件版本；只有在已保存的 Worker 需要刷新时才显示“更新 Cloudflare Worker”，历史版本或无法确认版本的 Worker 必须先更新后再发布。

Cloudflare 主连接和自定义域名状态相互独立。点击**解绑**只会移除自定义域名绑定，并将发布切回 Worker 地址，不会取消 Worker 或 Publish Token。若远程删除成功但 Vault 无法保存本地状态，设置页会保留可恢复标记，并提供**恢复自定义域名状态**操作。**取消连接**仍然是单独的本地连接操作。

完整用户指南请参阅[仓库 README](../README.zh-CN.md)；开发和发布说明请参阅[贡献指南](../CONTRIBUTING.zh-CN.md)。

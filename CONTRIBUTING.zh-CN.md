# 参与 One-Click Publish 开发

**语言 / Language:** 中文 | [English](CONTRIBUTING.md)

本文档面向维护者和贡献者。面向插件用户的说明请参阅[README.zh-CN.md](README.zh-CN.md)。

## 项目边界

- `plugin/manifest.json` 是插件 manifest 的唯一源文件。
- `plugin/main.js` 是自包含的 Obsidian 运行时入口。
- `plugin/compiler.js` 是开发/参考编译器，运行时不会加载，也不会进入插件发布附件。
- `src/`、`server/` 和 `tests/` 用于开发和发布基础设施，不是 Obsidian 安装文件。
- 插件 ID 永久保持为 `one-click-publish`；开发 Vault 的运行时目录是 `.obsidian/plugins/one-click-publish/`。

## 环境要求

使用 Node.js 26，或支持 TypeScript type stripping 的 Node.js 版本。运行检查前先安装仓库依赖。

## 本地开发

使用以下命令启动和管理本地内存发布服务：

```bash
npm run dev:server
npm run status
npm run restart
npm run stop
npm run logs
```

本地服务只用于契约和插件测试，不是生产托管服务。

## 验证

修改插件或发布服务后执行：

```bash
npm run check:plugin
node --check plugin/main.js
npm test
git diff --check
```

测试会启动本地 HTTP 监听器。如果沙箱禁止 loopback 监听，需要使用允许本地网络的环境重新运行测试。

## 插件打包

插件发布源文件只修改 `plugin/manifest.json` 和 `plugin/main.js`。修改任一文件后执行：

```bash
npm run update:plugin
```

该命令会构建内嵌 Worker、生成根目录 `manifest.json` 和 `main.js` 镜像、准备 `dist/obsidian-release/`、检查字节级一致性，并将运行时同步到开发 Vault。

Release 暂存目录只能包含：

```text
manifest.json
main.js
plugin/styles.css 存在时才包含 styles.css
```

不要将 `src/`、`server/`、`tests/`、`plugin/` 或 `plugin/compiler.js` 上传为插件 Release 附件。

## GitHub Release

每个版本都使用 `plugin/manifest.json` 中的完整版本号作为 `x.y.z` 标签，不能加 `v` 前缀。

`.github/workflows/plugin-release.yml` 会从 `package-lock.json` 安装依赖、校验仓库、为准确的 Release 暂存资产生成 GitHub artifact attestation，并在推送准确的 SemVer 标签后创建 GitHub Release；Release 只包含生成的 `manifest.json`、`main.js` 和可选的 `styles.css`。

推送版本前：

1. 同步升级 `plugin/manifest.json` 和 `package.json`。
2. 执行 `npm run update:plugin`。
3. 执行必需的验证命令。
4. 确认根目录镜像和 Release 暂存文件与 `plugin/` 源文件字节一致。
5. 推送 `main`。
6. 推送匹配的标签，例如 `0.3.0`。
7. 确认 GitHub Release 包含 `manifest.json` 和 `main.js`，并确认 workflow 已生成对应的 artifact attestation。

插件正式发布后不要再修改插件 ID。修改 ID 会让 Obsidian 将其识别为另一个插件，并破坏正常更新链路。

## 仓库结构

```text
plugin/                 Obsidian 源文件和面向用户的插件 README
src/                    编译器和共享应用源代码
server/                 本地服务和 Cloudflare Worker 源代码
tests/                  自动化测试
scripts/                构建、打包、检查和同步工具
dist/obsidian-release/  生成的 GitHub Release 暂存文件
.engineering/           架构和交付记录
```

用户可见的功能和文案变更要同步维护中英文 README。详细工程决策放在 `.engineering/`，项目任务索引放在 `Task Constitution.md`。

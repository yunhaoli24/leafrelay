# LeafRelay

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/yunhaoli24.leafrelay?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
[![npm](https://img.shields.io/npm/v/leafrelay?label=npm)](https://www.npmjs.com/package/leafrelay)
[![Build](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml/badge.svg)](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml)
[![许可证](https://img.shields.io/github/license/yunhaoli24/leafrelay)](./LICENSE)

**让 Overleaf 和 VS Code 本地项目可靠地双向同步。**

LeafRelay 是面向 Overleaf、LaTeX 和 VS Code 用户的本地同步扩展，适合在本地编辑器、终端、脚本或 AI 编程工具中修改项目，同时继续和 Overleaf 协作。它会同步两端变化，并在发生冲突时停下来让用户决定，而不是悄悄覆盖其中一份内容。

> LeafRelay 是由社区独立维护的 Overleaf Workshop 分支，与 Overleaf 及 Overleaf Workshop 维护者没有隶属或合作关系。已有的 `.overleaf/settings.json` 项目配置可以继续使用。

[English README](./README.md)

## 为什么选择 LeafRelay？

Overleaf Workshop 奠定了在 VS Code 中使用 Overleaf 的工作流，但较早的本地副本逻辑更偏向由编辑器驱动修改。当文件由其他编辑器、终端、脚本或 AI 工具修改时，工作流就容易变得不可靠：可能要等编辑器保存才触发同步，重新连接会重复下载大量文件，多个本地副本会互相抢占，同一路径两端同时修改时还可能发生无提示覆盖。

LeafRelay 专门针对这些问题设计：

- **外部修改自动同步**：终端、其他编辑器、脚本和 AI 工具修改文件后也能触发上传。
- **增量启动和重连**：本地状态有效时只传输发生变化的文件。
- **冲突先暂停**：本地和 Overleaf 同时修改同一路径时保留两边内容，不自动替用户选择。
- **每个工作区只启用一个本地副本**：避免旧目录继续向项目推送过期内容。
- **请求限流感知**：统一排队项目请求并遵守 Overleaf 的 `429` 冷却时间，减少请求突发。
- **忽略点目录和软链接**：包括 `.output` 等生成目录，不会被误上传或删除。

LeafRelay 保留 Overleaf Workshop 的虚拟项目和协作能力，同时把日常本地目录同步的可靠性放在首要位置。

## 安装

### VS Code 扩展

从 VS Code Marketplace 安装 **[LeafRelay](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)**。后续版本由 VS Code 按正常扩展更新机制自动更新。

### npm CLI

从 **[npm](https://www.npmjs.com/package/leafrelay)** 安装独立同步服务，需要 Node.js 24 或更高版本。

```bash
npm install --global leafrelay
```

## 开始同步

1. 在 VS Code 中打开 **LeafRelay** 视图并添加 Overleaf 服务器。
2. 登录，选择项目，然后点击 **Open Project Locally**。
3. 在 VS Code 中打开选定的本地目录，之后本地和 Overleaf 的变化会双向同步。

项目详情、登录方式、自托管 Overleaf 和故障排查请看[用户文档](./docs/README.md)。

## 脱离 VS Code 运行

LeafRelay 同时提供 Node.js CLI。VS Code 扩展创建的本地副本可以直接交给 CLI 使用，因为两者读取同一份 `.overleaf/settings.json` 项目关联配置。

```bash
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay login` 会按服务器把登录会话保存到 `~/.leafrelay/config.json`。可以用 `LEAFRELAY_CONFIG` 指定其他配置文件，或用 `LEAFRELAY_COOKIE` 仅覆盖当前进程使用的 cookie。

## 开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run compile
```

Pull Request 会运行 VS Code 激活测试和 ShareLaTeX 容器集成测试。发布由 Release Please 准备，并通过自动流水线发布 VS Code 扩展、npm 包和 GitHub Release 附件。

pnpm monorepo 将可复用同步引擎放在 `packages/core`，后台 CLI 放在 `packages/cli`，VS Code 适配层放在 `apps/vscode`。

## 项目背景

LeafRelay 起源于 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop)，现在作为独立项目维护，采用 [AGPL-3.0-only](./LICENSE) 许可证。项目重点是可靠的 Overleaf 与本地目录同步，并继续发展可脱离 VS Code 复用的同步组件。

## 链接

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
- [问题反馈与功能建议](https://github.com/yunhaoli24/leafrelay/issues)
- [贡献指南](./CONTRIBUTING.md)
- [文档](./docs/README.md)
- [原 Overleaf Workshop 项目](https://github.com/overleaf-workshop/Overleaf-Workshop)

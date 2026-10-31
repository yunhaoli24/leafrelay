# LeafRelay CLI

**在终端中双向同步 Overleaf。** 你用熟悉的编辑器、脚本或 AI 工具修改 LaTeX，合作者继续在 Overleaf 网页端写作。

[English](https://github.com/yunhaoli24/leafrelay/blob/main/packages/cli/README.md) · [VS Code 扩展与截图](https://github.com/yunhaoli24/leafrelay#readme) · [问题反馈](https://github.com/yunhaoli24/leafrelay/issues)

## 有什么优势？

- 外部工具修改文件后自动上传，不必再去 IDE 保存一次。
- 使用检查点增量启动和重连，减少重复下载。
- 三方合并自动处理不重叠的文本修改，冲突路径暂停等待处理。
- 多个 CLI 进程与 VS Code 窗口共享 daemon，每个本地目录只使用一套请求队列与同步引擎。
- 文件日志显示修改情况；统一调度同一账号的请求，遵守 Overleaf 限流。

## 快速上手

需要 **Node.js 24 或更高版本**，以及包含 `.overleaf/settings.json` 的本地副本。先用 VS Code 扩展的 **Open Project Locally…** 配置一次目录；`serve` 会复用这份关联，不会创建新的项目关联。

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`login` 会提示选择浏览器 Cookie 或邮箱和密码。登录状态按服务器保存到 `~/.leafrelay/config.json`，与 VS Code 扩展共用。自托管服务器可以直接把自己的 URL 传给 `login`。

保持 `serve` 运行即可持续同步，也可以用 `leafrelay serve /path/to/project` 直接指定目录。按 **Ctrl+C** 退出当前客户端；该目录没有其他客户端时会停止同步。需要查看或解决暂停的冲突时，用 VS Code 扩展打开同一目录即可。

## 与 VS Code 共用后端

CLI 和扩展同时打开相同目录，不会重复上传。每个 Overleaf 项目只对应一个可写本地目录，不同项目可以并行运行。两个客户端请保持相同发布版本：旧 daemon 会自动重启升级，daemon 版本更高时则要求先升级客户端。

```bash
leafrelay daemon status
leafrelay daemon stop
leafrelay daemon restart
```

`LEAFRELAY_HOME` 可以移动全部用户状态，`LEAFRELAY_CONFIG` 指定其他登录文件，`LEAFRELAY_COOKIE` 只覆盖当前进程使用的 Cookie。点号开头的路径与软链接不会参与同步。

库接口 `startServe()`、配置及架构说明见[文档](https://github.com/yunhaoli24/leafrelay/blob/main/docs/anatomy.md)。LeafRelay 是独立维护的 [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) 分支，采用 AGPL-3.0-only 许可证。

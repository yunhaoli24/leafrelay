# LeafRelay CLI

LeafRelay 可以脱离 VS Code，在后台持续同步 Overleaf 项目和本地目录。

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay serve` 会读取项目中的 `.overleaf/settings.json`，然后连接这台电脑上唯一的 LeafRelay daemon。VS Code 窗口和其他 CLI 进程共用同一个后台、请求队列、项目连接和本地 watcher。

登录会话按服务器保存到 `~/.leafrelay/config.json`。使用 `leafrelay daemon status|stop|restart` 控制后台进程。`LEAFRELAY_HOME` 可以移动全部 LeafRelay 用户状态，`LEAFRELAY_CONFIG` 只指定其他登录文件，`LEAFRELAY_COOKIE` 则仅覆盖当前进程使用的 cookie。

VS Code 扩展、架构和完整文档见 [LeafRelay 仓库](https://github.com/yunhaoli24/leafrelay)。

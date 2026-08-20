# LeafRelay CLI

LeafRelay 可以脱离 VS Code，在后台持续同步 Overleaf 项目和本地目录。

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay serve` 会读取项目中的 `.overleaf/settings.json`。登录会话按服务器保存到 `~/.leafrelay/config.json`；可以用 `LEAFRELAY_CONFIG` 指定其他配置文件，或用 `LEAFRELAY_COOKIE` 仅覆盖当前进程使用的 cookie。

VS Code 扩展、架构和完整文档见 [LeafRelay 仓库](https://github.com/yunhaoli24/leafrelay)。

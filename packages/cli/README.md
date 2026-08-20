# LeafRelay CLI

LeafRelay keeps an Overleaf project synchronized with a local directory without requiring VS Code.

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay serve` reads `.overleaf/settings.json` from the local project and connects to the machine-wide LeafRelay daemon. VS Code windows and other CLI processes use that same daemon, request scheduler, project connection, and local watcher.

Login sessions are stored per server in `~/.leafrelay/config.json`. Use `leafrelay daemon status|stop|restart` to control the daemon. `LEAFRELAY_HOME` relocates all LeafRelay user state, `LEAFRELAY_CONFIG` selects another login file, and `LEAFRELAY_COOKIE` overrides the saved cookie for the current process.

For the VS Code extension, architecture, and project documentation, see the [LeafRelay repository](https://github.com/yunhaoli24/leafrelay).

# LeafRelay CLI

LeafRelay keeps an Overleaf project synchronized with a local directory without requiring VS Code.

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay serve` reads `.overleaf/settings.json` from the local project. Login sessions are stored per server in `~/.leafrelay/config.json`. Use `LEAFRELAY_CONFIG` to select another config file or `LEAFRELAY_COOKIE` to override the saved cookie for the current process.

For the VS Code extension, architecture, and project documentation, see the [LeafRelay repository](https://github.com/yunhaoli24/leafrelay).

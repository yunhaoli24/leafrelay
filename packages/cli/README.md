# LeafRelay CLI

**Two-way Overleaf sync from your terminal.** Edit LaTeX with your preferred editor, scripts, or AI tools while collaborators keep working in Overleaf.

[中文](https://github.com/yunhaoli24/leafrelay/blob/main/packages/cli/README.zh-CN.md) · [VS Code extension and screenshots](https://github.com/yunhaoli24/leafrelay#readme) · [Issues](https://github.com/yunhaoli24/leafrelay/issues)

## Why use it?

- External file changes trigger uploads without an extra IDE save.
- Checkpoints support incremental startup and reconnects.
- Three-way merging combines non-overlapping edits; conflicting paths pause for review.
- Multiple CLI processes and VS Code windows share one daemon, request queue, and sync engine per local folder.
- Per-file logs show what changed; account-wide request scheduling respects Overleaf rate limits.

## Quick start

Requires **Node.js 24 or later** and a local replica containing `.overleaf/settings.json`. Set up the directory once with the VS Code extension's **Open Project Locally…** command; `serve` reuses that association and does not create one.

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`login` prompts for a browser cookie or email/password. Login sessions are saved per server in `~/.leafrelay/config.json` and shared with the VS Code extension. For a self-hosted server, pass its URL to `login`.

Keep `serve` running to keep the folder synchronized. You can pass a folder directly with `leafrelay serve /path/to/project`. Press **Ctrl+C** to detach; synchronization stops when that folder has no remaining clients. To review or resolve paused conflicts, open the same folder with the VS Code extension.

## Share the backend with VS Code

Running the CLI and extension together on the same folder does not create duplicate uploads. One Overleaf project may have one writable local directory; different projects can run in parallel. Keep both clients on the same release version: an older daemon restarts automatically, while a newer daemon requires upgrading the client.

```bash
leafrelay daemon status
leafrelay daemon stop
leafrelay daemon restart
```

`LEAFRELAY_HOME` relocates all user state, `LEAFRELAY_CONFIG` selects another login file, and `LEAFRELAY_COOKIE` overrides the saved cookie for the current process. Dot-prefixed paths and symbolic links are excluded from synchronization.

For the library's `startServe()` API, configuration, and architecture, see the [documentation](https://github.com/yunhaoli24/leafrelay/blob/main/docs/anatomy.md). LeafRelay is an independently maintained fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), licensed under AGPL-3.0-only.

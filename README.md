# LeafRelay

**Write locally. Collaborate on Overleaf. Keep both in sync.**

[![npm](https://img.shields.io/npm/v/leafrelay?label=npm)](https://www.npmjs.com/package/leafrelay)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/lealaxy.leafrelay-sync?label=VS%20Code)](https://marketplace.visualstudio.com/items?itemName=lealaxy.leafrelay-sync)
[![CI](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml/badge.svg)](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml)
[![License](https://img.shields.io/github/license/yunhaoli24/leafrelay)](./LICENSE)

[中文](./README.zh-CN.md) · [Get started](#get-started-in-vs-code) · [CLI](#sync-without-vs-code) · [Documentation](./docs/README.md) · [Releases](https://github.com/yunhaoli24/leafrelay/releases)

LeafRelay connects your **local LaTeX folder and Overleaf with two-way synchronization**. Edit with VS Code, another editor, a terminal, or AI coding tools while your collaborators keep working in the Overleaf browser editor. Use the VS Code extension for an integrated writing workspace, or the npm CLI for synchronization without an IDE.

![LaTeX source and a PDF preview side by side in VS Code](./docs/assets/leafrelay-editor-preview.png)

## Why LeafRelay?

Local editing should fit the way you work: file changes should upload without an extra editor save, reconnecting should not restart a whole download, and concurrent edits should not silently overwrite each other.

LeafRelay builds on Overleaf Workshop with a synchronization core shared by the extension and CLI:

| Your workflow | What LeafRelay adds |
| --- | --- |
| Edit with another editor, script, or AI tool | File-system events trigger synchronization, including while VS Code is in the background. |
| Work alongside someone in Overleaf | Three-way merging combines non-overlapping text edits. Overlapping edits pause that path for review. |
| Reopen a large project | Saved checkpoints let startup and reconnects transfer changed content instead of downloading every unchanged file. |
| Run several VS Code windows and CLI processes | A shared daemon coordinates connections, watchers, and uploads; the same folder can be attached more than once. |
| Encounter Overleaf rate limits | Requests share a queue per account and honor `429` cooldowns across projects. |
| Need to understand a sync problem | Per-file logs report direction, source, and line or byte changes; conflicts and failed paths remain visible. |

**Keep the writing features too:** remote compilation, PDF preview and SyncTeX, LaTeX completion, document outlines, project history, and collaborator chat.

| Navigate a LaTeX document | Chat with collaborators |
| --- | --- |
| ![VS Code document outline showing LaTeX sections and subsections](./docs/assets/leafrelay-document-outline.png) | ![Project files and the collaborator chat panel in VS Code](./docs/assets/leafrelay-chat.png) |

## Get started in VS Code

1. Install **[LeafRelay Sync](https://marketplace.visualstudio.com/items?itemName=lealaxy.leafrelay-sync)** (`lealaxy.leafrelay-sync`). Alternatively, download the `.vsix` from [GitHub Releases](https://github.com/yunhaoli24/leafrelay/releases) and use **Extensions → … → Install from VSIX…**.
2. Open **LeafRelay: Hosts**, click **+**, and add `www.overleaf.com` or your self-hosted Overleaf server. Sign in using a browser cookie or the authentication method supported by your server.
3. Select a project, choose **Open Project Locally…**, and pick a local folder. Open that folder in VS Code to start synchronization.
4. Edit the files with your preferred tools. Check **Output → LeafRelay** for sync activity. Use the extension's compile command when you want to build and preview the PDF on Overleaf.

Already have a local replica? Open the folder containing `.overleaf/settings.json` and sign in to its server. Existing Overleaf Workshop project associations remain usable. Disable the original extension for that folder so it does not run a second, independent sync process.

## Sync without VS Code

Requires **Node.js 24 or later**.

```bash
npm install --global leafrelay
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`login` offers an interactive browser-cookie or email/password prompt. For `www.overleaf.com`, you can reuse a session cookie from your signed-in browser. Sessions are saved in `~/.leafrelay/config.json` and shared with the VS Code extension.

`serve` reads the folder's **`.overleaf/settings.json`**; it does not create a project association. Use **Open Project Locally…** once to set up the folder, then run it from the terminal whenever you need it. You can also pass the directory explicitly:

```bash
leafrelay serve /path/to/local-replica
leafrelay daemon status
```

Keep `serve` running for terminal-only synchronization, and press **Ctrl+C** to detach. The CLI syncs files; remote compilation and the PDF viewer are available in the VS Code extension.

## Use both together

VS Code and the CLI connect to one local daemon, so opening the same folder in both shares one sync engine. Each Overleaf project has one writable local directory; different projects can sync in parallel. When the last client for a folder disconnects, that folder stops syncing and releases its remote connection.

Keep the extension and CLI on the same release version. An older running daemon restarts automatically; a newer daemon asks you to upgrade the connecting client.

## When edits overlap

Non-overlapping text changes merge automatically. If both sides edit the same passage, LeafRelay pauses **that file**, while healthy files continue to sync. In VS Code, choose **Review Difference**, **Use Local**, or **Use Overleaf**. Resolving one conflict continues to the next; for several conflicts, the dialog also offers a batch choice for the conflicting paths.

Dot-prefixed paths, such as `.git` and `.output`, and symbolic links are excluded from synchronization. Keep normal source files outside those directories.

## Learn more and contribute

- [User guide](./docs/README.md): project management, compilation, collaboration, and settings.
- [CLI and architecture](./docs/anatomy.md): configuration locations, shared daemon, and package layout.
- [Contributing](./CONTRIBUTING.md): development, Oxc tooling, tests, and release workflow.
- [Issues and feature requests](https://github.com/yunhaoli24/leafrelay/issues).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run compile
pnpm test
```

Pull requests run Vitest, platform IPC tests, real VS Code Extension Host checks, and ShareLaTeX container integration tests before packaging.

## Acknowledgments

LeafRelay is an independently maintained fork of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), licensed under [AGPL-3.0-only](./LICENSE). The editor screenshots above are adapted from its example-project demos. Thanks to the original contributors for the foundation. LeafRelay is not affiliated with Overleaf.

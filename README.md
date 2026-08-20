# LeafRelay

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/yunhaoli24.leafrelay?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
[![Build](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml/badge.svg)](https://github.com/yunhaoli24/leafrelay/actions/workflows/vsce-package.yml)
[![License](https://img.shields.io/github/license/yunhaoli24/leafrelay)](./LICENSE)

**Reliable two-way sync between Overleaf and a local project in Visual Studio Code.**

LeafRelay is a VS Code extension for Overleaf and LaTeX users who edit the same project with a local IDE, terminal, scripts, or AI coding tools. It keeps the local folder and Overleaf synchronized while making conflicts visible instead of silently choosing a winner.

> LeafRelay is an independent, community-maintained fork of Overleaf Workshop. It is not affiliated with Overleaf or the Overleaf Workshop maintainers. Existing `.overleaf/settings.json` project associations remain reusable.

[中文说明](./README.zh-CN.md)

## Why LeafRelay?

Overleaf Workshop pioneered the VS Code workflow, but older local-replica behavior was centered on editor-driven changes. That becomes fragile when the local folder is changed by another editor, a terminal, a script, or an AI tool: updates may wait for an editor save, reconnects may download far more than necessary, duplicate local replicas may compete, and simultaneous edits can overwrite one side without a clear decision.

LeafRelay is built around those failure modes:

- **External edits sync automatically** through file-system events, including edits made by another editor, a terminal, a script, or an AI tool.
- **Incremental startup and reconnects** transfer only changed files whenever the local checkpoint is usable.
- **Conflicts stop safely** when both local and Overleaf changed the same path; neither copy is silently overwritten.
- **One active local replica per workspace** prevents old folders from racing the project and pushing stale content.
- **Rate-limit aware requests** serialize project traffic and respect Overleaf `429` cooldowns instead of creating request bursts.
- **Dot directories and symbolic links stay out of sync**, including generated build folders such as `.output`.

LeafRelay keeps the original Overleaf Workshop virtual-project and collaboration features while prioritizing dependable local-folder synchronization for daily work.

## Install

Install **[LeafRelay](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)** from the VS Code Marketplace. VS Code will receive future releases through its normal extension update mechanism.

## Start syncing

1. Open the **LeafRelay** view in VS Code and add your Overleaf server.
2. Sign in, choose a project, and select **Open Project Locally**.
3. Open the selected folder in VS Code. Changes made locally or on Overleaf will then flow in both directions.

For project details, login options, self-hosted Overleaf, and troubleshooting, see the [user documentation](./docs/README.md).

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run compile
```

Pull requests run the VS Code activation check and a ShareLaTeX container integration test before packaging. Releases are prepared by Release Please and published automatically from the generated release pull request.

## Project background

LeafRelay started from [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) and is now maintained as an independent project under the [AGPL-3.0-only](./LICENSE). The focus is reliable Overleaf-to-local synchronization, while the project continues to evolve toward reusable sync components beyond VS Code.

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
- [Issues and feature requests](https://github.com/yunhaoli24/leafrelay/issues)
- [Contributing](./CONTRIBUTING.md)
- [Documentation](./docs/README.md)
- [Original Overleaf Workshop project](https://github.com/overleaf-workshop/Overleaf-Workshop)

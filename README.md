# LeafRelay

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/yunhaoli24.leafrelay?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
[![npm](https://img.shields.io/npm/v/leafrelay?label=npm)](https://www.npmjs.com/package/leafrelay)
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

### VS Code extension

Install **[LeafRelay](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)** from the VS Code Marketplace. VS Code will receive future releases through its normal extension update mechanism.

### npm CLI

Install the standalone sync service from **[npm](https://www.npmjs.com/package/leafrelay)**. Node.js 24 or later is required.

```bash
npm install --global leafrelay
```

## Start syncing

1. Open the **LeafRelay** view in VS Code and add your Overleaf server.
2. Sign in, choose a project, and select **Open Project Locally**.
3. Open the selected folder in VS Code. Changes made locally or on Overleaf will then flow in both directions.

For project details, login options, self-hosted Overleaf, and troubleshooting, see the [user documentation](./docs/README.md).

## Run without VS Code

LeafRelay also ships as a Node.js CLI. A local replica created by the VS Code extension can be served directly because both clients use the same `.overleaf/settings.json` project association.

```bash
leafrelay login https://www.overleaf.com
cd /path/to/local-replica
leafrelay serve
```

`leafrelay login` stores sessions by server in `~/.leafrelay/config.json`. Set `LEAFRELAY_CONFIG` to use another config file, or `LEAFRELAY_COOKIE` to override the saved cookie for one process.

## Development

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run compile
```

Pull requests run the VS Code activation check and a ShareLaTeX container integration test before packaging. Releases are prepared by Release Please and publish the VS Code extension, npm package, and GitHub release artifacts through automated workflows.

The pnpm monorepo keeps the reusable synchronization engine in `packages/core`, the background CLI in `packages/cli`, and the VS Code adapter in `apps/vscode`.

## Project background

LeafRelay started from [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) and is now maintained as an independent project under the [AGPL-3.0-only](./LICENSE). The focus is reliable Overleaf-to-local synchronization, while the project continues to evolve toward reusable sync components beyond VS Code.

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=yunhaoli24.leafrelay)
- [Issues and feature requests](https://github.com/yunhaoli24/leafrelay/issues)
- [Contributing](./CONTRIBUTING.md)
- [Documentation](./docs/README.md)
- [Original Overleaf Workshop project](https://github.com/overleaf-workshop/Overleaf-Workshop)

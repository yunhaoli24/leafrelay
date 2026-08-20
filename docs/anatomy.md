# Repository anatomy

LeafRelay is a pnpm monorepo with one reusable engine and two product adapters.

```text
leafrelay/
├── apps/
│   └── vscode/          VS Code extension, views, localization, and editor adapters
├── packages/
│   ├── core/            Overleaf API, realtime transport, sync engine, and Node adapters
│   └── cli/             Public `leafrelay` npm package and command-line interface
├── test/integration/    ShareLaTeX container integration test
├── docs/                User and contributor documentation
└── package.json         Private workspace scripts and fixed release version
```

## `packages/core`

Core has no dependency on the VS Code API. Its public entry point is `packages/core/src/index.ts`.

- `src/api` implements Overleaf HTTP requests and realtime events. Overleaf still exposes the Socket.IO 0.9 wire protocol; `overleafRealtimeSocket.ts` implements the required framing over Node's stable WebSocket API without the historical Socket.IO client or CommonJS runtime.
- `src/sync` owns checkpoints, ignore rules, incremental reconciliation, three-way text merging, and per-path conflict handling.
- `src/node` provides local filesystem watching, `.overleaf/settings.json` loading, user session configuration, sync-state persistence, and the long-running service entry point.
- `src/core` contains shared logging and Overleaf project entity types.

Core changes must remain usable from both the CLI and the VS Code extension.

## `packages/cli`

The CLI package is published to npm as `leafrelay` and exposes both the command and the bundled core API.

- `leafrelay login` authenticates to an Overleaf server and stores the session in `~/.leafrelay/config.json` by default.
- `leafrelay serve` reads the current replica's `.overleaf/settings.json` and runs event-driven two-way synchronization.
- `LEAFRELAY_CONFIG` selects another user config file; `LEAFRELAY_COOKIE` overrides the stored cookie for one process.

The package is built with tsup. The internal `@leafrelay/core` workspace package is bundled into its JavaScript and declaration outputs, so npm users do not depend on a private package.

## `apps/vscode`

The VS Code application contains only editor-facing responsibilities:

- project and remote filesystem views;
- commands, notifications, output logging, and persisted extension state;
- local-replica SCM integration;
- compilation, PDF preview, collaboration UI, and LaTeX language features.

The extension imports synchronization and protocol behavior from `@leafrelay/core` and bundles it with esbuild. The chat webview remains a nested pnpm workspace under `apps/vscode/views/chat-view`.

## Build and test

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm test:extension
pnpm test:overleaf
```

`pnpm test` builds all workspaces, lints TypeScript, and runs Vitest. Pull requests additionally activate the extension in a real Extension Host and run two-way synchronization against a ShareLaTeX container before packaging artifacts.

## Release layout

The root `package.json` is the fixed-version source. Release Please updates the root, `apps/vscode`, `packages/core`, and `packages/cli` versions together. The release workflow packages `apps/vscode` as a VSIX and packs `packages/cli` as the npm tarball.

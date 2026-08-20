# Repository anatomy

LeafRelay is a pnpm monorepo built around one machine-wide synchronization daemon.

```text
leafrelay/
├── apps/
│   └── vscode/          VS Code extension, views, localization, and editor adapters
├── packages/
│   ├── core/            Overleaf API, realtime transport, sync engine, and Node adapters
│   ├── protocol/        Versioned JSON-RPC methods, notifications, and transport DTOs
│   ├── daemon/          IPC lifecycle, network runtimes, replica registry, and request ownership
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

Core has no client lifecycle or editor dependency. The daemon is its network and synchronization owner.

## `packages/protocol`

The protocol package defines the versioned JSON-RPC contract shared by daemon clients. Binary data crosses JSON-RPC through explicit base64 DTOs. A protocol mismatch fails initialization and requires restarting the daemon; clients never fall back to direct Overleaf connections.

## `packages/daemon`

The first client atomically starts the daemon on `~/.leafrelay/daemon.sock` (or a Windows named pipe). The daemon owns:

- one HTTP scheduler per authenticated server user;
- one realtime runtime per Overleaf project;
- one Chokidar watcher and sync engine per writable local replica;
- conflict state, checkpoints, logs, and client leases.

The same real local path can be attached by several clients. A different local path cannot become a second writable replica of an already active project. Clients reconnect and restore their registrations after a daemon restart.

## `packages/cli`

The CLI package is published to npm as `leafrelay` and exposes both the command and the bundled core API.

- `leafrelay login` authenticates to an Overleaf server and stores the session in `~/.leafrelay/config.json` by default.
- `leafrelay serve` reads the current replica's `.overleaf/settings.json` and holds a daemon client lease.
- `leafrelay daemon status|stop|restart` controls the shared process.
- `LEAFRELAY_HOME` relocates daemon state; `LEAFRELAY_CONFIG` selects another login file; `LEAFRELAY_COOKIE` overrides the stored cookie for one process.

The package is built with tsup. The internal `@leafrelay/core` workspace package is bundled into its JavaScript and declaration outputs, so npm users do not depend on a private package.

## `apps/vscode`

The VS Code application contains only editor-facing responsibilities:

- project and remote filesystem views;
- commands, notifications, output logging, and persisted extension state;
- daemon-backed local-replica status and conflict UI;
- compilation, PDF preview, collaboration UI, and LaTeX language features.

The extension uses RPC adapters for project APIs and local replicas. It contains no Overleaf HTTP client, Socket.IO connection, watcher, or sync engine. The extension and daemon entry points are bundled with esbuild; the chat webview remains a nested pnpm workspace under `apps/vscode/views/chat-view`.

## Build and test

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm test:extension
pnpm test:overleaf
```

`pnpm test` builds all workspaces, lints TypeScript, and runs Vitest. Pull requests additionally test IPC on macOS and Windows, activate the extension in a real Linux Extension Host, and run multi-client synchronization, conflict resolution, and daemon recovery against a ShareLaTeX container before packaging artifacts.

## Release layout

The root `package.json` is the fixed-version source. Release Please updates the root, `apps/vscode`, `packages/core`, and `packages/cli` versions together. The release workflow packages `apps/vscode` as a VSIX and packs `packages/cli` as the npm tarball.

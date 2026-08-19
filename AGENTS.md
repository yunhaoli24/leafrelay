# LeafRelay

## Architecture

- LeafRelay is a synchronization engine first. Keep protocol, request scheduling, checkpoints, reconciliation, and merge logic independent of VS Code APIs so the same core can later power `leafrelay serve`, background services, and other clients.
- VS Code-specific modules are adapters for URI/file-system access, watchers, commands, notifications, and views. Do not put reusable synchronization decisions in the extension adapter layer.
- Prefer maintained libraries for established algorithms and protocols. Wrap them behind small core interfaces and test the behavioral boundaries LeafRelay relies on.

## Local Replica Sync

- Runtime local changes are event-driven through VS Code `FileSystemWatcher`; do not add periodic directory or hash polling.
- `.overleaf/sync-state.json` stores the remote history version, per-path SHA-256 checkpoint, and common UTF-8 text baseline used for startup, reconnect, and three-way reconciliation. Binary paths retain fingerprints but no merge baseline.
- `.overleaf/settings.json` is the authoritative local-replica association. It must contain enough project URI and SCM settings metadata to rebuild the transient per-login project/SCM state after authentication expires.
- Persist each successfully synchronized path's SHA-256 checkpoint before processing the next path, so a later conflict or failure does not discard completed progress. Skip writes when serialized state is unchanged and write the disposable cache in place to avoid delete/create watcher events.
- History API failures such as HTTP 429 must not be interpreted as a missing version. Leave the checkpoint unchanged and retry on a later reconnect.
- Reuse recent history updates for both version discovery and changed-path collection. Serialize unavoidable history requests and honor `Retry-After` instead of issuing immediate parallel probes.
- Route every HTTP request from every project through one process-wide queue. A 429 response pauses the entire queue for `Retry-After`; local watcher bursts are debounced before upload.
- A failed path must make incremental startup sync fail explicitly; never log completion or advance `remoteVersion` after partial failure.
- Report final user-actionable failures through a deduplicated VS Code notification with access to the Output log; individual retries remain log-only.
- Connection and SCM creation logs must include project ID, connection scheme, retry attempt, local base URI, and the original structured error. Never swallow `joinProject` or trigger-initialization errors behind a generic reconnecting message.
- Disposing a cached VFS is terminal: disconnect handlers must not schedule reconnects after disposal. Successful `Open Project Locally` creation must leave its provider-owned VFS alive.
- A background project used by `Open Project Locally` must not register workspace-global commands, views, status items, or compile actions. Those features belong only to the project identified by the active workspace; deterministic feature-registration failures must not enter the connection retry loop.
- Ignore every path containing a dot-prefixed component, including `.output`, before any stat/read/write work.
- Ignore symbolic links and paths below symbolic-link directories in both directions. Never upload them, overwrite/delete them during a pull, or include them in sync state.
- When both sides changed a text file, use a maintained diff3 implementation with the last synchronized text as the common base. Automatically synchronize only a clean, non-overlapping merge. Pause overlapping text edits, binary concurrent changes, deletions, and incompatible path-type changes, preserving both sides for an explicit per-path choice. Do not expose whole-project replacement or create conflict-copy files.
- Full remote-to-local sync is automatic only for an empty replica or when all local hashes still match the checkpoint. Missing/invalid history plus uncheckpointed local changes pauses all replica watchers.

## Verification

- Run `pnpm test` and `git diff --check` after synchronization changes. `pnpm test` runs compile, lint, and Vitest.
- Pull requests and releases must also pass the VS Code Extension Host activation test and the ShareLaTeX container integration test before packaging.
- Package artifacts in CI. User installations and updates come from the VS Code Marketplace; do not replace the installed extension with a local VSIX during normal development.

## Toolchain

- Use the pnpm workspace and the version declared in `package.json`; do not reintroduce npm lock files or per-package lock files.
- The extension runtime is bundled with esbuild. Keep `vscode` external and package the VSIX with `--no-dependencies`.
- Unit tests use Vitest and must run in GitHub Actions for pull requests.

## Release Process

- Never push release changes directly to `main`; create a branch and merge through a pull request.
- Merging ordinary pull requests to `main` updates the Release Please pull request but does not publish. Ordinary pull requests must not edit the release version manually.
- Merge the generated Release Please pull request only when the user explicitly requests a release. That merge creates the version tag and GitHub release, then invokes the reusable publish workflow.
- Before version `1.0.0`, fixes and features produce patch releases; only an explicit breaking change produces a minor release. Major or otherwise forced versions require an explicit release decision.
- A direct `v*` tag matching `package.json` may invoke the same pipeline as a recovery path. The pipeline attaches the VSIX and checksum to the release and attempts Marketplace publishing.
- Retry an existing release with `gh workflow run vsce-publish.yml -f ref=vX.Y.Z`; do not use `gh run rerun`, because a rerun of the tag-triggered job reports `main` as its release ref. Asset uploads and Marketplace publication are idempotent.
- The GitHub release and its VSIX must be created even when Marketplace publishing is temporarily unavailable.
- The `VSCE_PAT` GitHub Actions secret is required for Marketplace publishing; never commit or print the token. An optional `RELEASE_PLEASE_TOKEN` may be configured so generated release pull requests trigger normal pull-request workflows.

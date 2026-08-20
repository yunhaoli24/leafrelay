# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Build every workspace, run lint/unit/Extension Host/ShareLaTeX integration tests, then package the VS Code extension and validate the npm CLI when a pull request targets `main`.

- **release-please.yml**: Update a long-lived release pull request after normal changes reach `main`. Merging that generated release pull request creates the version tag and GitHub release, then invokes the extension publishing workflow. Before version `1.0.0`, ordinary fixes and features produce patch releases; an explicit breaking change produces a minor release.

- **vsce-publish.yml**: Reusable packaging pipeline invoked by Release Please, with direct matching `v*` tags supported as a fallback. It verifies the fixed monorepo version, tests the complete workspace, and attaches both the VSIX and npm tarball to the GitHub release before Marketplace publication.

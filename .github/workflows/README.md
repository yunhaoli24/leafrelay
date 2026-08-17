# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Run the compile, lint, and unit-test suite, then package LeafRelay when a pull request targets the `main` branch.

- **release-please.yml**: Update a long-lived release pull request after normal changes reach `main`. Merging that generated release pull request creates the version tag and GitHub release, then invokes the extension publishing workflow. Before version `1.0.0`, ordinary fixes and features produce patch releases; an explicit breaking change produces a minor release.

- **vsce-publish.yml**: Reusable packaging and publishing pipeline invoked by Release Please, with direct matching `v*` tags supported as a fallback. It verifies the tag against `package.json`, runs the full test suite, attaches the VSIX and SHA-256 checksum to the GitHub release, and publishes to the VS Code Marketplace through GitHub OIDC trusted publishing. Re-running the same release is safe because assets are replaced and duplicate Marketplace versions are accepted.

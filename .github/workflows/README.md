# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Compile, lint, and package LeafRelay when a pull request targets the `main` branch.

- **vsce-publish.yml**: Build a release VSIX for version tags or manual runs. Marketplace publishing is an explicit manual option and requires the `VSCE_PAT` repository secret.

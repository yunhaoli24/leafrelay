# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Compile, lint, and package LeafRelay when a pull request targets the `main` branch.

- **vsce-publish.yml**: After a pull request with a new `package.json` version is merged into `main`, compile, lint, package, publish the VSIX to the VS Code Marketplace, and create the matching GitHub tag and release. Normal pull requests increment the patch version; minor or major increments require an explicitly planned release. Manual runs can build without publishing or explicitly publish when needed. Marketplace publishing requires the `VSCE_PAT` repository secret.

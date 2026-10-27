# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Build every workspace, run lint/unit/Extension Host/ShareLaTeX integration tests, then package the VS Code extension and validate the npm CLI when a pull request targets `main`.

- **release-please.yml**: Update a long-lived release pull request after normal changes reach `main`. Merging that generated release pull request creates the version tag and GitHub release, publishes the CLI to npm through GitHub OIDC trusted publishing, then invokes the extension publishing workflow. Before version `1.0.0`, ordinary fixes and features produce patch releases; an explicit breaking change produces a minor release.

- **vsce-publish.yml**: Reusable packaging pipeline invoked by Release Please, with direct matching `v*` tags supported as a fallback. It verifies the fixed monorepo version, tests the complete workspace, and attaches both the VSIX and npm tarball to the GitHub release before Marketplace publication.

Marketplace publishing uses GitHub Actions OIDC with `vsce publish --oidc`; it does not use a PAT. In publisher `lealaxy`, create a Trusted Publishing policy for repository owner `yunhaoli24`, repository `leafrelay`, and workflow `vsce-publish.yml`. Leave the environment empty because this workflow does not use a GitHub environment. Configure the publisher policy before attempting publication; the workflow has no separate manual bootstrap upload step.

The pinned official `@vscode/vsce` preview implements the Marketplace OIDC token exchange. Microsoft is still rolling out the Marketplace backend and publisher configuration page; if the **Trusted Publishing** tab is absent, configuration and publication remain blocked on that rollout. See the [official setup guide in progress](https://github.com/microsoft/vscode-docs/pull/10517) and [Marketplace rollout update](https://github.com/microsoft/vscode-docs/pull/10519#issuecomment-6325167592). The workflow attaches release assets before attempting Marketplace publication.

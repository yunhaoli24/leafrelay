# Contributing to LeafRelay
LeafRelay is an open source project and we welcome contributions of all kinds from the community.
There are many ways to contribute, from improving the documentation, submitting bug reports and feature requests or writing code which can be incorporated into the extension itself.

In this document, we will mainly elaborate on how to make code contributions to the project.

## Contribution Guidance

For substantial changes, open an issue in the [LeafRelay repository](https://github.com/yunhaoli24/leafrelay/issues) before implementation so the behavior and compatibility impact can be discussed.

To make a contribution to this project, please follow the steps below:

1. Create or find a `Bug Report` or `Feature Request` issue on [GitHub](https://github.com/yunhaoli24/leafrelay/issues).
   
   If you are creating a new issue, please make sure that it is not a duplicate of an existing issue.

2. Fork this repository and create a new branch from the `main` branch.

   It is recommended to name the branch with the issue number, e.g., `issue-123`, or related keywords, e.g., `fix-xxx`, `feat-xxx`.

3. Make your changes and commit them to the new branch.

   Please make sure that your commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.

4. Create a pull request to the `main` branch of this repository.
   
   Please make sure that the pull request is associated with the issue you are working on. If you do not know how to do this, please refer to [Linking a pull request to an issue](https://docs.github.com/en/github/managing-your-work-on-github/linking-a-pull-request-to-an-issue).

5. Wait for the assigned reviewer to review your pull request.
   
   If there are any problems, please fix them and commit the changes to the same branch with rebase. If the reviewer approves your pull request, it will be merged into the `main` branch.

6. After the pull request is merged, the associated issue will be closed automatically.

## Release Versions

Merging an ordinary pull request into `main` does not publish a release. Release Please collects releasable Conventional Commits in a generated release pull request and maintains the version and `CHANGELOG.md`; ordinary pull requests must not edit the release version manually.

Merge the generated release pull request only when a release is intended. Release Please then creates the matching tag and GitHub release, and the automated publishing pipeline tests and packages that exact tag, attaches the VSIX and checksum, and attempts Marketplace publishing. Before version `1.0.0`, `fix:` and `feat:` changes both increment the patch component; an explicit breaking change such as `feat!:` increments the minor component. Re-run the same release workflow after correcting a transient release or Marketplace problem.


## Development Guidance

### Prerequisites
- [Node.js LTS](https://nodejs.org/en/) (>= 24)
- Visual Studio Code (>= 1.125.0)
  > Recommended extensions: [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint), [JavaScript and TypeScript Nightly](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-next), [Vue Language Features (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.volar), [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin)
- Operating System with common Unix commands.
  > If you are using Windows, please refer to [Windows Subsystem for Linux](https://docs.microsoft.com/en-us/windows/wsl/install-win10), [Cygwin](https://www.cygwin.com/) or [Git Bash](https://gitforwindows.org/).
  > You can also use [gow](https://github.com/bmatzelle/gow) installed with [scoop](https://scoop.sh/).

### Build

```bash
# Clone the Repository and Change Directory
git clone https://github.com/yunhaoli24/leafrelay.git
cd leafrelay

# Enable the pnpm version declared by the repository
corepack enable

# Install the extension and chat-view workspace dependencies
pnpm install --frozen-lockfile

# Build the Extension
pnpm run compile

# [Optional] Package the Extension
pnpm exec vsce package --no-dependencies
```

### Testing
In VSCode, press <kbd>F5</kbd> to start debugging. A new VSCode window will be opened with the extension loaded.

### Documentation
- [VSCode Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [LeafRelay Extension Documentation](./docs/README.md)

# Contributing to One-Click Publish

**Language / 语言:** English | [中文](CONTRIBUTING.zh-CN.md)

This document is for maintainers and contributors. For the user-facing plugin guide, see [README.md](README.md).

## Project boundaries

- `plugin/manifest.json` is the canonical plugin manifest.
- `plugin/main.js` is the self-contained Obsidian runtime entry point.
- `plugin/compiler.js` is a development/reference compiler and is not loaded by the runtime or shipped as a plugin asset.
- `src/`, `server/`, and `tests/` support development and publishing infrastructure; they are not Obsidian installation files.
- The plugin ID is permanently `one-click-publish`; the development Vault runtime directory is `.obsidian/plugins/one-click-publish/`.

## Prerequisites

Use Node.js 26 or a Node.js version with TypeScript type-stripping support. Install the repository dependencies before running the checks.

## Local development

Start and manage the local in-memory publishing service with:

```bash
npm run dev:server
npm run status
npm run restart
npm run stop
npm run logs
```

The local service is for contract and plugin testing only. It is not production hosting.

## Validation

Run the required checks after plugin or publishing changes:

```bash
npm run check:plugin
node --check plugin/main.js
npm test
git diff --check
```

The test suite starts local HTTP listeners. A sandbox that blocks loopback binding may require the test to run with local-network permission.

## Plugin packaging

Only edit `plugin/manifest.json` and `plugin/main.js` as plugin release sources. After changing either file:

```bash
npm run update:plugin
```

This command builds the embedded Worker artifact, generates the root `manifest.json` and `main.js` mirrors, prepares `dist/obsidian-release/`, checks byte parity, and syncs the runtime into the development Vault.

The exact release staging directory contains only:

```text
manifest.json
main.js
styles.css (only when plugin/styles.css exists)
```

Do not upload `src/`, `server/`, `tests/`, `plugin/`, or `plugin/compiler.js` as plugin release assets.

## GitHub Release

Every release uses the exact version in `plugin/manifest.json` as an `x.y.z` tag. Do not prefix the tag with `v`.

The workflow in `.github/workflows/plugin-release.yml` installs from `package-lock.json`, validates the repository, creates a GitHub artifact attestation for the exact staged release assets, and creates a GitHub Release with the generated `manifest.json`, `main.js`, and optional `styles.css` assets when an exact SemVer tag is pushed.

Before pushing a release:

1. Bump `plugin/manifest.json` and `package.json` together.
2. Run `npm run update:plugin`.
3. Run the required validation commands.
4. Confirm root mirrors and release staging are byte-identical to `plugin/` sources.
5. Push `main`.
6. Push the matching tag, for example `0.3.0`.
7. Confirm the GitHub Release contains `manifest.json` and `main.js`, and that the workflow exposes the corresponding artifact attestation.

Never change the plugin ID after a public release. An ID change creates a different Obsidian plugin and breaks the normal update path.

## Repository structure

```text
plugin/                 canonical Obsidian sources and user-facing package README
src/                    compiler and shared application source
server/                 local service and Cloudflare Worker source
tests/                  automated tests
scripts/                build, package, check, and sync utilities
dist/obsidian-release/  generated GitHub Release staging files
.engineering/           architecture and delivery records
```

Keep user-facing behavior and documentation changes synchronized in the English and Chinese README pairs. Keep detailed engineering decisions in `.engineering/` and the project task index in `Task Constitution.md`.

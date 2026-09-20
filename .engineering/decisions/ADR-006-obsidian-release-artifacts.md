# ADR-006: Obsidian release artifact synchronization

- Status: accepted
- Date: 2026-09-19
- Context: Obsidian Community reads `manifest.json` from the repository root, while the project keeps the self-contained plugin runtime under `plugin/` alongside the Cloudflare service and development sources. Manual copies caused the remote repository to expose an older manifest than the local plugin.
- Decision: Keep `plugin/manifest.json` and `plugin/main.js` as the only hand-maintained plugin release sources. Generate root mirrors, `dist/obsidian-release/` assets, and Vault runtime files from those sources through `npm run update:plugin`. Enforce parity in `npm run check:plugin` and in the GitHub main/tag workflow. Use the committed `package-lock.json` with `npm ci`, and create a GitHub artifact attestation for the exact staged release assets before publishing the Release.
- Alternatives: Move all plugin files to the repository root; rejected because it would mix source/runtime artifacts with the service monorepo and disrupt the existing Vault sync boundary. Upload the whole repository or `plugin/` directory as a Release asset; rejected because Obsidian installs individual `main.js`/`manifest.json` assets.
- Consequences: Root `manifest.json` and `main.js` are generated tracked mirrors and must not be edited manually. `dist/obsidian-release/` is ignored and regenerated. `plugin/compiler.js`, `src/`, `server/`, and tests remain development/source files and never enter the plugin Release.
- Affected packages/components: CMP-017, WP-005, T5.2, T5.3.
- Verification: `npm run update:plugin`, `npm run check:plugin`, `node --check plugin/main.js`, `npm test`, `git diff --check`, and `.github/workflows/plugin-release.yml`.

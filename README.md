# One-Click Publish

**Language / 语言:** English | [中文](README.zh-CN.md)

Once your Cloudflare account is connected, publish the active Obsidian Markdown note with one click. One-Click Publish can include linked notes, upload referenced local assets, and keep a stable link when you publish updates.

## What it does

- Publishes the active note as the root page of a stable `/s/{siteId}` website.
- Includes linked Markdown notes according to **Linked page depth**.
- Supports WikiLinks, relative Markdown links, images, callouts, code blocks, tables, and task lists.
- Uploads referenced local images and other supported assets.
- Keeps external URLs, anchors, `mailto:` links, and external assets unchanged.
- Copies the published URL automatically and writes `share_site_id`, `share_link`, and `share_updated` to the root note's frontmatter.
- Uses Obsidian's native renderer when available and a deterministic fallback renderer otherwise.
- Binds one root domain or subdomain from the connected Cloudflare account, while keeping the original Worker address as a fallback.

## Install

### Community plugins

In Obsidian, open **Settings → Community plugins → Browse**, search for **One-Click Publish**, install it, and enable it.

### Manual installation

Download `manifest.json` and `main.js` from the [latest GitHub Release](https://github.com/jinhefeng/One-Click-Publish/releases/latest). Place both files in:

```text
.obsidian/plugins/one-click-publish/
```

Then open **Settings → Community plugins** and enable **One-Click Publish**.

## Quick start

1. On Obsidian desktop, open **Settings → Community plugins → One-Click Publish**.
2. Click **Deploy to my Cloudflare** and complete the one-time Cloudflare authorization.
3. Open the Markdown note you want to publish.
4. Optionally enter a root domain or subdomain from the same Cloudflare account under **Custom domain**, then click **Bind domain**.
5. Choose **One-Click Publish** from the command palette, ribbon, or note context menu.
6. Open the copied link or find it in the note frontmatter.

The first deployment creates a private Worker and D1 database in your Cloudflare account. The plugin stores only the Worker URL and scoped Publish Token in the Vault after deployment. The Cloudflare access token is used in memory and revoked after setup.

After setup, include this plugin's settings when syncing the Vault to another device. Notes-only sync does not transfer the publishing connection.

Custom domains support both `example.com` and `notes.example.com` when the active Zone belongs to the connected Cloudflare account. Cloudflare manages the Worker domain record and certificate. The original `workers.dev` address remains available as a fallback; binding a root domain may affect existing routes on that domain.

The Cloudflare deployment connection and custom-domain binding are separate settings. Unbinding a custom domain removes only that custom-domain attachment and switches publishing back to the Worker address; it does not disconnect the saved Cloudflare Worker or Publish Token. **Disconnect** is a separate local connection action and is not a substitute for custom-domain unbinding.

If Cloudflare completes a domain removal but Obsidian cannot save the new local settings, the plugin keeps the primary connection and shows a recovery action in Settings. Use **Recover custom-domain state** to reconcile the saved state with Cloudflare before trying another domain operation.

## Linked notes and assets

**Linked page depth** controls how far One-Click Publish follows links:

- `0`: publish only the active note.
- `1`: include directly linked notes.
- Higher values: include deeper linked notes.

The active note is always the share root. Local images and supported referenced assets are uploaded with the pages. External resources are not downloaded or rewritten.

## Settings

- **Language**: English by default, with Chinese available.
- **Linked page depth**: controls linked-note traversal.
- **Use Obsidian renderer**: preserves Obsidian rendering when supported.
- **Custom domain**: optionally binds one root domain or subdomain in the connected Cloudflare account.
- **Update Cloudflare Worker**: refreshes an existing personal Worker after a plugin update without replacing its published data.
- **Worker compatibility check**: compares the online Worker version with the plugin version in settings and before each publish; historical or unverifiable Workers must be updated first.
- **Debug mode**: shows sanitized deployment and publishing diagnostics when troubleshooting.

The normal settings page does not ask for a service URL or Publish Token. The official hosted connection is planned; the current supported path deploys to your own Cloudflare account.

## Limits and privacy

- Personal publishing uses Cloudflare Workers and D1; it does not create or require R2.
- There is no account-wide published-content quota and no published-note count limit.
- Individual files are limited to 20 MB.
- Content is uploaded in chunks to stay within Cloudflare request limits; the per-request and per-file platform limits still apply.
- Debug logs exclude credentials, request bodies, and note contents.

## Updating a published note

One-Click Publish stores the site ID in the root note's frontmatter. Publishing the same root note again updates the existing site instead of creating a new link.

## Troubleshooting

- Reload community plugins after installing or updating the plugin.
- For a publish failure, enable **Debug mode**, retry once, and inspect the copyable Debug log.
- For a deployment failure, confirm that Obsidian desktop can open the Cloudflare authorization flow and that the account permits Worker and D1 changes.
- If custom-domain unbinding reports that Cloudflare changed the domain but local settings could not be saved, reopen Settings and use **Recover custom-domain state**. Do not disconnect the primary Cloudflare connection while recovery is pending.
- For a manual installation, confirm that `manifest.json` and `main.js` are directly inside `.obsidian/plugins/one-click-publish/`.

## Links

- [GitHub repository](https://github.com/jinhefeng/One-Click-Publish)
- [Latest release](https://github.com/jinhefeng/One-Click-Publish/releases/latest)
- [Author: Jin Hefeng](https://github.com/jinhefeng)
- [MIT License](LICENSE)

For development, testing, packaging, and release instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

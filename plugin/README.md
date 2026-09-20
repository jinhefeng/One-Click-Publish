# One-Click Publish plugin

**Language / 语言:** English | [中文](README.zh-CN.md)

After a one-time Cloudflare setup, One-Click Publish publishes the active Obsidian Markdown note as a shareable website page with one click. It can include linked notes, upload referenced local assets, copy the published URL, and preserve the same URL when the note is updated.

## Install manually

Download the `manifest.json` and `main.js` assets from the [latest release](https://github.com/jinhefeng/One-Click-Publish/releases/latest) and place them directly in:

```text
.obsidian/plugins/one-click-publish/
```

Enable **One-Click Publish** under **Settings → Community plugins**.

## Use the plugin

1. Open **Settings → Community plugins → One-Click Publish**.
2. Click **Deploy to my Cloudflare** on desktop and complete the one-time Cloudflare authorization.
3. Optionally enter one root domain or subdomain from the same Cloudflare account under **Custom domain** and click **Bind domain**.
4. Open a Markdown note and choose **One-Click Publish** from the command palette, ribbon, or note context menu.
5. Adjust **Linked page depth** if linked notes should be included.

The current note is the share root. One-Click Publish supports WikiLinks, relative links, images, callouts, code blocks, tables, task lists, and referenced local assets. External URLs and assets remain unchanged.

The plugin saves the Worker URL, optional custom domain, and scoped Publish Token after deployment. It does not create or require R2, and the normal settings page does not ask for a service URL or token. Custom domains must be Zones in the connected Cloudflare account; the Worker address remains available as a fallback. The settings page and publish flow compare the online Worker version with the plugin; historical or unverifiable Workers must be refreshed with **Update Cloudflare Worker** first.

The primary Cloudflare connection is independent from the custom-domain state. **Unbind** removes the custom-domain attachment and returns publishing to the Worker address; it does not disconnect the Worker or Publish Token. If the remote removal succeeds but the Vault cannot save the local state, Settings keeps a recoverable marker and offers **Recover custom-domain state**. **Disconnect** remains a separate local connection action.

For the full user guide, see the [repository README](../README.md). For development and release work, see [CONTRIBUTING.md](../CONTRIBUTING.md).

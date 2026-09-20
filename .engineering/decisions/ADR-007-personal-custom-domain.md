# ADR-007: Personal custom domain binding

- Status: accepted
- Date: 2026-09-20
- Scope: personal Cloudflare deployment in One-Click Publish 0.3.2

## Context

The personal Worker already has a stable `workers.dev` address, but users may want published notes to use a domain they already manage in Cloudflare. The first release should keep the operation short and should not ask users to copy DNS records, certificates, or Cloudflare management tokens into Obsidian.

## Decision

The Obsidian desktop settings page supports binding one root domain or subdomain from the currently authorized Cloudflare account to the personal Worker through the Cloudflare Workers Custom Domains API.

- The input accepts `example.com` and `notes.example.com`; the plugin normalizes the hostname and rejects paths or malformed labels.
- A short-lived Authorization Code + PKCE flow requests the additional Workers Custom Domains and Zone Read permissions only for bind/unbind. The access token remains in memory and is revoked after the operation.
- The plugin lists the account's active Zones and chooses the longest matching suffix, then attaches the hostname to the known Worker service. It does not create R2 or act as a general Cloudflare API proxy.
- Version 1 allows one primary custom domain per Worker. A root-domain confirmation warns that the binding can affect requests for the whole domain.
- The custom domain becomes the active publish URL, while the original `workers.dev` URL is retained as the fallback origin. Unbinding restores the fallback without deleting published sites.
- The Worker commit route uses the request origin when constructing the returned site URL, so publishing through the custom domain returns a custom-domain link.

## Alternatives considered

1. Ask users to create DNS records manually: rejected because it makes the first-run flow longer and leaves certificate/DNS state outside the product.
2. Store a long-lived Cloudflare API token: rejected because it increases credential exposure and conflicts with the existing memory-only OAuth policy.
3. Support multiple custom domains immediately: deferred because it complicates active URL selection, unbind semantics, and mobile synchronization without improving the first release's core flow.
4. Bind only subdomains: rejected because Cloudflare Custom Domains supports apex/root hostnames and users asked for both forms.

## Consequences

Positive:

- Root and subdomain users get the same short settings flow.
- Published links follow the hostname through which the Worker was reached.
- Existing workers.dev links remain usable after binding and unbinding.

Costs and risks:

- The settings page must explain that a root-domain binding can interact with existing routes.
- Real Cloudflare account, DNS, certificate, permission, and cross-device smoke testing still requires staging credentials.
- The plugin must reauthorize for bind/unbind because it intentionally does not persist the management token.

## Verification

- `tests/plugin-cloudflare.test.ts`: PKCE scope, account and Zone lookup, attach/detach, one-domain guard, and revoke.
- `tests/cloudflare-core.test.ts`: request-origin site URL through a custom domain.
- Real staging smoke remains an open integration item in `.engineering/integration-checklist.md`.

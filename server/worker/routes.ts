import { viewerPath } from "../../src/shared/paths.ts";
import { ServiceError, asServiceError, jsonError } from "../core/errors.ts";
import type { AuthContext, PublishService } from "../core/service.ts";
import { escapeHtml, formField, page, recoveryPage } from "../console/pages.ts";

export interface WorkerContext {
  service: PublishService;
  request: Request;
  env: Record<string, unknown>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export async function routeRequest(context: WorkerContext): Promise<Response> {
  const { request, service } = context;
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" } });

  try {
    if (request.method === "GET" && url.pathname === "/healthz") return json({
      status: "ok",
      service: "publish-note",
      version: String(context.env.PUBLISH_NOTE_VERSION || "unknown"),
      storage: context.env.CONTENTS ? "cloudflare-d1-r2" : "cloudflare-d1",
    });
    if (url.pathname.startsWith("/s/")) return await viewerResponse(service, request, url);
    if (url.pathname === "/connect" && request.method === "GET") return await connectPage(context);
    if (url.pathname === "/connect/approve" && request.method === "POST") return await approveConnect(context);
    if (url.pathname === "/__internal/provision/initialize" && request.method === "POST") return await initializeProvisioning(context);
    if (url.pathname === "/__internal/provision/reconnect" && request.method === "POST") return await reconnectProvisioning(context);
    if (url.pathname === "/setup") return await setupPage(context);
    if (url.pathname === "/login") return await loginPage(context);
    if (url.pathname === "/register") return await registerPage(context);
    if (url.pathname === "/recover") return await recoverPage(context);
    if (url.pathname === "/logout" && request.method === "POST") return await logoutPage(context);
    if (url.pathname.startsWith("/account")) return await accountPage(context);
    if (url.pathname.startsWith("/v1/")) return await apiRequest(context);
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz" || url.pathname === "/__internal/provision/initialize" || url.pathname === "/__internal/provision/reconnect") return jsonError(error);
    const normalized = asServiceError(error);
    return new Response(page("Error", `<h1>Request failed</h1><p>${escapeHtml(normalized.message)}</p>`), { status: normalized.status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}

async function initializeProvisioning(context: WorkerContext): Promise<Response> {
  const input = await readJson(context.request);
  const secret = context.request.headers.get("x-publish-note-bootstrap-secret") || "";
  const result = await context.service.initializeProvisioning({
    provisionSecret: secret,
    ownerKey: String(input.ownerKey || context.request.headers.get("x-publish-note-owner-key") || ""),
    expiresAt: String(input.expiresAt || context.request.headers.get("x-publish-note-expires-at") || ""),
    signature: String(input.signature || context.request.headers.get("x-publish-note-signature") || ""),
    tokenName: String(input.tokenName || "Obsidian plugin"),
  });
  return json(result, 201);
}

async function reconnectProvisioning(context: WorkerContext): Promise<Response> {
  const input = await readJson(context.request);
  const secret = context.request.headers.get("x-publish-note-bootstrap-secret") || "";
  const result = await context.service.reconnectProvisioning({
    provisionSecret: secret,
    ownerKey: String(input.ownerKey || context.request.headers.get("x-publish-note-owner-key") || ""),
    expiresAt: String(input.expiresAt || context.request.headers.get("x-publish-note-expires-at") || ""),
    signature: String(input.signature || context.request.headers.get("x-publish-note-signature") || ""),
    tokenName: String(input.tokenName || "Obsidian plugin"),
  });
  return json(result, 200);
}

async function apiRequest(context: WorkerContext): Promise<Response> {
  const { request, service } = context;
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/v1/auth/register") {
    const result = await service.register(await readJson(request));
    return json({ account: publicAccount(result.account), recoveryCode: result.recoveryCode }, 201);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/login") {
    const result = await service.login(await readJson(request));
    const response = json({ account: publicAccount(result.account) });
    response.headers.set("set-cookie", sessionCookie(result.session.id, request));
    return response;
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
    await service.logout(parseCookie(request.headers.get("cookie"), "pn_session"));
    const response = json({ ok: true });
    response.headers.set("set-cookie", clearCookie(request));
    return response;
  }
  if (request.method === "GET" && url.pathname === "/v1/me") return json({ account: publicAccount((await requireSession(context)).account) });
  if (request.method === "POST" && url.pathname === "/v1/auth/device/start") return json(await service.startDeviceAuthorization());
  if (request.method === "POST" && url.pathname === "/v1/auth/device/poll") return json(await service.pollDeviceAuthorization(String((await readJson(request)).deviceCode || "")));
  if (request.method === "POST" && url.pathname === "/v1/auth/device/approve") {
    const session = await requireSession(context);
    const input = await readJson(request);
    await service.approveDeviceAuthorization(session, String(input.deviceCode || ""), input.tokenName);
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/v1/account/recover") {
    await service.recover(await readJson(request));
    return json({ ok: true });
  }

  const sessionRoutes = url.pathname === "/v1/tokens" || url.pathname === "/v1/usage" || url.pathname === "/v1/sites" || /^\/v1\/tokens\/[^/]+\/revoke$/.test(url.pathname) || (request.method === "DELETE" && /^\/v1\/sites\/[^/]+$/.test(url.pathname));
  const session = sessionRoutes ? await requireSession(context) : undefined;
  if (session && request.method === "GET" && url.pathname === "/v1/tokens") return json({ tokens: await service.listTokens(session) });
  if (session && request.method === "POST" && url.pathname === "/v1/tokens") { const input = await readJson(request); return json(await service.createToken(session.account.id, String(input.name || "Obsidian plugin"), input.expiresAt)); }
  if (session && request.method === "POST" && /^\/v1\/tokens\/[^/]+\/revoke$/.test(url.pathname)) { await service.revokeToken(session, decodeURIComponent(url.pathname.split("/")[3])); return json({ ok: true }); }
  if (session && request.method === "GET" && url.pathname === "/v1/usage") return json(await usagePayload(service, session.account.id));
  if (session && request.method === "GET" && url.pathname === "/v1/sites") return json({ sites: await service.listSites(session.account.id) });
  if (session && request.method === "DELETE" && /^\/v1\/sites\/[^/]+$/.test(url.pathname)) { await service.deleteSite(session, decodeURIComponent(url.pathname.split("/")[3])); return json({ ok: true }); }

  const token = await service.authenticatePublishToken(parseBearer(request.headers.get("authorization")));
  if (request.method === "POST" && url.pathname === "/v1/sites/uploads") return json(await service.startUpload(token, await readJson(request)));
  const chunkMatch = /^\/v1\/uploads\/([^/]+)\/chunks$/.exec(url.pathname);
  if (request.method === "POST" && chunkMatch) return json(await service.uploadChunk(token, { ...(await readJson(request)), uploadId: decodeURIComponent(chunkMatch[1]) }));
  const commitMatch = /^\/v1\/uploads\/([^/]+)\/commit$/.exec(url.pathname);
  if (request.method === "POST" && commitMatch) return json(await service.commitUpload(token, decodeURIComponent(commitMatch[1]), new URL(request.url).origin));
  throw new ServiceError(404, "NOT_FOUND", "Not found");
}

async function viewerResponse(service: PublishService, request: Request, url: URL): Promise<Response> {
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) throw new ServiceError(404, "NOT_FOUND", "Not found");
  const siteId = decodeURIComponent(match[1]);
  const path = viewerPath(siteId, url.pathname);
  const value = await service.viewer(siteId, path);
  if (!value) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try { for await (const chunk of value.chunks) controller.enqueue(chunk); controller.close(); } catch (error) { controller.error(error); }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": value.object.contentType, "cache-control": "no-cache" } });
}

async function requireSession(context: WorkerContext): Promise<AuthContext> {
  const session = await context.service.accountForSession(parseCookie(context.request.headers.get("cookie"), "pn_session"));
  if (!session) throw new ServiceError(401, "UNAUTHORIZED", "Sign in required");
  return session;
}

async function connectPage(context: WorkerContext): Promise<Response> {
  const code = new URL(context.request.url).searchParams.get("code") || "";
  if (!code) return html("Connect One-Click Publish", `<h1>Connect One-Click Publish</h1><p>This link is missing a device code.</p>`);
  const session = await context.service.accountForSession(parseCookie(context.request.headers.get("cookie"), "pn_session"));
  const next = `/connect?code=${code}`;
  if (!session) return html("Connect One-Click Publish", `<h1>Connect One-Click Publish</h1><p>Sign in before approving this Obsidian plugin connection.</p><p><a href="/login?next=${encodeURIComponent(next)}">Sign in</a> · <a href="/register?next=${encodeURIComponent(next)}">Create an account</a></p>`);
  return html("Approve connection", `<h1>Approve connection</h1><p>Allow this Obsidian plugin to publish notes for <strong>${escapeHtml(session.account.email)}</strong>?</p><form method="post" action="/connect/approve"><input type="hidden" name="deviceCode" value="${escapeHtml(code)}">${formField("tokenName", "Token name", "text", false)}<button>Allow publishing</button></form>`);
}

async function approveConnect(context: WorkerContext): Promise<Response> {
  const session = await requireSession(context);
  const form = await readForm(context.request);
  await context.service.approveDeviceAuthorization(session, String(form.deviceCode || ""), String(form.tokenName || "Obsidian plugin"));
  return html("Connected", `<h1>Connected</h1><p>You can return to Obsidian. The plugin will finish connecting automatically.</p>`);
}

async function setupPage(context: WorkerContext): Promise<Response> {
  if (!context.service.bootstrapConfigured()) return html("Setup unavailable", `<h1>Setup unavailable</h1><p>This Worker has no BOOTSTRAP_SECRET configured.</p>`, 503);
  if (context.request.method === "GET") return html("First-time setup", `<h1>First-time setup</h1><p>This creates the first account. The bootstrap secret is single-use and is never shown again.</p><form method="post" action="/setup">${formField("bootstrapSecret", "Bootstrap secret", "password")}${formField("email", "Email", "email")}${formField("password", "Password (10+ characters)", "password")}<button>Create account</button></form>`);
  const form = await readForm(context.request);
  const result = await context.service.setup({ bootstrapSecret: String(form.bootstrapSecret || ""), email: String(form.email || ""), password: String(form.password || "") });
  return new Response(recoveryPage(result.recoveryCode), { status: 201, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function loginPage(context: WorkerContext): Promise<Response> {
  if (context.request.method === "GET") { const next = safeNext(new URL(context.request.url).searchParams.get("next")); return html("Sign in", `<h1>Sign in</h1><form method="post" action="/login">${formField("email", "Email", "email")}${formField("password", "Password", "password")}<input type="hidden" name="next" value="${escapeHtml(next)}"><button>Sign in</button></form><p><a href="/register?next=${encodeURIComponent(next)}">Create an account</a> · <a href="/recover">Use recovery code</a></p>`); }
  const form = await readForm(context.request);
  const result = await context.service.login({ email: String(form.email || ""), password: String(form.password || "") });
  return new Response(null, { status: 302, headers: { location: safeNext(form.next), "set-cookie": sessionCookie(result.session.id, context.request) } });
}

async function registerPage(context: WorkerContext): Promise<Response> {
  if (context.request.method === "GET") { const next = safeNext(new URL(context.request.url).searchParams.get("next")); return html("Create account", `<h1>Create account</h1><p>Email verification is not required. Save the one-time recovery code shown after registration.</p><form method="post" action="/register">${formField("email", "Email", "email")}${formField("password", "Password (10+ characters)", "password")}<input type="hidden" name="next" value="${escapeHtml(next)}"><button>Create account</button></form><p><a href="/login?next=${encodeURIComponent(next)}">Sign in</a></p>`); }
  const form = await readForm(context.request);
  const result = await context.service.register({ email: String(form.email || ""), password: String(form.password || "") });
  return new Response(recoveryPage(result.recoveryCode, `/login?next=${encodeURIComponent(safeNext(form.next))}`), { status: 201, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function recoverPage(context: WorkerContext): Promise<Response> {
  if (context.request.method === "GET") return html("Recover account", `<h1>Recover account</h1><p>Recovery revokes all existing sessions and Publish Tokens.</p><form method="post" action="/recover">${formField("email", "Email", "email")}${formField("recoveryCode", "Recovery code")}${formField("newPassword", "New password (10+ characters)", "password")}<button>Reset password</button></form>`);
  const form = await readForm(context.request);
  await context.service.recover({ email: String(form.email || ""), recoveryCode: String(form.recoveryCode || ""), newPassword: String(form.newPassword || "") });
  return html("Password reset", `<h1>Password reset</h1><p>All previous sessions and Publish Tokens were revoked. <a href="/login">Sign in again</a>.</p>`);
}

async function logoutPage(context: WorkerContext): Promise<Response> { await context.service.logout(parseCookie(context.request.headers.get("cookie"), "pn_session")); return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": clearCookie(context.request) } }); }

async function accountPage(context: WorkerContext): Promise<Response> {
  const session = await requireSession(context);
  const path = new URL(context.request.url).pathname;
  const revokeTokenMatch = /^\/account\/tokens\/([^/]+)\/revoke$/.exec(path);
  if (revokeTokenMatch && context.request.method === "POST") { await context.service.revokeToken(session, decodeURIComponent(revokeTokenMatch[1])); return new Response(null, { status: 302, headers: { location: "/account/tokens" } }); }
  const deleteSiteMatch = /^\/account\/sites\/([^/]+)\/delete$/.exec(path);
  if (deleteSiteMatch && context.request.method === "POST") { await context.service.deleteSite(session, decodeURIComponent(deleteSiteMatch[1])); return new Response(null, { status: 302, headers: { location: "/account/sites" } }); }
  if (path === "/account/tokens") {
    if (context.request.method === "POST") {
      const form = await readForm(context.request);
      const created = await context.service.createToken(session.account.id, String(form.name || "Obsidian plugin"));
      return html("Token created", `<h1>Token created</h1><p>Copy this token now. It will not be shown again.</p><p class="warning"><code>${escapeHtml(created.token)}</code></p><p><a href="/account/tokens">Back to tokens</a></p>`);
    }
    const tokens = await context.service.listTokens(session);
    return html("Tokens", `<h1>Publish Tokens</h1><p>Full token values are never shown after creation.</p><form method="post" action="/account/tokens">${formField("name", "Token name", "text", false)}<button>Create token</button></form>${tokens.map((token) => `<div class="card"><strong>${escapeHtml(token.name)}</strong><br>Created: ${escapeHtml(token.createdAt)}<br>Last used: ${escapeHtml(token.lastUsedAt || "Never")}<br>Status: ${escapeHtml(token.revokedAt ? "Revoked" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "Expired" : "Active")} ${token.revokedAt ? "" : `<form method="post" action="/account/tokens/${encodeURIComponent(token.id)}/revoke"><button>Revoke</button></form>`}</div>`).join("")}`, { session: true });
  }
  if (path === "/account/sites") {
    const sites = await context.service.listSites(session.account.id);
    return html("Sites", `<h1>Published Notes</h1>${sites.map((site) => `<div class="card"><strong>${escapeHtml(site.title)}</strong><br><a href="/s/${encodeURIComponent(site.siteId)}/">${escapeHtml(siteUrlFor(context, site.siteId))}</a><br>Size: ${escapeHtml(site.byteSize)} bytes · Updated: ${escapeHtml(site.updatedAt)}<form method="post" action="/account/sites/${encodeURIComponent(site.siteId)}/delete"><button>Delete site</button></form></div>`).join("") || "<p>No sites yet.</p>"}`, { session: true });
  }
  const usage = await usagePayload(context.service, session.account.id);
  return html("Usage", `<h1>Usage</h1><p>Account: ${escapeHtml(session.account.email)}</p><div class="card"><strong>${escapeHtml(usage.bytes)} bytes in current published content</strong><br>${escapeHtml(usage.siteCount)} published Notes<br>Service: ${escapeHtml(new URL(context.request.url).origin)}</div><p><a href="/account/tokens">Manage tokens</a> · <a href="/account/sites">Manage sites</a></p>`, { session: true });
}

async function usagePayload(service: PublishService, accountId: string) { const usage = await service.getUsage(accountId); return { ...usage, sites: await service.listSites(accountId) }; }
function siteUrlFor(context: WorkerContext, siteId: string) { return `${new URL(context.request.url).origin}/s/${encodeURIComponent(siteId)}/`; }
function publicAccount(account: { id: string; email: string; createdAt: string }) { return { id: account.id, email: account.email, createdAt: account.createdAt }; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS }); }
function html(title: string, body: string, statusOrOptions: number | { session?: boolean } = 200, options: { session?: boolean } = {}) { const status = typeof statusOrOptions === "number" ? statusOrOptions : 200; const pageOptions = typeof statusOrOptions === "number" ? options : statusOrOptions; return new Response(page(title, body, pageOptions), { status, headers: { "content-type": "text/html; charset=utf-8" } }); }
async function readJson(request: Request): Promise<Record<string, any>> { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > 4 * 1024 * 1024) throw new ServiceError(413, "QUOTA_EXCEEDED", "Request body is too large"); try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ServiceError(400, "BAD_REQUEST", "Invalid JSON"); } }
async function readForm(request: Request): Promise<Record<string, string>> { const form = await request.formData(); return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)])); }
function parseBearer(value: string | null): string | undefined { const match = /^Bearer\s+(.+)$/i.exec(value || ""); return match?.[1]; }
function parseCookie(value: string | null, name: string): string | undefined { const item = (value || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return item ? decodeURIComponent(item.slice(name.length + 1)) : undefined; }
function sessionCookie(value: string, request: Request) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `pn_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`; }
function clearCookie(request: Request) { const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""; return `pn_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`; }
function safeNext(value: unknown) { const next = String(value || "/account/usage"); return next.startsWith("/") && !next.startsWith("//") ? next : "/account/usage"; }

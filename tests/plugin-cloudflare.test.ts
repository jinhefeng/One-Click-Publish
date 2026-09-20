import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const pluginSource = readFileSync(new URL("../plugin/main.js", import.meta.url), "utf8");

function loadPlugin({ desktop = true, fetchImpl, requestImpl, openExternal, electronOpenExternal, windowValue }: { desktop?: boolean; fetchImpl?: typeof fetch; requestImpl?: (request: any) => Promise<any>; openExternal?: (url: string) => void; electronOpenExternal?: (url: string) => void; windowValue?: any } = {}) {
  const pluginModule = { exports: {} as any };
  const notices: string[] = [];
  const dependencies: string[] = [];
  const request = async ({ url, method = "GET", headers, body }: { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }) => {
    const response = await (fetchImpl || globalThis.fetch)(url, { method, headers, body });
    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* normalized by the plugin */ }
    return { status: response.status, text, json, headers: Object.fromEntries(response.headers) };
  };
  const obsidian: any = {
    Plugin: class {
      app: unknown; data: any; settings: any;
      constructor(app: unknown) { this.app = app; }
      async loadData() { return JSON.parse(JSON.stringify(this.data || this.settings || {})); }
      async saveData(data: any) { this.data = JSON.parse(JSON.stringify(data)); }
    },
    Notice: class { constructor(message: string) { notices.push(message); } },
    PluginSettingTab: class {},
    Setting: class {},
    requestUrl: requestImpl || request,
    Platform: { isDesktopApp: desktop },
    MarkdownRenderer: {},
    Component: class {},
  };
  if (openExternal) obsidian.openExternal = openExternal;
  const source = pluginSource.replace('"REPLACE_WITH_CLOUDFLARE_OAUTH_CLIENT_ID"', '"test-cloudflare-client"');
  vm.runInNewContext(`(function(require, module, exports) {\n${source}\n})(require, module, module.exports);`, {
    require: (request: string) => {
      dependencies.push(request);
      if (request === "obsidian") return obsidian;
      if (!desktop) throw new Error(`Desktop dependency loaded on mobile: ${request}`);
      if (request === "electron") return { shell: { openExternal: electronOpenExternal || (() => undefined) } };
      if (request === "node:http" || request === "http") return http;
      throw new Error(`Unexpected plugin dependency: ${request}`);
    },
    module: pluginModule,
    console,
    process: desktop ? { versions: { electron: "test" } } : { versions: {} },
    fetch: () => { throw new Error("Browser fetch is unavailable: CORS"); },
    crypto: globalThis.crypto,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    Response: globalThis.Response,
    URL,
    URLSearchParams,
    window: windowValue,
    TextEncoder,
    Uint8Array,
    btoa,
    setTimeout,
    clearTimeout,
  });
  return { PluginClass: pluginModule.exports, notices, dependencies };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, result: value }), { status, headers: { "content-type": "application/json" } });
}

test("direct personal deployment uses PKCE, creates isolated Cloudflare resources, and revokes the OAuth token", async () => {
  const calls: string[] = [];
  let authorizationUrl = "";
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    if (url === "https://dash.cloudflare.com/oauth2/token") {
      const body = String(init.body || "");
      assert.match(body, /client_id=REPLACE_WITH_CLOUDFLARE_OAUTH_CLIENT_ID|client_id=/);
      assert.match(body, /code_verifier=/);
      calls.push("oauth:exchange");
      return new Response(JSON.stringify({ access_token: "cf-oauth-token" }), { status: 200 });
    }
    if (url === "https://dash.cloudflare.com/oauth2/revoke") {
      calls.push("oauth:revoke");
      return new Response("{}", { status: 200 });
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(`${method} ${path}`);
    if (path.endsWith("/accounts")) return jsonResponse([{ id: "account-12345678", name: "Personal" }]);
    if (path.endsWith("/d1/database")) {
      if (method === "GET") return jsonResponse([]);
      return jsonResponse({ uuid: "d1-uuid", name: "publish-note" });
    }
    if (path.endsWith("/workers/scripts") && method === "GET") return jsonResponse([]);
    if (path.endsWith("/workers/subdomain") && method === "GET") return new Response(JSON.stringify({ success: false, errors: [{ message: "not configured" }] }), { status: 404 });
    if (path.endsWith("/workers/subdomain") && method === "PUT") return jsonResponse({ subdomain: "personal-example" });
    if (path.includes("/__internal/provision/initialize")) return new Response(JSON.stringify({ accountId: "target-account", publishToken: "pn_personal_token" }), { status: 201 });
    if (path.endsWith("/subdomain") && method === "POST") { assert.equal(JSON.parse(String(init.body)).enabled, true); return jsonResponse({ enabled: true }); }
    if (path.endsWith("/secrets/BOOTSTRAP_SECRET") && method === "DELETE") return jsonResponse({});
    if (path.endsWith("/query") && method === "POST") return jsonResponse([{ success: true }]);
    if (path === "/healthz") return new Response(JSON.stringify({ status: "ok", service: "publish-note", version: "0.3.9" }));
    if (path.includes("/workers/scripts/") && method === "PUT") {
      const form = await new Response(init.body, { headers: init.headers }).formData();
      const metadata = JSON.parse(String(form.get("metadata")));
      assert.equal(metadata.main_module, "index.js");
      assert.equal(metadata.bindings.find((binding: any) => binding.type === "d1").id, "d1-uuid");
      assert.equal(metadata.bindings.find((binding: any) => binding.name === "PUBLISH_NOTE_VERSION").text, "0.3.9");
      assert.match(await (form.get("index.js") as File).text(), /export/);
      return jsonResponse({});
    }
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    authorizationUrl = url;
    const parsed = new URL(url);
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=authorization-code&state=${encodeURIComponent(parsed.searchParams.get("state") || "")}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.settings = {
    language: "en",
    cloudflareMode: "official",
    apiBaseUrl: "https://api.publish-note.example.com",
    publishToken: "pn_old_token",
    officialPublishToken: "pn_old_token",
    selfPublishToken: "",
    connectionStatus: "connected",
    deploymentStatus: "not_deployed",
    deploymentManaged: false,
    deploymentWorkerUrl: "",
  };
  const writes: string[] = [];
  plugin.saveData = async (data: any) => { writes.push(JSON.stringify(data)); plugin.data = data; };

  const result = await plugin.runDirectCloudflareDeployment();
  assert.equal(result, true, `${notices.join(" | ")} | calls: ${calls.join(", ")}`);
  assert.equal(new URL(authorizationUrl).searchParams.get("code_challenge_method"), "S256");
  assert.ok(new URL(authorizationUrl).searchParams.get("code_challenge"));
  assert.equal(plugin.settings.apiBaseUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.publishToken, "pn_personal_token");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal_token");
  assert.equal(plugin.settings.deploymentStatus, "ready");
  assert.equal(calls.filter((call) => call === "oauth:revoke").length, 1);
  assert.ok(calls.some((call) => call.includes("POST /client/v4/accounts/account-12345678/d1/database")));
  assert.equal(calls.some((call) => call.includes("/r2/")), false);
  assert.ok(calls.some((call) => call.includes("PUT /client/v4/accounts/account-12345678/workers/scripts/publish-note")));
  assert.ok(calls.some((call) => call.includes("DELETE /client/v4/accounts/account-12345678/workers/scripts/publish-note/secrets/BOOTSTRAP_SECRET")));
  assert.equal(notices.some((notice) => notice.includes("provisioning service")), false);
  // The connection is committed once; completed, sanitized deployment logs are
  // then persisted separately without changing that usable connection.
  assert.equal(writes.length, 2);
  for (const serialized of writes) {
    const saved = JSON.parse(serialized);
    assert.equal(saved.deploymentWorkerUrl, plugin.settings.deploymentWorkerUrl);
    assert.equal(saved.selfPublishToken, "pn_personal_token");
    assert.equal(saved.deploymentStatus, "ready");
  }
  assert.ok(JSON.parse(writes[1]).deploymentLogs.length > 0);
  assert.doesNotMatch(writes.join(""), /cf-oauth-token|BOOTSTRAP_SECRET|code_verifier/);
  assert.ok(calls.indexOf("GET /healthz") < calls.indexOf("POST /__internal/provision/initialize"));
});

test("updates an existing personal Worker in place so new publishing limits take effect", async () => {
  const calls: string[] = [];
  const requiredTables = [
    "accounts", "recovery_codes", "sessions", "tokens", "sites", "revisions", "objects", "object_chunks",
    "uploads", "upload_objects", "upload_chunks", "device_authorizations", "bootstrap_state",
  ];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-oauth-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") { calls.push("oauth:revoke"); return new Response("{}", { status: 200 }); }
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(`${method} ${path}`);
    if (path.endsWith("/accounts")) return jsonResponse([{ id: "account-12345678", name: "Personal" }]);
    if (path.endsWith("/d1/database") && method === "GET") return jsonResponse([{ uuid: "d1-uuid", name: "publish-note" }]);
    if (path.endsWith("/workers/scripts") && method === "GET") return jsonResponse([{ id: "publish-note" }]);
    if (path.endsWith("/d1/database/d1-uuid/query") && method === "POST") {
      const sql = JSON.parse(String(init.body || "{}")).sql || "";
      if (sql.includes("sqlite_master")) return jsonResponse([{ success: true, results: requiredTables.map((name) => ({ name })) }]);
      if (sql.includes("PRAGMA table_info")) return jsonResponse([{ success: true, results: [{ name: "data" }] }]);
      return jsonResponse([{ success: true }]);
    }
    if (path.endsWith("/workers/subdomain") && method === "GET") return jsonResponse({ subdomain: "personal-example" });
    if (path.endsWith("/subdomain") && method === "POST") return jsonResponse({ enabled: true });
    if (path.includes("/workers/scripts/") && method === "PUT") {
      const form = await new Response(init.body, { headers: init.headers }).formData();
      const module = await (form.get("index.js") as File).text();
      const metadata = JSON.parse(String(form.get("metadata")));
      assert.equal(metadata.bindings.find((binding: any) => binding.name === "PUBLISH_NOTE_VERSION").text, "0.3.9");
      assert.doesNotMatch(module, /Account site limit exceeded|MAX_SITE_COUNT|Account storage quota exceeded|MAX_ACCOUNT_BYTES|52428800/);
      return jsonResponse({});
    }
    if (path === "/healthz") return new Response(JSON.stringify({ status: "ok", service: "publish-note", version: "0.3.9" }));
    if (path === "/__internal/provision/reconnect") return new Response(JSON.stringify({ accountId: "historical-account", publishToken: "pn_updated_token" }), { status: 200 });
    if (path.endsWith("/secrets/BOOTSTRAP_SECRET") && method === "DELETE") return jsonResponse({});
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://note.openstaff.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_old_token", publishToken: "pn_old_token",
    customDomain: "note.openstaff.dev", customDomainId: "domain-1", customDomainZoneName: "openstaff.dev", customDomainStatus: "active",
    connectionProfiles: JSON.stringify({ self: { serviceUrl: "https://note.openstaff.dev", publishToken: "pn_old_token" } }),
  };
  plugin.settings = plugin.data;
  plugin.saveData = async (data: any) => { plugin.data = JSON.parse(JSON.stringify(data)); };

  assert.equal(await plugin.runDirectCloudflareDeployment(), true);
  assert.equal(plugin.settings.selfPublishToken, "pn_updated_token");
  assert.equal(plugin.settings.apiBaseUrl, "https://note.openstaff.dev");
  assert.equal(plugin.settings.customDomain, "note.openstaff.dev");
  assert.equal(plugin.settings.deploymentWorkerUrl, "https://publish-note.personal-example.workers.dev");
  assert.ok(calls.includes("PUT /client/v4/accounts/account-12345678/workers/scripts/publish-note"));
  assert.equal(calls.some((call) => call === "POST /client/v4/accounts/account-12345678/d1/database"), false);
  assert.equal(calls.some((call) => call === "DELETE /client/v4/accounts/account-12345678/workers/scripts/publish-note"), false);
  assert.equal(calls.filter((call) => call === "oauth:revoke").length, 1);
  assert.ok(calls.includes("POST /__internal/provision/reconnect"));
});

test("personal deployment requests the Cloudflare-supported account page size", async () => {
  const paths: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/client/v4/accounts" && url.search === "?per_page=50") {
      return jsonResponse([{ id: "account-12345678" }]);
    }
    throw new Error(`Unexpected Cloudflare request: ${String(input)}`);
  };
  const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch });
  await assert.rejects(PluginClass.__testing.provisionPersonalCloudflare("cf-oauth-token"));
  assert.equal(paths[0], "/client/v4/accounts?per_page=50");
});

test("binds and unbinds a root custom domain through the user's Cloudflare account", async () => {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const authorizationUrls: string[] = [];
  let domains: any[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined });
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-domain-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response("{}", { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/client/v4/accounts") return jsonResponse([{ id: "account-domain" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains" && method === "GET") return jsonResponse(domains);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains" && method === "PUT") {
      const body = JSON.parse(String(init.body || "{}"));
      domains = [{ id: "domain-1", hostname: body.hostname, service: body.service, zone_id: body.zone_id, zone_name: body.zone_name }];
      return jsonResponse(domains[0]);
    }
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains/domain-1" && method === "DELETE") {
      domains = [];
      return jsonResponse({});
    }
    if (parsed.pathname === "/client/v4/zones" && parsed.searchParams.get("name") === "example.com") return jsonResponse([{ id: "zone-1", name: "example.com", status: "active" }]);
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    authorizationUrls.push(url);
    const parsed = new URL(url);
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=domain-code&state=${encodeURIComponent(parsed.searchParams.get("state") || "")}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open, windowValue: { confirm: () => true } });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_personal", publishToken: "pn_personal",
    lastPublishedUrl: "https://publish-note.personal-example.workers.dev/s/site-1/",
  };
  await plugin.loadSettings();
  assert.equal(await plugin.bindCustomDomain("https://example.com"), true, notices.join(" | "));
  assert.equal(plugin.settings.customDomain, "example.com");
  assert.equal(plugin.settings.apiBaseUrl, "https://example.com");
  assert.equal(plugin.settings.deploymentWorkerUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal");
  assert.equal(plugin.settings.lastPublishedUrl, "https://example.com/s/site-1/");
  assert.equal(plugin.settings.deploymentOriginUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(new URL(authorizationUrls[0]).searchParams.get("scope"), "account-settings.read workers-scripts.write workers-routes.write zone.read");
  assert.equal(calls.some((call) => call.method === "PUT" && call.url.endsWith("/workers/domains")), true);
  assert.equal(await plugin.unbindCustomDomain(), true);
  assert.equal(plugin.settings.customDomain, "");
  assert.equal(plugin.settings.apiBaseUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.deploymentWorkerUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal");
  assert.equal(plugin.settings.lastPublishedUrl, "https://publish-note.personal-example.workers.dev/s/site-1/");
  assert.equal(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/workers/domains/domain-1")), true);
  assert.ok(plugin.domainBindingSession.operationId);
  assert.ok(plugin.domainBindingSession.logs.every((entry: any) => entry.operationId === plugin.domainBindingSession.operationId));
});

test("rejects a custom domain that is not a Zone in the authorized Cloudflare account", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ method, url });
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-domain-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response("{}", { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/client/v4/accounts") return jsonResponse([{ id: "account-domain" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains") return jsonResponse([]);
    if (parsed.pathname === "/client/v4/zones" && parsed.searchParams.get("name") === "not-owned.example") return jsonResponse([]);
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const parsed = new URL(url);
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=domain-code&state=${encodeURIComponent(parsed.searchParams.get("state") || "")}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_personal", publishToken: "pn_personal",
  };
  await plugin.loadSettings();

  assert.equal(await plugin.bindCustomDomain("not-owned.example"), false);
  assert.match(notices.join(" | "), /not an active Zone in the authorized Cloudflare account/);
  assert.equal(calls.some((call) => call.method === "PUT"), false);
  assert.equal(plugin.settings.customDomain, "");
  assert.equal(plugin.settings.apiBaseUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal");
});

test("failed custom domain unbinding keeps the primary Cloudflare connection", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ method, url });
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-domain-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response("{}", { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/client/v4/accounts") return jsonResponse([{ id: "account-domain" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains" && method === "GET") return jsonResponse([{ id: "domain-1", hostname: "example.com", service: "publish-note" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains/domain-1" && method === "DELETE") return new Response(JSON.stringify({ success: false, errors: [{ message: "Permission denied" }] }), { status: 403, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const parsed = new URL(url);
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=domain-code&state=${encodeURIComponent(parsed.searchParams.get("state") || "")}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://example.com",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_personal", publishToken: "pn_personal",
    customDomain: "example.com", customDomainId: "domain-1", customDomainZoneName: "example.com", customDomainStatus: "active",
    connectionProfiles: JSON.stringify({ self: { serviceUrl: "https://example.com", publishToken: "pn_personal" } }),
  };
  await plugin.loadSettings();

  assert.equal(await plugin.unbindCustomDomain(), false);
  assert.match(notices.join(" | "), /Could not unbind the custom domain/);
  assert.equal(plugin.settings.customDomain, "example.com");
  assert.equal(plugin.settings.apiBaseUrl, "https://example.com");
  assert.equal(plugin.settings.deploymentWorkerUrl, "https://publish-note.personal-example.workers.dev");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal");
  assert.equal(plugin.settings.connectionStatus, "connected");
  assert.equal(calls.some((call) => call.method === "DELETE"), true);
});

test("custom domain unbinding keeps a recoverable marker when local save fails after Cloudflare deletion", async () => {
  const calls: string[] = [];
  const originUrl = "https://publish-note.personal-example.workers.dev";
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-domain-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response("{}", { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/client/v4/accounts") return jsonResponse([{ id: "account-domain" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains" && method === "GET") return jsonResponse([{ id: "domain-1", hostname: "example.com", service: "publish-note" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains/domain-1" && method === "DELETE") return jsonResponse({});
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=domain-code&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://example.com",
    deploymentWorkerUrl: originUrl, deploymentOriginUrl: originUrl, deploymentWorkerName: "publish-note",
    selfPublishToken: "pn_personal", publishToken: "pn_personal",
    customDomain: "example.com", customDomainId: "domain-1", customDomainZoneName: "example.com", customDomainStatus: "active",
  };
  await plugin.loadSettings();
  const originalSaveData = plugin.saveData.bind(plugin);
  let failedFinalSave = false;
  plugin.saveData = async (data: any) => {
    if (!failedFinalSave && data.customDomain === "" && data.customDomainTransition === null) {
      failedFinalSave = true;
      throw new Error("Vault is read-only");
    }
    await originalSaveData(data);
  };

  assert.equal(await plugin.unbindCustomDomain(), false);
  assert.equal(calls.some((call) => call.includes("DELETE https://api.cloudflare.com/client/v4/accounts/account-domain/workers/domains/domain-1")), true);
  assert.equal(plugin.settings.customDomain, "example.com");
  assert.equal(plugin.settings.selfPublishToken, "pn_personal");
  assert.equal(plugin.settings.customDomainTransition?.state, "detaching");
  assert.equal(plugin.domainBindingSession.error.code, "LOCAL_SETTINGS_SAVE_FAILED");
  assert.equal(plugin.domainBindingSession.error.remoteOutcome, "detached");
  assert.ok(plugin.domainBindingSession.error.causeMessage.includes("read-only"));
  assert.match(notices.join(" | "), /local custom-domain state could not be saved/);
});

test("custom domain recovery finalizes local settings after Cloudflare no longer has the attachment", async () => {
  const calls: string[] = [];
  const originUrl = "https://publish-note.personal-example.workers.dev";
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-domain-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") return new Response("{}", { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/client/v4/accounts") return jsonResponse([{ id: "account-domain" }]);
    if (parsed.pathname === "/client/v4/accounts/account-domain/workers/domains" && method === "GET") return jsonResponse([]);
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=domain-code&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://example.com",
    deploymentWorkerUrl: originUrl, deploymentOriginUrl: originUrl, deploymentWorkerName: "publish-note",
    selfPublishToken: "pn_personal", publishToken: "pn_personal",
    customDomain: "example.com", customDomainId: "domain-1", customDomainZoneName: "example.com", customDomainStatus: "active",
    customDomainTransition: { state: "detaching", operationId: "domain-unbind-test", hostname: "example.com", domainId: "domain-1", originUrl, workerName: "publish-note", startedAt: new Date().toISOString() },
    lastPublishedUrl: "https://example.com/s/site-1/",
  };
  await plugin.loadSettings();

  assert.equal(await plugin.recoverCustomDomainTransition(), true);
  assert.equal(plugin.settings.customDomain, "");
  assert.equal(plugin.settings.apiBaseUrl, originUrl);
  assert.equal(plugin.settings.customDomainTransition, null);
  assert.equal(plugin.settings.lastPublishedUrl, "https://publish-note.personal-example.workers.dev/s/site-1/");
  assert.equal(calls.filter((call) => call.includes("oauth2/revoke")).length, 1);
});

test("clearing deployment and technical diagnostics clears persisted and in-memory operation logs", async () => {
  const { PluginClass } = loadPlugin({ desktop: false });
  const plugin = new PluginClass({});
  plugin.data = { language: "en", debugMode: true, deploymentLogs: [{ operationId: "op-1", stage: "resources", message: "old" }] };
  await plugin.loadSettings();
  plugin.deploymentSession = { operationId: "op-1", active: false, logs: [{ operationId: "op-1", stage: "resources", message: "old" }], error: new Error("old") };
  assert.equal(await plugin.clearDeploymentLogs(), true);
  assert.equal(plugin.settings.deploymentLogs.length, 0);
  assert.equal(plugin.deploymentSession.logs.length, 0);

  plugin.domainBindingSession = { operationId: "op-2", active: false, logs: [{ operationId: "op-2", stage: "authorization", message: "failed" }], error: new Error("failed") };
  plugin.settings.deploymentLogs = [{ operationId: "op-2", stage: "authorization", message: "failed" }];
  await plugin.saveSettings({ deploymentLogs: plugin.settings.deploymentLogs });
  assert.equal(await plugin.clearOperationDiagnostics(plugin.domainBindingSession), true);
  assert.equal(plugin.domainBindingSession, null);
  assert.equal(plugin.settings.deploymentLogs.length, 0);
});

test("custom domain authorization denial keeps a visible sanitized diagnostic log", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error(`Cloudflare should not be called after authorization denial: ${String(input)}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      const description = encodeURIComponent("The user denied access to the requested domain permissions");
      http.get(`http://127.0.0.1:8976/oauth/callback?error=access_denied&error_description=${description}&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open, windowValue: { confirm: () => true } });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_personal", publishToken: "pn_personal", debugMode: true, debugLogs: [],
  };
  await plugin.loadSettings();

  assert.equal(await plugin.bindCustomDomain("notes.example.com"), false);
  assert.equal(calls.length, 0);
  assert.equal(plugin.settings.customDomain, "");
  const failure = plugin.domainBindingSession.logs.find((entry: any) => entry.code === "OAUTH_DENIED");
  assert.ok(failure);
  assert.equal(failure.providerCode, "access_denied");
  assert.match(failure.providerMessage, /denied access/);
  assert.equal(plugin.domainBindingSession.error.code, "OAUTH_DENIED");
  await plugin.debugLogsWritePromise;
  const debugFailure = plugin.settings.debugLogs.find((entry: any) => entry.code === "OAUTH_DENIED");
  assert.ok(debugFailure);
  assert.equal(debugFailure.providerCode, "access_denied");
  assert.match(notices.join(" | "), /user denied access to the requested domain permissions/);
});

test("custom domain invalid scope explains the OAuth client configuration", async () => {
  const fakeFetch = async (input: RequestInfo | URL) => {
    throw new Error(`Cloudflare should not be called after invalid scope: ${String(input)}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      const description = encodeURIComponent("The OAuth 2.0 Client is not allowed to request scope 'workers-routes.write'.");
      http.get(`http://127.0.0.1:8976/oauth/callback?error=invalid_scope&error_description=${description}&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass, notices } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open, windowValue: { confirm: () => true } });
  const plugin = new PluginClass({});
  plugin.data = {
    language: "en", cloudflareMode: "self", apiBaseUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev", deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    deploymentWorkerName: "publish-note", selfPublishToken: "pn_personal", publishToken: "pn_personal",
  };
  await plugin.loadSettings();

  assert.equal(await plugin.bindCustomDomain("notes.example.com"), false);
  assert.match(notices.join(" | "), /does not allow the Workers Routes Write scope/);
  assert.equal(plugin.domainBindingSession.error.providerCode, "invalid_scope");
});

test("personal deployment is unavailable on mobile while the plugin remains loadable", async () => {
  const { PluginClass, notices } = loadPlugin({ desktop: false });
  const plugin = new PluginClass({});
  plugin.settings = {
    language: "en",
    cloudflareMode: "official",
    apiBaseUrl: "https://api.publish-note.example.com",
    publishToken: "",
    officialPublishToken: "",
    selfPublishToken: "",
    connectionStatus: "disconnected",
    deploymentStatus: "not_deployed",
    deploymentManaged: false,
    deploymentWorkerUrl: "",
  };

  assert.equal(await plugin.runDirectCloudflareDeployment(), false);
  assert.match(notices[0], /desktop/);
});

test("external links fall back to Electron when Obsidian does not export openExternal", () => {
  const opened: string[] = [];
  const { PluginClass } = loadPlugin({ electronOpenExternal: (url) => opened.push(url) });
  const plugin = new PluginClass({});
  plugin.settings = { language: "en", lastPublishedUrl: "https://publish-note.example.test/s/test" };

  plugin.openLastPublishedSite();

  assert.deepEqual(opened, ["https://publish-note.example.test/s/test"]);
});

test("personal resource names avoid every existing Worker and D1 name", () => {
  const { PluginClass } = loadPlugin();
  const { __testing } = PluginClass;
  const names = __testing.choosePersonalCloudflareNames(
    "account-12345678",
    ["publish-note", "publish-note-account", "publish-note-account-2"],
    ["publish-note-account", "publish-note-account-2"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(names)), { worker: "publish-note", d1: "publish-note-account-3" });

  const workerCollision = __testing.choosePersonalCloudflareNames("account-12345678", [], ["publish-note"]);
  assert.deepEqual(JSON.parse(JSON.stringify(workerCollision)), { worker: "publish-note-account", d1: "publish-note" });
});

test("personal deployment reuses a recognized historical One-Click Publish D1 and reconnects its account", async () => {
  const calls: string[] = [];
  const requiredTables = [
    "accounts", "recovery_codes", "sessions", "tokens", "sites", "revisions", "objects", "object_chunks",
    "uploads", "upload_objects", "upload_chunks", "device_authorizations", "bootstrap_state",
  ];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(`${method} ${path}`);
    if (path.endsWith("/accounts")) return jsonResponse([{ id: "account-12345678", name: "Personal" }]);
    if (path.endsWith("/d1/database") && method === "GET") return jsonResponse([{ uuid: "historical-db", name: "publish-note-417f3533" }]);
    if (path.endsWith("/workers/scripts") && method === "GET") return jsonResponse([{ id: "publish-note-417f3533" }]);
    if (path.endsWith("/d1/database/historical-db/query") && method === "POST") {
      const sql = JSON.parse(String(init.body || "{}")).sql || "";
      if (sql.includes("sqlite_master")) return jsonResponse([{ success: true, results: requiredTables.map((name) => ({ name })) }]);
      if (sql.includes("PRAGMA table_info")) return jsonResponse([{ success: true, results: [{ name: "data" }] }]);
      return jsonResponse([{ success: true }]);
    }
    if (path.endsWith("/workers/subdomain") && method === "GET") return jsonResponse({ subdomain: "personal-example" });
    if (path.endsWith("/subdomain") && method === "POST") return jsonResponse({ enabled: true });
    if (path.includes("/workers/scripts/") && method === "PUT") {
      const form = await new Response(init.body, { headers: init.headers }).formData();
      const metadata = JSON.parse(String(form.get("metadata")));
      assert.equal(metadata.bindings.find((binding: any) => binding.name === "DB").id, "historical-db");
      return jsonResponse({});
    }
    if (path === "/healthz") return new Response(JSON.stringify({ status: "ok", service: "publish-note", version: "0.3.9" }));
    if (path === "/__internal/provision/reconnect") return new Response(JSON.stringify({ accountId: "historical-account", publishToken: "pn_reconnected" }), { status: 200 });
    if (path.endsWith("/secrets/BOOTSTRAP_SECRET") && method === "DELETE") return jsonResponse({});
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch });
  const result = await PluginClass.__testing.provisionPersonalCloudflare("test-token");
  assert.equal(result.serviceUrl, "https://publish-note-417f3533.personal-example.workers.dev");
  assert.equal(result.publishToken, "pn_reconnected");
  assert.equal(calls.some((call) => call === "POST /client/v4/accounts/account-12345678/d1/database"), false);
  assert.ok(calls.includes("POST /client/v4/accounts/account-12345678/d1/database/historical-db/query"));
  assert.ok(calls.includes("PUT /client/v4/accounts/account-12345678/workers/scripts/publish-note-417f3533"));
  assert.ok(calls.includes("DELETE /client/v4/accounts/account-12345678/workers/scripts/publish-note-417f3533/secrets/BOOTSTRAP_SECRET"));
  assert.equal(calls.some((call) => call === "DELETE /client/v4/accounts/account-12345678/workers/scripts/publish-note-417f3533"), false);
  assert.ok(calls.includes("POST /__internal/provision/reconnect"));
});

test("personal deployment creates only the missing resource when a Worker or D1 is absent", async () => {
  const requiredTables = [
    "accounts", "recovery_codes", "sessions", "tokens", "sites", "revisions", "objects", "object_chunks",
    "uploads", "upload_objects", "upload_chunks", "device_authorizations", "bootstrap_state",
  ];
  const scenarios = [
    {
      name: "missing Worker",
      databases: [{ uuid: "historical-db", name: "publish-note-417f3533" }],
      workers: [],
      expectedWorker: "publish-note-417f3533",
      expectedDatabase: "historical-db",
      initPath: "/__internal/provision/reconnect",
    },
    {
      name: "missing D1",
      databases: [],
      workers: [{ id: "publish-note" }],
      expectedWorker: "publish-note",
      expectedDatabase: "created-db",
      initPath: "/__internal/provision/initialize",
    },
  ];
  for (const scenario of scenarios) {
    const calls: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      const path = new URL(url).pathname;
      calls.push(`${method} ${path}`);
      if (path.endsWith("/accounts")) return jsonResponse([{ id: "account-12345678", name: "Personal" }]);
      if (path.endsWith("/d1/database") && method === "GET") return jsonResponse(scenario.databases);
      if (path.endsWith("/d1/database") && method === "POST") return jsonResponse({ uuid: "created-db" });
      if (path.endsWith("/workers/scripts") && method === "GET") return jsonResponse(scenario.workers);
      if (path.endsWith("/d1/database/historical-db/query") && method === "POST") {
        const sql = JSON.parse(String(init.body || "{}")).sql || "";
        if (sql.includes("sqlite_master")) return jsonResponse([{ success: true, results: requiredTables.map((name) => ({ name })) }]);
        if (sql.includes("PRAGMA table_info")) return jsonResponse([{ success: true, results: [{ name: "data" }] }]);
        return jsonResponse([{ success: true }]);
      }
      if (path.includes("/d1/database/") && path.endsWith("/query") && method === "POST") return jsonResponse([{ success: true }]);
      if (path.endsWith("/workers/subdomain") && method === "GET") return jsonResponse({ subdomain: "personal-example" });
      if (path.endsWith("/subdomain") && method === "POST") return jsonResponse({ enabled: true });
      if (path.includes("/workers/scripts/") && method === "PUT") {
        assert.equal(path.endsWith(`/workers/scripts/${scenario.expectedWorker}`), true, scenario.name);
        const form = await new Response(init.body, { headers: init.headers }).formData();
        const metadata = JSON.parse(String(form.get("metadata")));
        assert.equal(metadata.bindings.find((binding: any) => binding.name === "DB").id, scenario.expectedDatabase, scenario.name);
        return jsonResponse({});
      }
    if (path === "/healthz") return new Response(JSON.stringify({ status: "ok", service: "publish-note", version: "0.3.9" }));
      if (path === scenario.initPath) return new Response(JSON.stringify({ accountId: "target-account", publishToken: "pn_personal_token" }), { status: 201 });
      if (path.endsWith("/secrets/BOOTSTRAP_SECRET") && method === "DELETE") return jsonResponse({});
      throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
    };
    const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch });
    const result = await PluginClass.__testing.provisionPersonalCloudflare("test-token");
    assert.equal(result.serviceUrl, `https://${scenario.expectedWorker}.personal-example.workers.dev`, scenario.name);
    assert.equal(calls.includes("POST /client/v4/accounts/account-12345678/d1/database"), scenario.name === "missing D1", scenario.name);
    assert.ok(calls.includes(`PUT /client/v4/accounts/account-12345678/workers/scripts/${scenario.expectedWorker}`), scenario.name);
    assert.ok(calls.includes(scenario.initPath === "/__internal/provision/reconnect" ? "POST /__internal/provision/reconnect" : "POST /__internal/provision/initialize"), scenario.name);
  }
});

test("native renderer stylesheet uses the binary asset protocol", () => {
  const { PluginClass } = loadPlugin();
  const css = 'body{content:"中文"}';
  const asset = PluginClass.__testing.createNativeStylesheetAsset(css);
  const bytes = Uint8Array.from(atob(asset.body), (character) => character.charCodeAt(0));

  assert.equal(asset.path, "assets/obsidian-snapshot.css");
  assert.equal(asset.contentType, "text/css");
  assert.equal(asset.encoding, "base64");
  assert.equal(new TextDecoder().decode(bytes), css);
});

test("personal deployment rejects missing or ambiguous Cloudflare account access before creating resources", async () => {
  for (const [accounts, expectedCode] of [
    [[], "NO_ACCOUNT_ACCESS"],
    [[{ id: "account-one" }, { id: "account-two" }], "MULTIPLE_ACCOUNTS"],
  ] as const) {
    const paths: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/accounts")) return jsonResponse(accounts);
      throw new Error(`Unexpected Cloudflare request: ${String(input)}`);
    };
    const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch });
    await assert.rejects(
      PluginClass.__testing.provisionPersonalCloudflare("cf-oauth-token"),
      (error: any) => error?.code === expectedCode,
    );
    assert.deepEqual(paths, ["/client/v4/accounts"]);
  }
});

function requestLoopback(path: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:8976${path}`, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
  });
}

test("loopback OAuth callback rejects an invalid state", async () => {
  const { PluginClass } = loadPlugin();
  const { __testing } = PluginClass;
  const callback = __testing.createLoopbackOAuthCallback("expected-state", 2_000);
  await callback.ready;
  const rejection = assert.rejects(callback.code, (error: any) => error?.code === "INVALID_OAUTH_STATE");
  assert.equal(await requestLoopback("/oauth/callback?code=wrong&state=wrong-state"), 400);
  await rejection;
  await callback.closed;
});

test("loopback OAuth callback accepts one authorization code", async () => {
  const { PluginClass } = loadPlugin();
  const { __testing } = PluginClass;
  const callback = __testing.createLoopbackOAuthCallback("expected-state", 2_000);
  await callback.ready;
  assert.equal(await requestLoopback("/oauth/callback?code=authorization-code&state=expected-state"), 200);
  assert.equal(await callback.code, "authorization-code");
  await callback.closed;
});

test("loopback OAuth callback reports an explicit authorization denial", async () => {
  const { PluginClass } = loadPlugin();
  const { __testing } = PluginClass;
  const callback = __testing.createLoopbackOAuthCallback("expected-state", 2_000);
  await callback.ready;
  assert.equal(await requestLoopback("/oauth/callback?error=access_denied&error_description=User%20denied%20domain%20access&state=expected-state"), 400);
  await assert.rejects(callback.code, (error: any) => error?.code === "OAUTH_DENIED" && error?.providerCode === "access_denied" && error?.providerMessage === "User denied domain access");
  await callback.closed;
});

test("loopback OAuth callback times out and refuses an occupied port", async () => {
  const { PluginClass } = loadPlugin();
  const { __testing } = PluginClass;
  const timedOut = __testing.createLoopbackOAuthCallback("expected-state", 20);
  await timedOut.ready;
  await assert.rejects(timedOut.code, (error: any) => error?.code === "OAUTH_TIMEOUT");
  await timedOut.closed;

  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(8976, "127.0.0.1", () => resolve()));
  try {
    const occupied = __testing.createLoopbackOAuthCallback("expected-state", 100);
    await assert.rejects(occupied.ready, (error: any) => error?.code === "OAUTH_CALLBACK_UNAVAILABLE");
    await occupied.closed;
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});

test("a failed personal deployment cleans only resources created in this run", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    if (url === "https://dash.cloudflare.com/oauth2/token") return new Response(JSON.stringify({ access_token: "cf-oauth-token" }), { status: 200 });
    if (url === "https://dash.cloudflare.com/oauth2/revoke") {
      calls.push("oauth:revoke");
      return new Response("{}", { status: 200 });
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(`${method} ${path}`);
    if (path.endsWith("/accounts")) return jsonResponse([{ id: "account-12345678", name: "Personal" }]);
    if (path.endsWith("/d1/database") && method === "GET") return jsonResponse([]);
    if (path.endsWith("/d1/database") && method === "POST") return jsonResponse({ uuid: "d1-created" });
    if (path.endsWith("/workers/scripts") && method === "GET") return jsonResponse([]);
    if (path.endsWith("/workers/subdomain")) return jsonResponse({ subdomain: "personal-example" });
    if (path.endsWith("/workers/scripts/publish-note") && method === "PUT") return new Response(JSON.stringify({ success: false, errors: [{ message: "simulated upload failure" }] }), { status: 400 });
    if (path.endsWith("/d1/database/d1-created") && method === "DELETE") return jsonResponse({});
    throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
  };
  const open = (url: string) => {
    const state = new URL(url).searchParams.get("state") || "";
    setImmediate(() => {
      http.get(`http://127.0.0.1:8976/oauth/callback?code=authorization-code&state=${encodeURIComponent(state)}`, (response) => response.resume());
    });
  };
  const { PluginClass } = loadPlugin({ fetchImpl: fakeFetch, openExternal: open });
  const plugin = new PluginClass({});
  plugin.settings = {
    language: "en",
    cloudflareMode: "official",
    apiBaseUrl: "https://api.publish-note.example.com",
    publishToken: "pn_old_token",
    officialPublishToken: "pn_old_token",
    selfPublishToken: "",
    connectionStatus: "connected",
    deploymentStatus: "not_deployed",
    deploymentManaged: false,
    deploymentWorkerUrl: "",
  };

  assert.equal(await plugin.runDirectCloudflareDeployment(), false);
  assert.equal(plugin.settings.cloudflareMode, "official");
  assert.equal(plugin.settings.apiBaseUrl, "https://api.publish-note.example.com");
  assert.equal(plugin.settings.publishToken, "pn_old_token");
  assert.doesNotMatch(JSON.stringify(plugin.settings), /cf-oauth-token/);
  assert.equal(calls.some((call) => call.includes("/r2/")), false);
  assert.ok(calls.includes("DELETE /client/v4/accounts/account-12345678/d1/database/d1-created"));
  assert.equal(calls.includes("DELETE /client/v4/accounts/account-12345678/workers/scripts/publish-note"), false);
  assert.equal(calls.filter((call) => call === "oauth:revoke").length, 1);
});

test("multipart preserves Unicode, exact module bytes and content types without browser APIs", async () => {
  const { PluginClass, dependencies } = loadPlugin();
  assert.deepEqual(dependencies, ["obsidian"]);
  const module = 'export default { fetch() { return new Response("笔记 🌏\\r\\n"); } };';
  const encoded = PluginClass.__testing.encodeWorkerMultipart({ main_module: "index.js", note: "笔记" }, module);
  assert.ok(encoded.body instanceof ArrayBuffer);
  const form = await new Response(encoded.body, { headers: encoded.headers }).formData();
  assert.equal(JSON.parse(String(form.get("metadata"))).note, "笔记");
  assert.equal(await (form.get("index.js") as File).text(), module);
  assert.equal((form.get("index.js") as File).type, "application/javascript+module");
});

test("deployment diagnostics distinguish network, HTTP, parsing and rate errors without leaking payloads", async () => {
  for (const scenario of [
    { response: () => { throw new Error("secret-token in a TLS failure"); }, code: "NETWORK_ERROR", status: 0, attempts: 3 },
    { response: () => ({ status: 403, text: "<html>secret-token</html>", get json() { throw new Error("do not access"); } }), code: "CLOUDFLARE_403", status: 403, attempts: 1 },
    { response: () => ({ status: 200, text: "<html>secret-token</html>" }), code: "INVALID_RESPONSE", status: 200, attempts: 1 },
    { response: () => ({ status: 429, text: '{"success":false,"errors":[{"code":1015,"message":"secret-token"}]}' }), code: "CLOUDFLARE_429", status: 429, attempts: 3 },
    { response: () => ({ status: 502, text: "Bad Gateway" }), code: "CLOUDFLARE_502", status: 502, attempts: 3 },
  ]) {
    let calls = 0;
    const { PluginClass } = loadPlugin({ requestImpl: async () => { calls++; return scenario.response(); } });
    await assert.rejects(PluginClass.__testing.deploymentRequest("https://api.cloudflare.com/client/v4/accounts/private-account/workers/scripts/private-worker", {}, { stage: "worker_upload", retryDelayMs: 0 }), (error: any) => {
      assert.equal(error.code, scenario.code);
      assert.equal(error.httpStatus, scenario.status);
      assert.equal(error.stage, "worker_upload");
      assert.doesNotMatch(JSON.stringify(PluginClass.__testing.deploymentDiagnostic(error)), /secret-token|private-account|private-worker/);
      return true;
    });
    assert.equal(calls, scenario.attempts);
  }
});

test("deployment diagnostics show the internal D1-linking failure and the safe Cloudflare error", async () => {
  const { PluginClass } = loadPlugin({ requestImpl: async () => ({
    status: 400,
    text: '{"success":false,"errors":[{"code":10007,"message":"D1 database not found"}]}',
  }) });
  await assert.rejects(PluginClass.__testing.deploymentRequest("https://api.cloudflare.com/client/v4/accounts/account-123/workers/scripts/publish-note", { method: "PUT" }, { stage: "worker_upload" }), (error: any) => {
    assert.equal(error.code, "CLOUDFLARE_400");
    assert.equal(error.providerCode, "10007");
    assert.equal(error.providerMessage, "D1 database not found");
    const diagnostic = PluginClass.__testing.deploymentDiagnostic(error);
    assert.equal(diagnostic.internal.stage, "worker_upload");
    assert.equal(diagnostic.external.code, "10007");
    assert.equal(diagnostic.external.message, "D1 database not found");
    const notice = PluginClass.__testing.deploymentFailure(error, PluginClass.__testing.copyForLanguage("zh"));
    assert.match(notice, /Worker/);
    assert.match(notice, /D1/);
    assert.match(notice, /10007/);
    return true;
  });
});

test("deployment logs retain safe troubleshooting fields without credentials", () => {
  const { PluginClass } = loadPlugin();
  const error = new PluginClass.__testing.CloudflareProvisioningError("CLOUDFLARE_400", "Deployment service rejected the request", {
    stage: "initialize",
    httpStatus: 400,
    method: "POST",
    route: "/__internal/provision/initialize",
    providerCode: "BAD_REQUEST",
    providerMessage: "Invalid JSON; token=secret-token",
  });
  const log = PluginClass.__testing.deploymentLogRecord({ error });
  assert.equal(log.stage, "initialize");
  assert.equal(log.providerCode, "BAD_REQUEST");
  assert.match(log.providerMessage, /Invalid JSON/);
  assert.doesNotMatch(JSON.stringify(log), /secret-token|access-token|bootstrap-secret/);
  assert.equal(PluginClass.__testing.normalizeDeploymentLogs([log]).length, 1);
});

test("debug mode records publish request and external response details without secrets or request bodies", async () => {
  const secret = "pn_publish_secret_12345678901234567890";
  const { PluginClass } = loadPlugin({ requestImpl: async () => ({
    status: 400,
    text: JSON.stringify({ code: "BAD_REQUEST", error: "D1 database table uploads is missing; token=should-not-appear" }),
    json: { code: "BAD_REQUEST", error: "D1 database table uploads is missing; token=should-not-appear" },
    headers: { "content-type": "application/json" },
  }) });
  const plugin = new PluginClass({});
  plugin.settings = {
    language: "en",
    debugMode: true,
    debugLogs: [],
    apiBaseUrl: "https://personal.example.test",
    publishToken: secret,
  };
  plugin.settingsBaseline = { ...plugin.settings };
  plugin.debugLogsBuffer = [];
  await assert.rejects(
    plugin.requestPublish("https://personal.example.test/v1/sites/uploads?token=should-not-appear", "POST", { noteBody: "private note" }, { connection: { serviceUrl: "https://personal.example.test", publishToken: secret } }),
    (error: any) => error.code === "BAD_REQUEST" && error.status === 400 && error.providerMessage.includes("D1 database"),
  );
  await plugin.debugLogsWritePromise;
  const text = JSON.stringify(plugin.settings.debugLogs);
  assert.match(text, /v1\/sites\/uploads/);
  assert.match(text, /D1 database table uploads is missing/);
  assert.doesNotMatch(text, /pn_publish_secret|should-not-appear|private note/);
  assert.equal(plugin.settings.debugLogs.some((entry: any) => entry.type === "request"), true);
  assert.equal(plugin.settings.debugLogs.some((entry: any) => entry.type === "response" && entry.httpStatus === 400), true);
});

test("debug mode preserves safe requestUrl transport diagnostics for statusless failures", async () => {
  const secret = "pn_network_secret_12345678901234567890";
  const { PluginClass } = loadPlugin({ requestImpl: async () => {
    const error = new Error("getaddrinfo ENOTFOUND publish-note.hefeng-jin.workers.dev");
    (error as any).code = "ENOTFOUND";
    throw error;
  } });
  const plugin = new PluginClass({});
  plugin.settings = { language: "en", debugMode: true, debugLogs: [], apiBaseUrl: "https://publish-note.hefeng-jin.workers.dev", publishToken: secret };
  plugin.settingsBaseline = { ...plugin.settings };
  plugin.debugLogsBuffer = [];
  await assert.rejects(
    plugin.requestPublish("https://publish-note.hefeng-jin.workers.dev/v1/sites/uploads", "POST", { privateNote: "must not be logged" }, { connection: { serviceUrl: "https://publish-note.hefeng-jin.workers.dev", publishToken: secret } }),
    (error: any) => error.code === "NETWORK_ERROR" && error.providerMessage.includes("ENOTFOUND"),
  );
  await plugin.debugLogsWritePromise;
  const networkError = plugin.settings.debugLogs.find((entry: any) => entry.type === "error");
  assert.equal(networkError.transport, "obsidian.requestUrl");
  assert.equal(networkError.endpointOrigin, "https://publish-note.hefeng-jin.workers.dev");
  assert.equal(networkError.errorName, "Error");
  assert.equal(networkError.errorCode, "ENOTFOUND");
  assert.match(networkError.errorMessage, /ENOTFOUND/);
  assert.equal(networkError.hasAuthorization, true);
  assert.ok(networkError.requestBodyBytes > 0);
  assert.doesNotMatch(JSON.stringify(networkError), /pn_network_secret|must not be logged/);
});

test("debug log records deployment request attempts without including authorization bodies", async () => {
  const events: any[] = [];
  const { PluginClass } = loadPlugin({ requestImpl: async () => ({
    status: 401,
    text: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
    headers: { "content-type": "application/json" },
  }) });
  await assert.rejects(
    PluginClass.__testing.deploymentRequest("https://api.cloudflare.com/client/v4/accounts/private-account/d1/database", { method: "GET", headers: { authorization: "Bearer cf-secret-token" } }, { stage: "resources", debugLog: (entry: any) => events.push(entry), retryDelayMs: 0 }),
    (error: any) => error.code === "CLOUDFLARE_401" && error.providerCode === "10000",
  );
  assert.equal(events[0].type, "request");
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).route, "/client/v4/accounts/:account/d1/database");
  assert.doesNotMatch(JSON.stringify(events), /cf-secret-token|private-account/);
  assert.match(JSON.stringify(events), /Authentication error/);
});

test("write timeouts never retry or adopt late responses; read timeouts retry at most twice", async () => {
  let resolveRequest: (response: any) => void = () => undefined;
  let writes = 0;
  const { PluginClass } = loadPlugin({ requestImpl: () => { writes++; return new Promise((resolve) => { resolveRequest = resolve; }); } });
  let completed = false;
  const pending = PluginClass.__testing.deploymentRequest("https://api.cloudflare.com/client/v4/accounts/a/d1/database", { method: "POST", body: "{}" }, { stage: "database", timeoutMs: 5 }).then(() => { completed = true; });
  await assert.rejects(pending, (error: any) => error.code === "REQUEST_TIMEOUT" && error.outcomeUnknown && !error.retryable);
  resolveRequest({ status: 200, text: '{"success":true,"result":{"uuid":"late"}}' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(completed, false);
  let reads = 0;
  const loaded = loadPlugin({ requestImpl: () => { reads++; return new Promise(() => {}); } });
  await assert.rejects(loaded.PluginClass.__testing.deploymentRequest("https://api.cloudflare.com/client/v4/accounts", {}, { timeoutMs: 5, retryDelayMs: 0 }), (error: any) => error.code === "REQUEST_TIMEOUT" && !error.outcomeUnknown);
  assert.equal(reads, 3);
});

function provisioningFixture(failStage = "", cleanupFails = false) {
  const calls: string[] = [];
  const respond = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname.replace("/client/v4/accounts/account-123", "");
    const method = init.method || "GET";
    calls.push(`${method} ${path}`);
    const failure = () => new Response('{"success":false,"errors":[{"code":1000,"message":"provider detail"}]}', { status: failStage === "unknown_upload" ? 500 : 400 });
    if (method === "DELETE") return cleanupFails && !path.includes("secrets/") ? new Response("Forbidden", { status: 403 }) : path.includes("secrets/") && failStage === "bootstrap_cleanup" ? failure() : jsonResponse({});
    if (path === "/client/v4/accounts") return jsonResponse([{ id: "account-123" }]);
    if (path === "/d1/database") return method === "GET" ? jsonResponse([]) : failStage === "database" ? failure() : jsonResponse({ uuid: "created-db" });
    if (path === "/workers/scripts") return jsonResponse([]);
    if (path === "/workers/subdomain") return failStage === "subdomain" ? failure() : jsonResponse({ subdomain: "example" });
    if (path === "/workers/scripts/publish-note") return ["worker_upload", "unknown_upload"].includes(failStage) ? failure() : jsonResponse({});
    if (path.endsWith("/subdomain")) return failStage === "worker_enable" ? failure() : jsonResponse({ enabled: true });
    if (path.endsWith("/query")) return jsonResponse([{ success: failStage !== "migration" }]);
    if (path === "/healthz") return new Response(JSON.stringify({ status: "ok", service: failStage === "ready_check" ? "wrong-service" : "publish-note", version: "0.3.9" }));
    if (path === "/__internal/provision/initialize") return failStage === "initialize" ? new Response("Claim consumed", { status: 403 }) : new Response('{"publishToken":"pn_test"}', { status: 201 });
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { calls, respond };
}

test("every definite provisioning failure only cleans confirmed resources in dependency order", async () => {
  const stages = ["database", "subdomain", "worker_upload", "worker_enable", "migration", "ready_check", "initialize", "bootstrap_cleanup"];
  for (const stage of stages) {
    const fixture = provisioningFixture(stage);
    const { PluginClass } = loadPlugin({ fetchImpl: fixture.respond });
    await assert.rejects(PluginClass.__testing.provisionPersonalCloudflare("test-token"), (error: any) => error.stage === stage && !error.cleanupIncomplete);
    const deletions = fixture.calls.filter((call) => call.startsWith("DELETE") && !call.includes("secrets/"));
    const expected = stage === "database" ? [] : ["subdomain", "worker_upload"].includes(stage) ? ["DELETE /d1/database/created-db"] : ["DELETE /workers/scripts/publish-note", "DELETE /d1/database/created-db"];
    assert.deepEqual(deletions, expected, stage);
    assert.ok(fixture.calls.filter((call) => call === "POST /__internal/provision/initialize").length <= 1);
  }
});

test("unknown writes and failed cleanup are reported without deleting a possibly active dependency", async () => {
  for (const [stage, cleanupFails] of [["unknown_upload", false], ["migration", true]] as const) {
    const fixture = provisioningFixture(stage, cleanupFails);
    const { PluginClass } = loadPlugin({ fetchImpl: fixture.respond });
    await assert.rejects(PluginClass.__testing.provisionPersonalCloudflare("test-token"), (error: any) => error.cleanupIncomplete && (stage !== "unknown_upload" || error.outcomeUnknown));
    assert.equal(fixture.calls.includes("DELETE /d1/database/created-db"), false);
  }
});

const personalSettings = {
  language: "zh", cloudflareMode: "self", apiBaseUrl: "https://personal.example.test", deploymentWorkerUrl: "https://personal.example.test",
  publishToken: "pn_personal", selfPublishToken: "pn_personal", officialPublishToken: "pn_official", deploymentManaged: false,
  deploymentStatus: "provisioning", lastPublishedUrl: "https://personal.example.test/s/stable/",
};

test("mobile loads legacy and synchronized credentials without loading any deployment dependency", async () => {
  const { PluginClass, dependencies } = loadPlugin({ desktop: false, requestImpl: async () => { throw new Error("No network expected"); } });
  const plugin = new PluginClass({});
  plugin.data = personalSettings;
  await plugin.loadSettings();
  assert.equal(plugin.settings.deploymentStatus, "ready");
  assert.equal(plugin.settings.publishToken, "pn_personal");
  assert.equal(plugin.settings.lastPublishedUrl, personalSettings.lastPublishedUrl);
  await plugin.selectCloudflareMode("official");
  assert.equal(plugin.settings.publishToken, "pn_official");
  assert.equal(await plugin.deployToCloudflare(), true);
  assert.equal(plugin.settings.cloudflareMode, "self");
  assert.deepEqual(dependencies, ["obsidian"]);
  plugin.data = { ...plugin.data, deploymentWorkerUrl: "https://wrong.test", selfPublishToken: "pn_wrong", connectionProfiles: JSON.stringify({ self: { serviceUrl: "https://synced.test", publishToken: "pn_synced" } }) };
  await plugin.onExternalSettingsChange();
  assert.equal(plugin.settings.apiBaseUrl, "https://synced.test");
  assert.equal(plugin.settings.publishToken, "pn_synced");
  plugin.data = { ...plugin.data, connectionProfiles: '{"self":{"serviceUrl":"https://partial.test"}}' };
  await plugin.onExternalSettingsChange();
  assert.equal(plugin.settings.publishToken, "");
  assert.equal(plugin.settings.deploymentStatus, "not_deployed");
});

test("legacy control-plane connections and transient deployment statuses migrate independently", () => {
  const { PluginClass } = loadPlugin({ desktop: false });
  const normalize = PluginClass.__testing.normalizeSettings;
  const legacy = normalize({ deploymentManaged: true, deploymentWorkerUrl: "https://legacy.test", publishToken: "pn_legacy", controlPlaneUrl: "https://old-control.test", deploymentStatus: "authorizing", share_link: "kept" });
  assert.equal(legacy.cloudflareMode, "self");
  assert.equal(legacy.apiBaseUrl, "https://legacy.test");
  assert.equal(legacy.publishToken, "pn_legacy");
  assert.equal(legacy.controlPlaneUrl, undefined);
  assert.equal(legacy.share_link, "kept");
  assert.equal(normalize({ deploymentStatus: "provisioning" }).deploymentStatus, "not_deployed");
});

test("settings changes merge with synchronized connections instead of overwriting them", async () => {
  const { PluginClass } = loadPlugin();
  const plugin = new PluginClass({});
  plugin.data = personalSettings;
  await plugin.loadSettings();
  plugin.data = { ...personalSettings, selfPublishToken: "pn_new", deploymentWorkerUrl: "https://new.test" };
  plugin.settings.language = "en";
  await plugin.saveSettings();
  assert.equal(plugin.data.selfPublishToken, "pn_new");
  assert.equal(plugin.data.deploymentWorkerUrl, "https://new.test");
  assert.equal(plugin.data.language, "en");
  assert.doesNotMatch(JSON.stringify(plugin.data), /provisioning|authorizing/);
});

test("disconnecting stays local, avoids native confirmation, and leaves settings refresh to the view", async () => {
  let confirmationCalls = 0;
  const { PluginClass } = loadPlugin({
    desktop: false,
    windowValue: { confirm: () => { confirmationCalls += 1; return false; } },
  });
  const plugin = new PluginClass({});
  plugin.data = personalSettings;
  await plugin.loadSettings();
  let refreshCalls = 0;
  plugin.refreshSettingTab = () => { refreshCalls += 1; };

  assert.equal(await plugin.disconnectCloudflare(), true);
  assert.equal(confirmationCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(plugin.settings.selfPublishToken, "");
  assert.equal(plugin.settings.deploymentWorkerUrl, "");
  assert.equal(plugin.settings.connectionStatus, "disconnected");
  assert.equal(plugin.settings.deploymentStatus, "not_deployed");
});

test("historical Worker versions are detected and publishing is paused until the Worker is updated", async () => {
  let remoteVersion = "0.3.6";
  const requests: string[] = [];
  const { PluginClass, notices } = loadPlugin({ desktop: false, requestImpl: async ({ url, method }) => {
    requests.push(`${method} ${url}`);
    assert.equal(method, "GET");
    assert.ok(url === "https://publish-note.personal-example.workers.dev/healthz");
    return { status: 200, json: { status: "ok", service: "publish-note", version: remoteVersion } };
  } });
  const plugin = new PluginClass({});
  plugin.data = {
    ...personalSettings,
    apiBaseUrl: "https://note.openstaff.dev",
    deploymentWorkerUrl: "https://publish-note.personal-example.workers.dev",
    deploymentOriginUrl: "https://publish-note.personal-example.workers.dev",
    connectionProfiles: JSON.stringify({ self: { serviceUrl: "https://note.openstaff.dev", publishToken: "pn_personal" } }),
    workerVersion: "",
    workerVersionStatus: "unknown",
    workerVersionCheckedAt: 0,
  };
  await plugin.loadSettings();
  const file = { extension: "md", path: "Note.md", basename: "Note" };
  plugin.app = { vault: { read: async () => "# Note" }, metadataCache: { getFileCache: () => ({ frontmatter: {} }) } };
  plugin.collectShareNotes = async () => [{ file, sourcePath: file.path, title: file.basename, markdown: "# Note" }];
  plugin.collectAssets = async () => [];
  plugin.compileForPublish = async () => ({ formatVersion: 1, sourcePath: "Note.md", title: "Note", pages: [], assets: [] });
  plugin.publishBundle = async () => { throw new Error("publishBundle must not run for an outdated Worker"); };
  await plugin.publishFile(file);
  assert.equal(plugin.settings.workerVersion, remoteVersion);
  assert.equal(plugin.settings.workerVersionStatus, "outdated");
  assert.equal(requests.length, 1);
  assert.match(notices.at(-1) || "", /0\.3\.6/);

  remoteVersion = "0.3.9";
  const current = await plugin.refreshWorkerVersion({ force: true });
  assert.equal(current.status, "current");
  assert.equal(current.version, "0.3.9");
  assert.equal(plugin.settings.workerVersionStatus, "current");
});

test("publishing pins one connection across concurrent sync and does not call Cloudflare OAuth", async () => {
  const requests: Array<{ url: string; token: string }> = [];
  let plugin: any;
  const { PluginClass, dependencies } = loadPlugin({ desktop: false, requestImpl: async ({ url, headers }) => {
    requests.push({ url, token: headers.authorization });
    if (url.endsWith("/healthz")) return { status: 200, json: { status: "ok", service: "publish-note", version: "0.3.9" } };
    assert.ok(url.startsWith("https://personal.example.test/"));
    assert.equal(headers.authorization, "Bearer pn_personal");
    if (url.endsWith("/v1/sites/uploads")) {
      plugin.data = { ...personalSettings, deploymentWorkerUrl: "https://other.test", selfPublishToken: "pn_other" };
      await plugin.onExternalSettingsChange();
      return { status: 200, json: { uploadId: "upload-1" } };
    }
    return { status: 200, json: url.endsWith("/commit") ? { url: "https://personal.example.test/s/stable", siteId: "stable" } : {} };
  } });
  plugin = new PluginClass({});
  plugin.data = personalSettings;
  await plugin.loadSettings();
  const result = await plugin.publishBundle({ formatVersion: 1, sourcePath: "test.md", title: "Test", pages: [{ path: "index.html", body: "<h1>Test</h1>", contentType: "text/html", encoding: "utf8" }], assets: [] }, undefined, "test.md");
  assert.equal(result.siteId, "stable");
  assert.equal(requests.filter((request) => request.url.includes("/v1/")).length, 3);
  assert.equal(plugin.settings.publishToken, "pn_other");
  assert.deepEqual(dependencies, ["obsidian"]);
});

test("official first connection works on desktop and mobile and subsequent selection skips authorization", async () => {
  for (const desktop of [true, false]) {
    const paths: string[] = [];
    const { PluginClass } = loadPlugin({ desktop, openExternal: () => undefined, requestImpl: async ({ url }) => {
      paths.push(url);
      return { status: 200, json: url.endsWith("/start") ? { deviceCode: "test", verificationUrl: "https://official.test/connect", expiresIn: 10 } : { status: "approved", publishToken: "pn_official" } };
    } });
    const plugin = new PluginClass({});
    plugin.data = { ...personalSettings, officialPublishToken: "", officialServiceUrl: "https://official.test" };
    await plugin.loadSettings();
    assert.equal(await plugin.connectAccount(), true);
    assert.equal(plugin.settings.cloudflareMode, "official");
    await plugin.selectCloudflareMode("self");
    assert.equal(await plugin.connectAccount(), true);
    assert.equal(paths.length, 2);
    assert.equal(plugin.settings.apiBaseUrl, "https://official.test");
    assert.equal(plugin.settings.selfPublishToken, "pn_personal");
  }
});

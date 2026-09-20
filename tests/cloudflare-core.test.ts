import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compileNote } from "../src/compiler/site-compiler.ts";
import { createUploadChunks } from "../src/shared/upload-queue.ts";
import { ServiceError } from "../server/core/errors.ts";
import { hashPassword, hmacSha256, verifyPassword } from "../server/core/crypto.ts";
import { PublishService } from "../server/core/service.ts";
import { MemoryStorage } from "../server/storage/memory/index.ts";
import { CloudflareD1R2Storage, type D1DatabaseLike, type D1Statement } from "../server/storage/cloudflare-d1-r2/index.ts";
import { routeRequest } from "../server/worker/routes.ts";

class SqliteD1Statement implements D1Statement {
  private values: unknown[] = [];
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  constructor(statement: ReturnType<DatabaseSync["prepare"]>) { this.statement = statement; }
  bind(...values: unknown[]) { this.values = values; return this; }
  // D1 serializes BLOB reads as number[], unlike node:sqlite's Uint8Array.
  private row(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, field instanceof Uint8Array ? Array.from(field) : field]));
  }
  async first<T = Record<string, unknown>>() { const value = this.statement.get(...this.values); return value ? this.row(value) as T : null; }
  async all<T = Record<string, unknown>>() { return { success: true, results: this.statement.all(...this.values).map((row) => this.row(row)) as T[] }; }
  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  readonly database: DatabaseSync;
  constructor(database = new DatabaseSync(":memory:")) { this.database = database; }
  prepare(sql: string) { return new SqliteD1Statement(this.database.prepare(sql)); }
  async batch(statements: D1Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
  async exec(sql: string) { this.database.exec(sql); }
  close() { this.database.close(); }
}

function createD1OnlyStorage() {
  const database = new SqliteD1Database();
  database.database.exec(readFileSync(new URL("../server/storage/migrations/0001_initial.sql", import.meta.url), "utf8"));
  database.database.exec(readFileSync(new URL("../server/storage/migrations/0002_d1_chunk_bodies.sql", import.meta.url), "utf8"));
  return database;
}

async function connectedService(options: ConstructorParameters<typeof PublishService>[0] = {}) {
  const storage = options.storage || new MemoryStorage();
  const service = new PublishService({ storage, publicBaseUrl: "https://publish.example.com", ...options });
  const registered = await service.register({ email: "owner@example.com", password: "correct horse battery" });
  const login = await service.login({ email: registered.account.email, password: "correct horse battery" });
  return { service, storage, registered, login };
}

test("password hashing stays within the Cloudflare Workers PBKDF2 limit", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.match(stored, /^pbkdf2\$100000\$/);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse battery", stored.replace("$100000$", "$120000$")), false);
});

test("registers accounts with one-time recovery codes and revokes sessions/tokens on recovery", async () => {
  const { service, registered, login } = await connectedService();
  const token = await service.createToken(registered.account.id, "Laptop");
  await service.recover({ email: registered.account.email, recoveryCode: registered.recoveryCode, newPassword: "new correct password" });
  assert.equal(await service.accountForSession(login.session.id), undefined);
  await assert.rejects(() => service.authenticatePublishToken(token.token), (error) => error instanceof ServiceError && error.status === 401);
  await assert.rejects(() => service.recover({ email: registered.account.email, recoveryCode: registered.recoveryCode, newPassword: "another password" }), /Recovery failed/);
});

test("requires and consumes a bootstrap secret exactly once for self-deployed setup", async () => {
  const service = new PublishService({ storage: new MemoryStorage(), publicBaseUrl: "https://worker.example.com", bootstrapSecret: "bootstrap-secret" });
  const first = await service.setup({ bootstrapSecret: "bootstrap-secret", email: "first@example.com", password: "correct horse battery" });
  assert.equal(first.account.email, "first@example.com");
  await assert.rejects(() => service.setup({ bootstrapSecret: "bootstrap-secret", email: "second@example.com", password: "correct horse battery" }), (error) => error instanceof ServiceError && error.status === 403);
  await assert.rejects(() => service.setup({ bootstrapSecret: "wrong", email: "third@example.com", password: "correct horse battery" }), (error) => error instanceof ServiceError && error.status === 403);
});

test("automated Worker provisioning initialization requires a short-lived signed claim and consumes bootstrap once", async () => {
  const storage = new MemoryStorage();
  const service = new PublishService({ storage, publicBaseUrl: "https://worker.example.com", bootstrapSecret: "bootstrap-secret" });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const signature = await hmacSha256("bootstrap-secret", `job-123\n${expiresAt}`);
  const initialized = await service.initializeProvisioning({ provisionSecret: "bootstrap-secret", ownerKey: "job-123", expiresAt, signature });
  assert.match(initialized.publishToken, /^pn_/);
  const auth = await service.authenticatePublishToken(initialized.publishToken);
  assert.equal(auth.account.email, "owner-job-123@selfhosted.publish-note.invalid");
  await assert.rejects(() => service.initializeProvisioning({ provisionSecret: "bootstrap-secret", ownerKey: "job-123", expiresAt, signature }), (error) => error instanceof ServiceError && error.status === 403);
  await assert.rejects(() => service.initializeProvisioning({ provisionSecret: "bootstrap-secret", ownerKey: "job-456", expiresAt, signature }), (error) => error instanceof ServiceError && error.status === 403);
});

test("Worker reconnection reuses the historical personal account after bootstrap is consumed", async () => {
  const storage = new MemoryStorage();
  const service = new PublishService({ storage, publicBaseUrl: "https://worker.example.com", bootstrapSecret: "bootstrap-secret" });
  const firstExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const firstSignature = await hmacSha256("bootstrap-secret", `job-123\n${firstExpiresAt}`);
  const initialized = await service.initializeProvisioning({ provisionSecret: "bootstrap-secret", ownerKey: "job-123", expiresAt: firstExpiresAt, signature: firstSignature });
  const reconnectExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const reconnectSignature = await hmacSha256("bootstrap-secret", `job-reconnect\n${reconnectExpiresAt}`);
  const reconnected = await service.reconnectProvisioning({ provisionSecret: "bootstrap-secret", ownerKey: "job-reconnect", expiresAt: reconnectExpiresAt, signature: reconnectSignature });
  assert.equal(reconnected.accountId, (await service.authenticatePublishToken(initialized.publishToken)).account.id);
  assert.match(reconnected.publishToken, /^pn_/);
});

test("Worker provisioning initialization returns JSON errors instead of an HTML error page", async () => {
  const service = new PublishService({ storage: new MemoryStorage(), publicBaseUrl: "https://worker.example.com", bootstrapSecret: "bootstrap-secret" });
  const response = await routeRequest({
    service,
    request: new Request("https://worker.example.com/__internal/provision/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" }),
    env: {},
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "Invalid JSON", code: "BAD_REQUEST" });
});

test("device authorization creates a publish token once and stores only token metadata", async () => {
  const { service, registered, login } = await connectedService();
  const device = await service.startDeviceAuthorization();
  assert.match(device.verificationUrl, /\/connect\?code=/);
  await service.approveDeviceAuthorization({ account: registered.account }, device.deviceCode, "Obsidian plugin");
  const approved = await service.pollDeviceAuthorization(device.deviceCode);
  assert.equal(approved.status, "approved");
  assert.match(approved.publishToken || "", /^pn_/);
  const repeated = await service.pollDeviceAuthorization(device.deviceCode);
  assert.equal(repeated.status, "expired");
  const tokens = await service.listTokens(login);
  assert.equal(tokens.length, 1);
  assert.equal("tokenHash" in tokens[0], false);
});

test("uploads independent binary base64 chunks, commits atomically, and serves the current revision", async () => {
  const { service, registered } = await connectedService();
  const issued = await service.createToken(registered.account.id, "Obsidian");
  const auth = await service.authenticatePublishToken(issued.token);
  const bundle = compileNote({ sourcePath: "Notes/Binary.md", markdown: "# Binary", assets: [{ sourcePath: "image.bin", path: "assets/image.bin", contentType: "application/octet-stream", body: "AAECAwQFBgcICQ==", encoding: "base64" }] });
  const chunks = createUploadChunks(bundle, 3);
  assert.ok(chunks.filter((chunk) => chunk.encoding === "base64").every((chunk) => /^[A-Za-z0-9+/]*={0,2}$/.test(chunk.body)));
  const started = await service.startUpload(auth, { siteId: undefined, idempotencyKey: "binary-1", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 2, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
  for (const chunk of chunks) await service.uploadChunk(auth, { uploadId: started.uploadId, ...chunk });
  const result = await service.commitUpload(auth, started.uploadId);
  assert.equal(result.url, `https://publish.example.com/s/${result.siteId}`);
  assert.deepEqual(result.uploadedPaths, ["assets/image.bin", "index.html"]);
  const viewer = await service.viewer(result.siteId, "assets/image.bin");
  assert.deepEqual([...((viewer?.chunks || []).flatMap((chunk) => [...chunk]))], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("uses the request origin when a Worker is reached through a custom domain", async () => {
  const { service, registered } = await connectedService();
  const auth = await service.authenticatePublishToken((await service.createToken(registered.account.id)).token);
  const bundle = compileNote({ sourcePath: "custom-domain.md", markdown: "# Custom domain" });
  const chunks = createUploadChunks(bundle);
  const started = await service.startUpload(auth, { idempotencyKey: "custom-domain", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 1, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
  for (const chunk of chunks) await service.uploadChunk(auth, { uploadId: started.uploadId, ...chunk });
  const result = await service.commitUpload(auth, started.uploadId, "https://notes.example.com");
  assert.equal(result.url, `https://notes.example.com/s/${result.siteId}`);
});

test("D1-only storage persists chunks as D1 BLOBs without an R2 binding", async () => {
  const database = createD1OnlyStorage();
  try {
    const storage = new CloudflareD1R2Storage(database);
    const { service, registered } = await connectedService({ storage });
    const issued = await service.createToken(registered.account.id, "Obsidian");
    const auth = await service.authenticatePublishToken(issued.token);
    const bundle = compileNote({ sourcePath: "Notes/D1-only.md", markdown: "# D1 only", assets: [{ sourcePath: "image.bin", path: "assets/image.bin", contentType: "application/octet-stream", body: "AAECAwQFBgcICQ==", encoding: "base64" }] });
    const chunks = createUploadChunks(bundle, 3);
    const started = await service.startUpload(auth, { idempotencyKey: "d1-only-1", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 2, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
    for (const chunk of chunks) await service.uploadChunk(auth, { uploadId: started.uploadId, ...chunk });
    const result = await service.commitUpload(auth, started.uploadId);
    const viewer = await service.viewer(result.siteId, "assets/image.bin");
    const viewed: number[] = [];
    for await (const chunk of viewer?.chunks || []) viewed.push(...chunk);
    assert.deepEqual(viewed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const stored = database.database.prepare("SELECT data FROM object_chunks WHERE site_id = ?").all(result.siteId) as Array<{ data: Uint8Array }>;
    assert.ok(stored.length > 0);
    assert.ok(stored.every((row) => row.data instanceof Uint8Array));
  } finally {
    database.close();
  }
});

test("D1 array BLOBs support HTTP commit, duplicate chunks, binary viewers and stable-link updates", async () => {
  const database = createD1OnlyStorage();
  try {
    const storage = new CloudflareD1R2Storage(database);
    const { service, registered } = await connectedService({ storage });
    const issued = await service.createToken(registered.account.id, "Obsidian");
    const post = (path: string, body: unknown) => routeRequest({ service, env: {}, request: new Request(`https://publish.example.com${path}`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }) });
    const get = (path: string) => routeRequest({ service, env: {}, request: new Request(`https://publish.example.com${path}`) });
    let siteId: string | undefined;
    let stableUrl: string | undefined;
    for (const revision of [1, 2]) {
      const binary = new Uint8Array([0, 127, 128, 254, 255, revision]);
      const bundle = compileNote({ sourcePath: "Notes/D1.md", markdown: `# D1 第 ${revision} 版`, assets: [
        { sourcePath: "image.bin", path: "assets/image.bin", contentType: "application/octet-stream", body: Buffer.from(binary).toString("base64"), encoding: "base64" },
        { sourcePath: "empty.bin", path: "assets/empty.bin", contentType: "application/octet-stream", body: "", encoding: "base64" },
      ] });
      const chunks = createUploadChunks(bundle);
      assert.equal(chunks.length, 3);
      const started = await post("/v1/sites/uploads", { siteId, idempotencyKey: `d1-http-${revision}`, formatVersion: 1, chunkProtocolVersion: 2,
        sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 3, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
      assert.equal(started.status, 200);
      const { uploadId } = await started.json();
      for (const chunk of chunks) {
        const uploaded = await post(`/v1/uploads/${uploadId}/chunks`, chunk);
        assert.equal(uploaded.status, 200);
        const duplicate = await post(`/v1/uploads/${uploadId}/chunks`, chunk);
        assert.equal(duplicate.status, 200);
        assert.deepEqual(await duplicate.json(), await uploaded.json());
      }
      const stored = await database.prepare("SELECT data FROM upload_chunks WHERE upload_id = ?").bind(uploadId).all();
      assert.ok(stored.results.every((row) => Array.isArray(row.data)), "fixture must reproduce the Workers D1 BLOB read contract");
      const committed = await post(`/v1/uploads/${uploadId}/commit`, {});
      const result = await committed.json();
      assert.equal(committed.status, 200, JSON.stringify(result));
      assert.equal(result.revision, revision);
      if (siteId) { assert.equal(result.siteId, siteId); assert.equal(result.url, stableUrl); }
      siteId = result.siteId;
      stableUrl = result.url;
      assert.deepEqual(await (await post(`/v1/uploads/${uploadId}/commit`, {})).json(), result);
      const page = await get(`/s/${siteId}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), new RegExp(`D1 第 ${revision} 版`));
      const asset = await get(`/s/${siteId}/assets/image.bin`);
      assert.equal(asset.status, 200);
      assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), binary);
      assert.equal((await (await get(`/s/${siteId}/assets/empty.bin`)).arrayBuffer()).byteLength, 0);
      if (revision === 2) {
        const revisions = database.database.prepare("SELECT revision FROM revisions WHERE site_id = ?").all(siteId);
        assert.deepEqual(revisions.map((row) => row.revision), [2]);
      }
    }
  } finally { database.close(); }
});

test("D1 BLOB decoding accepts byte containers but rejects missing or coercible invalid bytes", async () => {
  const database = createD1OnlyStorage();
  try {
    const storage = new CloudflareD1R2Storage(database);
    const { service, registered } = await connectedService({ storage });
    const auth = await service.authenticatePublishToken((await service.createToken(registered.account.id)).token);
    const started = await service.startUpload(auth, { idempotencyKey: "blob-validation", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: "one.md", title: "One", chunkCount: 1, objectCount: 1, totalBytes: 3 });
    await service.uploadChunk(auth, { uploadId: started.uploadId, chunkProtocolVersion: 2, kind: "page", path: "index.html", contentType: "text/html", encoding: "utf8", chunkIndex: 0, chunkCount: 1, byteLength: 3, body: "abc" });
    const objectId = (await storage.listUploadObjects(started.uploadId))[0].objectId;
    const prepare = database.prepare.bind(database);
    let blob: unknown;
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("SELECT * FROM upload_chunks")) statement.all = async () => ({ success: true, results: [{ data: blob, chunk_index: 0, byte_length: 3 }] as any });
      return statement;
    };
    for (const value of [[0, 128, 255], new Uint8Array([0, 128, 255]), new Uint8Array([0, 128, 255]).buffer, new DataView(new Uint8Array([9, 0, 128, 255, 9]).buffer, 1, 3)]) {
      blob = value;
      assert.deepEqual([...(await storage.listUploadChunks(started.uploadId, objectId))[0].bytes], [0, 128, 255]);
    }
    for (const value of [null, undefined, "abc", [-1], [256], [1.5], [NaN], ["1"], [null], new Array(1)]) {
      blob = value;
      await assert.rejects(() => storage.listUploadChunks(started.uploadId, objectId), (error) => error instanceof ServiceError && error.status === 500);
    }
  } finally { database.close(); }
});

test("allows content above the former account quota and preserves account isolation", async () => {
  const storage = new MemoryStorage();
  const service = new PublishService({ storage, publicBaseUrl: "https://publish.example.com" });
  const one = await service.register({ email: "one@example.com", password: "correct horse battery" });
  const two = await service.register({ email: "two@example.com", password: "correct horse battery" });
  const oneLogin = await service.login({ email: one.account.email, password: "correct horse battery" });
  const twoLogin = await service.login({ email: two.account.email, password: "correct horse battery" });
  const oneToken = await service.createToken(one.account.id);
  const twoToken = await service.createToken(two.account.id);
  const oneAuth = await service.authenticatePublishToken(oneToken.token);
  const twoAuth = await service.authenticatePublishToken(twoToken.token);
  const formerAccountQuotaBytes = 50 * 1024 * 1024;
  const bundle = compileNote({ sourcePath: "one.md", markdown: `# larger than the former quota\n\n${"x".repeat(formerAccountQuotaBytes + 1)}` });
  const chunks = createUploadChunks(bundle);
  const start = await service.startUpload(oneAuth, { idempotencyKey: "above-former-quota", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 1, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
  for (const chunk of chunks) await service.uploadChunk(oneAuth, { uploadId: start.uploadId, ...chunk });
  const first = await service.commitUpload(oneAuth, start.uploadId);
  const small = compileNote({ sourcePath: "one.md", markdown: "x" });
  const smallChunks = createUploadChunks(small);
  const second = await service.startUpload(oneAuth, { idempotencyKey: "second-site", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: "second.md", title: "Second", chunkCount: 1, objectCount: 1, totalBytes: 1 });
  assert.notEqual(second.siteId, first.siteId);
  await assert.rejects(() => service.startUpload(twoAuth, { siteId: first.siteId, idempotencyKey: "cross-account", formatVersion: 1, chunkProtocolVersion: 2, sourcePath: small.sourcePath, title: small.title, chunkCount: smallChunks.length, objectCount: 1, totalBytes: 1 }), (error) => error instanceof ServiceError && error.status === 404);
  await assert.rejects(() => service.deleteSite(twoLogin, first.siteId), (error) => error instanceof ServiceError && error.status === 404);
  assert.equal((await service.listSites(oneLogin.account.id)).length, 1);
  await service.deleteSite(oneLogin, first.siteId);
  assert.equal((await service.listSites(oneLogin.account.id)).length, 0);
  assert.equal(await service.viewer(first.siteId, "index.html"), undefined);
});

test("publishes more than ten notes because there is no site-count limit", async () => {
  const { service, registered } = await connectedService();
  const auth = await service.authenticatePublishToken((await service.createToken(registered.account.id)).token);
  for (let index = 1; index <= 11; index += 1) {
    const bundle = compileNote({ sourcePath: `note-${index}.md`, markdown: `# Note ${index}` });
    const chunks = createUploadChunks(bundle);
    const started = await service.startUpload(auth, { idempotencyKey: `no-site-count-limit-${index}`, formatVersion: 1, chunkProtocolVersion: 2, sourcePath: bundle.sourcePath, title: bundle.title, chunkCount: chunks.length, objectCount: 1, totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0) });
    for (const chunk of chunks) await service.uploadChunk(auth, { uploadId: started.uploadId, ...chunk });
    await service.commitUpload(auth, started.uploadId);
  }
  assert.equal((await service.listSites(registered.account.id)).length, 11);
});

test("Worker router returns safe JSON errors and streams viewer chunks", async () => {
  const { service, registered } = await connectedService();
  const unauthorized = await routeRequest({ service, request: new Request("https://publish.example.com/v1/me"), env: {} });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "Sign in required", code: "UNAUTHORIZED" });
  const health = await routeRequest({ service, request: new Request("https://publish.example.com/healthz"), env: {} });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "publish-note", version: "unknown", storage: "cloudflare-d1" });
  const versionedHealth = await routeRequest({ service, request: new Request("https://publish.example.com/healthz"), env: { PUBLISH_NOTE_VERSION: "0.3.8" } });
  assert.deepEqual(await versionedHealth.json(), { status: "ok", service: "publish-note", version: "0.3.8", storage: "cloudflare-d1" });
  assert.equal(registered.account.email, "owner@example.com");
});

test("Worker auth routes issue a session cookie and keep console account data scoped", async () => {
  const service = new PublishService({ storage: new MemoryStorage(), publicBaseUrl: "https://publish.example.com" });
  const registered = await routeRequest({ service, request: new Request("https://publish.example.com/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "route@example.com", password: "correct horse battery" }) }), env: {} });
  assert.equal(registered.status, 201);
  const login = await routeRequest({ service, request: new Request("https://publish.example.com/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "route@example.com", password: "correct horse battery" }) }), env: {} });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie || "", /pn_session=/);
  const me = await routeRequest({ service, request: new Request("https://publish.example.com/v1/me", { headers: { cookie: cookie || "" } }), env: {} });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.email, "route@example.com");
});

test("D1 migration contains the tenant, revision, upload, auth, and bootstrap entities", () => {
  const migration = readFileSync(new URL("../server/storage/migrations/0001_initial.sql", import.meta.url), "utf8");
  for (const table of ["accounts", "sessions", "tokens", "sites", "revisions", "objects", "object_chunks", "uploads", "upload_objects", "device_authorizations", "recovery_codes"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS bootstrap_state/);
  assert.match(migration, /UNIQUE \(account_id, idempotency_key\)/);
  const d1OnlyMigration = readFileSync(new URL("../server/storage/migrations/0002_d1_chunk_bodies.sql", import.meta.url), "utf8");
  assert.match(d1OnlyMigration, /ALTER TABLE object_chunks ADD COLUMN data BLOB/);
  assert.match(d1OnlyMigration, /ALTER TABLE upload_chunks ADD COLUMN data BLOB/);
});

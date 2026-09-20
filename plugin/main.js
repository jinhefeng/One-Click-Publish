const { Plugin, Notice, PluginSettingTab, Setting, requestUrl, openExternal: obsidianOpenExternal, MarkdownRenderer, Component, Platform } = require("obsidian");

function openExternalUrl(url) {
  if (typeof obsidianOpenExternal === "function") return obsidianOpenExternal(url);
  try {
    const electron = require("electron");
    if (typeof electron?.shell?.openExternal === "function") return electron.shell.openExternal(url);
  } catch {
    // Mobile builds do not expose Electron. Use the browser fallback below.
  }
  if (typeof window !== "undefined" && typeof window.open === "function") return window.open(url, "_blank");
  throw new Error("Unable to open an external browser window.");
}

async function copyTextToClipboard(value) {
  const text = String(value || "");
  if (!text) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy document command used by some Obsidian views.
    }
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const parent = document.body || document.documentElement;
  if (!parent) return false;
  parent.appendChild(textarea);
  textarea.select();
  let copied = false;
  try { copied = typeof document.execCommand === "function" && document.execCommand("copy"); } catch { copied = false; }
  textarea.remove();
  return copied;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceKey(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
}

function requestErrorDetail(response) {
  try {
    const payload = response?.json;
    if (payload && typeof payload === "object") {
      const detail = payload.error || payload.message || payload.error_description;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    }
  } catch {
    // Fall through to the raw response body.
  }
  const raw = String(response?.text || response?.body || response?.response?.text || response?.responseText || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error || parsed?.message || raw);
  } catch {
    return raw;
  }
}

function sanitizeExternalMessage(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9._~-]{24,}\b/gi, "[redacted]")
    .replace(/\b(?:secret|token|password|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|code[_ -]?verifier|bootstrap)[-_A-Za-z0-9./=]{0,120}\b/gi, "[redacted]");
  text = text.slice(0, 320).trim();
  return text === "[redacted]" || !text ? "" : text;
}

function sanitizeProviderCode(value) {
  const code = String(value || "").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : "";
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return String(response.headers.get(name) || "");
  const headers = response?.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || "");
}

function safeEndpointOrigin(value) {
  try { return new URL(String(value || "")).origin; } catch { return ""; }
}

function requestTransportDetails(error) {
  const source = error?.cause || error;
  return {
    errorName: sanitizeProviderCode(source?.name),
    errorCode: sanitizeProviderCode(source?.code || source?.errno || source?.cause?.code),
    errorMessage: sanitizeExternalMessage(source?.message),
  };
}

function utf8ByteLength(value) {
  try { return typeof TextEncoder === "function" ? new TextEncoder().encode(String(value || "")).byteLength : String(value || "").length; } catch { return 0; }
}

function responsePreview(response) {
  const raw = String(typeof response?.text === "string" ? response.text : typeof response?.body === "string" ? response.body : "").trim();
  if (!raw) return "";
  const plain = raw.replace(/<[^>]*>/g, " ").replace(/&(?:lt|gt|amp|quot|#39);/g, " ").replace(/\s+/g, " ").trim();
  return sanitizeExternalMessage(plain).slice(0, 160);
}

function externalErrorDetails(payload, response, parsed = true, cause) {
  const firstError = Array.isArray(payload?.errors) ? payload.errors.find((item) => item && typeof item === "object") : void 0;
  const messages = [
    ...(Array.isArray(payload?.errors) ? payload.errors.map((item) => item?.message) : []),
    ...(Array.isArray(payload?.messages) ? payload.messages.map((item) => item?.message || item) : []),
    payload?.error_description,
    typeof payload?.error === "string" ? payload.error : payload?.error?.message,
    payload?.message,
    cause?.message,
  ].map(sanitizeExternalMessage).filter(Boolean);
  const status = Number(response?.status || cause?.status || cause?.statusCode || 0);
  const contentType = responseHeader(response, "content-type");
  const preview = responsePreview(response);
  const providerMessage = messages[0]
    || (!parsed && status ? `Cloudflare returned a non-JSON error response${preview ? `: ${preview}` : ""}.` : "");
  return {
    httpStatus: status,
    providerCode: sanitizeProviderCode(firstError?.code ?? payload?.error?.code ?? payload?.code ?? (typeof payload?.error === "string" ? payload.error : "")),
    providerMessage,
    responseContentType: contentType,
  };
}

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_OAUTH_BASE_URL = "https://dash.cloudflare.com";
// Cloudflare's public desktop flow is Authorization Code + PKCE; no client secret is shipped.
const CLOUDFLARE_OAUTH_CLIENT_ID = "be8c51bb93410da71562848331e34657";
const CLOUDFLARE_OAUTH_REDIRECT_URI = "http://127.0.0.1:8976/oauth/callback";
const CLOUDFLARE_OAUTH_SCOPE = "account-settings.read workers-scripts.write d1.write";
const CLOUDFLARE_DOMAIN_OAUTH_SCOPE = "account-settings.read workers-scripts.write workers-routes.write zone.read";
const CLOUDFLARE_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const CLOUDFLARE_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
const CLOUDFLARE_RESOURCE_PREFIX = "publish-note";

const DEFAULT_UPLOAD_CHUNK_BYTES = 1_000_000;
const DEFAULT_UPLOAD_CHUNK_CHARACTERS = DEFAULT_UPLOAD_CHUNK_BYTES;
const uploadTextEncoder = typeof TextEncoder === "function"
  ? new TextEncoder()
  : { encode(value) { const bytes = []; for (const character of value) { const encoded = encodeURIComponent(character); if (encoded.startsWith("%")) { for (const part of encoded.slice(1).split("%")) bytes.push(Number.parseInt(part, 16)); } else bytes.push(character.charCodeAt(0)); } return Uint8Array.from(bytes); } };

// Replaced by scripts/build-plugin.mjs so the released plugin stays self-contained.
const EMBEDDED_TARGET_PLUGIN_VERSION = "0.3.9";
const EMBEDDED_TARGET_ARTIFACT_HASH = "5e10a606887feac7";
const EMBEDDED_TARGET_WORKER_MODULE = "// src/shared/paths.ts\nfunction normalizeRelativePath(input) {\n  const normalized = input.replaceAll(\"\\\\\", \"/\").replace(/^\\/+/, \"\");\n  if (!normalized || normalized === \".\") {\n    return \"index.html\";\n  }\n  const parts = normalized.split(\"/\");\n  if (parts.some((part) => part === \"..\" || part === \".\" || part === \"\")) {\n    throw new Error(`Invalid relative path: ${input}`);\n  }\n  return parts.join(\"/\");\n}\nfunction siteUrl(siteId, baseUrl = \"https://share.example.com\") {\n  return `${baseUrl.replace(/\\/$/, \"\")}/s/${encodeURIComponent(siteId)}`;\n}\nfunction viewerPath(siteId, requestPath) {\n  const prefix = `/s/${encodeURIComponent(siteId)}`;\n  const withoutPrefix = requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : requestPath;\n  let path = withoutPrefix.replace(/^\\/+/, \"\");\n  try {\n    path = decodeURIComponent(path);\n  } catch {\n  }\n  return normalizeRelativePath(path || \"index.html\");\n}\n\n// server/core/errors.ts\nvar ServiceError = class extends Error {\n  status;\n  code;\n  constructor(status, code, message) {\n    super(message);\n    this.name = \"ServiceError\";\n    this.status = status;\n    this.code = code;\n  }\n};\nfunction asServiceError(error) {\n  if (error instanceof ServiceError) return error;\n  return new ServiceError(400, \"BAD_REQUEST\", error instanceof Error ? error.message : \"Bad request\");\n}\nfunction jsonError(error) {\n  const normalized = asServiceError(error);\n  const safeMessage = normalized.status >= 500 ? \"Internal server error\" : normalized.message;\n  return new Response(JSON.stringify({ error: safeMessage, code: normalized.code }), {\n    status: normalized.status,\n    headers: { \"content-type\": \"application/json; charset=utf-8\" }\n  });\n}\n\n// server/core/crypto.ts\nfunction runtimeCrypto() {\n  const value = globalThis.crypto;\n  if (!value?.subtle || !value?.getRandomValues) throw new Error(\"Web Crypto is unavailable\");\n  return value;\n}\nfunction randomId(byteLength = 18) {\n  const bytes = new Uint8Array(byteLength);\n  runtimeCrypto().getRandomValues(bytes);\n  let binary = \"\";\n  for (const byte of bytes) binary += String.fromCharCode(byte);\n  return btoa(binary).replaceAll(\"+\", \"-\").replaceAll(\"/\", \"_\").replace(/=+$/, \"\");\n}\nfunction randomSecret(prefix = \"\", byteLength = 32) {\n  return `${prefix}${randomId(byteLength)}`;\n}\nasync function sha256(value) {\n  const bytes = new TextEncoder().encode(value);\n  const digest = new Uint8Array(await runtimeCrypto().subtle.digest(\"SHA-256\", bytes));\n  let binary = \"\";\n  for (const byte of digest) binary += String.fromCharCode(byte);\n  return btoa(binary).replaceAll(\"+\", \"-\").replaceAll(\"/\", \"_\").replace(/=+$/, \"\");\n}\nasync function hmacSha256(secret, value) {\n  const crypto = runtimeCrypto();\n  const key = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(secret), { name: \"HMAC\", hash: \"SHA-256\" }, false, [\"sign\"]);\n  const signature = new Uint8Array(await crypto.subtle.sign(\"HMAC\", key, new TextEncoder().encode(value)));\n  let binary = \"\";\n  for (const byte of signature) binary += String.fromCharCode(byte);\n  return btoa(binary).replaceAll(\"+\", \"-\").replaceAll(\"/\", \"_\").replace(/=+$/, \"\");\n}\nvar MAX_PBKDF2_ITERATIONS = 1e5;\nasync function hashPassword(password, salt = randomSecret(\"\", 16), iterations = MAX_PBKDF2_ITERATIONS) {\n  const crypto = runtimeCrypto();\n  const key = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(password), \"PBKDF2\", false, [\"deriveBits\"]);\n  const bits = await crypto.subtle.deriveBits({ name: \"PBKDF2\", salt: new TextEncoder().encode(salt), iterations, hash: \"SHA-256\" }, key, 256);\n  let binary = \"\";\n  for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);\n  return `pbkdf2$${iterations}$${salt}$${btoa(binary)}`;\n}\nasync function verifyPassword(password, stored) {\n  const [scheme, iterationText, salt, expected] = stored.split(\"$\");\n  const iterations = Number(iterationText);\n  if (scheme !== \"pbkdf2\" || !iterationText || !salt || !expected || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) return false;\n  const actual = await hashPassword(password, salt, iterations);\n  return constantTimeEqual(actual, stored);\n}\nfunction constantTimeEqual(left, right) {\n  if (left.length !== right.length) return false;\n  let different = 0;\n  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);\n  return different === 0;\n}\nfunction normalizeEmail(email) {\n  return String(email || \"\").trim().toLowerCase();\n}\nfunction normalizePassword(password) {\n  return String(password || \"\");\n}\nfunction normalizeTokenName(name) {\n  return String(name || \"\").trim().slice(0, 100) || \"Obsidian plugin\";\n}\nfunction recoveryCode() {\n  const value = randomId(12).toUpperCase();\n  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;\n}\n\n// server/core/service.ts\nvar UPLOAD_TTL_MS = 24 * 60 * 60 * 1e3;\nvar SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;\nvar DEVICE_TTL_MS = 10 * 60 * 1e3;\nvar PublishService = class {\n  storage;\n  now;\n  publicBaseUrl;\n  bootstrapSecret;\n  constructor(config) {\n    this.storage = config.storage;\n    this.now = config.now ?? (() => /* @__PURE__ */ new Date());\n    this.publicBaseUrl = String(config.publicBaseUrl || \"\").replace(/\\/$/, \"\");\n    this.bootstrapSecret = config.bootstrapSecret;\n  }\n  currentIso() {\n    return this.now().toISOString();\n  }\n  async register(input) {\n    const email = normalizeEmail(input.email);\n    const password = normalizePassword(input.password);\n    validateEmail(email);\n    validatePassword(password);\n    if (await this.storage.getAccountByEmail(email)) throw new ServiceError(409, \"CONFLICT\", \"Registration unavailable\");\n    const account = { id: randomId(18), email, passwordHash: await hashPassword(password), createdAt: this.currentIso() };\n    const plainRecoveryCode = recoveryCode();\n    const recovery = { id: randomId(16), accountId: account.id, codeHash: await sha256(plainRecoveryCode), createdAt: account.createdAt };\n    await this.storage.createAccount(account, recovery);\n    return { account, recoveryCode: plainRecoveryCode };\n  }\n  async login(input) {\n    const account = await this.storage.getAccountByEmail(normalizeEmail(input.email));\n    if (!account || !await verifyPassword(normalizePassword(input.password), account.passwordHash)) {\n      throw new ServiceError(401, \"UNAUTHORIZED\", \"Invalid email or password\");\n    }\n    const session = {\n      id: randomSecret(\"\", 32),\n      accountId: account.id,\n      createdAt: this.currentIso(),\n      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS).toISOString()\n    };\n    await this.storage.createSession(session);\n    return { account, session };\n  }\n  async accountForSession(sessionId) {\n    if (!sessionId) return void 0;\n    const session = await this.storage.getSession(sessionId);\n    if (!session) return void 0;\n    if (Date.parse(session.expiresAt) <= this.now().getTime()) {\n      await this.storage.deleteSession(session.id);\n      return void 0;\n    }\n    const account = await this.storage.getAccount(session.accountId);\n    return account ? { account } : void 0;\n  }\n  async logout(sessionId) {\n    if (sessionId) await this.storage.deleteSession(sessionId);\n  }\n  async recover(input) {\n    const account = await this.storage.getAccountByEmail(normalizeEmail(input.email));\n    const newPassword = normalizePassword(input.newPassword);\n    validatePassword(newPassword);\n    if (!account) throw new ServiceError(401, \"UNAUTHORIZED\", \"Recovery failed\");\n    const codeHash = await sha256(String(input.recoveryCode || \"\").trim().toUpperCase());\n    const consumed = await this.storage.consumeRecoveryCode(account.id, codeHash, this.currentIso());\n    if (!consumed) throw new ServiceError(401, \"UNAUTHORIZED\", \"Recovery failed\");\n    await this.storage.updateAccountPassword(account.id, await hashPassword(newPassword));\n    await this.storage.revokeAccountSessions(account.id);\n    await this.storage.revokeAccountTokens(account.id, this.currentIso());\n  }\n  async authenticatePublishToken(value) {\n    const token = String(value || \"\");\n    if (!token.startsWith(\"pn_\")) throw new ServiceError(401, \"UNAUTHORIZED\", \"Unauthorized\");\n    const record = await this.storage.getTokenByHash(await sha256(token));\n    if (!record || record.revokedAt || record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {\n      throw new ServiceError(401, \"UNAUTHORIZED\", \"Unauthorized\");\n    }\n    const account = await this.storage.getAccount(record.accountId);\n    if (!account) throw new ServiceError(401, \"UNAUTHORIZED\", \"Unauthorized\");\n    await this.storage.touchToken(record.id, this.currentIso());\n    return { account, token: record };\n  }\n  async createToken(accountId, name = \"Obsidian plugin\", expiresAt) {\n    const account = await this.storage.getAccount(accountId);\n    if (!account) throw new ServiceError(401, \"UNAUTHORIZED\", \"Unauthorized\");\n    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid token expiry\");\n    const token = randomSecret(\"pn_\", 32);\n    const record = {\n      id: randomId(16),\n      accountId,\n      name: normalizeTokenName(name),\n      tokenHash: await sha256(token),\n      scope: \"publish:write\",\n      createdAt: this.currentIso(),\n      expiresAt\n    };\n    await this.storage.createToken(record);\n    return { token, view: tokenView(record) };\n  }\n  async listTokens(context) {\n    return (await this.storage.listTokens(context.account.id)).map(tokenView);\n  }\n  async revokeToken(context, tokenId) {\n    if (!await this.storage.revokeToken(context.account.id, tokenId, this.currentIso())) throw new ServiceError(404, \"NOT_FOUND\", \"Token not found\");\n  }\n  async startDeviceAuthorization() {\n    const deviceCode = randomSecret(\"\", 24);\n    const createdAt = this.currentIso();\n    const expiresAt = new Date(this.now().getTime() + DEVICE_TTL_MS).toISOString();\n    const record = { id: randomId(16), deviceCodeHash: await sha256(deviceCode), status: \"pending\", createdAt, expiresAt };\n    await this.storage.createDeviceAuthorization(record);\n    return { deviceCode, verificationUrl: `${this.publicBaseUrl}/connect?code=${encodeURIComponent(deviceCode)}`, expiresIn: DEVICE_TTL_MS / 1e3, interval: 2 };\n  }\n  async approveDeviceAuthorization(context, deviceCode, tokenName) {\n    const hash = await sha256(String(deviceCode || \"\"));\n    const ok = await this.storage.approveDeviceAuthorization(hash, context.account.id, \"\", normalizeTokenName(tokenName || \"Obsidian plugin\"), this.currentIso());\n    if (!ok) throw new ServiceError(400, \"BAD_REQUEST\", \"Device code is invalid, expired, or already used\");\n  }\n  async pollDeviceAuthorization(deviceCode) {\n    const hash = await sha256(String(deviceCode || \"\"));\n    const current = await this.storage.getDeviceAuthorization(hash);\n    if (!current) return { status: \"expired\" };\n    if (Date.parse(current.expiresAt) <= this.now().getTime()) return { status: \"expired\" };\n    if (current.status !== \"approved\") return { status: current.status };\n    const approved = await this.storage.consumeApprovedDeviceAuthorization(hash);\n    if (!approved?.accountId) return { status: approved?.status || \"expired\" };\n    const issued = await this.createToken(approved.accountId, approved.tokenName || \"Obsidian plugin\");\n    return { status: \"approved\", publishToken: issued.token };\n  }\n  async setup(input) {\n    if (!this.bootstrapSecret || input.bootstrapSecret !== this.bootstrapSecret || await this.storage.isBootstrapConsumed()) {\n      throw new ServiceError(403, \"FORBIDDEN\", \"Bootstrap is unavailable\");\n    }\n    const result = await this.register({ email: input.email, password: input.password });\n    if (!await this.storage.consumeBootstrap(this.currentIso())) {\n      await this.storage.deleteAccount(result.account.id);\n      throw new ServiceError(409, \"CONFLICT\", \"Bootstrap is unavailable\");\n    }\n    return result;\n  }\n  async initializeProvisioning(input) {\n    const expiresAt = Date.parse(String(input.expiresAt || \"\"));\n    if (!this.bootstrapSecret || input.provisionSecret !== this.bootstrapSecret || await this.storage.isBootstrapConsumed() || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime() || expiresAt > this.now().getTime() + 10 * 60 * 1e3) {\n      throw new ServiceError(403, \"FORBIDDEN\", \"Provisioning is unavailable\");\n    }\n    const ownerKey = String(input.ownerKey || \"\").trim();\n    if (!ownerKey || !input.signature || !constantTimeEqual(await hmacSha256(this.bootstrapSecret, `${ownerKey}\n${input.expiresAt}`), String(input.signature))) {\n      throw new ServiceError(403, \"FORBIDDEN\", \"Provisioning is unavailable\");\n    }\n    const suffix = ownerKey.replace(/[^A-Za-z0-9_-]/g, \"\").slice(0, 48) || randomId(8);\n    const email = `owner-${suffix}@selfhosted.publish-note.invalid`;\n    const password = randomSecret(\"\", 32);\n    const result = await this.register({ email, password });\n    const issued = await this.createToken(result.account.id, input.tokenName || \"Obsidian plugin\");\n    if (!await this.storage.consumeBootstrap(this.currentIso())) {\n      await this.storage.deleteAccount(result.account.id);\n      throw new ServiceError(409, \"CONFLICT\", \"Provisioning is unavailable\");\n    }\n    return { accountId: result.account.id, publishToken: issued.token };\n  }\n  async reconnectProvisioning(input) {\n    const expiresAt = Date.parse(String(input.expiresAt || \"\"));\n    if (!this.bootstrapSecret || input.provisionSecret !== this.bootstrapSecret || !await this.storage.isBootstrapConsumed() || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime() || expiresAt > this.now().getTime() + 10 * 60 * 1e3) {\n      throw new ServiceError(403, \"FORBIDDEN\", \"Reconnection is unavailable\");\n    }\n    const ownerKey = String(input.ownerKey || \"\").trim();\n    if (!ownerKey || !input.signature || !constantTimeEqual(await hmacSha256(this.bootstrapSecret, `${ownerKey}\n${input.expiresAt}`), String(input.signature))) {\n      throw new ServiceError(403, \"FORBIDDEN\", \"Reconnection is unavailable\");\n    }\n    const account = await this.storage.findProvisioningAccount();\n    if (!account) throw new ServiceError(404, \"NOT_FOUND\", \"Reconnection account is unavailable\");\n    const issued = await this.createToken(account.id, input.tokenName || \"Obsidian plugin\");\n    return { accountId: account.id, publishToken: issued.token };\n  }\n  async startUpload(context, input) {\n    validateUploadStart(input);\n    const existingUpload = await this.storage.findUpload(context.account.id, input.idempotencyKey);\n    if (existingUpload) return { uploadId: existingUpload.uploadId, siteId: existingUpload.siteId, revision: existingUpload.revision };\n    const existingSite = input.siteId ? await this.storage.getSite(context.account.id, input.siteId) : void 0;\n    if (input.siteId && !existingSite) throw new ServiceError(404, \"NOT_FOUND\", \"Site not found\");\n    const siteId = existingSite?.siteId || randomId(16);\n    const revision = (existingSite?.currentRevision || 0) + 1;\n    const createdAt = this.currentIso();\n    const upload = {\n      uploadId: randomId(18),\n      accountId: context.account.id,\n      siteId,\n      revision,\n      sourcePath: String(input.sourcePath),\n      title: String(input.title),\n      idempotencyKey: input.idempotencyKey,\n      formatVersion: 1,\n      chunkProtocolVersion: 2,\n      expectedChunkCount: input.chunkCount,\n      expectedObjectCount: input.objectCount,\n      declaredBytes: input.totalBytes,\n      status: \"open\",\n      createdAt,\n      expiresAt: new Date(this.now().getTime() + UPLOAD_TTL_MS).toISOString()\n    };\n    await this.storage.createUpload(upload);\n    return { uploadId: upload.uploadId, siteId, revision };\n  }\n  async uploadChunk(context, input) {\n    const upload = await this.authorizedUpload(context, input.uploadId);\n    if (upload.status !== \"open\") throw new ServiceError(409, \"CONFLICT\", \"Upload is no longer open\");\n    validateChunk(input);\n    const path = normalizeRelativePath(input.path);\n    const bytes = decodeChunk(input.encoding, input.body);\n    if (bytes.byteLength !== input.byteLength) throw new ServiceError(400, \"BAD_REQUEST\", \"Upload chunk byteLength does not match body\");\n    const result = await this.storage.putUploadChunk({ upload, object: { kind: input.kind, path, contentType: input.contentType, encoding: input.encoding, chunkCount: input.chunkCount }, chunkIndex: input.chunkIndex, byteLength: input.byteLength, bytes });\n    return { uploadId: upload.uploadId, path, chunkIndex: input.chunkIndex, receivedChunks: result.receivedChunks };\n  }\n  async commitUpload(context, uploadId, publicBaseUrl = this.publicBaseUrl) {\n    const upload = await this.authorizedUpload(context, uploadId);\n    if (upload.result) return this.resultFor(upload, upload.result, publicBaseUrl);\n    if (upload.status !== \"open\") throw new ServiceError(409, \"CONFLICT\", \"Upload is no longer open\");\n    const objects = await this.storage.listUploadObjects(upload.uploadId);\n    if (objects.length !== upload.expectedObjectCount || objects.length === 0) throw new ServiceError(400, \"BAD_REQUEST\", \"Upload is incomplete\");\n    let totalBytes = 0;\n    const uploadedPaths = [];\n    for (const object of objects) {\n      const chunks = await this.storage.listUploadChunks(upload.uploadId, object.objectId);\n      if (chunks.length !== object.chunkCount || chunks.some((chunk, index) => chunk.chunkIndex !== index)) throw new ServiceError(400, \"BAD_REQUEST\", `Upload object is incomplete: ${object.path}`);\n      const byteSize = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);\n      if (byteSize !== object.byteSize) throw new ServiceError(400, \"BAD_REQUEST\", `Upload object size mismatch: ${object.path}`);\n      totalBytes += byteSize;\n      uploadedPaths.push(object.path);\n      if (object.kind === \"page\" && object.encoding !== \"utf8\") throw new ServiceError(400, \"BAD_REQUEST\", \"Pages must use UTF-8 chunks\");\n      if (object.kind === \"asset\" && object.encoding !== \"base64\") throw new ServiceError(400, \"BAD_REQUEST\", \"Assets must use base64 chunks\");\n    }\n    if (totalBytes !== upload.declaredBytes) throw new ServiceError(400, \"BAD_REQUEST\", \"Upload byte size does not match the declared total\");\n    const input = { byteSize: totalBytes, objectCount: objects.length, now: this.currentIso(), publicBaseUrl: this.publicBaseUrl };\n    const site = await this.storage.commitUpload(upload.uploadId, input);\n    const result = { siteId: site.siteId, revision: site.currentRevision, uploadedPaths: [...uploadedPaths].sort() };\n    return this.resultFor({ ...upload, result }, result, publicBaseUrl);\n  }\n  async getUsage(accountId) {\n    return this.storage.getUsage(accountId);\n  }\n  async listSites(accountId) {\n    return this.storage.listSites(accountId);\n  }\n  async deleteSite(context, siteId) {\n    if (!await this.storage.deleteSite(context.account.id, siteId)) throw new ServiceError(404, \"NOT_FOUND\", \"Site not found\");\n  }\n  async viewer(siteId, path) {\n    return this.storage.getViewerObject(siteId, normalizeRelativePath(path || \"index.html\"));\n  }\n  async cleanup() {\n    const now = this.currentIso();\n    return { uploads: await this.storage.expireUploads(now), objects: await this.storage.cleanupOrphanedObjects(now) };\n  }\n  bootstrapConfigured() {\n    return Boolean(this.bootstrapSecret);\n  }\n  async authorizedUpload(context, uploadId) {\n    const upload = await this.storage.getUpload(uploadId);\n    if (!upload || upload.accountId !== context.account.id) throw new ServiceError(404, \"NOT_FOUND\", \"Upload not found\");\n    if (Date.parse(upload.expiresAt) <= this.now().getTime() && upload.status === \"open\") throw new ServiceError(410, \"UPLOAD_EXPIRED\", \"Upload session expired\");\n    return upload;\n  }\n  resultFor(upload, result, publicBaseUrl = this.publicBaseUrl) {\n    const base = String(publicBaseUrl || \"\").replace(/\\/$/, \"\");\n    return { siteId: result.siteId, url: siteUrl(result.siteId, base || \"https://share.example.com\"), revision: result.revision, uploadedPaths: [...result.uploadedPaths] };\n  }\n};\nfunction tokenView(token) {\n  return { id: token.id, name: token.name, scope: token.scope, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, expiresAt: token.expiresAt, revokedAt: token.revokedAt };\n}\nfunction validateEmail(email) {\n  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 320) throw new ServiceError(400, \"BAD_REQUEST\", \"A valid email is required\");\n}\nfunction validatePassword(password) {\n  if (password.length < 10 || password.length > 200) throw new ServiceError(400, \"BAD_REQUEST\", \"Password must be 10 to 200 characters\");\n}\nfunction validateUploadStart(input) {\n  if (input.chunkProtocolVersion !== 2 || !String(input.sourcePath || \"\").trim() || !String(input.title || \"\").trim() || !String(input.idempotencyKey || \"\").trim()) throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid upload metadata\");\n  if (!Number.isInteger(input.chunkCount) || input.chunkCount < 1 || !Number.isInteger(input.objectCount) || input.objectCount < 1 || !Number.isInteger(input.totalBytes) || input.totalBytes < 1) throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid upload sizes\");\n}\nfunction validateChunk(input) {\n  if (input.chunkProtocolVersion !== 2 || ![\"page\", \"asset\"].includes(input.kind) || ![\"utf8\", \"base64\"].includes(input.encoding)) throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid upload chunk metadata\");\n  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || !Number.isInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkIndex >= input.chunkCount || !Number.isInteger(input.byteLength) || input.byteLength < 0 || typeof input.body !== \"string\") throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid upload chunk\");\n}\nfunction decodeChunk(encoding, body) {\n  if (encoding === \"utf8\") return new TextEncoder().encode(body);\n  try {\n    const binary = atob(body);\n    return Uint8Array.from(binary, (character) => character.charCodeAt(0));\n  } catch {\n    throw new ServiceError(400, \"BAD_REQUEST\", \"Binary asset chunk is not valid base64\");\n  }\n}\n\n// server/storage/cloudflare-d1-r2/index.ts\nvar D1_ONLY_MAX_OBJECT_BYTES = 2e7;\nvar CloudflareD1R2Storage = class {\n  db;\n  bucket;\n  tenantId;\n  constructor(db, bucket, tenantId = \"default\") {\n    this.db = db;\n    this.bucket = bucket;\n    this.tenantId = tenantId;\n  }\n  async getAccountByEmail(email) {\n    return this.account(await this.db.prepare(\"SELECT * FROM accounts WHERE email = ?1\").bind(email).first());\n  }\n  async getAccount(accountId) {\n    return this.account(await this.db.prepare(\"SELECT * FROM accounts WHERE id = ?1\").bind(accountId).first());\n  }\n  async findProvisioningAccount() {\n    return this.account(await this.db.prepare(\"SELECT * FROM accounts WHERE email LIKE ?1 ORDER BY created_at ASC LIMIT 1\").bind(\"%@selfhosted.publish-note.invalid\").first());\n  }\n  async createAccount(account, recoveryCode2) {\n    await this.db.batch([\n      this.db.prepare(\"INSERT INTO accounts(id,email,password_hash,created_at) VALUES (?1,?2,?3,?4)\").bind(account.id, account.email, account.passwordHash, account.createdAt),\n      this.db.prepare(\"INSERT INTO recovery_codes(id,account_id,code_hash,created_at) VALUES (?1,?2,?3,?4)\").bind(recoveryCode2.id, recoveryCode2.accountId, recoveryCode2.codeHash, recoveryCode2.createdAt)\n    ]);\n  }\n  async deleteAccount(accountId) {\n    await this.db.prepare(\"DELETE FROM accounts WHERE id = ?1\").bind(accountId).run();\n  }\n  async updateAccountPassword(accountId, passwordHash) {\n    await this.db.prepare(\"UPDATE accounts SET password_hash = ?1 WHERE id = ?2\").bind(passwordHash, accountId).run();\n  }\n  async getRecoveryCode(accountId) {\n    return this.recovery(await this.db.prepare(\"SELECT * FROM recovery_codes WHERE account_id = ?1\").bind(accountId).first());\n  }\n  async consumeRecoveryCode(accountId, codeHash, usedAt) {\n    const result = await this.db.prepare(\"UPDATE recovery_codes SET used_at = ?1 WHERE account_id = ?2 AND code_hash = ?3 AND used_at IS NULL\").bind(usedAt, accountId, codeHash).run();\n    return Number(result.meta?.changes || 0) === 1;\n  }\n  async createSession(session) {\n    await this.db.prepare(\"INSERT INTO sessions(id,account_id,created_at,expires_at) VALUES (?1,?2,?3,?4)\").bind(session.id, session.accountId, session.createdAt, session.expiresAt).run();\n  }\n  async getSession(sessionId) {\n    return this.session(await this.db.prepare(\"SELECT * FROM sessions WHERE id = ?1\").bind(sessionId).first());\n  }\n  async deleteSession(sessionId) {\n    await this.db.prepare(\"DELETE FROM sessions WHERE id = ?1\").bind(sessionId).run();\n  }\n  async revokeAccountSessions(accountId) {\n    await this.db.prepare(\"DELETE FROM sessions WHERE account_id = ?1\").bind(accountId).run();\n  }\n  async createToken(token) {\n    await this.db.prepare(\"INSERT INTO tokens(id,account_id,name,token_hash,scope,created_at,last_used_at,expires_at,revoked_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)\").bind(token.id, token.accountId, token.name, token.tokenHash, token.scope, token.createdAt, token.lastUsedAt || null, token.expiresAt || null, token.revokedAt || null).run();\n  }\n  async getTokenByHash(tokenHash) {\n    return this.token(await this.db.prepare(\"SELECT * FROM tokens WHERE token_hash = ?1\").bind(tokenHash).first());\n  }\n  async listTokens(accountId) {\n    const result = await this.db.prepare(\"SELECT * FROM tokens WHERE account_id = ?1 ORDER BY created_at DESC\").bind(accountId).all();\n    return (result.results || []).map((row) => this.token(row));\n  }\n  async revokeToken(accountId, tokenId, revokedAt) {\n    const result = await this.db.prepare(\"UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2 AND account_id = ?3\").bind(revokedAt, tokenId, accountId).run();\n    return Number(result.meta?.changes || 0) === 1;\n  }\n  async touchToken(tokenId, usedAt) {\n    await this.db.prepare(\"UPDATE tokens SET last_used_at = ?1 WHERE id = ?2\").bind(usedAt, tokenId).run();\n  }\n  async revokeAccountTokens(accountId, revokedAt) {\n    await this.db.prepare(\"UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?1) WHERE account_id = ?2\").bind(revokedAt, accountId).run();\n  }\n  async getSite(accountId, siteId) {\n    return this.site(await this.db.prepare(\"SELECT * FROM sites WHERE account_id = ?1 AND site_id = ?2\").bind(accountId, siteId).first());\n  }\n  async listSites(accountId) {\n    const result = await this.db.prepare(\"SELECT * FROM sites WHERE account_id = ?1 ORDER BY updated_at DESC\").bind(accountId).all();\n    return (result.results || []).map((row) => this.site(row));\n  }\n  async getUsage(accountId) {\n    const row = await this.db.prepare(\"SELECT COALESCE(SUM(byte_size),0) AS bytes, COUNT(*) AS site_count FROM sites WHERE account_id = ?1\").bind(accountId).first();\n    return { bytes: Number(row?.bytes || 0), siteCount: Number(row?.site_count || 0) };\n  }\n  async deleteSite(accountId, siteId) {\n    const site = await this.getSite(accountId, siteId);\n    if (!site) return false;\n    const keys = await this.db.prepare(\"SELECT r2_key FROM object_chunks WHERE site_id = ?1\").bind(siteId).all();\n    const uploadKeys = await this.db.prepare(\"SELECT uc.r2_key FROM upload_chunks uc JOIN uploads u ON u.upload_id = uc.upload_id WHERE u.account_id = ?1 AND u.site_id = ?2\").bind(accountId, siteId).all();\n    await this.db.batch([\n      this.db.prepare(\"DELETE FROM object_chunks WHERE site_id = ?1\").bind(siteId),\n      this.db.prepare(\"DELETE FROM objects WHERE site_id = ?1\").bind(siteId),\n      this.db.prepare(\"DELETE FROM revisions WHERE site_id = ?1\").bind(siteId),\n      this.db.prepare(\"DELETE FROM uploads WHERE account_id = ?1 AND site_id = ?2\").bind(accountId, siteId),\n      this.db.prepare(\"DELETE FROM sites WHERE account_id = ?1 AND site_id = ?2\").bind(accountId, siteId)\n    ]);\n    await this.deleteKeys([...keys.results || [], ...uploadKeys.results || []].map((row) => row.r2_key));\n    return true;\n  }\n  async findUpload(accountId, idempotencyKey) {\n    return this.upload(await this.db.prepare(\"SELECT * FROM uploads WHERE account_id = ?1 AND idempotency_key = ?2\").bind(accountId, idempotencyKey).first());\n  }\n  async createUpload(upload) {\n    await this.db.prepare(\"INSERT INTO uploads(upload_id,account_id,site_id,revision,source_path,title,idempotency_key,format_version,chunk_protocol_version,expected_chunk_count,expected_object_count,declared_bytes,status,created_at,expires_at,result_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)\").bind(upload.uploadId, upload.accountId, upload.siteId, upload.revision, upload.sourcePath, upload.title, upload.idempotencyKey, upload.formatVersion, upload.chunkProtocolVersion, upload.expectedChunkCount, upload.expectedObjectCount, upload.declaredBytes, upload.status, upload.createdAt, upload.expiresAt, null).run();\n  }\n  async getUpload(uploadId) {\n    return this.upload(await this.db.prepare(\"SELECT * FROM uploads WHERE upload_id = ?1\").bind(uploadId).first());\n  }\n  async putUploadChunk(input) {\n    let object = this.uploadObject(await this.db.prepare(\"SELECT * FROM upload_objects WHERE upload_id = ?1 AND path = ?2\").bind(input.upload.uploadId, input.object.path).first());\n    if (object && (object.kind !== input.object.kind || object.contentType !== input.object.contentType || object.encoding !== input.object.encoding || object.chunkCount !== input.object.chunkCount)) throw new ServiceError(409, \"CONFLICT\", \"Upload object metadata conflict\");\n    if (!object) {\n      object = { uploadId: input.upload.uploadId, objectId: randomId(16), ...input.object, byteSize: 0 };\n      await this.db.prepare(\"INSERT INTO upload_objects(upload_id,object_id,kind,path,content_type,encoding,chunk_count,byte_size) VALUES (?1,?2,?3,?4,?5,?6,?7,0)\").bind(object.uploadId, object.objectId, object.kind, object.path, object.contentType, object.encoding, object.chunkCount).run();\n    }\n    const existing = await this.db.prepare(\"SELECT * FROM upload_chunks WHERE upload_id = ?1 AND object_id = ?2 AND chunk_index = ?3\").bind(input.upload.uploadId, object.objectId, input.chunkIndex).first();\n    const key = existing?.r2_key ? String(existing.r2_key) : this.r2Key(input.upload, object.objectId, input.chunkIndex);\n    if (existing) {\n      const current = this.bucket ? await this.readR2Chunk(key, \"Stored upload object is missing\") : this.d1ChunkBytes(existing, \"Stored upload object is missing\");\n      if (!bytesEqual(current, input.bytes)) throw new ServiceError(409, \"CONFLICT\", \"Upload chunk conflict\");\n    } else {\n      if (!this.bucket && object.byteSize + input.byteLength > D1_ONLY_MAX_OBJECT_BYTES) {\n        throw new ServiceError(413, \"OBJECT_TOO_LARGE\", `Individual files must be ${D1_ONLY_MAX_OBJECT_BYTES / 1e6} MB or smaller for D1-only deployment`);\n      }\n      try {\n        if (this.bucket) await this.bucket.put(key, input.bytes);\n        const chunkStatement = this.bucket ? this.db.prepare(\"INSERT INTO upload_chunks(upload_id,object_id,chunk_index,r2_key,byte_length) VALUES (?1,?2,?3,?4,?5)\").bind(input.upload.uploadId, object.objectId, input.chunkIndex, key, input.byteLength) : this.db.prepare(\"INSERT INTO upload_chunks(upload_id,object_id,chunk_index,r2_key,byte_length,data) VALUES (?1,?2,?3,?4,?5,?6)\").bind(input.upload.uploadId, object.objectId, input.chunkIndex, key, input.byteLength, input.bytes.slice());\n        await this.db.batch([\n          chunkStatement,\n          this.db.prepare(\"UPDATE upload_objects SET byte_size = byte_size + ?1 WHERE upload_id = ?2 AND object_id = ?3\").bind(input.byteLength, input.upload.uploadId, object.objectId)\n        ]);\n      } catch (error) {\n        await this.bucket?.delete(key).catch(() => void 0);\n        throw error;\n      }\n      object.byteSize += input.byteLength;\n    }\n    const count = await this.db.prepare(\"SELECT COUNT(*) AS count FROM upload_chunks WHERE upload_id = ?1 AND object_id = ?2\").bind(input.upload.uploadId, object.objectId).first();\n    return { object, chunk: { uploadId: input.upload.uploadId, objectId: object.objectId, chunkIndex: input.chunkIndex, byteLength: input.byteLength, bytes: input.bytes.slice() }, receivedChunks: Number(count?.count || 0) };\n  }\n  async listUploadObjects(uploadId) {\n    const result = await this.db.prepare(\"SELECT * FROM upload_objects WHERE upload_id = ?1 ORDER BY path\").bind(uploadId).all();\n    return (result.results || []).map((row) => this.uploadObject(row));\n  }\n  async listUploadChunks(uploadId, objectId) {\n    const result = await this.db.prepare(\"SELECT * FROM upload_chunks WHERE upload_id = ?1 AND object_id = ?2 ORDER BY chunk_index\").bind(uploadId, objectId).all();\n    const chunks = [];\n    for (const row of result.results || []) {\n      const bytes = this.bucket ? await this.readR2Chunk(String(row.r2_key), \"Stored upload object is missing\") : this.d1ChunkBytes(row, \"Stored upload object is missing\");\n      chunks.push({ uploadId, objectId, chunkIndex: Number(row.chunk_index), byteLength: Number(row.byte_length), bytes });\n    }\n    return chunks;\n  }\n  async commitUpload(uploadId, input) {\n    const upload = await this.getUpload(uploadId);\n    if (!upload) throw new ServiceError(404, \"NOT_FOUND\", \"Upload not found\");\n    const previous = await this.db.prepare(\"SELECT * FROM sites WHERE site_id = ?1\").bind(upload.siteId).first();\n    const oldKeys = previous ? await this.db.prepare(\"SELECT r2_key FROM object_chunks WHERE site_id = ?1\").bind(upload.siteId).all() : { results: [] };\n    const paths = (await this.listUploadObjects(uploadId)).map((object) => object.path).sort();\n    const resultJson = JSON.stringify({ siteId: upload.siteId, revision: upload.revision, uploadedPaths: paths });\n    const statements = [\n      this.db.prepare(\"INSERT INTO sites(site_id,account_id,title,source_path,current_revision,byte_size,object_count,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(site_id) DO UPDATE SET title=excluded.title,source_path=excluded.source_path,current_revision=excluded.current_revision,byte_size=excluded.byte_size,object_count=excluded.object_count,updated_at=excluded.updated_at\").bind(upload.siteId, upload.accountId, upload.title, upload.sourcePath, upload.revision, input.byteSize, input.objectCount, input.now, input.now),\n      this.db.prepare(\"INSERT OR IGNORE INTO revisions(site_id,revision,created_at) VALUES (?1,?2,?3)\").bind(upload.siteId, upload.revision, input.now),\n      this.db.prepare(\"INSERT OR IGNORE INTO objects(site_id,revision,object_id,kind,path,content_type,encoding,chunk_count,byte_size) SELECT ?1,?2,object_id,kind,path,content_type,encoding,chunk_count,byte_size FROM upload_objects WHERE upload_id = ?3\").bind(upload.siteId, upload.revision, uploadId),\n      (this.bucket ? this.db.prepare(\"INSERT OR IGNORE INTO object_chunks(site_id,revision,object_id,chunk_index,r2_key,byte_length) SELECT ?1,?2,object_id,chunk_index,r2_key,byte_length FROM upload_chunks WHERE upload_id = ?3\") : this.db.prepare(\"INSERT OR IGNORE INTO object_chunks(site_id,revision,object_id,chunk_index,r2_key,byte_length,data) SELECT ?1,?2,object_id,chunk_index,r2_key,byte_length,data FROM upload_chunks WHERE upload_id = ?3\")).bind(upload.siteId, upload.revision, uploadId),\n      this.db.prepare(\"DELETE FROM object_chunks WHERE site_id = ?1 AND revision <> ?2\").bind(upload.siteId, upload.revision),\n      this.db.prepare(\"DELETE FROM objects WHERE site_id = ?1 AND revision <> ?2\").bind(upload.siteId, upload.revision),\n      this.db.prepare(\"DELETE FROM revisions WHERE site_id = ?1 AND revision <> ?2\").bind(upload.siteId, upload.revision),\n      this.db.prepare(\"UPDATE uploads SET status='committed', result_json=?1 WHERE upload_id=?2 AND status='open'\").bind(resultJson, uploadId),\n      this.db.prepare(\"DELETE FROM upload_chunks WHERE upload_id = ?1\").bind(uploadId),\n      this.db.prepare(\"DELETE FROM upload_objects WHERE upload_id = ?1\").bind(uploadId)\n    ];\n    await this.db.batch(statements);\n    await this.deleteKeys((oldKeys.results || []).map((row) => row.r2_key));\n    return await this.getSite(upload.accountId, upload.siteId);\n  }\n  async expireUploads(now) {\n    const rows = await this.db.prepare(\"SELECT upload_id FROM uploads WHERE status='open' AND expires_at <= ?1\").bind(now).all();\n    if ((rows.results || []).length === 0) return 0;\n    const ids = (rows.results || []).map((row) => row.upload_id);\n    const keys = await this.db.prepare(`SELECT r2_key FROM upload_chunks WHERE upload_id IN (${ids.map(() => \"?\").join(\",\")})`).bind(...ids).all();\n    await this.db.batch(ids.map((id) => this.db.prepare(\"DELETE FROM uploads WHERE upload_id = ?1 AND status='open'\").bind(id)));\n    await this.deleteKeys((keys.results || []).map((row) => row.r2_key));\n    return ids.length;\n  }\n  async getViewerObject(siteId, path) {\n    const site = this.site(await this.db.prepare(\"SELECT * FROM sites WHERE site_id = ?1\").bind(siteId).first());\n    if (!site) return void 0;\n    const object = this.publishedObject(await this.db.prepare(\"SELECT * FROM objects WHERE site_id = ?1 AND revision = ?2 AND path = ?3\").bind(siteId, site.currentRevision, path).first(), siteId, site.currentRevision);\n    if (!object) return void 0;\n    const rows = await this.db.prepare(\"SELECT * FROM object_chunks WHERE site_id = ?1 AND revision = ?2 AND object_id = ?3 ORDER BY chunk_index\").bind(siteId, site.currentRevision, object.objectId).all();\n    const bucket = this.bucket;\n    const chunkRows = rows.results || [];\n    const chunks = (async function* () {\n      for (const row of chunkRows) {\n        if (!bucket) {\n          yield d1BlobBytes(row.data, \"Stored published object is missing\");\n          continue;\n        }\n        const stored = await bucket.get(String(row.r2_key));\n        if (!stored) throw new ServiceError(500, \"INTERNAL_ERROR\", \"Stored published object is missing\");\n        if (stored.body) {\n          const reader = stored.body.getReader();\n          while (true) {\n            const next = await reader.read();\n            if (next.done) break;\n            if (next.value) yield next.value;\n          }\n        } else {\n          yield new Uint8Array(await stored.arrayBuffer());\n        }\n      }\n    })();\n    return { site, object: { ...object, siteId, revision: site.currentRevision }, chunks };\n  }\n  async cleanupOrphanedObjects(_now) {\n    const old = await this.db.prepare(\"SELECT oc.r2_key FROM object_chunks oc JOIN sites s ON s.site_id = oc.site_id WHERE oc.revision <> s.current_revision\").all();\n    const expired = await this.db.prepare(\"SELECT uc.r2_key FROM upload_chunks uc JOIN uploads u ON u.upload_id = uc.upload_id WHERE u.status='expired'\").all();\n    const keys = [...old.results || [], ...expired.results || []].map((row) => row.r2_key);\n    const listed = this.bucket?.list ? await this.bucket.list({ prefix: \"tenants/\" }) : void 0;\n    if (listed) {\n      const active = await this.db.prepare(\"SELECT r2_key FROM object_chunks UNION SELECT uc.r2_key FROM upload_chunks uc JOIN uploads u ON u.upload_id=uc.upload_id WHERE u.status='open'\").all();\n      const activeKeys = new Set((active.results || []).map((row) => row.r2_key));\n      for (const object of listed.objects || []) if (!activeKeys.has(object.key)) keys.push(object.key);\n    }\n    await this.db.batch([\n      this.db.prepare(\"DELETE FROM object_chunks WHERE EXISTS (SELECT 1 FROM sites s WHERE s.site_id=object_chunks.site_id AND object_chunks.revision <> s.current_revision)\"),\n      this.db.prepare(\"DELETE FROM upload_chunks WHERE upload_id IN (SELECT upload_id FROM uploads WHERE status='expired')\"),\n      this.db.prepare(\"DELETE FROM upload_objects WHERE upload_id IN (SELECT upload_id FROM uploads WHERE status='expired')\"),\n      this.db.prepare(\"DELETE FROM uploads WHERE status='expired'\")\n    ]);\n    const uniqueKeys = [...new Set(keys)];\n    await this.deleteKeys(uniqueKeys);\n    return uniqueKeys.length;\n  }\n  async createDeviceAuthorization(record) {\n    await this.db.prepare(\"INSERT INTO device_authorizations(id,device_code_hash,status,created_at,expires_at,token_name) VALUES (?1,?2,?3,?4,?5,?6)\").bind(record.id, record.deviceCodeHash, record.status, record.createdAt, record.expiresAt, record.tokenName || null).run();\n  }\n  async getDeviceAuthorization(deviceCodeHash) {\n    return this.device(await this.db.prepare(\"SELECT * FROM device_authorizations WHERE device_code_hash = ?1\").bind(deviceCodeHash).first());\n  }\n  async approveDeviceAuthorization(deviceCodeHash, accountId, _tokenId, tokenName, now = (/* @__PURE__ */ new Date()).toISOString()) {\n    const result = await this.db.prepare(\"UPDATE device_authorizations SET account_id=?1,status='approved',token_name=?2 WHERE device_code_hash=?3 AND status='pending' AND expires_at > ?4\").bind(accountId, tokenName, deviceCodeHash, now).run();\n    return Number(result.meta?.changes || 0) === 1;\n  }\n  async consumeApprovedDeviceAuthorization(deviceCodeHash) {\n    const now = (/* @__PURE__ */ new Date()).toISOString();\n    const result = await this.db.prepare(\"UPDATE device_authorizations SET consumed_at=?1 WHERE device_code_hash=?2 AND status='approved' AND consumed_at IS NULL\").bind(now, deviceCodeHash).run();\n    if (Number(result.meta?.changes || 0) !== 1) return void 0;\n    return this.device(await this.db.prepare(\"SELECT * FROM device_authorizations WHERE device_code_hash = ?1\").bind(deviceCodeHash).first());\n  }\n  async isBootstrapConsumed() {\n    const row = await this.db.prepare(\"SELECT consumed_at FROM bootstrap_state WHERE id=1\").first();\n    return Boolean(row?.consumed_at);\n  }\n  async consumeBootstrap(now) {\n    const result = await this.db.prepare(\"UPDATE bootstrap_state SET consumed_at=?1 WHERE id=1 AND consumed_at IS NULL\").bind(now).run();\n    return Number(result.meta?.changes || 0) === 1;\n  }\n  async deleteKeys(keys) {\n    if (keys.length > 0 && this.bucket) await this.bucket.delete(keys);\n  }\n  async readR2Chunk(key, message) {\n    const stored = await this.bucket.get(key);\n    if (!stored) throw new ServiceError(500, \"INTERNAL_ERROR\", message);\n    return new Uint8Array(await stored.arrayBuffer());\n  }\n  d1ChunkBytes(row, message) {\n    return d1BlobBytes(row.data, message);\n  }\n  r2Key(upload, objectId, chunkIndex) {\n    return `tenants/${upload.accountId || this.tenantId}/sites/${upload.siteId}/revisions/${upload.revision}/objects/${objectId}/chunks/${chunkIndex}`;\n  }\n  account(row) {\n    return row ? { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), createdAt: String(row.created_at) } : void 0;\n  }\n  recovery(row) {\n    return row ? { id: String(row.id), accountId: String(row.account_id), codeHash: String(row.code_hash), createdAt: String(row.created_at), usedAt: row.used_at ? String(row.used_at) : void 0 } : void 0;\n  }\n  session(row) {\n    return row ? { id: String(row.id), accountId: String(row.account_id), createdAt: String(row.created_at), expiresAt: String(row.expires_at) } : void 0;\n  }\n  token(row) {\n    return row ? { id: String(row.id), accountId: String(row.account_id), name: String(row.name), tokenHash: String(row.token_hash), scope: String(row.scope), createdAt: String(row.created_at), lastUsedAt: row.last_used_at ? String(row.last_used_at) : void 0, expiresAt: row.expires_at ? String(row.expires_at) : void 0, revokedAt: row.revoked_at ? String(row.revoked_at) : void 0 } : void 0;\n  }\n  site(row) {\n    return row ? { siteId: String(row.site_id), accountId: String(row.account_id), title: String(row.title), sourcePath: String(row.source_path), currentRevision: Number(row.current_revision), byteSize: Number(row.byte_size), objectCount: Number(row.object_count), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : void 0;\n  }\n  upload(row) {\n    if (!row) return void 0;\n    return { uploadId: String(row.upload_id), accountId: String(row.account_id), siteId: String(row.site_id), revision: Number(row.revision), sourcePath: String(row.source_path), title: String(row.title), idempotencyKey: String(row.idempotency_key), formatVersion: 1, chunkProtocolVersion: 2, expectedChunkCount: Number(row.expected_chunk_count), expectedObjectCount: Number(row.expected_object_count), declaredBytes: Number(row.declared_bytes), status: String(row.status), createdAt: String(row.created_at), expiresAt: String(row.expires_at), result: row.result_json ? JSON.parse(String(row.result_json)) : void 0 };\n  }\n  uploadObject(row) {\n    return row ? { uploadId: String(row.upload_id), objectId: String(row.object_id), kind: String(row.kind), path: String(row.path), contentType: String(row.content_type), encoding: String(row.encoding), chunkCount: Number(row.chunk_count), byteSize: Number(row.byte_size) } : void 0;\n  }\n  publishedObject(row, siteId, revision) {\n    return row ? { siteId, revision, uploadId: \"\", objectId: String(row.object_id), kind: String(row.kind), path: String(row.path), contentType: String(row.content_type), encoding: String(row.encoding), chunkCount: Number(row.chunk_count), byteSize: Number(row.byte_size) } : void 0;\n  }\n  device(row) {\n    return row ? { id: String(row.id), deviceCodeHash: String(row.device_code_hash), accountId: row.account_id ? String(row.account_id) : void 0, status: String(row.status), createdAt: String(row.created_at), expiresAt: String(row.expires_at), consumedAt: row.consumed_at ? String(row.consumed_at) : void 0, tokenName: row.token_name ? String(row.token_name) : void 0 } : void 0;\n  }\n};\nfunction bytesEqual(left, right) {\n  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);\n}\nfunction d1BlobBytes(value, message) {\n  if (Array.isArray(value)) {\n    for (const byte of value) {\n      if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new ServiceError(500, \"INTERNAL_ERROR\", message);\n    }\n    return Uint8Array.from(value);\n  }\n  if (value instanceof Uint8Array) return value.slice();\n  if (value instanceof ArrayBuffer) return new Uint8Array(value);\n  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();\n  throw new ServiceError(500, \"INTERNAL_ERROR\", message);\n}\n\n// server/worker/env.ts\nfunction createService(env, request) {\n  const publicBaseUrl = String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\\/$/, \"\");\n  return new PublishService({ storage: new CloudflareD1R2Storage(env.DB, env.CONTENTS, \"default\"), publicBaseUrl, bootstrapSecret: env.BOOTSTRAP_SECRET });\n}\n\n// server/console/pages.ts\nfunction escapeHtml(value) {\n  return String(value ?? \"\").replaceAll(\"&\", \"&amp;\").replaceAll(\"<\", \"&lt;\").replaceAll(\">\", \"&gt;\").replaceAll('\"', \"&quot;\").replaceAll(\"'\", \"&#39;\");\n}\nfunction page(title, body, options = {}) {\n  const nav = options.session ? `<nav><a href=\"/account/usage\">Usage</a> \\xB7 <a href=\"/account/tokens\">Tokens</a> \\xB7 <a href=\"/account/sites\">Sites</a><form method=\"post\" action=\"/logout\" style=\"display:inline\"><button>Log out</button></form></nav>` : \"\";\n  return `<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>${escapeHtml(title)} \\xB7 One-Click Publish</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.5;color:#202124}label{display:block;margin:14px 0 4px}input{width:100%;max-width:420px;padding:9px;border:1px solid #bbb;border-radius:6px}button{margin-top:16px;padding:9px 14px;border:0;border-radius:6px;background:#5b4bdb;color:white;cursor:pointer}nav{margin-bottom:28px}nav form button{background:none;color:#5b4bdb;padding:0;margin:0}code{background:#f1f1f1;padding:3px 5px;border-radius:4px;word-break:break-all}.card{border:1px solid #ddd;border-radius:8px;padding:18px;margin:16px 0}.warning{background:#fff4d6;padding:12px;border-radius:6px}</style></head><body>${nav}${body}</body></html>`;\n}\nfunction formField(name, label, type = \"text\", required = true) {\n  return `<label for=\"${escapeHtml(name)}\">${escapeHtml(label)}</label><input id=\"${escapeHtml(name)}\" name=\"${escapeHtml(name)}\" type=\"${escapeHtml(type)}\"${required ? \" required\" : \"\"}>`;\n}\nfunction recoveryPage(recoveryCode2, next = \"/login\") {\n  return page(\"Save your recovery code\", `<h1>Save your recovery code</h1><p>This code is shown once. Store it somewhere safe before continuing.</p><p class=\"warning\"><code>${escapeHtml(recoveryCode2)}</code></p><p><a href=\"${escapeHtml(next)}\">Continue</a></p>`);\n}\n\n// server/worker/routes.ts\nvar JSON_HEADERS = { \"content-type\": \"application/json; charset=utf-8\", \"cache-control\": \"no-store\" };\nasync function routeRequest(context) {\n  const { request, service } = context;\n  const url = new URL(request.url);\n  if (request.method === \"OPTIONS\") return new Response(null, { status: 204, headers: { \"access-control-allow-origin\": \"*\", \"access-control-allow-headers\": \"authorization,content-type\", \"access-control-allow-methods\": \"GET,POST,DELETE,OPTIONS\" } });\n  try {\n    if (request.method === \"GET\" && url.pathname === \"/healthz\") return json({\n      status: \"ok\",\n      service: \"publish-note\",\n      version: String(context.env.PUBLISH_NOTE_VERSION || \"unknown\"),\n      storage: context.env.CONTENTS ? \"cloudflare-d1-r2\" : \"cloudflare-d1\"\n    });\n    if (url.pathname.startsWith(\"/s/\")) return await viewerResponse(service, request, url);\n    if (url.pathname === \"/connect\" && request.method === \"GET\") return await connectPage(context);\n    if (url.pathname === \"/connect/approve\" && request.method === \"POST\") return await approveConnect(context);\n    if (url.pathname === \"/__internal/provision/initialize\" && request.method === \"POST\") return await initializeProvisioning(context);\n    if (url.pathname === \"/__internal/provision/reconnect\" && request.method === \"POST\") return await reconnectProvisioning(context);\n    if (url.pathname === \"/setup\") return await setupPage(context);\n    if (url.pathname === \"/login\") return await loginPage(context);\n    if (url.pathname === \"/register\") return await registerPage(context);\n    if (url.pathname === \"/recover\") return await recoverPage(context);\n    if (url.pathname === \"/logout\" && request.method === \"POST\") return await logoutPage(context);\n    if (url.pathname.startsWith(\"/account\")) return await accountPage(context);\n    if (url.pathname.startsWith(\"/v1/\")) return await apiRequest(context);\n    return new Response(\"Not Found\", { status: 404 });\n  } catch (error) {\n    if (url.pathname.startsWith(\"/v1/\") || url.pathname === \"/healthz\" || url.pathname === \"/__internal/provision/initialize\" || url.pathname === \"/__internal/provision/reconnect\") return jsonError(error);\n    const normalized = asServiceError(error);\n    return new Response(page(\"Error\", `<h1>Request failed</h1><p>${escapeHtml(normalized.message)}</p>`), { status: normalized.status, headers: { \"content-type\": \"text/html; charset=utf-8\" } });\n  }\n}\nasync function initializeProvisioning(context) {\n  const input = await readJson(context.request);\n  const secret = context.request.headers.get(\"x-publish-note-bootstrap-secret\") || \"\";\n  const result = await context.service.initializeProvisioning({\n    provisionSecret: secret,\n    ownerKey: String(input.ownerKey || context.request.headers.get(\"x-publish-note-owner-key\") || \"\"),\n    expiresAt: String(input.expiresAt || context.request.headers.get(\"x-publish-note-expires-at\") || \"\"),\n    signature: String(input.signature || context.request.headers.get(\"x-publish-note-signature\") || \"\"),\n    tokenName: String(input.tokenName || \"Obsidian plugin\")\n  });\n  return json(result, 201);\n}\nasync function reconnectProvisioning(context) {\n  const input = await readJson(context.request);\n  const secret = context.request.headers.get(\"x-publish-note-bootstrap-secret\") || \"\";\n  const result = await context.service.reconnectProvisioning({\n    provisionSecret: secret,\n    ownerKey: String(input.ownerKey || context.request.headers.get(\"x-publish-note-owner-key\") || \"\"),\n    expiresAt: String(input.expiresAt || context.request.headers.get(\"x-publish-note-expires-at\") || \"\"),\n    signature: String(input.signature || context.request.headers.get(\"x-publish-note-signature\") || \"\"),\n    tokenName: String(input.tokenName || \"Obsidian plugin\")\n  });\n  return json(result, 200);\n}\nasync function apiRequest(context) {\n  const { request, service } = context;\n  const url = new URL(request.url);\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/register\") {\n    const result = await service.register(await readJson(request));\n    return json({ account: publicAccount(result.account), recoveryCode: result.recoveryCode }, 201);\n  }\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/login\") {\n    const result = await service.login(await readJson(request));\n    const response = json({ account: publicAccount(result.account) });\n    response.headers.set(\"set-cookie\", sessionCookie(result.session.id, request));\n    return response;\n  }\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/logout\") {\n    await service.logout(parseCookie(request.headers.get(\"cookie\"), \"pn_session\"));\n    const response = json({ ok: true });\n    response.headers.set(\"set-cookie\", clearCookie(request));\n    return response;\n  }\n  if (request.method === \"GET\" && url.pathname === \"/v1/me\") return json({ account: publicAccount((await requireSession(context)).account) });\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/device/start\") return json(await service.startDeviceAuthorization());\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/device/poll\") return json(await service.pollDeviceAuthorization(String((await readJson(request)).deviceCode || \"\")));\n  if (request.method === \"POST\" && url.pathname === \"/v1/auth/device/approve\") {\n    const session2 = await requireSession(context);\n    const input = await readJson(request);\n    await service.approveDeviceAuthorization(session2, String(input.deviceCode || \"\"), input.tokenName);\n    return json({ ok: true });\n  }\n  if (request.method === \"POST\" && url.pathname === \"/v1/account/recover\") {\n    await service.recover(await readJson(request));\n    return json({ ok: true });\n  }\n  const sessionRoutes = url.pathname === \"/v1/tokens\" || url.pathname === \"/v1/usage\" || url.pathname === \"/v1/sites\" || /^\\/v1\\/tokens\\/[^/]+\\/revoke$/.test(url.pathname) || request.method === \"DELETE\" && /^\\/v1\\/sites\\/[^/]+$/.test(url.pathname);\n  const session = sessionRoutes ? await requireSession(context) : void 0;\n  if (session && request.method === \"GET\" && url.pathname === \"/v1/tokens\") return json({ tokens: await service.listTokens(session) });\n  if (session && request.method === \"POST\" && url.pathname === \"/v1/tokens\") {\n    const input = await readJson(request);\n    return json(await service.createToken(session.account.id, String(input.name || \"Obsidian plugin\"), input.expiresAt));\n  }\n  if (session && request.method === \"POST\" && /^\\/v1\\/tokens\\/[^/]+\\/revoke$/.test(url.pathname)) {\n    await service.revokeToken(session, decodeURIComponent(url.pathname.split(\"/\")[3]));\n    return json({ ok: true });\n  }\n  if (session && request.method === \"GET\" && url.pathname === \"/v1/usage\") return json(await usagePayload(service, session.account.id));\n  if (session && request.method === \"GET\" && url.pathname === \"/v1/sites\") return json({ sites: await service.listSites(session.account.id) });\n  if (session && request.method === \"DELETE\" && /^\\/v1\\/sites\\/[^/]+$/.test(url.pathname)) {\n    await service.deleteSite(session, decodeURIComponent(url.pathname.split(\"/\")[3]));\n    return json({ ok: true });\n  }\n  const token = await service.authenticatePublishToken(parseBearer(request.headers.get(\"authorization\")));\n  if (request.method === \"POST\" && url.pathname === \"/v1/sites/uploads\") return json(await service.startUpload(token, await readJson(request)));\n  const chunkMatch = /^\\/v1\\/uploads\\/([^/]+)\\/chunks$/.exec(url.pathname);\n  if (request.method === \"POST\" && chunkMatch) return json(await service.uploadChunk(token, { ...await readJson(request), uploadId: decodeURIComponent(chunkMatch[1]) }));\n  const commitMatch = /^\\/v1\\/uploads\\/([^/]+)\\/commit$/.exec(url.pathname);\n  if (request.method === \"POST\" && commitMatch) return json(await service.commitUpload(token, decodeURIComponent(commitMatch[1]), new URL(request.url).origin));\n  throw new ServiceError(404, \"NOT_FOUND\", \"Not found\");\n}\nasync function viewerResponse(service, request, url) {\n  const match = /^\\/s\\/([^/]+)(\\/.*)?$/.exec(url.pathname);\n  if (!match) throw new ServiceError(404, \"NOT_FOUND\", \"Not found\");\n  const siteId = decodeURIComponent(match[1]);\n  const path = viewerPath(siteId, url.pathname);\n  const value = await service.viewer(siteId, path);\n  if (!value) return new Response(\"Not Found\", { status: 404, headers: { \"content-type\": \"text/plain; charset=utf-8\" } });\n  const stream = new ReadableStream({\n    async start(controller) {\n      try {\n        for await (const chunk of value.chunks) controller.enqueue(chunk);\n        controller.close();\n      } catch (error) {\n        controller.error(error);\n      }\n    }\n  });\n  return new Response(stream, { status: 200, headers: { \"content-type\": value.object.contentType, \"cache-control\": \"no-cache\" } });\n}\nasync function requireSession(context) {\n  const session = await context.service.accountForSession(parseCookie(context.request.headers.get(\"cookie\"), \"pn_session\"));\n  if (!session) throw new ServiceError(401, \"UNAUTHORIZED\", \"Sign in required\");\n  return session;\n}\nasync function connectPage(context) {\n  const code = new URL(context.request.url).searchParams.get(\"code\") || \"\";\n  if (!code) return html(\"Connect One-Click Publish\", `<h1>Connect One-Click Publish</h1><p>This link is missing a device code.</p>`);\n  const session = await context.service.accountForSession(parseCookie(context.request.headers.get(\"cookie\"), \"pn_session\"));\n  const next = `/connect?code=${code}`;\n  if (!session) return html(\"Connect One-Click Publish\", `<h1>Connect One-Click Publish</h1><p>Sign in before approving this Obsidian plugin connection.</p><p><a href=\"/login?next=${encodeURIComponent(next)}\">Sign in</a> \\xB7 <a href=\"/register?next=${encodeURIComponent(next)}\">Create an account</a></p>`);\n  return html(\"Approve connection\", `<h1>Approve connection</h1><p>Allow this Obsidian plugin to publish notes for <strong>${escapeHtml(session.account.email)}</strong>?</p><form method=\"post\" action=\"/connect/approve\"><input type=\"hidden\" name=\"deviceCode\" value=\"${escapeHtml(code)}\">${formField(\"tokenName\", \"Token name\", \"text\", false)}<button>Allow publishing</button></form>`);\n}\nasync function approveConnect(context) {\n  const session = await requireSession(context);\n  const form = await readForm(context.request);\n  await context.service.approveDeviceAuthorization(session, String(form.deviceCode || \"\"), String(form.tokenName || \"Obsidian plugin\"));\n  return html(\"Connected\", `<h1>Connected</h1><p>You can return to Obsidian. The plugin will finish connecting automatically.</p>`);\n}\nasync function setupPage(context) {\n  if (!context.service.bootstrapConfigured()) return html(\"Setup unavailable\", `<h1>Setup unavailable</h1><p>This Worker has no BOOTSTRAP_SECRET configured.</p>`, 503);\n  if (context.request.method === \"GET\") return html(\"First-time setup\", `<h1>First-time setup</h1><p>This creates the first account. The bootstrap secret is single-use and is never shown again.</p><form method=\"post\" action=\"/setup\">${formField(\"bootstrapSecret\", \"Bootstrap secret\", \"password\")}${formField(\"email\", \"Email\", \"email\")}${formField(\"password\", \"Password (10+ characters)\", \"password\")}<button>Create account</button></form>`);\n  const form = await readForm(context.request);\n  const result = await context.service.setup({ bootstrapSecret: String(form.bootstrapSecret || \"\"), email: String(form.email || \"\"), password: String(form.password || \"\") });\n  return new Response(recoveryPage(result.recoveryCode), { status: 201, headers: { \"content-type\": \"text/html; charset=utf-8\" } });\n}\nasync function loginPage(context) {\n  if (context.request.method === \"GET\") {\n    const next = safeNext(new URL(context.request.url).searchParams.get(\"next\"));\n    return html(\"Sign in\", `<h1>Sign in</h1><form method=\"post\" action=\"/login\">${formField(\"email\", \"Email\", \"email\")}${formField(\"password\", \"Password\", \"password\")}<input type=\"hidden\" name=\"next\" value=\"${escapeHtml(next)}\"><button>Sign in</button></form><p><a href=\"/register?next=${encodeURIComponent(next)}\">Create an account</a> \\xB7 <a href=\"/recover\">Use recovery code</a></p>`);\n  }\n  const form = await readForm(context.request);\n  const result = await context.service.login({ email: String(form.email || \"\"), password: String(form.password || \"\") });\n  return new Response(null, { status: 302, headers: { location: safeNext(form.next), \"set-cookie\": sessionCookie(result.session.id, context.request) } });\n}\nasync function registerPage(context) {\n  if (context.request.method === \"GET\") {\n    const next = safeNext(new URL(context.request.url).searchParams.get(\"next\"));\n    return html(\"Create account\", `<h1>Create account</h1><p>Email verification is not required. Save the one-time recovery code shown after registration.</p><form method=\"post\" action=\"/register\">${formField(\"email\", \"Email\", \"email\")}${formField(\"password\", \"Password (10+ characters)\", \"password\")}<input type=\"hidden\" name=\"next\" value=\"${escapeHtml(next)}\"><button>Create account</button></form><p><a href=\"/login?next=${encodeURIComponent(next)}\">Sign in</a></p>`);\n  }\n  const form = await readForm(context.request);\n  const result = await context.service.register({ email: String(form.email || \"\"), password: String(form.password || \"\") });\n  return new Response(recoveryPage(result.recoveryCode, `/login?next=${encodeURIComponent(safeNext(form.next))}`), { status: 201, headers: { \"content-type\": \"text/html; charset=utf-8\" } });\n}\nasync function recoverPage(context) {\n  if (context.request.method === \"GET\") return html(\"Recover account\", `<h1>Recover account</h1><p>Recovery revokes all existing sessions and Publish Tokens.</p><form method=\"post\" action=\"/recover\">${formField(\"email\", \"Email\", \"email\")}${formField(\"recoveryCode\", \"Recovery code\")}${formField(\"newPassword\", \"New password (10+ characters)\", \"password\")}<button>Reset password</button></form>`);\n  const form = await readForm(context.request);\n  await context.service.recover({ email: String(form.email || \"\"), recoveryCode: String(form.recoveryCode || \"\"), newPassword: String(form.newPassword || \"\") });\n  return html(\"Password reset\", `<h1>Password reset</h1><p>All previous sessions and Publish Tokens were revoked. <a href=\"/login\">Sign in again</a>.</p>`);\n}\nasync function logoutPage(context) {\n  await context.service.logout(parseCookie(context.request.headers.get(\"cookie\"), \"pn_session\"));\n  return new Response(null, { status: 302, headers: { location: \"/login\", \"set-cookie\": clearCookie(context.request) } });\n}\nasync function accountPage(context) {\n  const session = await requireSession(context);\n  const path = new URL(context.request.url).pathname;\n  const revokeTokenMatch = /^\\/account\\/tokens\\/([^/]+)\\/revoke$/.exec(path);\n  if (revokeTokenMatch && context.request.method === \"POST\") {\n    await context.service.revokeToken(session, decodeURIComponent(revokeTokenMatch[1]));\n    return new Response(null, { status: 302, headers: { location: \"/account/tokens\" } });\n  }\n  const deleteSiteMatch = /^\\/account\\/sites\\/([^/]+)\\/delete$/.exec(path);\n  if (deleteSiteMatch && context.request.method === \"POST\") {\n    await context.service.deleteSite(session, decodeURIComponent(deleteSiteMatch[1]));\n    return new Response(null, { status: 302, headers: { location: \"/account/sites\" } });\n  }\n  if (path === \"/account/tokens\") {\n    if (context.request.method === \"POST\") {\n      const form = await readForm(context.request);\n      const created = await context.service.createToken(session.account.id, String(form.name || \"Obsidian plugin\"));\n      return html(\"Token created\", `<h1>Token created</h1><p>Copy this token now. It will not be shown again.</p><p class=\"warning\"><code>${escapeHtml(created.token)}</code></p><p><a href=\"/account/tokens\">Back to tokens</a></p>`);\n    }\n    const tokens = await context.service.listTokens(session);\n    return html(\"Tokens\", `<h1>Publish Tokens</h1><p>Full token values are never shown after creation.</p><form method=\"post\" action=\"/account/tokens\">${formField(\"name\", \"Token name\", \"text\", false)}<button>Create token</button></form>${tokens.map((token) => `<div class=\"card\"><strong>${escapeHtml(token.name)}</strong><br>Created: ${escapeHtml(token.createdAt)}<br>Last used: ${escapeHtml(token.lastUsedAt || \"Never\")}<br>Status: ${escapeHtml(token.revokedAt ? \"Revoked\" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? \"Expired\" : \"Active\")} ${token.revokedAt ? \"\" : `<form method=\"post\" action=\"/account/tokens/${encodeURIComponent(token.id)}/revoke\"><button>Revoke</button></form>`}</div>`).join(\"\")}`, { session: true });\n  }\n  if (path === \"/account/sites\") {\n    const sites = await context.service.listSites(session.account.id);\n    return html(\"Sites\", `<h1>Published Notes</h1>${sites.map((site) => `<div class=\"card\"><strong>${escapeHtml(site.title)}</strong><br><a href=\"/s/${encodeURIComponent(site.siteId)}/\">${escapeHtml(siteUrlFor(context, site.siteId))}</a><br>Size: ${escapeHtml(site.byteSize)} bytes \\xB7 Updated: ${escapeHtml(site.updatedAt)}<form method=\"post\" action=\"/account/sites/${encodeURIComponent(site.siteId)}/delete\"><button>Delete site</button></form></div>`).join(\"\") || \"<p>No sites yet.</p>\"}`, { session: true });\n  }\n  const usage = await usagePayload(context.service, session.account.id);\n  return html(\"Usage\", `<h1>Usage</h1><p>Account: ${escapeHtml(session.account.email)}</p><div class=\"card\"><strong>${escapeHtml(usage.bytes)} bytes in current published content</strong><br>${escapeHtml(usage.siteCount)} published Notes<br>Service: ${escapeHtml(new URL(context.request.url).origin)}</div><p><a href=\"/account/tokens\">Manage tokens</a> \\xB7 <a href=\"/account/sites\">Manage sites</a></p>`, { session: true });\n}\nasync function usagePayload(service, accountId) {\n  const usage = await service.getUsage(accountId);\n  return { ...usage, sites: await service.listSites(accountId) };\n}\nfunction siteUrlFor(context, siteId) {\n  return `${new URL(context.request.url).origin}/s/${encodeURIComponent(siteId)}/`;\n}\nfunction publicAccount(account) {\n  return { id: account.id, email: account.email, createdAt: account.createdAt };\n}\nfunction json(value, status = 200) {\n  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });\n}\nfunction html(title, body, statusOrOptions = 200, options = {}) {\n  const status = typeof statusOrOptions === \"number\" ? statusOrOptions : 200;\n  const pageOptions = typeof statusOrOptions === \"number\" ? options : statusOrOptions;\n  return new Response(page(title, body, pageOptions), { status, headers: { \"content-type\": \"text/html; charset=utf-8\" } });\n}\nasync function readJson(request) {\n  const bytes = new Uint8Array(await request.arrayBuffer());\n  if (bytes.byteLength > 4 * 1024 * 1024) throw new ServiceError(413, \"QUOTA_EXCEEDED\", \"Request body is too large\");\n  try {\n    return JSON.parse(new TextDecoder().decode(bytes));\n  } catch {\n    throw new ServiceError(400, \"BAD_REQUEST\", \"Invalid JSON\");\n  }\n}\nasync function readForm(request) {\n  const form = await request.formData();\n  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));\n}\nfunction parseBearer(value) {\n  const match = /^Bearer\\s+(.+)$/i.exec(value || \"\");\n  return match?.[1];\n}\nfunction parseCookie(value, name) {\n  const item = (value || \"\").split(\";\").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));\n  return item ? decodeURIComponent(item.slice(name.length + 1)) : void 0;\n}\nfunction sessionCookie(value, request) {\n  const secure = new URL(request.url).protocol === \"https:\" ? \"; Secure\" : \"\";\n  return `pn_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;\n}\nfunction clearCookie(request) {\n  const secure = new URL(request.url).protocol === \"https:\" ? \"; Secure\" : \"\";\n  return `pn_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;\n}\nfunction safeNext(value) {\n  const next = String(value || \"/account/usage\");\n  return next.startsWith(\"/\") && !next.startsWith(\"//\") ? next : \"/account/usage\";\n}\n\n// server/worker/index.ts\nvar index_default = {\n  async fetch(request, env, ctx) {\n    const service = createService(env, request);\n    return routeRequest({ service, request, env });\n  },\n  async scheduled(_controller, env, _ctx) {\n    await createService(env, new Request(\"https://worker.invalid/healthz\")).cleanup();\n  }\n};\nexport {\n  index_default as default\n};\n";
const EMBEDDED_TARGET_MIGRATION_SQL = "-- 0001_initial.sql\nPRAGMA foreign_keys = ON;\n\nCREATE TABLE IF NOT EXISTS accounts (\n  id TEXT PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  password_hash TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS recovery_codes (\n  id TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,\n  code_hash TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  used_at TEXT\n);\nCREATE TABLE IF NOT EXISTS sessions (\n  id TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS tokens (\n  id TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,\n  name TEXT NOT NULL,\n  token_hash TEXT NOT NULL UNIQUE,\n  scope TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  last_used_at TEXT,\n  expires_at TEXT,\n  revoked_at TEXT\n);\nCREATE TABLE IF NOT EXISTS sites (\n  site_id TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,\n  title TEXT NOT NULL,\n  source_path TEXT NOT NULL,\n  current_revision INTEGER NOT NULL,\n  byte_size INTEGER NOT NULL,\n  object_count INTEGER NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS sites_account_idx ON sites(account_id);\nCREATE TABLE IF NOT EXISTS revisions (\n  site_id TEXT NOT NULL,\n  revision INTEGER NOT NULL,\n  created_at TEXT NOT NULL,\n  PRIMARY KEY (site_id, revision),\n  FOREIGN KEY (site_id) REFERENCES sites(site_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS objects (\n  site_id TEXT NOT NULL,\n  revision INTEGER NOT NULL,\n  object_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  path TEXT NOT NULL,\n  content_type TEXT NOT NULL,\n  encoding TEXT NOT NULL,\n  chunk_count INTEGER NOT NULL,\n  byte_size INTEGER NOT NULL,\n  PRIMARY KEY (site_id, revision, object_id),\n  UNIQUE (site_id, revision, path),\n  FOREIGN KEY (site_id, revision) REFERENCES revisions(site_id, revision) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS object_chunks (\n  site_id TEXT NOT NULL,\n  revision INTEGER NOT NULL,\n  object_id TEXT NOT NULL,\n  chunk_index INTEGER NOT NULL,\n  r2_key TEXT NOT NULL,\n  byte_length INTEGER NOT NULL,\n  PRIMARY KEY (site_id, revision, object_id, chunk_index),\n  FOREIGN KEY (site_id, revision, object_id) REFERENCES objects(site_id, revision, object_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS uploads (\n  upload_id TEXT PRIMARY KEY,\n  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,\n  site_id TEXT NOT NULL,\n  revision INTEGER NOT NULL,\n  source_path TEXT NOT NULL,\n  title TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  format_version INTEGER NOT NULL,\n  chunk_protocol_version INTEGER NOT NULL,\n  expected_chunk_count INTEGER NOT NULL,\n  expected_object_count INTEGER NOT NULL,\n  declared_bytes INTEGER NOT NULL,\n  status TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  result_json TEXT,\n  UNIQUE (account_id, idempotency_key)\n);\nCREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads(status, expires_at);\nCREATE TABLE IF NOT EXISTS upload_objects (\n  upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE,\n  object_id TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  path TEXT NOT NULL,\n  content_type TEXT NOT NULL,\n  encoding TEXT NOT NULL,\n  chunk_count INTEGER NOT NULL,\n  byte_size INTEGER NOT NULL,\n  PRIMARY KEY (upload_id, object_id),\n  UNIQUE (upload_id, path)\n);\nCREATE TABLE IF NOT EXISTS upload_chunks (\n  upload_id TEXT NOT NULL,\n  object_id TEXT NOT NULL,\n  chunk_index INTEGER NOT NULL,\n  r2_key TEXT NOT NULL,\n  byte_length INTEGER NOT NULL,\n  PRIMARY KEY (upload_id, object_id, chunk_index),\n  FOREIGN KEY (upload_id, object_id) REFERENCES upload_objects(upload_id, object_id) ON DELETE CASCADE\n);\nCREATE TABLE IF NOT EXISTS device_authorizations (\n  id TEXT PRIMARY KEY,\n  device_code_hash TEXT NOT NULL UNIQUE,\n  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,\n  status TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  consumed_at TEXT,\n  token_name TEXT\n);\nCREATE INDEX IF NOT EXISTS device_authorizations_expiry_idx ON device_authorizations(status, expires_at);\nCREATE TABLE IF NOT EXISTS bootstrap_state (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  consumed_at TEXT\n);\nINSERT OR IGNORE INTO bootstrap_state(id, consumed_at) VALUES (1, NULL);\n\n\n-- 0002_d1_chunk_bodies.sql\n-- Personal D1-only Workers keep upload and published chunks in D1 BLOBs.\n-- Official and legacy R2-backed Workers leave both columns NULL.\nALTER TABLE object_chunks ADD COLUMN data BLOB;\nALTER TABLE upload_chunks ADD COLUMN data BLOB;\n";

class CloudflareProvisioningError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CloudflareProvisioningError";
    this.code = code;
    this.stage = details.stage || "authorization";
    this.httpStatus = details.httpStatus || 0;
    this.retryable = details.retryable === true;
    this.method = details.method || "";
    this.route = details.route || "";
    this.providerCode = sanitizeProviderCode(details.providerCode);
    this.providerMessage = sanitizeExternalMessage(details.providerMessage);
    this.responseContentType = sanitizeExternalMessage(details.responseContentType);
    this.causeMessage = sanitizeExternalMessage(details.causeMessage);
    this.remoteOutcome = sanitizeProviderCode(details.remoteOutcome);
    this.outcomeUnknown = details.outcomeUnknown === true;
    this.cleanupIncomplete = details.cleanupIncomplete === true;
  }
}

function isDesktopEnvironment() {
  return typeof Platform?.isDesktopApp === "boolean" ? Platform.isDesktopApp : Boolean(typeof process !== "undefined" && process.versions?.electron);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomUrlSecret(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  if (!globalThis.crypto?.getRandomValues) throw new CloudflareProvisioningError("CRYPTO_UNAVAILABLE", "Secure random generation is unavailable");
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function createOperationId(kind = "operation") {
  const safeKind = String(kind || "operation").replace(/[^a-z0-9_-]/gi, "-").slice(0, 32) || "operation";
  return `${safeKind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeOperationId(value) {
  return String(value || "").trim().replace(/[^a-z0-9._:-]/gi, "").slice(0, 96);
}

async function sha256Base64Url(value) {
  if (!globalThis.crypto?.subtle) throw new CloudflareProvisioningError("CRYPTO_UNAVAILABLE", "Secure hashing is unavailable");
  return bytesToBase64Url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", uploadTextEncoder.encode(value))));
}

async function hmacSha256Base64Url(secret, value) {
  if (!globalThis.crypto?.subtle) throw new CloudflareProvisioningError("CRYPTO_UNAVAILABLE", "Secure signing is unavailable");
  const key = await globalThis.crypto.subtle.importKey("raw", uploadTextEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, uploadTextEncoder.encode(value))));
}

function createLoopbackOAuthCallback(expectedState, timeoutMs = CLOUDFLARE_OAUTH_TIMEOUT_MS) {
  if (!isDesktopEnvironment()) throw new CloudflareProvisioningError("DESKTOP_REQUIRED", "Cloudflare deployment is available on Obsidian desktop only");
  let desktopHttp;
  try { desktopHttp = require("node:http"); } catch {
    try { desktopHttp = require("http"); } catch { throw new CloudflareProvisioningError("OAUTH_CALLBACK_UNAVAILABLE", "Desktop callback is unavailable"); }
  }
  let settled = false;
  let server;
  let timer;
  let resolveCode;
  let rejectCode;
  let resolveReady;
  let rejectReady;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A bind failure can reject `ready` before callers ever await `code`; consume the
  // rejection here so an unavailable port never becomes an unhandled rejection.
  void code.catch(() => undefined);
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (server?.listening) server.close(() => resolveClosed()); else resolveClosed();
    if (error) rejectCode(error); else resolveCode(value);
  };
  server = desktopHttp.createServer((request, response) => {
    response.setHeader("connection", "close");
    response.setHeader("cache-control", "no-store");
    if (settled) { response.statusCode = 410; response.end("Authorization callback already consumed."); return; }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    const state = String(url.searchParams.get("state") || "");
    if (state !== expectedState) {
      response.statusCode = 400;
      response.end("Authorization state could not be verified. Return to Obsidian and try again.");
      finish(new CloudflareProvisioningError("INVALID_OAUTH_STATE", "Cloudflare authorization could not be verified"));
      return;
    }
    const oauthError = String(url.searchParams.get("error") || "");
    if (oauthError) {
      response.statusCode = 400;
      response.end("Cloudflare authorization was denied. Return to Obsidian.");
      finish(new CloudflareProvisioningError("OAUTH_DENIED", "Cloudflare authorization was denied", {
        stage: "authorization",
        providerCode: oauthError,
        providerMessage: url.searchParams.get("error_description") || "",
      }));
      return;
    }
    const authorizationCode = String(url.searchParams.get("code") || "");
    if (!authorizationCode) {
      response.statusCode = 400;
      response.end("Cloudflare authorization did not return a code. Return to Obsidian and try again.");
      finish(new CloudflareProvisioningError("OAUTH_CALLBACK_INVALID", "Cloudflare authorization response is incomplete"));
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<p>Cloudflare authorization received. Return to Obsidian.</p>");
    finish(undefined, authorizationCode);
  });
  server.once("listening", () => resolveReady());
  server.once("error", () => {
    const error = new CloudflareProvisioningError("OAUTH_CALLBACK_UNAVAILABLE", "Could not start the local Cloudflare authorization callback");
    rejectReady(error);
    finish(error);
  });
  server.listen(8976, "127.0.0.1");
  timer = setTimeout(() => finish(new CloudflareProvisioningError("OAUTH_TIMEOUT", "Cloudflare authorization timed out")), timeoutMs);
  return { ready, code, closed, close() { finish(new CloudflareProvisioningError("OAUTH_CANCELLED", "Cloudflare authorization was cancelled")); } };
}

function deploymentRoute(url) {
  const path = new URL(url).pathname;
  if (path === "/healthz" || path === "/__internal/provision/initialize" || path === "/__internal/provision/reconnect") return path;
  return path.replace(/\/accounts\/[^/]+/, "/accounts/:account")
    .replace(/\/scripts\/[^/]+/, "/scripts/:worker")
    .replace(/\/database\/[^/]+/, "/database/:database");
}

function serviceRoute(value) {
  let path;
  try { path = new URL(String(value)).pathname; } catch { path = String(value || "").split(/[?#]/, 1)[0]; }
  return path
    .replace(/\/accounts\/[^/]+/, "/accounts/:account")
    .replace(/\/scripts\/[^/]+/, "/scripts/:worker")
    .replace(/\/database\/[^/]+/, "/database/:database")
    .replace(/\/v1\/uploads\/[^/]+\/chunks$/, "/v1/uploads/:upload/chunks")
    .replace(/\/v1\/uploads\/[^/]+\/commit$/, "/v1/uploads/:upload/commit");
}

function deploymentJson(response) {
  // Accessing Obsidian's .json getter can itself throw. Prefer text so an HTML
  // gateway response is classified as an HTTP/format error, not a network error.
  if (typeof response?.text === "string") return response.text.trim() ? JSON.parse(response.text) : {};
  return response?.json || {};
}

async function deploymentRequest(url, init = {}, options = {}) {
  const method = init.method || "GET";
  const readOnly = method === "GET" || method === "HEAD";
  const details = { stage: options.stage || "resources", method, route: deploymentRoute(url) };
  const attempts = readOnly ? 3 : 1;
  const debug = (entry) => { try { options.debugLog?.({ ...details, ...entry }); } catch { /* diagnostics must never affect deployment */ } };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let timer;
    let expired = false;
    const startedAt = Date.now();
    debug({ type: "request", attempt: attempt + 1 });
    try {
      const pending = Promise.resolve().then(() => requestUrl({ url, ...init, method, throw: false }));
      // requestUrl cannot abort a request. Late responses never continue the
      // deployment. A late OAuth token is revoked without saving or logging it.
      void pending.then((response) => expired && options.onLateResponse?.(response)).catch(() => undefined);
      const response = await Promise.race([
        pending,
        new Promise((_, reject) => { timer = setTimeout(() => {
          expired = true;
          reject(new CloudflareProvisioningError("REQUEST_TIMEOUT", "Deployment request timed out", { ...details, retryable: readOnly, outcomeUnknown: !readOnly }));
        }, options.timeoutMs ?? 30_000); }),
      ]);
      clearTimeout(timer);
      const status = Number(response?.status || 0);
      let payload;
      let parsed = true;
      try { payload = deploymentJson(response); } catch {
        parsed = false;
        const external = externalErrorDetails({}, response, false);
        if (status >= 200 && status < 300) throw new CloudflareProvisioningError("INVALID_RESPONSE", "Invalid deployment response", { ...details, ...external, outcomeUnknown: !readOnly });
        payload = {};
      }
      if (status < 200 || status >= 300 || payload?.success === false || payload?.error) {
        const external = externalErrorDetails(payload, response, parsed);
        throw new CloudflareProvisioningError(`CLOUDFLARE_${status}`, "Deployment service rejected the request", {
          ...details, ...external,
          retryable: readOnly && (status === 429 || status >= 500), outcomeUnknown: !readOnly && status >= 500,
        });
      }
      if (!payload || typeof payload !== "object") {
        const external = externalErrorDetails({}, response, parsed);
        throw new CloudflareProvisioningError("INVALID_RESPONSE", "Invalid deployment response", { ...details, ...external, outcomeUnknown: !readOnly });
      }
      debug({ type: "response", attempt: attempt + 1, httpStatus: status, ...externalErrorDetails(payload, response, parsed), durationMs: Date.now() - startedAt });
      return payload;
    } catch (cause) {
      clearTimeout(timer);
      const external = cause instanceof CloudflareProvisioningError ? {} : externalErrorDetails({}, cause, true, cause);
      const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("NETWORK_ERROR", "Deployment network request failed", {
        ...details, ...external, retryable: readOnly, outcomeUnknown: !readOnly,
      });
      debug({ type: "error", attempt: attempt + 1, error, durationMs: Date.now() - startedAt });
      if (!error.retryable || attempt + 1 === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 1000) * (attempt + 1)));
    }
  }
}

function encodeWorkerMultipart(metadata, workerModule = EMBEDDED_TARGET_WORKER_MODULE) {
  const metadataText = JSON.stringify(metadata);
  let boundary;
  do { boundary = `publish-note-${randomUrlSecret(24)}`; } while (metadataText.includes(boundary) || workerModule.includes(boundary));
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadataText}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n${workerModule}\r\n--${boundary}--\r\n`;
  const bytes = uploadTextEncoder.encode(body);
  return { body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function cloudflareApiRequest(path, accessToken, init = {}, options = {}) {
  const headers = { "content-type": "application/json", ...init.headers, authorization: `Bearer ${accessToken}` };
  const payload = await deploymentRequest(`${CLOUDFLARE_API_BASE_URL}${path}`, { ...init, headers }, options);
  if (!("result" in payload)) {
    const external = externalErrorDetails(payload, { status: 200 });
    throw new CloudflareProvisioningError("INVALID_RESPONSE", "Cloudflare result is missing", { stage: options.stage, method: init.method || "GET", route: deploymentRoute(`${CLOUDFLARE_API_BASE_URL}${path}`), ...external, outcomeUnknown: Boolean(init.method && init.method !== "GET") });
  }
  return payload.result;
}

async function exchangeCloudflareCode(codeValue, codeVerifier, options = {}) {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: CLOUDFLARE_OAUTH_CLIENT_ID, code: codeValue, redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URI, code_verifier: codeVerifier });
  const payload = await deploymentRequest(`${CLOUDFLARE_OAUTH_BASE_URL}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: String(body) }, {
    stage: "authorization",
    debugLog: options.debugLog,
    onLateResponse: async (response) => { const late = deploymentJson(response); if (late?.access_token) await revokeCloudflareToken(String(late.access_token), options); },
  });
  if (!payload.access_token) throw new CloudflareProvisioningError("OAUTH_TOKEN_EXCHANGE_FAILED", "Cloudflare authorization could not be completed");
  return String(payload.access_token);
}

async function revokeCloudflareToken(accessToken, options = {}) {
  const body = new URLSearchParams({ token: accessToken, client_id: CLOUDFLARE_OAUTH_CLIENT_ID });
  await deploymentRequest(`${CLOUDFLARE_OAUTH_BASE_URL}/oauth2/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: String(body) }, { stage: "authorization_cleanup", debugLog: options.debugLog });
}

async function authorizeCloudflareScope(scope, options = {}) {
  const state = randomUrlSecret(32);
  const codeVerifier = randomUrlSecret(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const callback = createLoopbackOAuthCallback(state);
  try {
    await callback.ready;
    const authorization = new URL(`${CLOUDFLARE_OAUTH_BASE_URL}/oauth2/auth`);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", CLOUDFLARE_OAUTH_CLIENT_ID);
    authorization.searchParams.set("redirect_uri", CLOUDFLARE_OAUTH_REDIRECT_URI);
    authorization.searchParams.set("scope", scope);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", codeChallenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    openExternalUrl(authorization.toString());
    const code = await callback.code;
    const accessToken = await exchangeCloudflareCode(code, codeVerifier, options);
    return { callback, accessToken };
  } catch (error) {
    options.debugLog?.({ type: "oauth_error", stage: "authorization", error });
    callback.close();
    await callback.closed;
    throw error;
  }
}

async function findCloudflareZone(accessToken, accountId, hostname, options = {}) {
  const labels = normalizeCustomDomain(hostname).split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    const zones = await cloudflareApiRequest(`/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(candidate)}&per_page=50&page=1`, accessToken, {}, options);
    const zone = findCloudflareZoneForHostname(hostname, zones);
    if (zone) return zone;
  }
  return undefined;
}

function splitMigrationStatements(sql) {
  const withoutComments = String(sql || "").replace(/^\s*--.*$/gm, "");
  const statements = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (quote) { if (character === quote && withoutComments[index - 1] !== "\\") quote = ""; continue; }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === ";") { const statement = withoutComments.slice(start, index).trim(); if (statement) statements.push(statement); start = index + 1; }
  }
  const tail = withoutComments.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

const PERSONAL_D1_NAME_PATTERN = /^publish-note(?:-[a-z0-9-]+)?$/i;
const PERSONAL_D1_REQUIRED_TABLES = [
  "accounts", "recovery_codes", "sessions", "tokens", "sites", "revisions", "objects", "object_chunks",
  "uploads", "upload_objects", "upload_chunks", "device_authorizations", "bootstrap_state",
];

function d1QueryItems(value) {
  const queries = Array.isArray(value) ? value : [value];
  return queries.flatMap((query) => Array.isArray(query?.results) ? query.results : []);
}

function d1QuerySucceeded(value) {
  const queries = Array.isArray(value) ? value : [value];
  return queries.length > 0 && queries.every((query) => query?.success !== false);
}

async function inspectHistoricalPersonalD1(cf, accountId, database) {
  const queryPath = `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(database.id)}/query`;
  const runQuery = async (sql) => {
    const result = await cf(queryPath, { method: "POST", body: JSON.stringify({ sql, params: [] }) });
    if (!d1QuerySucceeded(result)) throw new CloudflareProvisioningError("D1_INSPECTION_FAILED", "Could not inspect an existing Cloudflare D1 database", { stage: "resources" });
    return d1QueryItems(result);
  };
  const tableRows = await runQuery("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(tableRows.map((row) => String(row.name || "").toLowerCase()).filter(Boolean));
  if (!PERSONAL_D1_REQUIRED_TABLES.every((name) => tables.has(name))) return { database, historical: false, columns: {} };
  const columns = {};
  for (const table of ["object_chunks", "upload_chunks"]) {
    columns[table] = new Set((await runQuery(`PRAGMA table_info(${table})`)).map((row) => String(row.name || "").toLowerCase()).filter(Boolean));
  }
  return { database, historical: true, columns };
}

async function findHistoricalPersonalD1(cf, accountId, databases, workerNames) {
  const candidates = databases.filter((database) => PERSONAL_D1_NAME_PATTERN.test(database.name) && database.id);
  const recognized = [];
  for (const database of candidates) {
    const inspected = await inspectHistoricalPersonalD1(cf, accountId, database);
    if (inspected.historical) recognized.push(inspected);
  }
  if (recognized.length === 0) return undefined;
  if (recognized.length === 1) return recognized[0];
  const matchingWorkers = recognized.filter((value) => workerNames.includes(value.database.name));
  if (matchingWorkers.length === 1) return matchingWorkers[0];
  throw new CloudflareProvisioningError("MULTIPLE_HISTORICAL_DATABASES", "More than one historical One-Click Publish database was found; deployment was stopped to protect existing content", { stage: "resources" });
}

function migrationStatementsForDatabase(sql, schema) {
  const statements = splitMigrationStatements(sql);
  if (!schema) return statements;
  return statements.filter((statement) => {
    const match = /^ALTER TABLE (object_chunks|upload_chunks) ADD COLUMN data BLOB$/i.exec(statement.trim());
    return !match || !schema.columns[match[1]]?.has("data");
  });
}

function choosePersonalCloudflareNames(accountId, d1Names, workerNames) {
  const accountSuffix = String(accountId || "account").replace(/[^A-Za-z0-9-]/g, "").slice(0, 8).replace(/^-+|-+$/g, "").toLowerCase() || "account";
  const chooseName = (occupiedNames) => {
    const occupied = new Set(occupiedNames);
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${accountSuffix}${index === 1 ? "" : `-${index}`}`;
      const name = `${CLOUDFLARE_RESOURCE_PREFIX}${suffix}`;
      if (!occupied.has(name)) return name;
    }
    throw new CloudflareProvisioningError("RESOURCE_NAME_UNAVAILABLE", "Could not find an available Cloudflare resource name");
  };
  // Worker and D1 use separate Cloudflare namespaces. Keep the public Worker
  // hostname stable even when an unrelated D1 database already uses the base
  // name; only a conflicting Worker should change the hostname.
  const worker = chooseName(workerNames);
  const d1 = chooseName(d1Names);
  return { worker, d1 };
}

function chooseHistoricalPersonalWorker(historicalD1, workerNames) {
  const historicalName = historicalD1?.database.name;
  if (historicalName && workerNames.includes(historicalName)) return { name: historicalName, exact: true };
  const candidates = workerNames.filter((name) => PERSONAL_D1_NAME_PATTERN.test(name));
  if (candidates.length === 1) return { name: candidates[0], exact: false };
  return undefined;
}

async function initializePersonalWorker(serviceUrl, ownerKey, bootstrapSecret, expiresAt, signature, options = {}) {
  // Fresh databases consume the bootstrap claim; historical databases only
  // use it to issue a new token for the existing personal account.
  const endpoint = options.reconnect ? "reconnect" : "initialize";
  const payload = await deploymentRequest(`${serviceUrl}/__internal/provision/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-publish-note-bootstrap-secret": bootstrapSecret },
    body: JSON.stringify({ ownerKey, expiresAt, signature, tokenName: "Obsidian plugin" }),
  }, { stage: "initialize", debugLog: options.debugLog });
  if (!payload.publishToken?.startsWith("pn_")) throw new CloudflareProvisioningError("INVALID_RESPONSE", "Initialization result is incomplete", { stage: "initialize", outcomeUnknown: true });
  return { serviceUrl, publishToken: String(payload.publishToken), workerName: options.workerName || workerNameFromServiceUrl(serviceUrl) };
}

async function provisionPersonalCloudflare(accessToken, onStatus = () => {}, options = {}) {
  if (EMBEDDED_TARGET_ARTIFACT_HASH.startsWith("__PUBLISH_NOTE_")) throw new CloudflareProvisioningError("WORKER_ARTIFACT_MISSING", "The self-deployment Worker artifact version is not included in this plugin build");
  if (EMBEDDED_TARGET_WORKER_MODULE.startsWith("__PUBLISH_NOTE_")) throw new CloudflareProvisioningError("WORKER_ARTIFACT_MISSING", "The self-deployment Worker artifact is not included in this plugin build");
  if (EMBEDDED_TARGET_MIGRATION_SQL.startsWith("__PUBLISH_NOTE_")) throw new CloudflareProvisioningError("MIGRATION_ARTIFACT_MISSING", "The self-deployment migration is not included in this plugin build");
  let stage = "accounts";
  const step = (value) => { stage = value; onStatus(value); };
  const cf = (path, init = {}, options = {}) => cloudflareApiRequest(path, accessToken, init, { stage, ...options });
  step("accounts");
  // Cloudflare currently caps the accounts endpoint at 50 items per page.
  // Personal deployment accepts exactly one account, so a single bounded page
  // is sufficient and avoids a server-side validation error.
  const accounts = await cf("/accounts?per_page=50");
  if (!Array.isArray(accounts) || accounts.length === 0) throw new CloudflareProvisioningError("NO_ACCOUNT_ACCESS", "No Cloudflare account is available for this authorization");
  if (accounts.length > 1) throw new CloudflareProvisioningError("MULTIPLE_ACCOUNTS", "Authorize exactly one Cloudflare account for personal deployment");
  const accountId = String(accounts[0].id || "");
  if (!accountId) throw new CloudflareProvisioningError("NO_ACCOUNT_ACCESS", "Cloudflare did not return an account for this authorization");
  step("resources");
  const [d1Databases, workerNames] = await Promise.all([
    cf(`/accounts/${encodeURIComponent(accountId)}/d1/database`),
    cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts`),
  ]);
  const databaseRecords = (d1Databases || [])
    .map((value) => ({ id: String(value.uuid || value.database_id || value.id || ""), name: String(value.name || "") }))
    .filter((value) => value.id && value.name);
  const availableWorkerNames = (workerNames || []).map((value) => String(value.id || value.name || value)).filter(Boolean);
  const historicalD1 = await findHistoricalPersonalD1(cf, accountId, databaseRecords, availableWorkerNames);
  const historicalWorker = chooseHistoricalPersonalWorker(historicalD1, availableWorkerNames);
  const generatedNames = choosePersonalCloudflareNames(accountId, databaseRecords.map((value) => value.name), availableWorkerNames);
  const workerName = historicalWorker?.name
    || (historicalD1 && !availableWorkerNames.includes(historicalD1.database.name) ? historicalD1.database.name : generatedNames.worker);
  const d1Name = historicalD1?.database.name
    || (historicalWorker && !databaseRecords.some((database) => database.name === historicalWorker.name) ? historicalWorker.name : generatedNames.d1);
  const names = { worker: workerName, d1: d1Name };
  const reusingWorker = Boolean(historicalWorker);
  let createdD1;
  let databaseId = "";
  let createdWorker = false;
  try {
    step("database");
    if (historicalD1) {
      databaseId = historicalD1.database.id;
    } else {
      const database = await cf(`/accounts/${encodeURIComponent(accountId)}/d1/database`, { method: "POST", body: JSON.stringify({ name: names.d1 }) });
      createdD1 = databaseId = String(database?.uuid || database?.database_id || database?.id || "");
      if (!createdD1) throw new CloudflareProvisioningError("INVALID_RESPONSE", "Database result is incomplete", { stage, outcomeUnknown: true });
    }
    step("subdomain");
    let subdomain;
    try { subdomain = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`); } catch (error) {
      if (!(error instanceof CloudflareProvisioningError) || !error.code.endsWith("_404")) throw error;
    }
    if (!subdomain?.subdomain) subdomain = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain: `${CLOUDFLARE_RESOURCE_PREFIX}-${accountId.slice(0, 8).toLowerCase()}` }) });
    if (!subdomain?.subdomain) throw new CloudflareProvisioningError("WORKERS_SUBDOMAIN_FAILED", "Cloudflare workers.dev subdomain is unavailable");
    const serviceUrl = `https://${names.worker}.${subdomain.subdomain}.workers.dev`;
    const bootstrapSecret = randomUrlSecret(32);
    const ownerKey = randomUrlSecret(18);
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-09-15",
      bindings: [
        { name: "DB", type: "d1", id: databaseId },
        { name: "BOOTSTRAP_SECRET", type: "secret_text", text: bootstrapSecret },
        { name: "PUBLIC_BASE_URL", type: "plain_text", text: serviceUrl },
        { name: "PUBLISH_NOTE_VERSION", type: "plain_text", text: EMBEDDED_TARGET_PLUGIN_VERSION },
      ],
    };
    step("worker_upload");
    // Reusing a historical Worker means updating that same script in place so
    // its URL and D1 binding survive reconnects. The upload only refreshes the
    // one-time bootstrap secret needed to issue a new Publish Token.
    await cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(names.worker)}`, { method: "PUT", ...encodeWorkerMultipart(metadata) }, { timeoutMs: 90_000 });
    createdWorker = !reusingWorker;
    step("worker_enable");
    const enabled = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(names.worker)}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: false }) });
    if (enabled?.enabled !== true) throw new CloudflareProvisioningError("WORKERS_SUBDOMAIN_FAILED", "Worker address is not enabled", { stage });
    step("migration");
    for (const statement of migrationStatementsForDatabase(EMBEDDED_TARGET_MIGRATION_SQL, historicalD1)) {
      const queries = await cf(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, { method: "POST", body: JSON.stringify({ sql: statement, params: [] }) });
      if (!Array.isArray(queries) || queries.length === 0 || queries.some((query) => query.success !== true)) throw new CloudflareProvisioningError("MIGRATION_FAILED", "Database migration failed", { stage });
    }
    step("ready_check");
    let ready = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const health = await deploymentRequest(`${serviceUrl}/healthz`, {}, { stage, debugLog: options.debugLog });
        if (health.status !== "ok" || health.service !== "publish-note" || String(health.version || "") !== EMBEDDED_TARGET_PLUGIN_VERSION) {
          throw new CloudflareProvisioningError("WORKER_VERSION_MISMATCH", "Worker version does not match this plugin", { stage });
        }
        ready = true;
        break;
      } catch (error) {
        if (attempt === 7 || !(error.retryable || error.httpStatus === 404)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
      }
    }
    if (!ready) throw new CloudflareProvisioningError("TARGET_INITIALIZATION_FAILED", "Worker is not ready", { stage });
    step("initialize");
    const expiresAt = new Date(Date.now() + CLOUDFLARE_BOOTSTRAP_TIMEOUT_MS).toISOString();
    const signature = await hmacSha256Base64Url(bootstrapSecret, `${ownerKey}\n${expiresAt}`);
    const initialized = await initializePersonalWorker(serviceUrl, ownerKey, bootstrapSecret, expiresAt, signature, { ...options, reconnect: Boolean(historicalD1), workerName: names.worker });
    step("bootstrap_cleanup");
    await cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(names.worker)}/secrets/BOOTSTRAP_SECRET`, { method: "DELETE" });
    return initialized;
  } catch (cause) {
    const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("PROVISIONING_FAILED", "Cloudflare personal deployment failed", { stage });
    // Do not delete dependencies while an unconfirmed write may still be running.
    if (error.outcomeUnknown) { error.cleanupIncomplete = true; throw error; }
    step("cleanup");
    try {
      if (createdWorker) await cf(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(names.worker)}`, { method: "DELETE" });
      if (createdD1) await cf(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(createdD1)}`, { method: "DELETE" });
    } catch { error.cleanupIncomplete = true; }
    throw error;
  }
}

function normalizeLinkedPageDepth(value, fallback = 1) {
  const parsed = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function shouldFollowLinkedPage(depth, maxDepth) {
  return maxDepth > 0 && depth < maxDepth;
}

function splitUploadText(value, maxBytes = DEFAULT_UPLOAD_CHUNK_BYTES) {
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    let bytes = 0;
    while (end < value.length) {
      const character = String.fromCodePoint(value.codePointAt(end));
      const characterBytes = uploadTextEncoder.encode(character).byteLength;
      if (end > start && bytes + characterBytes > maxBytes) break;
      bytes += characterBytes;
      end += character.length;
      if (bytes >= maxBytes) break;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length > 0 ? chunks : [""];
}

function decodeUploadBase64(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Binary asset body is not valid base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeUploadBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function createNativeStylesheetAsset(css) {
  return { path: "assets/obsidian-snapshot.css", contentType: "text/css", body: encodeUploadBase64(uploadTextEncoder.encode(String(css || ""))), encoding: "base64" };
}

function createUploadChunks(bundle, maxBytes = DEFAULT_UPLOAD_CHUNK_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("Upload chunk size must be a positive integer");
  const objects = [
    ...bundle.pages.map((page) => ({ kind: "page", ...page })),
    ...bundle.assets.map((asset) => ({ kind: "asset", ...asset })),
  ];
  return objects.flatMap((object) => {
    const binaryBytes = object.encoding === "base64" ? decodeUploadBase64(object.body) : null;
    const bodies = object.encoding === "base64"
      ? Array.from({ length: Math.max(1, Math.ceil(binaryBytes.byteLength / maxBytes)) }, (_, index) => {
          const bytes = binaryBytes.slice(index * maxBytes, (index + 1) * maxBytes);
          return encodeUploadBase64(bytes);
        })
      : splitUploadText(object.body, maxBytes);
    return bodies.map((body, chunkIndex) => ({
      chunkProtocolVersion: 2,
      kind: object.kind,
      path: object.path,
      contentType: object.contentType,
      encoding: object.encoding,
      chunkIndex,
      chunkCount: bodies.length,
      byteLength: object.encoding === "base64" ? decodeUploadBase64(body).byteLength : uploadTextEncoder.encode(body).byteLength,
      body,
    }));
  });
}

function pageSlug(value) {
  return sourceKey(value).replace(/[^a-z0-9/_-]+/gi, "-").replace(/-+/g, "-").replace(/^[-/]+|[-/]+$/g, "") || "index";
}

function encodePath(value) {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function isExternalUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value.trim());
}

function isExternalReference(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("#") || isExternalUrl(trimmed);
}

function relativeHref(fromPagePath, targetPagePath) {
  const fromParts = fromPagePath.split("/");
  fromParts.pop();
  const targetParts = targetPagePath.split("/");
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
    common += 1;
  }
  const prefix = "../".repeat(fromParts.length - common) || "./";
  return `${prefix}${encodePath(targetParts.slice(common).join("/")) || "index.html"}`;
}

function resolveRelativeSourcePath(target, currentSourcePath) {
  let normalized = target.replaceAll("\\", "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep malformed or partially encoded paths for the normal lookup fallback.
  }
  if (!currentSourcePath || !/^\.\.?\//.test(normalized)) return normalized;
  const parts = currentSourcePath.replaceAll("\\", "/").split("/");
  parts.pop();
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolvePageHref(target, context = {}) {
  if (isExternalReference(target)) return target.trim();
  const [rawTarget, rawAnchor] = target.split("#", 2);
  const resolvedTarget = resolveRelativeSourcePath(rawTarget, context.currentSourcePath);
  const targetKey = sourceKey(resolvedTarget);
  const mappedPath = context.pagePaths?.get(targetKey)
    || [...(context.pagePaths?.entries() || [])].find(([key]) => key.endsWith(`/${targetKey}`))?.[1];
  if (context.pagePaths && !mappedPath) return undefined;
  const pagePath = mappedPath || `${pageSlug(resolvedTarget)}.html`;
  const href = context.currentPagePath ? relativeHref(context.currentPagePath, pagePath) : `./${encodePath(pagePath)}`;
  return rawAnchor ? `${href}#${encodeURIComponent(rawAnchor)}` : href;
}

function resolveMarkdownLinkHref(href, context = {}) {
  const trimmed = href.trim();
  if (isExternalReference(trimmed) || !/\.md(?:#|$)/i.test(trimmed)) return trimmed;
  return resolvePageHref(trimmed.replace(/\.md(?=#|$)/i, ""), context);
}

function resolveAssetPath(sourcePath, context = {}) {
  if (isExternalUrl(sourcePath)) return sourcePath;
  const normalized = sourcePath.replaceAll("\\", "/");
  const assetKeys = [sourceKey(normalized), sourceKey(normalized.split("/").pop() || normalized)];
  const assetPath = assetKeys.map((key) => context.assetPaths?.get(key)).find(Boolean);
  if (assetPath) return context.currentPagePath ? relativeHref(context.currentPagePath, assetPath) : `./${encodePath(assetPath)}`;
  const name = sourcePath.replaceAll("\\", "/").split("/").pop() || sourcePath;
  return `./${encodePath(`assets/${name}`)}`;
}

function splitTableRow(line) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function inlineMarkdown(value, context = {}) {
  let html = escapeHtml(value);
  html = html.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, sourcePath, alt) => `<img src="${escapeHtml(resolveAssetPath(sourcePath.trim(), context))}" alt="${escapeHtml((alt || sourcePath).trim())}">`);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, sourcePath) => `<img src="${escapeHtml(resolveAssetPath(sourcePath.trim(), context))}" alt="${escapeHtml(alt)}">`);
  html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, label) => {
    const text = (label || target).trim();
    const href = resolvePageHref(target.trim(), context);
    return href
      ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`
      : `<span class="internal-link-unpublished" title="Linked page is not included">${escapeHtml(text)}</span>`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const resolvedHref = resolveMarkdownLinkHref(href, context);
    return resolvedHref
      ? `<a href="${escapeHtml(resolvedHref)}">${label}</a>`
      : `<span class="internal-link-unpublished" title="Linked page is not included">${label}</span>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/_([^_]+)_/g, "<em>$1</em>");
  return html;
}

function renderTable(lines, context = {}) {
  const header = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow);
  const headerHtml = header.map((cell) => `<th>${inlineMarkdown(cell, context)}</th>`).join("");
  const rowsHtml = rows.map((row) => `<tr>${header.map((_cell, index) => `<td>${inlineMarkdown(row[index] || "", context)}</td>`).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

function renderCallout(lines, context = {}) {
  const first = /^>\s*\[!([^\]]+)\]\s*(.*)$/.exec(lines[0]);
  if (!first) return "";
  const kind = first[1].trim().toLowerCase();
  const title = first[2].trim() || first[1].trim();
  const content = lines.slice(1).map((line) => line.replace(/^>\s?/, "")).join("\n");
  return `<aside class="callout callout-${escapeHtml(kind)}"><div class="callout-title">${escapeHtml(title)}</div><div class="callout-content">${renderMarkdown(content, context)}</div></aside>`;
}

function renderHeadingSection(section) {
  const content = section.items.map((item) => typeof item === "string" ? item : renderHeadingSection(item)).join("\n");
  return `<details class="heading-section heading-level-${section.level}" open><summary>${section.heading}</summary>${content}</details>`;
}

function wrapHeadingSections(blocks) {
  const roots = [];
  const stack = [];
  for (const block of blocks) {
    const heading = /^<h([1-6])(?:\s[^>]*)?>[\s\S]*<\/h\1>$/.exec(block.trim());
    if (!heading) {
      (stack.at(-1)?.items || roots).push(block);
      continue;
    }
    const section = { level: Number(heading[1]), heading: block.trim(), items: [] };
    while (stack.length > 0 && stack.at(-1).level >= section.level) stack.pop();
    (stack.at(-1)?.items || roots).push(section);
    stack.push(section);
  }
  return roots.map((item) => typeof item === "string" ? item : renderHeadingSection(item)).join("\n");
}

function renderList(lines, context = {}) {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[0]);
  const tag = ordered ? "ol" : "ul";
  const items = lines.map((line) => {
    const match = ordered ? /^\s*\d+[.)]\s+(.+)$/.exec(line) : /^\s*[-+*]\s+(.+)$/.exec(line);
    const value = match?.[1] || line.trim();
    const task = /^\[([ xX])\]\s+(.+)$/.exec(value);
    if (!task) return `<li>${inlineMarkdown(value, context)}</li>`;
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return `<li class="task-list-item"><input type="checkbox" disabled${checked}> ${inlineMarkdown(task[2], context)}</li>`;
  }).join("\n");
  return `<${tag}>${items}</${tag}>`;
}

function renderMarkdown(markdown, context = {}) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let index = 0;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${inlineMarkdown(paragraph.join(" "), context)}</p>`);
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushParagraph();
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(`<pre><code${className}>${escapeHtml(codeLines.join("\n"))}</code><button type="button" class="copy-code-button" aria-label="Copy code">Copy</button></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2], context)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s*\[![^\]]+\]/.test(line)) {
      flushParagraph();
      const calloutLines = [line];
      index += 1;
      while (index < lines.length && /^>/.test(lines[index])) {
        calloutLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderCallout(calloutLines, context));
      continue;
    }

    if (/^>/.test(line)) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && /^>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), context)}</blockquote>`);
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderTable(tableLines, context));
      continue;
    }

    if (/^\s*(?:[-+*]\s+|\d+[.)]\s+)/.test(line)) {
      flushParagraph();
      const listLines = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-+*]\s+/;
      while (index < lines.length && pattern.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(listLines, context));
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return wrapHeadingSections(blocks);
}

function defaultAssetPath(sourcePath) {
  const name = sourcePath.replaceAll("\\", "/").split("/").pop() || sourcePath;
  return `assets/${name.replace(/[^a-z0-9._-]+/gi, "-")}`;
}

function extractAssetReferences(markdown) {
  const references = [];
  for (const match of markdown.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) references.push(match[1]);
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) references.push(match[1]);
  return [...new Set(references)];
}

function mimeTypeFor(extension) {
  const types = {
    avif: "image/avif",
    css: "text/css",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    md: "text/markdown",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
  };
  return types[String(extension || "").toLowerCase()] || "application/octet-stream";
}

function sanitizeSnapshotClasses(value) {
  const layoutClasses = new Set([
    "app-container",
    "obsidian-app",
    "is-frameless",
    "is-hidden-frameless",
    "is-maximized",
    "is-focused",
    "is-translucent",
    "is-floating-nav",
    "auto-full-screen",
    "show-ribbon",
    "show-view-header",
    "mod-macos",
    "mod-windows",
    "mod-linux",
  ]);
  return String(value || "").split(/\s+/).filter((className) => className && !layoutClasses.has(className)).join(" ");
}

function pageHtml(title, body, navigation = "", options = {}) {
  const pagePath = options.pagePath || "index.html";
  const stylesheetHref = options.stylesheetPath ? relativeHref(pagePath, options.stylesheetPath) : "";
  const htmlClasses = ["share-publisher-page", sanitizeSnapshotClasses(options.htmlClass)].filter(Boolean).join(" ");
  const bodyClasses = ["share-publisher-page", sanitizeSnapshotClasses(options.bodyClass)].filter(Boolean).join(" ");
  const htmlClass = ` class="${escapeHtml(htmlClasses)}"`;
  const bodyClass = ` class="${escapeHtml(bodyClasses)}"`;
  return `<!doctype html>
<html lang="en"${htmlClass}>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    ${stylesheetHref ? `<link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">` : ""}
    <style>html.share-publisher-page,body.share-publisher-page{width:auto!important;min-width:0;height:auto!important;min-height:100%;overflow:visible!important;contain:initial!important}body.share-publisher-page{display:block!important;position:static!important;user-select:text!important;max-width:54rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.65 var(--font-text,system-ui,sans-serif);font-size:var(--font-text-size,16px);color:var(--text-normal,#202124);background:var(--background-primary,#fff)}main.markdown-rendered{min-width:0}.page-title{margin:0 0 2rem;border-bottom:1px solid var(--background-modifier-border,#e5e5e7);padding-bottom:.75rem}.page-title h1{margin:0}.heading-section>summary{cursor:pointer;list-style:none;position:relative}.heading-section>summary::-webkit-details-marker{display:none}.heading-section>summary::marker{content:""}.heading-section>summary::before{content:"";position:absolute;inset-inline-start:-1.1em;inset-block-start:50%;width:0;height:0;border-block:.35em solid transparent;border-inline-start:.5em solid var(--text-muted,#888);opacity:0;transform:translateY(-50%);transition:opacity .12s ease,transform .12s ease}.heading-section>summary:hover::before,.heading-section>summary:focus-visible::before{opacity:1}.heading-section[open]>summary::before{transform:translateY(-50%) rotate(90deg)}.copy-code-button{cursor:pointer}.copy-code-button.is-copied{color:var(--text-accent,#7c3aed)}img,video,svg{max-width:100%;height:auto}nav{padding:.75rem 1rem;margin-bottom:2rem;background:var(--background-secondary,#f7f7f8);border-radius:.5rem}nav ul{margin:.35rem 0 0;padding-left:1.2rem}pre{position:relative;padding:1rem;overflow:auto;background:var(--code-background,#f4f4f5);border-radius:.5rem}code{font-family:var(--font-monospace,ui-monospace,monospace)}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid var(--background-modifier-border,#d7d7dc);padding:.5rem;text-align:left}th{background:var(--background-secondary,#f4f4f5)}blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:4px solid var(--interactive-accent,#c7c7cc);background:var(--background-secondary,#fafafa)}.callout{margin:1rem 0;padding:1rem;border:1px solid var(--background-modifier-border,#d7d7dc);border-radius:.5rem;background:var(--background-secondary,#fafafa)}.callout-title{font-weight:700;margin-bottom:.35rem}.callout-content{margin-top:.35rem}.callout-note,.callout-tip{border-color:#82b1ff;background:#f4f8ff}.callout-warning,.callout-caution{border-color:#e5b84b;background:#fff9e6}.task-list-item{list-style:none;margin-left:-1.5rem}.task-list-item-checkbox{margin-right:.4rem}</style>
    <style>.copy-code-button{position:absolute;inset-block-start:.5rem;inset-inline-end:.5rem}</style>
  </head>
    <body${bodyClass}>
      <main class="markdown-rendered">
        <header class="page-title"><h1>${escapeHtml(title)}</h1></header>
${navigation}${body}
      <script>
document.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest(".copy-code-button") : null;
  if (!button) return;
  const code = button.closest("pre")?.querySelector("code");
  if (!code) return;
  const text = code.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  const previousLabel = button.getAttribute("aria-label") || "Copy code";
  button.setAttribute("aria-label", "Copied");
  button.classList.add("is-copied");
  window.setTimeout(() => {
    button.setAttribute("aria-label", previousLabel);
    button.classList.remove("is-copied");
  }, 1200);
});
      </script>
      </main>
  </body>
</html>`;
}

function compareSourcePaths(left, right) {
  const leftKey = sourceKey(left.sourcePath);
  const rightKey = sourceKey(right.sourcePath);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0;
}

function shareNotes(input) {
  const rootKey = sourceKey(input.root.sourcePath);
  const related = new Map();
  for (const note of input.relatedNotes || []) {
    const key = sourceKey(note.sourcePath);
    if (key !== rootKey && !related.has(key)) related.set(key, note);
  }
  return [input.root, ...[...related.values()].sort(compareSourcePaths)];
}

function relatedPagePath(index) {
  return `page-${index}.html`;
}

function buildAssetPathMap(inputs) {
  const assetPaths = new Map();
  for (const asset of inputs || []) {
    const path = asset.path || defaultAssetPath(asset.sourcePath);
    const normalized = asset.sourcePath.replaceAll("\\", "/");
    assetPaths.set(sourceKey(normalized), path);
    assetPaths.set(sourceKey(normalized.split("/").pop() || normalized), path);
  }
  return assetPaths;
}

function renderedPath(value) {
  if (!value) return "";
  let result = value;
  try {
    result = decodeURIComponent(value);
  } catch {
    // Keep the original URL when a plugin emits an incomplete percent escape.
  }
  result = result.replace(/^[a-z]+:\/\/[^/]+\/?/i, "");
  return result.replace(/^\/+/, "");
}

function codeBlockSources(markdown, language) {
  const sources = [];
  const fence = "```";
  const pattern = new RegExp(`^${fence}${language}\\s*\\n([\\s\\S]*?)^${fence}\\s*$`, "gim");
  for (const match of markdown.matchAll(pattern)) sources.push(match[1].trim());
  return sources;
}

function dynamicLanguages(markdown) {
  const languages = [];
  for (const match of markdown.matchAll(/^```([^\s`]+)?/gm)) {
    const language = String(match[1] || "").toLowerCase();
    if (language && !["js", "javascript", "ts", "typescript", "css", "html", "json", "yaml", "md", "markdown", "text"].includes(language)) {
      languages.push(language);
    }
  }
  return [...new Set(languages)];
}

async function waitForDynamicBlocks(container, markdown) {
  const languages = dynamicLanguages(markdown);
  if (languages.length === 0) return;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const settled = languages.every((language) => [...container.querySelectorAll(`.block-language-${language}`)].every((block) => block.children.length > 0 || block.textContent.trim().length > 0));
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function parseTaskLines(markdown) {
  const tasks = [];
  let fenced = false;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(\s*)[-+*]\s+\[([^\]])\]\s+(.+)$/.exec(line);
    if (!match) continue;
    tasks.push({
      indent: match[1].length,
      status: match[2],
      description: match[3].trim(),
    });
  }
  return tasks;
}

function taskQueryLimit(query) {
  const match = /(?:^|\n)\s*limit\s+(\d+)/i.exec(query);
  return Math.max(1, Math.min(Number(match?.[1] || 500), 2000));
}

function filterTaskSnapshot(tasks, query) {
  const normalized = query.toLowerCase();
  const wantsNotDone = /\bnot\s+done\b/.test(normalized);
  const wantsDone = !wantsNotDone && /\bdone\b/.test(normalized);
  return tasks.filter((task) => {
    const done = /^[x✓✔]$/i.test(task.status);
    if (wantsNotDone && done) return false;
    if (wantsDone && !done) return false;
    const pathFilter = /(?:path|file)\s+includes\s+(.+)/i.exec(query);
    if (pathFilter && !task.sourcePath.toLowerCase().includes(pathFilter[1].trim().toLowerCase())) return false;
    return true;
  });
}

async function collectVaultTaskSnapshot(plugin) {
  const files = plugin.app.vault.getMarkdownFiles();
  const tasks = [];
  for (const file of files) {
    const markdown = await plugin.app.vault.cachedRead(file);
    for (const task of parseTaskLines(markdown)) tasks.push({ ...task, sourcePath: file.path });
  }
  return tasks;
}

async function renderTasksSnapshot(plugin, query, context) {
  const tasks = filterTaskSnapshot(await collectVaultTaskSnapshot(plugin), query).slice(0, taskQueryLimit(query));
  if (tasks.length === 0) return `<p class="tasks-query-empty">No tasks found.</p>`;
  const items = tasks.map((task) => {
    const checked = /^[x✓✔]$/i.test(task.status) ? " checked" : "";
    const indent = Math.min(task.indent, 8);
    return `<li class="task-list-item tasks-query-item" style="margin-left:${indent * 1.25}rem"><input type="checkbox" disabled${checked}> ${renderMarkdown(task.description, context)}</li>`;
  }).join("\n");
  return `<ul class="contains-task-list tasks-query-snapshot">${items}</ul>`;
}

async function fillEmptyTasksBlocks(plugin, container, markdown, context) {
  const queries = codeBlockSources(markdown, "tasks");
  const blocks = [...container.querySelectorAll(".block-language-tasks")];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.children.length > 0 || block.textContent.trim().length > 0) continue;
    block.innerHTML = await renderTasksSnapshot(plugin, queries[index] || "", context);
  }
}

function resolveRenderedAsset(element, context) {
  const candidates = [element.getAttribute("data-src"), element.getAttribute("src")].filter(Boolean);
  for (const candidate of candidates) {
    if (isExternalUrl(candidate)) continue;
    const clean = renderedPath(candidate.split("#", 1)[0].split("?", 1)[0]);
    const keys = [sourceKey(clean), sourceKey(clean.split("/").pop() || clean)];
    const assetPath = keys.map((key) => context.assetPaths?.get(key)).find(Boolean);
    if (assetPath) return context.currentPagePath ? relativeHref(context.currentPagePath, assetPath) : `./${encodePath(assetPath)}`;
  }
  return null;
}

function normalizeNativeSnapshot(container, context) {
  container.querySelectorAll("a.internal-link").forEach((link) => {
    const target = link.getAttribute("data-href") || link.getAttribute("href");
    if (!target || isExternalReference(target) && !/^app:\/\//i.test(target)) return;
    const href = resolvePageHref(renderedPath(target), context);
    if (href) {
      link.setAttribute("href", href);
      return;
    }
    const replacement = document.createElement("span");
    replacement.className = "internal-link-unpublished";
    replacement.title = "Linked page is not included";
    replacement.textContent = link.textContent || renderedPath(target);
    link.replaceWith(replacement);
  });

  container.querySelectorAll("img, audio, video, source").forEach((element) => {
    const assetPath = resolveRenderedAsset(element, context);
    if (assetPath) element.setAttribute("src", assetPath);
  });

  container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.setAttribute("disabled", "disabled");
  });

  container.querySelectorAll(".copy-code-button").forEach((button) => {
    button.setAttribute("type", "button");
    if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", "Copy code");
  });

  container.querySelectorAll("script, object, embed").forEach((element) => element.remove());
  container.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    });
  });
  return container.innerHTML;
}

function makeHeadingsCollapsible(container) {
  const fragment = document.createDocumentFragment();
  const stack = [];
  for (const node of [...container.childNodes]) {
    const tagName = String(node.tagName || "").toLowerCase();
    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
      const details = document.createElement("details");
      details.className = `heading-section heading-level-${level}`;
      details.open = true;
      const summary = document.createElement("summary");
      summary.appendChild(node);
      details.appendChild(summary);
      (stack.at(-1)?.details || fragment).appendChild(details);
      stack.push({ level, details });
      continue;
    }
    (stack.at(-1)?.details || fragment).appendChild(node);
  }
  container.replaceChildren(fragment);
}

function collectDocumentStyles(container) {
  const chunks = [];
  for (const stylesheet of [...document.styleSheets]) {
    try {
      const cssText = [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");
      if (cssText) chunks.push(cssText);
    } catch {
      // Some platform stylesheets do not expose cssRules; the local page styles remain usable.
    }
  }

  const variables = [];
  try {
    const computed = getComputedStyle(document.body);
    for (let index = 0; index < computed.length; index += 1) {
      const property = computed[index];
      if (!property.startsWith("--")) continue;
      const value = computed.getPropertyValue(property).trim();
      if (value) variables.push(`${property}:${value};`);
    }
  } catch {
    // CSS variables are an enhancement; the captured stylesheets still provide the theme.
  }

  const computedRules = [];
  const computedProperties = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "color",
    "text-align",
    "text-decoration",
    "text-transform",
    "background-color",
    "border-color",
  ];
  try {
    [...container.querySelectorAll("*")].forEach((element, index) => {
      const computed = getComputedStyle(element);
      const declarations = computedProperties
        .map((property) => `${property}:${computed.getPropertyValue(property)};`)
        .join("");
      element.setAttribute("data-share-computed", String(index));
      computedRules.push(`[data-share-computed="${index}"]{${declarations}}`);
    });
  } catch {
    // Computed typography is an enhancement; the theme stylesheets remain the source of truth.
  }

  let contentStyle = "";
  try {
    const computed = getComputedStyle(container);
    contentStyle = `.markdown-rendered{font-family:${computed.fontFamily};font-size:${computed.fontSize};font-weight:${computed.fontWeight};line-height:${computed.lineHeight};color:${computed.color};}`;
  } catch {
    // The fallback page stylesheet supplies the base typography.
  }

  return {
    css: `:root{${variables.join("")}}\n${chunks.join("\n")}\n${contentStyle}\n${computedRules.join("\n")}`,
    htmlClass: document.documentElement.className || "",
    bodyClass: document.body.className || "",
  };
}

async function renderNativeMarkdown(plugin, markdown, sourcePath, context) {
  if (!MarkdownRenderer?.render || typeof document === "undefined") {
    throw new Error("Obsidian Markdown renderer is unavailable");
  }

  const container = document.createElement("div");
  container.className = "markdown-rendered";
  container.style.position = "fixed";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.width = "960px";
  container.style.visibility = "hidden";
  container.setAttribute("aria-hidden", "true");
  document.body.appendChild(container);

  const component = new Component();
  component.load();
  try {
    await MarkdownRenderer.render(plugin.app, markdown, container, sourcePath, component);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitForDynamicBlocks(container, markdown);
    await fillEmptyTasksBlocks(plugin, container, markdown, context);
    makeHeadingsCollapsible(container);
    return {
      html: normalizeNativeSnapshot(container, context),
      styles: collectDocumentStyles(container),
    };
  } finally {
    component.unload();
    container.remove();
  }
}

async function compileShareWithNative(plugin, input) {
  const fallback = compileShare(input);
  const notes = shareNotes(input);
  const pagePaths = new Map(notes.map((note, index) => [sourceKey(note.sourcePath), index === 0 ? "index.html" : relatedPagePath(index)]));
  const assetPaths = buildAssetPathMap(notes.flatMap((note) => note.assets || []));
  const pages = [];
  let styles;
  for (const [index, note] of notes.entries()) {
    const pagePath = pagePaths.get(sourceKey(note.sourcePath)) || (index === 0 ? "index.html" : relatedPagePath(index));
    const snapshot = await renderNativeMarkdown(plugin, note.markdown, note.sourcePath, {
      currentPagePath: pagePath,
      currentSourcePath: note.sourcePath,
      pagePaths,
      assetPaths,
    });
    styles ||= snapshot.styles;
    const title = note.title?.trim() || note.sourcePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "Untitled";
    pages.push({ path: pagePath, contentType: "text/html", body: pageHtml(title, snapshot.html, "", { pagePath, stylesheetPath: "assets/obsidian-snapshot.css", htmlClass: snapshot.styles.htmlClass, bodyClass: snapshot.styles.bodyClass }), encoding: "utf8" });
  }
  const assets = styles?.css
    ? [...fallback.assets, createNativeStylesheetAsset(styles.css)]
    : fallback.assets;
  return { ...fallback, pages, assets };
}

function compileShare(input) {
  const notes = shareNotes(input);
  const pagePaths = new Map(notes.map((note, index) => [sourceKey(note.sourcePath), index === 0 ? "index.html" : relatedPagePath(index)]));
  const allAssets = notes.flatMap((note) => note.assets || []);
  const assets = allAssets.map((asset) => ({
    path: asset.path || defaultAssetPath(asset.sourcePath),
    contentType: asset.contentType,
    body: asset.body,
    encoding: asset.encoding,
  }));
  const assetPaths = new Map();
  allAssets.forEach((asset, index) => {
    const normalized = asset.sourcePath.replaceAll("\\", "/");
    assetPaths.set(sourceKey(normalized), assets[index].path);
    assetPaths.set(sourceKey(normalized.split("/").pop() || normalized), assets[index].path);
  });
  const pages = notes.map((note, index) => {
    const pagePath = pagePaths.get(sourceKey(note.sourcePath)) || (index === 0 ? "index.html" : relatedPagePath(index));
    const title = note.title?.trim() || note.sourcePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "Untitled";
    return { path: pagePath, contentType: "text/html", body: pageHtml(title, renderMarkdown(note.markdown, { currentPagePath: pagePath, currentSourcePath: note.sourcePath, pagePaths, assetPaths })), encoding: "utf8" };
  });
  return {
    formatVersion: 1,
    sourcePath: input.root.sourcePath,
    title: input.root.title?.trim() || input.root.sourcePath.split(/[\\/]/).pop()?.replace(/\.md$/i, "") || "Untitled",
    pages,
    assets,
  };
}

function compileNote(input) {
  return compileShare({ root: input });
}

const DEFAULT_SETTINGS = {
  apiBaseUrl: "https://api.publish-note.example.com",
  cloudflareMode: "self",
  officialPublishToken: "",
  selfPublishToken: "",
  publishToken: "",
  connectionStatus: "disconnected",
  deploymentStatus: "not_deployed",
  deploymentManaged: false,
  deploymentWorkerUrl: "",
  deploymentOriginUrl: "",
  deploymentWorkerName: "",
  workerVersion: "",
  workerVersionStatus: "unknown",
  workerVersionCheckedAt: 0,
  workerVersionServiceUrl: "",
  customDomain: "",
  customDomainId: "",
  customDomainZoneName: "",
  customDomainStatus: "none",
  customDomainTransition: null,
  deploymentLogs: [],
  debugMode: false,
  debugLogs: [],
  includeLinkedPages: true,
  linkedPageDepth: 1,
  useNativeRenderer: true,
  language: "en",
};

const REPOSITORY_URL = "https://github.com/jinhefeng/One-Click-Publish";
const OFFICIAL_SERVICE_URL = "https://api.publish-note.example.com";

const COPY = {
  productName: "One-Click Publish",
  publishNote: "One-Click Publish",
  openPublishedSite: "Open published site",
  repository: "Project repository",
  open: "Visit",
  settingsIntro: "One-Click Publish turns the active Obsidian Markdown note into a shareable website. After a one-time Cloudflare setup, publish from the command palette, ribbon icon, or note context menu with one click. It uses the active note as the share root, can include linked notes to the depth you choose, uploads referenced local assets, and copies a stable link after publishing.",
  settingsIntroDetails: "Connect your own Cloudflare account once, choose the publishing scope, then use One-Click Publish from the command palette, ribbon icon, or a note's context menu.",
  language: "Language",
  languageDescription: "Choose the language used in this settings page.",
  cloudflareSection: "Cloudflare publishing",
  cloudflareModeDescription: "Deploy once on desktop, then publish from this Vault on desktop or mobile.",
  deployToCloudflare: "Deploy to my Cloudflare",
  connectOfficialCloudflare: "Connect to official Cloudflare",
  selfCloudflareDescription: "Publish through a Worker and D1 database in your Cloudflare account. The deployment prefers the stable Worker name publish-note and reuses a recognized historical One-Click Publish D1 when reconnecting; only an unrelated name conflict causes a predictable suffix. Notes and referenced local assets stay in your account; personal deployment does not create or require R2.",
  officialCloudflareDescription: "Use the official One-Click Publish Cloudflare service. Authorize once, then publish from Obsidian.",
  selectedMode: "Selected",
  notSelectedMode: "Select this option",
  deploymentStatus: "Deployment status",
  redeployCloudflare: "Retry Cloudflare deployment",
  updateCloudflareWorker: "Update Cloudflare Worker",
  workerUpdateRequiredTitle: "Worker update required",
  workerUpdateRequired: (remote, current) => remote
    ? `This Worker is running version ${remote}, but this plugin requires ${current}. Click Update Cloudflare Worker before publishing.`
    : `This Worker does not report a compatible version. Click Update Cloudflare Worker before publishing.`,
  workerVersionUnavailable: "The Worker version could not be verified. Update the Worker from Obsidian desktop before publishing.",
  workerUpdateBeforePublishing: (remote, current) => remote
    ? `Publishing is paused because the Worker is running ${remote}; this plugin requires ${current}. Update the Worker in settings, then publish again.`
    : "Publishing is paused because the Worker version could not be verified. Update the Worker in settings, then publish again.",
  deploymentDescription: "Complete setup once on desktop. After syncing this plugin's settings with the Vault, desktop and mobile can publish and update through the saved Worker without another Cloudflare authorization. Use Update Cloudflare Worker after a plugin update to refresh the existing Worker without replacing its data.",
  customDomain: "Custom domain",
  customDomainDescription: "Bind a root domain or subdomain already managed by this Cloudflare account. Cloudflare handles the DNS record and certificate. The Cloudflare connection and original Worker address stay unchanged; unbinding only switches publishing back to that Worker.",
  customDomainPlaceholder: "example.com or notes.example.com",
  bindCustomDomain: "Bind domain",
  customDomainBinding: "Binding custom domain...",
  customDomainBound: (url) => `Custom domain connected: ${url}`,
  customDomainNotConfigured: "Deploy to your Cloudflare account before binding a custom domain.",
  customDomainDesktopOnly: "Bind a custom domain from Obsidian desktop. Sync the settings afterward for mobile publishing.",
  customDomainInvalid: "Enter a valid domain or subdomain without a path.",
  customDomainConfirm: (domain) => `Bind ${domain} to the One-Click Publish Worker? If this is a root domain, requests for the whole domain may be handled by this Worker. Continue?`,
  customDomainUnbind: "Unbind",
  customDomainUnbindConfirm: (domain) => `Unbind ${domain}? Existing published content will remain available on the Worker address.`,
  customDomainUnbound: "Custom domain unbound. Publishing now uses the Worker address.",
  customDomainStatus: "Active",
  customDomainBindingFailed: "Could not bind the custom domain",
  customDomainUnbindingFailed: "Could not unbind the custom domain",
  customDomainZoneNotFound: "This domain is not an active Zone in the authorized Cloudflare account.",
  customDomainNotOwned: "This custom domain is not attached to this One-Click Publish Worker.",
  customDomainNotFound: "Cloudflare could not find the saved custom domain attachment. The primary Cloudflare connection was kept unchanged.",
  customDomainLocalSaveFailed: "Cloudflare changed the domain, but the local custom-domain state could not be saved.",
  customDomainRecoveryRequired: "The custom domain operation changed Cloudflare, but local settings need recovery.",
  customDomainRecover: "Recover custom-domain state",
  customDomainRecoveryRestored: "The custom-domain state was restored because Cloudflare still has the domain attached.",
  customDomainRecoveryCompleted: "The custom domain is no longer attached in Cloudflare. Local settings now use the Worker address.",
  customDomainRecoveryFailed: "Could not recover the custom-domain state",
  customDomainOAuthScopeUnavailable: "Custom domain binding is unavailable because this app's Cloudflare OAuth client does not allow the Workers Routes Write scope. The app owner must enable workers-routes.write in the OAuth client before retrying.",
  customDomainConfirmAction: "Continue",
  customDomainCancelAction: "Cancel",
  customDomainActiveAddress: (url) => `Current publishing address: ${url}`,
  customDomainDiagnostics: "Custom domain authorization diagnostics",
  deploymentStarting: "Starting Cloudflare deployment...",
  deploymentAuthorizing: "Waiting for Cloudflare authorization...",
  deploymentProvisioning: "Checking and preparing your Worker and D1 database...",
  deploymentFinishing: "Finishing your connection...",
  deploymentReady: "Cloudflare is connected",
  deploymentFailed: "Cloudflare deployment failed",
  desktopDeploymentOnly: "Complete setup on desktop and sync this plugin's settings first. Syncing notes alone does not sync the connection.",
  cloudflareOAuthNotConfigured: "This build does not support automatic setup yet. Install the latest official plugin release.",
  oauthCleanupWarning: "Cloudflare authorization cleanup could not be confirmed. Check the app authorization in Cloudflare; your saved publishing connection is unchanged.",
  useConnection: "Use this connection",
  disconnectCloudflare: "Disconnect",
  disconnectCloudflareDescription: "Remove this Vault's saved Worker connection and Publish Token. Cloudflare resources, published sites, and other devices are not deleted.",
  disconnectConfirm: "Click Confirm to remove this Vault's saved connection. Cloudflare resources and published sites will not be deleted.",
  confirmDisconnect: "Confirm",
  cancelDisconnect: "Cancel",
  disconnectFailed: "Could not remove the Cloudflare connection",
  disconnectedNotice: "Cloudflare connection removed from this Vault.",
  technicalDetails: "Technical details",
  deploymentLogs: "Deployment log",
  clearDeploymentLogs: "Clear log",
  copyDeploymentLogs: "Copy log",
  debugMode: "Debug mode",
  debugModeDescription: "When enabled, record detailed deployment and publishing request/response logs. Secrets, request bodies, and note content are never recorded.",
  debugLogs: "Debug log",
  clearDebugLogs: "Clear debug log",
  copyDebugLogs: "Copy debug log",
  noDebugLogs: "No debug log yet. Turn on Debug mode and retry the operation.",
  copyTechnicalDetails: "Copy details",
  clearTechnicalDetails: "Clear details",
  copied: "Copied to clipboard",
  copyFailed: "Could not copy to clipboard",
  noDeploymentLogs: "No deployment log yet.",
  deploymentStages: { authorization: "Authorization", accounts: "Account check", resources: "Resource check", database: "Database creation", subdomain: "Service address", worker_upload: "Service upload", worker_enable: "Service activation", migration: "Database preparation", ready_check: "Service startup", initialize: "Connection setup", bootstrap_cleanup: "Setup cleanup", cleanup: "Resource cleanup", save: "Saving connection", authorization_cleanup: "Authorization cleanup" },
  deploymentReasons: { network: "Check your network and try again.", timeout: "The request timed out.", unknown: "The request result is unconfirmed. Check the resources in Cloudflare before retrying; no replacement was created automatically.", permission: "Cloudflare did not allow this operation. Check the account and the requested permissions.", rate: "Cloudflare is busy. Please try again later.", response: "The service returned an unexpected response. Please try again later.", denied: "Authorization was cancelled. You can try again when ready.", account: "Authorize exactly one Cloudflare account.", callback: "Could not start authorization on this computer. Close any other setup attempt and try again.", save: "Could not save the connection. Check that your Vault is writable.", generic: "Setup could not finish. Please try again.", cleanup: "Some resources could not be confirmed as cleaned up. Check Cloudflare before retrying." },
  deploymentInternalError: "Plugin error",
  deploymentExternalError: "Cloudflare error",
  deploymentStageErrors: { accounts: "The plugin could not read the authorized Cloudflare accounts.", resources: "The plugin could not inspect Cloudflare resources or identify a historical One-Click Publish database.", database: "The plugin could not create or identify the D1 database.", subdomain: "The plugin could not configure the Worker address.", worker_upload: "The plugin could not attach the D1 database to the Worker while uploading it.", worker_enable: "The plugin could not enable the Worker address.", migration: "The plugin could not apply the D1 database schema.", ready_check: "The plugin could not confirm that the Worker is ready.", initialize: "The plugin could not create or reconnect the One-Click Publish account.", bootstrap_cleanup: "The plugin could not remove the temporary initialization secret.", authorization: "The plugin could not complete Cloudflare authorization." },
  notDeployed: "Not deployed",
  workerAddress: (url) => `Worker address: ${url}`,
  deployedNotice: (url) => `Cloudflare Worker connected: ${url}`,
  deployCancelled: "Cloudflare deployment was cancelled or expired.",
  connected: "Connected",
  notConnected: "Not connected",
  connectAccount: "Connect account",
  connectAccountDescription: "Open the secure browser authorization page. The plugin will save a Publish Token after you approve it.",
  connecting: "Waiting for browser authorization...",
  connectedNotice: "One-Click Publish account connected.",
  connectionCancelled: "Account connection was cancelled or expired.",
  officialServiceNotConfigured: (url) => `The official Cloudflare service is not configured yet (${url}). The project owner must deploy the official service before account connection can work.`,
  clearToken: "Clear saved token",
  contentSection: "Published content",
  accessToken: "Publish Token",
  accessTokenDescription: "Usually filled automatically after account connection. Manual entry is available for a self-hosted or local test service.",
  linkedNoteDepth: "Linked page depth",
  linkedNoteDepthDescription: "0 = current note only; 1 = directly linked Markdown notes; higher values continue through linked notes. External URLs and assets are not traversed.",
  nativeRenderer: "Use Obsidian renderer",
  nativeRendererDescription: "Use Obsidian's native renderer when available to preserve Obsidian styling and installed Markdown plugin output. Turn it off to use the deterministic fallback renderer.",
  noPublishedLink: "No published link yet. Publish a note first.",
  linkCopied: "Published link copied.",
  linkCopyFailed: "Could not copy the published link.",
  openNote: "Open a Markdown note to publish it.",
  publishFailed: "Could not publish note",
  fallbackRenderer: "Obsidian rendering was unavailable; published with the fallback renderer.",
  cannotReachService: "Cannot reach the publishing service",
  startLocalServer: "Check that the publishing service is reachable and that the network connection is available, then try again.",
  requestTooLarge: "The publishing request is too large for the Worker. Publishing is chunked; reduce the size of one request and try again.",
  authenticationRequired: "Complete Cloudflare setup on Obsidian desktop, then sync this plugin's settings with the Vault before publishing.",
  workerUnavailable: "The Cloudflare Worker is unavailable. Check its URL and deployment status.",
  uploading: (current, total) => `Uploading ${current}/${total} chunks...`,
  publishedAndCopied: (url) => `Published and copied link: ${url}`,
  published: (url) => `Published: ${url}`,
};

const COPY_ZH = {
  ...COPY,
  repository: "项目仓库",
  open: "访问",
  settingsIntro: "One-Click Publish 可以将当前打开的 Obsidian Markdown 笔记转换为可分享的网站。完成一次 Cloudflare 连接后，你可以从命令面板、功能区图标或笔记右键菜单一键发布。当前笔记会作为分享根页面，可以按你选择的深度携带链接笔记，上传笔记引用的本地资源，并在发布后复制稳定链接。",
  settingsIntroDetails: "请先连接你自己的 Cloudflare 账户并选择发布范围；完成一次设置后，即可从命令面板、功能区图标或笔记右键菜单一键发布。",
  language: "语言",
  languageDescription: "选择设置页面使用的语言。",
  cloudflareSection: "Cloudflare 发布",
  cloudflareModeDescription: "请先在桌面版部署一次，之后此 Vault 可以在电脑或手机上发布。",
  deployToCloudflare: "部署到我的 Cloudflare",
  connectOfficialCloudflare: "连接到官方 Cloudflare",
  selfCloudflareDescription: "通过你 Cloudflare 账户中的 Worker 和 D1 发布。部署会优先使用固定的 Worker 名称 publish-note，重新连接时会复用已识别的历史 One-Click Publish D1；只有无关资源同名时才使用可预测的后缀。笔记及引用的本地资源保存在你的账户中；个人部署不会创建或要求 R2。",
  officialCloudflareDescription: "使用官方 One-Click Publish Cloudflare 服务。授权一次后即可从 Obsidian 一键发布。",
  selectedMode: "当前选中",
  notSelectedMode: "选择此方式",
  deploymentStatus: "部署状态",
  redeployCloudflare: "重试 Cloudflare 部署",
  updateCloudflareWorker: "更新 Cloudflare Worker",
  deploymentDescription: "请先在桌面版完成一次部署。将本插件的设置随 Vault 同步后，电脑和手机都可以通过已保存的 Worker 发布和更新，无需再次授权 Cloudflare。插件更新后可点击“更新 Cloudflare Worker”，在不替换数据的情况下刷新现有 Worker。",
  customDomain: "自定义域名",
  customDomainDescription: "绑定当前 Cloudflare 账户管理的根域名或子域名。Cloudflare 会处理 DNS 记录和证书。Cloudflare 主连接和原始 Worker 地址保持不变；解绑只会切回 Worker 发布地址。",
  customDomainPlaceholder: "example.com 或 notes.example.com",
  bindCustomDomain: "绑定域名",
  customDomainBinding: "正在绑定自定义域名……",
  customDomainBound: (url) => `自定义域名已连接：${url}`,
  customDomainNotConfigured: "请先部署到你的 Cloudflare 账户，再绑定自定义域名。",
  customDomainDesktopOnly: "请在 Obsidian 桌面版绑定自定义域名；完成后同步设置即可在移动端发布。",
  customDomainInvalid: "请输入有效的域名或子域名，且不要包含路径。",
  customDomainConfirm: (domain) => `确定将 ${domain} 绑定到 One-Click Publish Worker 吗？如果这是根域名，整个域名的请求可能会由此 Worker 处理。是否继续？`,
  customDomainUnbind: "解绑",
  customDomainUnbindConfirm: (domain) => `确定解绑 ${domain} 吗？已有发布内容仍可通过 Worker 地址访问。`,
  customDomainUnbound: "自定义域名已解绑，发布将改用 Worker 地址。",
  customDomainStatus: "已生效",
  customDomainBindingFailed: "无法绑定自定义域名",
  customDomainUnbindingFailed: "无法解绑自定义域名",
  customDomainZoneNotFound: "此域名不在当前已授权的 Cloudflare 账户中，或该 Zone 尚未激活。",
  customDomainNotOwned: "此自定义域名并未绑定到当前 One-Click Publish Worker。",
  customDomainNotFound: "Cloudflare 中找不到已保存的自定义域名绑定记录。主 Cloudflare 连接未改变。",
  customDomainLocalSaveFailed: "Cloudflare 已经处理了域名，但本地自定义域名状态保存失败。",
  customDomainRecoveryRequired: "Cloudflare 中的自定义域名操作已发生变化，但本地设置需要恢复。",
  customDomainRecover: "恢复自定义域名状态",
  customDomainRecoveryRestored: "Cloudflare 中的域名仍然存在，已恢复本地自定义域名状态。",
  customDomainRecoveryCompleted: "Cloudflare 中已没有该自定义域名绑定，本地设置已切回 Worker 地址。",
  customDomainRecoveryFailed: "无法恢复自定义域名状态",
  customDomainOAuthScopeUnavailable: "当前应用的 Cloudflare OAuth Client 尚未允许 Workers Routes Write 权限。请由应用维护者在 OAuth Client 中启用 workers-routes.write 后再重试。",
  customDomainConfirmAction: "继续",
  customDomainCancelAction: "取消",
  customDomainActiveAddress: (url) => `当前发布地址：${url}`,
  customDomainDiagnostics: "自定义域名授权诊断",
  deploymentStarting: "正在启动 Cloudflare 部署……",
  deploymentAuthorizing: "等待 Cloudflare 授权……",
  deploymentProvisioning: "正在检查并准备 Worker 和 D1 数据库……",
  deploymentFinishing: "正在完成连接……",
  deploymentReady: "Cloudflare 已连接",
  deploymentFailed: "Cloudflare 部署失败",
  desktopDeploymentOnly: "请先在桌面版完成部署并同步本插件的设置。仅同步笔记不会同步连接配置。",
  cloudflareOAuthNotConfigured: "此版本尚未启用自动部署，请安装最新正式版插件。",
  oauthCleanupWarning: "Cloudflare 临时授权尚未确认清理成功，请在 Cloudflare 中检查应用授权。已保存的发布连接不受影响。",
  useConnection: "使用此连接",
  disconnectCloudflare: "取消连接",
  disconnectCloudflareDescription: "只移除此 Vault 保存的 Worker 地址和 Publish Token，不会删除 Cloudflare 资源、已发布网站或其他设备的连接。",
  disconnectConfirm: "点击“确认”后才会移除此 Vault 保存的连接；Cloudflare 资源和已发布网站不会被删除。",
  confirmDisconnect: "确认",
  cancelDisconnect: "取消",
  disconnectFailed: "无法移除 Cloudflare 连接",
  disconnectedNotice: "已取消此 Vault 与 Cloudflare 的连接。",
  technicalDetails: "技术详情",
  deploymentLogs: "部署日志",
  clearDeploymentLogs: "清除日志",
  copyDeploymentLogs: "复制日志",
  debugMode: "调试模式",
  debugModeDescription: "开启后记录部署和发布请求/响应的详细日志。日志不会记录 Token、请求正文或笔记内容。",
  debugLogs: "调试日志",
  clearDebugLogs: "清除调试日志",
  copyDebugLogs: "复制调试日志",
  noDebugLogs: "还没有调试日志。请开启调试模式后重试操作。",
  copyTechnicalDetails: "复制详情",
  clearTechnicalDetails: "清除详情",
  copied: "已复制到剪贴板",
  copyFailed: "无法复制到剪贴板",
  noDeploymentLogs: "还没有部署日志。",
  deploymentStages: { authorization: "授权", accounts: "检查账户", resources: "检查资源", database: "创建数据库", subdomain: "配置服务地址", worker_upload: "上传服务", worker_enable: "启用服务", migration: "准备数据库", ready_check: "等待服务启动", initialize: "初始化连接", bootstrap_cleanup: "清理初始化凭证", cleanup: "清理资源", save: "保存连接", authorization_cleanup: "清理临时授权" },
  deploymentReasons: { network: "请检查网络后重试。", timeout: "请求等待超时。", unknown: "请求结果尚未确认。请检查 Cloudflare 中的资源后再重试，插件没有自动重复创建。", permission: "Cloudflare 拒绝了此操作，请检查所选账户和授权权限。", rate: "Cloudflare 暂时繁忙，请稍后重试。", response: "服务返回了异常响应，请稍后重试。", denied: "授权已取消，准备好后可以重试。", account: "请只授权一个 Cloudflare 账户。", callback: "无法在此电脑上启动授权，请关闭其他部署尝试后重试。", save: "无法保存连接，请检查 Vault 是否可写。", generic: "未能完成部署，请重试。", cleanup: "部分资源尚未确认清理成功，请检查 Cloudflare 后再重试。" },
  deploymentInternalError: "插件内部错误",
  deploymentExternalError: "Cloudflare 外部错误",
  deploymentStageErrors: { accounts: "插件无法读取已授权的 Cloudflare 账户。", resources: "插件无法检查 Cloudflare 资源或识别历史 One-Click Publish 数据库。", database: "插件无法创建或识别 D1 数据库。", subdomain: "插件无法配置 Worker 地址。", worker_upload: "插件在上传 Worker 时无法连接 D1 数据库。请确认 D1 数据库已创建且绑定信息有效。", worker_enable: "插件无法启用 Worker 地址。", migration: "插件无法执行 D1 数据库迁移。", ready_check: "插件无法确认 Worker 已就绪。", initialize: "插件无法创建或恢复 One-Click Publish 账户。", bootstrap_cleanup: "插件无法删除临时初始化凭证。", authorization: "插件无法完成 Cloudflare 授权。" },
  notDeployed: "尚未部署",
  workerAddress: (url) => `Worker 地址：${url}`,
  workerUpdateRequiredTitle: "需要更新 Worker",
  workerUpdateRequired: (remote, current) => remote
    ? `当前 Worker 运行的是 ${remote}，但本插件需要 ${current}。请点击“更新 Cloudflare Worker”后再发布。`
    : "当前 Worker 没有报告兼容版本。请点击“更新 Cloudflare Worker”后再发布。",
  workerVersionUnavailable: "无法确认 Worker 版本。请在 Obsidian 桌面版更新 Worker 后再发布。",
  workerUpdateBeforePublishing: (remote, current) => remote
    ? `发布已暂停：当前 Worker 是 ${remote}，本插件需要 ${current}。请先在设置中更新 Worker，再重新发布。`
    : "发布已暂停：无法确认 Worker 版本。请先在设置中更新 Worker，再重新发布。",
  deployedNotice: (url) => `Cloudflare Worker 已连接：${url}`,
  deployCancelled: "Cloudflare 部署已取消或已过期。",
  connected: "已连接",
  notConnected: "未连接",
  connectAccount: "连接账户",
  connectAccountDescription: "打开安全的浏览器授权页面。确认后插件会自动保存 Publish Token。",
  connecting: "等待浏览器完成授权……",
  connectedNotice: "One-Click Publish 账户已连接。",
  connectionCancelled: "账户连接已取消或已过期。",
  officialServiceNotConfigured: (url) => `官方 Cloudflare 服务尚未配置（${url}）。项目方需要先部署官方服务，才能连接账户。`,
  clearToken: "清除已保存令牌",
  contentSection: "发布内容",
  accessToken: "Publish Token",
  accessTokenDescription: "连接账户后通常会自动填写；自部署或本地测试服务仍支持手动输入。",
  linkedNoteDepth: "引用页面深度",
  linkedNoteDepthDescription: "0 = 仅发布当前笔记；1 = 包含直接引用的 Markdown 笔记；更大的值会继续遍历引用笔记。外部 URL 和资源不会被遍历。",
  nativeRenderer: "使用 Obsidian 渲染器",
  nativeRendererDescription: "可用时使用 Obsidian 原生渲染器，保留 Obsidian 样式和已安装 Markdown 插件的输出。关闭后使用确定性的备用渲染器。",
  noPublishedLink: "还没有已发布链接，请先发布一篇笔记。",
  linkCopied: "已复制发布链接。",
  linkCopyFailed: "无法复制发布链接。",
  openNote: "请先打开一个 Markdown 笔记。",
  publishFailed: "笔记发布失败",
  fallbackRenderer: "Obsidian 原生渲染不可用，已使用备用渲染器发布。",
  cannotReachService: "无法连接发布服务",
  startLocalServer: "请确认发布服务可访问且网络连接可用，然后重试。",
  requestTooLarge: "发布请求超过 Worker 单次请求大小限制。发布会自动分片，请减少单个请求大小后重试。",
  authenticationRequired: "请先在 Obsidian 桌面版完成 Cloudflare 部署，再将本插件的设置随 Vault 同步后发布。",
  workerUnavailable: "Cloudflare Worker 当前不可用，请检查地址和部署状态。",
  uploading: (current, total) => `正在上传第 ${current}/${total} 个分片...`,
  publishedAndCopied: (url) => `已发布并复制链接：${url}`,
  published: (url) => `已发布：${url}`,
};

function normalizeLanguage(value) {
  return value === "zh" ? "zh" : "en";
}

function normalizeCloudflareMode(value) {
  return value === "self" ? "self" : "official";
}

function normalizeWorkerVersionStatus(value) {
  return ["current", "outdated", "unreachable"].includes(value) ? value : "unknown";
}

function workerVersionNeedsUpdate(settings) {
  if (!settings?.deploymentWorkerUrl || !settings?.selfPublishToken) return false;
  return settings.workerVersionStatus !== "current" || String(settings.workerVersion || "") !== EMBEDDED_TARGET_PLUGIN_VERSION;
}

function isPlaceholderEndpoint(value) {
  return value === OFFICIAL_SERVICE_URL;
}

function validConnection(value) {
  if (!value || typeof value.serviceUrl !== "string" || typeof value.publishToken !== "string" || !value.publishToken.trim()) return null;
  try { const url = new URL(value.serviceUrl); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null; } catch { return null; }
  return { serviceUrl: value.serviceUrl.trim().replace(/\/$/, ""), publishToken: value.publishToken.trim() };
}

function normalizeCustomDomain(value) {
  let input = String(value || "").trim().toLowerCase();
  if (!input) return "";
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) input = `https://${input}`;
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    input = url.hostname.replace(/\.$/, "");
  } catch {
    return "";
  }
  if (input.length > 253 || !input.includes(".") || input.includes("..")) return "";
  const labels = input.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return "";
  return input;
}

function normalizeCustomDomainTransition(value) {
  if (!value || typeof value !== "object" || value.state !== "detaching") return null;
  const hostname = normalizeCustomDomain(value.hostname);
  if (!hostname) return null;
  return {
    state: "detaching",
    operationId: normalizeOperationId(value.operationId),
    hostname,
    domainId: sanitizeProviderCode(value.domainId).slice(0, 160),
    originUrl: String(value.originUrl || "").trim().replace(/\/$/, ""),
    workerName: sanitizeProviderCode(value.workerName),
    startedAt: String(value.startedAt || "").slice(0, 40),
  };
}

function customDomainUrl(hostname) {
  return `https://${normalizeCustomDomain(hostname)}`;
}

function rewriteUrlOrigin(value, fromOrigin, toOrigin) {
  const current = String(value || "").trim();
  const from = String(fromOrigin || "").replace(/\/$/, "");
  const to = String(toOrigin || "").replace(/\/$/, "");
  if (!current || !from || !to) return current;
  try {
    const url = new URL(current);
    if (url.origin !== from) return current;
    return `${to}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return current;
  }
}

function canonicalWorkerUrl(settings) {
  return String(settings?.deploymentOriginUrl || settings?.deploymentWorkerUrl || "").trim().replace(/\/$/, "");
}

function selfConnectionUrl(settings) {
  const active = String(settings?.apiBaseUrl || "").trim().replace(/\/$/, "");
  const worker = canonicalWorkerUrl(settings);
  const custom = normalizeCustomDomain(settings?.customDomain);
  if (settings?.cloudflareMode === "self" && active && (active === worker || custom && active === customDomainUrl(custom))) return active;
  return worker;
}

function findCloudflareZoneForHostname(hostname, zones) {
  const normalized = normalizeCustomDomain(hostname);
  return (Array.isArray(zones) ? zones : [])
    .map((zone) => ({ ...zone, name: normalizeCustomDomain(zone?.name) }))
    .filter((zone) => zone.name && (normalized === zone.name || normalized.endsWith(`.${zone.name}`)))
    .sort((left, right) => right.name.length - left.name.length)[0];
}

function workerNameFromServiceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!url.hostname.endsWith(".workers.dev")) return "";
    const name = url.hostname.split(".")[0];
    return /^[a-z\d][a-z\d-]{0,62}$/i.test(name) ? name : "";
  } catch {
    return "";
  }
}

function packConnections(settings) {
  // A single JSON string is a sync unit: URL/token pairs cannot be merged field
  // by field by a settings sync service. Legacy fields remain readable.
  return JSON.stringify({
    self: validConnection({ serviceUrl: selfConnectionUrl(settings), publishToken: settings.selfPublishToken }),
    official: validConnection({ serviceUrl: settings.officialServiceUrl || OFFICIAL_SERVICE_URL, publishToken: settings.officialPublishToken }),
  });
}

function normalizeSettings(stored) {
  stored = stored && typeof stored === "object" ? stored : {};
  const legacySelf = stored.deploymentManaged === true || stored.cloudflareMode === "self";
  const mode = normalizeCloudflareMode(stored.cloudflareMode || "self");
  const legacyUrl = String(stored.apiBaseUrl || stored.serviceUrl || DEFAULT_SETTINGS.apiBaseUrl).trim().replace(/\/$/, "");
  let self = validConnection({ serviceUrl: stored.deploymentWorkerUrl || (legacySelf ? legacyUrl : ""), publishToken: stored.selfPublishToken || (legacySelf ? stored.publishToken || stored.accessToken : "") });
  let official = validConnection({ serviceUrl: stored.officialServiceUrl || (!legacySelf ? legacyUrl : OFFICIAL_SERVICE_URL), publishToken: stored.officialPublishToken || (!legacySelf ? stored.publishToken || stored.accessToken : "") });
  if (typeof stored.connectionProfiles === "string") {
    try { const profiles = JSON.parse(stored.connectionProfiles); self = validConnection(profiles?.self); official = validConnection(profiles?.official); }
    catch { self = null; official = null; }
  }
  const current = mode === "self" ? self : official;
  const originUrl = String(stored.deploymentOriginUrl || (stored.deploymentWorkerUrl && String(stored.deploymentWorkerUrl).replace(/\/$/, "").endsWith(".workers.dev") ? stored.deploymentWorkerUrl : self?.serviceUrl?.endsWith(".workers.dev") ? self.serviceUrl : "")).replace(/\/$/, "");
  const savedWorkerVersion = String(stored.workerVersion || "").trim();
  const savedWorkerVersionStatus = savedWorkerVersion && savedWorkerVersion !== EMBEDDED_TARGET_PLUGIN_VERSION
    ? "outdated"
    : normalizeWorkerVersionStatus(stored.workerVersionStatus);
  const settings = { ...DEFAULT_SETTINGS, ...stored,
    cloudflareMode: mode,
    apiBaseUrl: current?.serviceUrl || (mode === "self" ? "" : stored.officialServiceUrl || legacyUrl),
    publishToken: current?.publishToken || "",
    selfPublishToken: self?.publishToken || "", deploymentWorkerUrl: originUrl || self?.serviceUrl || "",
    deploymentOriginUrl: originUrl,
    deploymentWorkerName: String(stored.deploymentWorkerName || workerNameFromServiceUrl(stored.deploymentOriginUrl || self?.serviceUrl) || ""),
    workerVersion: savedWorkerVersion,
    workerVersionStatus: savedWorkerVersionStatus,
    workerVersionCheckedAt: Number.isFinite(Number(stored.workerVersionCheckedAt)) ? Number(stored.workerVersionCheckedAt) : 0,
    workerVersionServiceUrl: String(stored.workerVersionServiceUrl || "").trim().replace(/\/$/, ""),
    customDomain: normalizeCustomDomain(stored.customDomain),
    customDomainId: String(stored.customDomainId || ""),
    customDomainZoneName: normalizeCustomDomain(stored.customDomainZoneName),
    customDomainStatus: stored.customDomain && normalizeCustomDomain(stored.customDomain) ? String(stored.customDomainStatus || "active") : "none",
    customDomainTransition: normalizeCustomDomainTransition(stored.customDomainTransition),
    officialPublishToken: official?.publishToken || "", officialServiceUrl: official?.serviceUrl || stored.officialServiceUrl || OFFICIAL_SERVICE_URL,
    connectionStatus: current ? "connected" : "disconnected", deploymentStatus: self ? "ready" : "not_deployed",
    deploymentLogs: normalizeDeploymentLogs(stored.deploymentLogs),
    debugMode: stored.debugMode === true,
    debugLogs: normalizeDebugLogs(stored.debugLogs),
    // Read legacy state to migrate it, but it never controls new deployments.
    deploymentManaged: stored.deploymentManaged === true,
    language: normalizeLanguage(stored.language), useNativeRenderer: stored.useNativeRenderer !== false,
    linkedPageDepth: normalizeLinkedPageDepth(stored.linkedPageDepth === undefined ? (stored.includeLinkedPages === false ? 0 : 1) : stored.linkedPageDepth),
  };
  delete settings.controlPlaneUrl;
  delete settings.accessToken;
  settings.includeLinkedPages = settings.linkedPageDepth > 0;
  return settings;
}

function copyForLanguage(language) {
  return normalizeLanguage(language) === "zh" ? COPY_ZH : COPY;
}

class SharePublisherPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addCommand({ id: "publish-current-note", name: COPY.publishNote, callback: () => void this.publishCurrentNote() });
    this.addCommand({ id: "open-last-published-site", name: COPY.openPublishedSite, callback: () => this.openLastPublishedSite() });
    this.addRibbonIcon("upload", COPY.publishNote, () => void this.publishCurrentNote());
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file?.extension === "md") {
        menu.addItem((item) => item.setTitle(COPY.publishNote).setIcon("upload").onClick(() => void this.publishFile(file)));
      }
    }));
    this.settingTab = new SharePublisherSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    void this.refreshWorkerVersion();
    if (typeof document !== "undefined") this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.refreshSettings();
    });
    if (typeof window !== "undefined") this.registerDomEvent(window, "focus", () => void this.refreshSettings());
  }

  enqueueSettings(operation) {
    const pending = (this.settingsQueue || Promise.resolve()).catch(() => undefined).then(operation);
    this.settingsQueue = pending;
    return pending;
  }

  loadSettings() {
    return this.enqueueSettings(async () => {
      this.settings = normalizeSettings(await this.loadData());
      this.debugLogsBuffer = [...this.settings.debugLogs];
      this.settingsBaseline = { ...this.settings };
    });
  }

  async refreshSettings() {
    try { await this.loadSettings(); await this.refreshWorkerVersion(); this.refreshSettingTab(); } catch { /* keep the last complete in-memory connection */ }
  }

  async onExternalSettingsChange() { await this.refreshSettings(); }

  refreshSettingTab() {
    if (this.settingTab?.containerEl?.isShown?.()) this.settingTab.display();
  }

  async refreshWorkerVersion(options = {}) {
    const settings = this.settings || {};
    const hasPersonalConnection = Boolean(settings.cloudflareMode === "self" && settings.deploymentWorkerUrl && settings.selfPublishToken);
    if (!hasPersonalConnection) return { status: "not_applicable", version: "" };
    const storedVersion = String(settings.workerVersion || "").trim();
    const checkedAt = Number(settings.workerVersionCheckedAt || 0);
    const now = Date.now();
    const serviceUrl = String(canonicalWorkerUrl(settings) || options.connection?.serviceUrl || settings.apiBaseUrl || selfConnectionUrl(settings)).replace(/\/$/, "");
    if (!options.force && storedVersion && storedVersion !== EMBEDDED_TARGET_PLUGIN_VERSION) {
      return { status: "outdated", version: storedVersion };
    }
    if (!options.force && settings.workerVersionStatus === "current" && storedVersion === EMBEDDED_TARGET_PLUGIN_VERSION && settings.workerVersionServiceUrl === serviceUrl && now - checkedAt < 5 * 60 * 1000) {
      return { status: "current", version: storedVersion };
    }
    if (this.workerVersionCheckPromise) return this.workerVersionCheckPromise;
    if (!serviceUrl) return { status: "unreachable", version: "" };
    const connection = { serviceUrl, publishToken: "" };
    const pending = (async () => {
      try {
        const health = await this.requestPublish(`${serviceUrl}/healthz`, "GET", undefined, {
          authenticated: false,
          connection,
          stage: "worker_version",
        });
        const version = String(health?.version || "").trim();
        const status = version === EMBEDDED_TARGET_PLUGIN_VERSION ? "current" : "outdated";
        await this.saveSettings({ workerVersion: version, workerVersionStatus: status, workerVersionCheckedAt: Date.now(), workerVersionServiceUrl: serviceUrl });
        return { status, version };
      } catch (error) {
        await this.saveSettings({ workerVersion: "", workerVersionStatus: "unreachable", workerVersionCheckedAt: Date.now(), workerVersionServiceUrl: serviceUrl });
        return { status: "unreachable", version: "", error };
      }
    })();
    this.workerVersionCheckPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.workerVersionCheckPromise === pending) this.workerVersionCheckPromise = null;
      this.refreshSettingTab();
    }
  }

  recordDeploymentLog(entry) {
    const session = [this.deploymentSession, this.domainBindingSession].find((item) => item?.active) || this.domainBindingSession || this.deploymentSession;
    if (!session) return;
    const record = deploymentLogRecord({ ...entry, operationId: entry.operationId || session.operationId });
    session.logs = [...(session.logs || []), record].slice(-60);
    this.refreshSettingTab();
  }

  async persistDeploymentLogs(session = this.deploymentSession || this.domainBindingSession) {
    if (!session?.logs?.length) return;
    try {
      await this.saveSettings({ deploymentLogs: [...(this.settings.deploymentLogs || []), ...session.logs].slice(-60) });
    } catch {
      // Deployment diagnostics must never replace the original deployment result.
    }
  }

  async clearDeploymentLogs() {
    if ([this.deploymentSession, this.domainBindingSession].some((session) => session?.active)) return false;
    for (const session of [this.deploymentSession, this.domainBindingSession]) {
      if (session) session.logs = [];
    }
    await this.saveSettings({ deploymentLogs: [] });
    this.refreshSettingTab();
    return true;
  }

  async clearOperationDiagnostics(session) {
    if (!session || session.active) return false;
    const operationId = String(session.operationId || "");
    const retainedLogs = operationId
      ? (this.settings.deploymentLogs || []).filter((entry) => String(entry?.operationId || "") !== operationId)
      : (this.settings.deploymentLogs || []).filter((entry) => String(entry?.operationId || ""));
    session.logs = [];
    session.error = null;
    session.cleanupError = null;
    await this.saveSettings({ deploymentLogs: retainedLogs });
    if (this.deploymentSession === session) this.deploymentSession = null;
    if (this.domainBindingSession === session) this.domainBindingSession = null;
    this.refreshSettingTab();
    return true;
  }

  recordDebugLog(entry) {
    if (!this.settings?.debugMode) return;
    const activeSession = [this.deploymentSession, this.domainBindingSession].find((session) => session?.active);
    const record = debugLogRecord({
      ...entry,
      operationId: entry.operationId || activeSession?.operationId || this.publishOperationId,
    });
    if (!record.stage && !record.route && !record.message && !record.code && !record.providerMessage) return;
    this.debugLogsBuffer = [...(this.debugLogsBuffer || this.settings.debugLogs || []), record].slice(-120);
    this.settings.debugLogs = this.debugLogsBuffer;
    void this.persistDebugLogs();
    this.refreshSettingTab();
  }

  async persistDebugLogs() {
    if (!this.settings?.debugMode || !this.debugLogsBuffer?.length) return;
    const snapshot = [...this.debugLogsBuffer];
    this.debugLogsWritePromise = (this.debugLogsWritePromise || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.saveSettings({ debugLogs: snapshot }));
    return this.debugLogsWritePromise;
  }

  async clearDebugLogs() {
    this.debugLogsBuffer = [];
    this.settings.debugLogs = [];
    this.debugLogsWritePromise = (this.debugLogsWritePromise || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.saveSettings({ debugLogs: [] }));
    await this.debugLogsWritePromise;
    this.refreshSettingTab();
  }

  connectionSnapshot() {
    return Object.freeze({ serviceUrl: this.settings.apiBaseUrl, publishToken: this.settings.publishToken });
  }

  copy() {
    return copyForLanguage(this.settings.language);
  }

  saveSettings(changes) {
    const delta = changes || Object.fromEntries(Object.entries(this.settings).filter(([key, value]) => value !== this.settingsBaseline?.[key]));
    return this.enqueueSettings(async () => {
      const latest = normalizeSettings(await this.loadData());
      let next = { ...latest, ...delta };
      if (["cloudflareMode", "apiBaseUrl", "serviceUrl", "selfPublishToken", "deploymentWorkerUrl", "deploymentOriginUrl", "customDomain", "officialPublishToken", "officialServiceUrl"].some((key) => key in delta)) next.connectionProfiles = packConnections(next);
      next = normalizeSettings(next);
      await this.saveData(next);
      this.settings = next;
      this.settingsBaseline = { ...next };
    });
  }

  async selectCloudflareMode(mode) {
    await this.saveSettings({ cloudflareMode: normalizeCloudflareMode(mode) });
    this.refreshSettingTab();
  }

  async disconnectCloudflare() {
    if (this.deploymentSession?.active || this.provisioningPromise || this.domainBindingPromise || this.domainBindingSession?.active) {
      new Notice(this.copy().deploymentStarting);
      return false;
    }
    if (this.settings?.customDomainTransition) {
      new Notice(this.copy().customDomainRecoveryRequired);
      return false;
    }
    await this.saveSettings({
      cloudflareMode: "self",
      apiBaseUrl: "",
      serviceUrl: "",
      publishToken: "",
      accessToken: "",
      selfPublishToken: "",
      deploymentWorkerUrl: "",
      deploymentOriginUrl: "",
      deploymentWorkerName: "",
      workerVersion: "",
      workerVersionStatus: "unknown",
      workerVersionCheckedAt: 0,
      workerVersionServiceUrl: "",
      customDomain: "",
      customDomainId: "",
      customDomainZoneName: "",
      customDomainStatus: "none",
      customDomainTransition: null,
      connectionStatus: "disconnected",
      deploymentStatus: "not_deployed",
      deploymentManaged: false,
    });
    new Notice(this.copy().disconnectedNotice);
    return true;
  }

  async publishCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice(this.copy().openNote);
      return;
    }
    await this.publishFile(file);
  }

  async publishFile(file) {
    const operationId = createOperationId("publish");
    this.publishOperationId = operationId;
    let phase = "prepare";
    this.recordDebugLog({ operationId, type: "phase", stage: "publish.prepare", message: "Publish started" });
    try {
      phase = "load_settings";
      await this.loadSettings();
      const connection = this.connectionSnapshot();
      phase = "worker_version";
      const workerVersion = await this.refreshWorkerVersion({ force: true, connection });
      if (this.settings.cloudflareMode === "self" && workerVersion.status !== "current") {
        const copy = this.copy();
        const message = workerVersion.status === "outdated"
          ? copy.workerUpdateBeforePublishing(workerVersion.version, EMBEDDED_TARGET_PLUGIN_VERSION)
          : copy.workerVersionUnavailable;
        new Notice(message, 12_000);
        return;
      }
      phase = "read_note";
      const markdown = await this.app.vault.read(file);
      phase = "collect_notes";
      const notes = await this.collectShareNotes(file, markdown);
      phase = "collect_assets";
      const assets = await this.collectAssets(notes);
      const [root, ...relatedNotes] = notes;
      const input = {
        root: { sourcePath: root.sourcePath, title: root.title, markdown: root.markdown, assets },
        relatedNotes: relatedNotes.map(({ sourcePath, title, markdown: noteMarkdown }) => ({ sourcePath, title, markdown: noteMarkdown })),
      };
      phase = "compile";
      const bundle = await this.compileForPublish(input);
      const storedSiteId = this.app.metadataCache.getFileCache(file)?.frontmatter?.share_site_id;
      const siteId = /^site-\d+$/i.test(String(storedSiteId || "")) ? undefined : storedSiteId;
      phase = "upload";
      const result = await this.publishBundle(bundle, siteId, file.path, connection);
      const publishedUrl = `${result.url}/`;
      phase = "save_metadata";
      await this.savePublishedMetadata(file, result, publishedUrl);
      await this.finishPublish(result, publishedUrl);
      this.recordDebugLog({ operationId, type: "phase", stage: "publish.complete", message: "Publish completed", route: "/v1/uploads/:upload/commit" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = String(error?.code || message.split(":", 1)[0] || "");
      const providerMessage = sanitizeExternalMessage(error?.providerMessage);
      const friendly = code === "QUOTA_EXCEEDED"
        ? this.copy().requestTooLarge
        : code === "UNAUTHORIZED"
            ? this.copy().authenticationRequired
            : code === "INTERNAL_ERROR" || code === "WORKER_UNAVAILABLE"
              ? `${this.copy().workerUnavailable}${providerMessage ? ` ${providerMessage}` : ""}`
              : message;
      this.recordDebugLog({ operationId, type: "publish_error", stage: `publish.${phase}`, error, message: `${phase}: ${message}` });
      await this.persistDebugLogs();
      new Notice(`${this.copy().publishFailed}: ${friendly}`);
    } finally {
      if (this.publishOperationId === operationId) this.publishOperationId = "";
    }
  }

  async compileForPublish(input) {
    if (this.settings.useNativeRenderer === false) {
      return compileShare(input);
    }
    try {
      return await compileShareWithNative(this, input);
    } catch (error) {
      console.warn(`${COPY.productName}: native Obsidian rendering failed; using fallback renderer`, error);
      new Notice(this.copy().fallbackRenderer);
      return compileShare(input);
    }
  }

  async requestPublish(endpoint, method, payload, options = {}) {
    let response;
    const route = serviceRoute(endpoint);
    const stage = options.stage || (route.startsWith("/v1/auth/") ? "authorization" : "publish");
    const startedAt = Date.now();
    const serializedPayload = payload === undefined ? "" : JSON.stringify(payload);
    const connection = options.connection || this.connectionSnapshot();
    const hasAuthorization = options.authenticated !== false && Boolean(connection.publishToken);
    const transport = { transport: "obsidian.requestUrl", endpointOrigin: safeEndpointOrigin(endpoint), requestBodyBytes: utf8ByteLength(serializedPayload), hasAuthorization };
    this.recordDebugLog({ type: "request", stage, method, route, ...transport });
    try {
      const headers = { "content-type": "application/json" };
      if (hasAuthorization) headers.authorization = `Bearer ${connection.publishToken}`;
      const requestOptions = {
        url: endpoint,
        method,
        headers,
        throw: false,
      };
      if (!/^(GET|HEAD)$/i.test(method) && serializedPayload) requestOptions.body = serializedPayload;
      response = await requestUrl(requestOptions);
    } catch (error) {
      const status = error?.status ?? error?.statusCode ?? error?.response?.status;
      const detail = requestErrorDetail(error);
      if (status) {
        const requestError = new Error(`Publish request failed (${status})${detail ? `: ${detail}` : ""}`);
        requestError.status = status;
        requestError.code = "NETWORK_ERROR";
        requestError.stage = stage;
        requestError.method = method;
        requestError.route = route;
        requestError.providerMessage = sanitizeExternalMessage(detail);
        Object.assign(requestError, requestTransportDetails(error));
        this.recordDebugLog({ type: "error", stage, method, route, ...transport, error: requestError, durationMs: Date.now() - startedAt });
        throw requestError;
      }
      const copy = this.copy();
      const requestError = new Error(`${copy.cannotReachService}. ${copy.startLocalServer}`);
      requestError.code = "NETWORK_ERROR";
      requestError.stage = stage;
      requestError.method = method;
      requestError.route = route;
      requestError.providerMessage = sanitizeExternalMessage(detail || error?.message);
      Object.assign(requestError, requestTransportDetails(error));
      this.recordDebugLog({ type: "error", stage, method, route, ...transport, error: requestError, durationMs: Date.now() - startedAt });
      throw requestError;
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = requestErrorDetail(response);
      let code = "";
      try { code = String(response?.json?.code || JSON.parse(response?.text || "{}").code || ""); } catch { /* keep generic detail */ }
      const error = new Error(`${code ? `${code}: ` : ""}${detail || `Publish request failed (${response.status})`}`);
      error.status = response.status;
      error.code = code;
      error.stage = stage;
      error.method = method;
      error.route = route;
      error.providerCode = sanitizeProviderCode(code);
      error.providerMessage = sanitizeExternalMessage(detail);
      error.responseContentType = responseHeader(response, "content-type");
      this.recordDebugLog({ type: "response", stage, method, route, ...transport, error, durationMs: Date.now() - startedAt });
      throw error;
    }
    this.recordDebugLog({ type: "response", stage, method, route, ...transport, httpStatus: response.status, responseContentType: responseHeader(response, "content-type"), durationMs: Date.now() - startedAt });
    try {
      return response.json || JSON.parse(response.text);
    } catch (cause) {
      const error = new Error("Publish response could not be parsed");
      error.code = "INVALID_RESPONSE";
      error.stage = stage;
      error.method = method;
      error.route = route;
      error.providerMessage = sanitizeExternalMessage(cause?.message);
      this.recordDebugLog({ type: "error", stage, method, route, ...transport, error, durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  async connectAccount() {
    if (this.officialConnecting) return false;
    this.officialConnecting = true;
    const copy = this.copy();
    try {
      await this.loadSettings();
      if (this.settings.officialPublishToken) { await this.selectCloudflareMode("official"); return true; }
      const apiBaseUrl = this.settings.officialServiceUrl || OFFICIAL_SERVICE_URL;
      if (isPlaceholderEndpoint(apiBaseUrl)) {
        throw new Error(copy.officialServiceNotConfigured(apiBaseUrl));
      }
      this.refreshSettingTab();
      const started = await this.requestPublish(`${apiBaseUrl}/v1/auth/device/start`, "POST", {}, { authenticated: false });
      const verificationUrl = started.verificationUrl || `${apiBaseUrl}/connect?code=${encodeURIComponent(started.deviceCode)}`;
      openExternalUrl(verificationUrl);
      new Notice(copy.connecting);
      const expiresAt = Date.now() + Number(started.expiresIn || 600) * 1000;
      const interval = Math.max(1000, Number(started.interval || 2) * 1000);
      while (Date.now() < expiresAt) {
        const result = await this.requestPublish(`${apiBaseUrl}/v1/auth/device/poll`, "POST", { deviceCode: started.deviceCode }, { authenticated: false });
        if (result.status === "approved" && result.publishToken) {
          await this.saveSettings({ cloudflareMode: "official", officialPublishToken: result.publishToken, officialServiceUrl: apiBaseUrl });
          new Notice(copy.connectedNotice);
          return true;
        }
        if (result.status === "rejected" || result.status === "expired") break;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      new Notice(copy.connectionCancelled);
      return false;
    } catch (error) {
      new Notice(`${copy.publishFailed}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.officialConnecting = false;
      this.refreshSettingTab();
    }
  }

  async deployToCloudflare() {
    if (this.provisioningPromise) return this.provisioningPromise;
    this.provisioningPromise = this.runDirectCloudflareDeployment();
    try { return await this.provisioningPromise; } finally { this.provisioningPromise = null; }
  }

  async runDirectCloudflareDeployment() {
    const copy = this.copy();
    await this.loadSettings();
    const hasPersonalConnection = Boolean(this.settings.selfPublishToken && this.settings.deploymentWorkerUrl);
    if (hasPersonalConnection && this.settings.cloudflareMode !== "self") {
      await this.selectCloudflareMode("self");
      return true;
    }
    if (!isDesktopEnvironment()) {
      new Notice(copy.desktopDeploymentOnly);
      return false;
    }
    if (CLOUDFLARE_OAUTH_CLIENT_ID.startsWith("REPLACE_WITH_")) {
      new Notice(`${copy.deploymentFailed}: ${copy.cloudflareOAuthNotConfigured}`);
      return false;
    }
    const session = { operationId: createOperationId("deployment"), stage: "authorization", active: true, error: null, logs: [] };
    this.deploymentSession = session;
    const progress = new Notice(copy.deploymentAuthorizing, 0);
    const onStage = (stage) => {
      session.stage = stage;
      this.recordDeploymentLog({ type: "stage", stage, message: deploymentProgress(stage, copy) });
      progress.setMessage?.(deploymentProgress(stage, copy));
      this.refreshSettingTab();
    };
    const debugLog = (entry) => this.recordDebugLog(entry);
    this.recordDebugLog({ type: "phase", stage: "deployment.authorization", message: "Deployment started" });
    onStage("authorization");
    let callback;
    let accessToken = "";
    try {
      const state = randomUrlSecret(32);
      const codeVerifier = randomUrlSecret(32);
      const codeChallenge = await sha256Base64Url(codeVerifier);
      callback = createLoopbackOAuthCallback(state);
      this.oauthCallback = callback;
      await callback.ready;
      const authorization = new URL(`${CLOUDFLARE_OAUTH_BASE_URL}/oauth2/auth`);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("client_id", CLOUDFLARE_OAUTH_CLIENT_ID);
      authorization.searchParams.set("redirect_uri", CLOUDFLARE_OAUTH_REDIRECT_URI);
      authorization.searchParams.set("scope", CLOUDFLARE_OAUTH_SCOPE);
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("code_challenge", codeChallenge);
      authorization.searchParams.set("code_challenge_method", "S256");
      openExternalUrl(authorization.toString());
      const code = await callback.code;
      accessToken = await exchangeCloudflareCode(code, codeVerifier, { debugLog });
      const result = await provisionPersonalCloudflare(accessToken, onStage, { debugLog });
      onStage("save");
      try {
        await this.saveSettings({
          cloudflareMode: "self",
          selfPublishToken: result.publishToken,
          deploymentWorkerUrl: result.serviceUrl,
          deploymentOriginUrl: result.serviceUrl,
          deploymentWorkerName: result.workerName || workerNameFromServiceUrl(result.serviceUrl),
          workerVersion: EMBEDDED_TARGET_PLUGIN_VERSION,
          workerVersionStatus: "current",
          workerVersionCheckedAt: Date.now(),
          workerVersionServiceUrl: result.serviceUrl,
        });
      } catch {
        const error = new CloudflareProvisioningError("SETTINGS_SAVE_FAILED", "Could not save the connection", { stage: "save" });
        error.cleanupIncomplete = true;
        throw error;
      }
      new Notice(copy.deployedNotice(result.serviceUrl));
      return true;
    } catch (cause) {
      const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("PROVISIONING_FAILED", "Deployment failed", { stage: session.stage });
      error.operationId = session.operationId;
      session.error = error;
      this.recordDeploymentLog({ error });
      new Notice(deploymentFailure(error, copy), 12_000);
      return false;
    } finally {
      progress.hide?.();
      callback?.close();
      if (callback) await callback.closed;
      this.oauthCallback = null;
      onStage("authorization_cleanup");
      if (accessToken) {
        try {
          await revokeCloudflareToken(accessToken, { debugLog });
        } catch (error) {
          session.cleanupError = error instanceof CloudflareProvisioningError ? error : new CloudflareProvisioningError("OAUTH_REVOKE_FAILED", "Authorization cleanup failed", { stage: "authorization_cleanup" });
          this.recordDeploymentLog({ error: session.cleanupError });
          new Notice(copy.oauthCleanupWarning);
        }
      }
      accessToken = "";
      await this.persistDeploymentLogs(session);
      await this.persistDebugLogs();
      session.active = false;
      this.refreshSettingTab();
    }
  }

  async bindCustomDomain(value) {
    if (this.domainBindingPromise) return this.domainBindingPromise;
    const hostname = normalizeCustomDomain(value);
    const copy = this.copy();
    if (!hostname) {
      new Notice(copy.customDomainInvalid);
      return false;
    }
    if (!this.settings?.selfPublishToken || !this.settings?.deploymentWorkerUrl) {
      new Notice(copy.customDomainNotConfigured);
      return false;
    }
    if (!isDesktopEnvironment()) {
      new Notice(copy.customDomainDesktopOnly);
      return false;
    }
    this.domainBindingPromise = this.runCustomDomainBinding(hostname);
    try { return await this.domainBindingPromise; } finally { this.domainBindingPromise = null; }
  }

  async runCustomDomainBinding(hostname) {
    const copy = this.copy();
    const session = { operationId: createOperationId("domain-bind"), stage: "authorization", active: true, error: null, logs: [] };
    this.domainBindingSession = session;
    const progress = new Notice(copy.customDomainBinding, 0);
    const onStage = (stage) => {
      session.stage = stage;
      this.recordDeploymentLog({ type: "stage", stage, message: stage });
      progress.setMessage?.(copy.customDomainBinding);
      this.refreshSettingTab();
    };
    const debugLog = (entry) => this.recordDebugLog(entry);
    this.recordDebugLog({ type: "phase", stage: "custom_domain.authorization", message: "Custom domain binding started" });
    let callback;
    let accessToken = "";
    try {
      await this.loadSettings();
      const deploymentWorkerUrl = String(this.settings.deploymentWorkerUrl || "");
      const originUrl = String(this.settings.deploymentOriginUrl || (deploymentWorkerUrl.endsWith(".workers.dev") ? deploymentWorkerUrl : "")).replace(/\/$/, "");
      const workerName = this.settings.deploymentWorkerName || workerNameFromServiceUrl(originUrl);
      if (!originUrl || !workerName) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ORIGIN_MISSING", "The original Worker address is unavailable", { stage: "resources" });
      onStage("authorization");
      const authorized = await authorizeCloudflareScope(CLOUDFLARE_DOMAIN_OAUTH_SCOPE, { debugLog });
      callback = authorized.callback;
      accessToken = authorized.accessToken;
      const cf = (path, init = {}, options = {}) => cloudflareApiRequest(path, accessToken, init, { stage: session.stage, debugLog, ...options });
      onStage("accounts");
      const accounts = await cf("/accounts?per_page=50");
      if (!Array.isArray(accounts) || accounts.length === 0) throw new CloudflareProvisioningError("NO_ACCOUNT_ACCESS", "No Cloudflare account is available for this authorization", { stage: session.stage });
      if (accounts.length > 1) throw new CloudflareProvisioningError("MULTIPLE_ACCOUNTS", "Authorize exactly one Cloudflare account for custom domain binding", { stage: session.stage });
      const accountId = String(accounts[0]?.id || "");
      if (!accountId) throw new CloudflareProvisioningError("NO_ACCOUNT_ACCESS", "Cloudflare did not return an account for this authorization", { stage: session.stage });
      onStage("resources");
      const domains = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains`);
      const currentDomains = Array.isArray(domains) ? domains : [];
      const workerDomains = currentDomains.filter((domain) => String(domain?.service || "") === workerName);
      const existing = workerDomains.find((domain) => normalizeCustomDomain(domain?.hostname) === hostname);
      const other = workerDomains.find((domain) => normalizeCustomDomain(domain?.hostname) && normalizeCustomDomain(domain?.hostname) !== hostname);
      if (other) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ALREADY_BOUND", `This Worker already has a custom domain: ${normalizeCustomDomain(other.hostname)}`, { stage: session.stage });
      const zone = await findCloudflareZone(accessToken, accountId, hostname, { stage: session.stage, debugLog });
      if (!zone?.id || !zone?.name) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ZONE_NOT_FOUND", "The domain is not an active Zone in this Cloudflare account", { stage: session.stage });
      if (zone.status && zone.status !== "active") throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ZONE_INACTIVE", "The Cloudflare Zone is not active", { stage: session.stage });
      onStage("domain_attach");
      const attached = existing || await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains`, {
        method: "PUT",
        body: JSON.stringify({ hostname, service: workerName, zone_id: String(zone.id), zone_name: String(zone.name) }),
      });
      const domainId = String(attached?.id || existing?.id || "");
      if (!domainId) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_INVALID_RESPONSE", "Cloudflare did not return a custom domain id", { stage: session.stage });
      const activeUrl = customDomainUrl(hostname);
      await this.saveSettings({
        cloudflareMode: "self",
        apiBaseUrl: activeUrl,
        serviceUrl: activeUrl,
        deploymentWorkerUrl: originUrl,
        deploymentOriginUrl: originUrl,
        deploymentWorkerName: workerName,
        customDomain: hostname,
        customDomainId: domainId,
        customDomainZoneName: String(zone.name),
        customDomainStatus: "active",
        connectionStatus: "connected",
        deploymentStatus: "ready",
        lastPublishedUrl: rewriteUrlOrigin(this.settings.lastPublishedUrl, originUrl, activeUrl),
      });
      new Notice(copy.customDomainBound(activeUrl));
      return true;
    } catch (cause) {
      const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("CUSTOM_DOMAIN_BINDING_FAILED", "Custom domain binding failed", { stage: session.stage });
      error.operationId = session.operationId;
      session.error = error;
      this.recordDeploymentLog({ error });
      new Notice(`${copy.customDomainBindingFailed}: ${customDomainFailureMessage(error, copy)}`, 12_000);
      return false;
    } finally {
      progress.hide?.();
      callback?.close();
      if (callback) await callback.closed;
      if (accessToken) {
        try { await revokeCloudflareToken(accessToken, { debugLog }); }
        catch (error) { session.cleanupError = error; this.recordDeploymentLog({ error }); new Notice(copy.oauthCleanupWarning); }
      }
      accessToken = "";
      await this.persistDeploymentLogs(session);
      await this.persistDebugLogs();
      session.active = false;
      this.refreshSettingTab();
    }
  }

  async unbindCustomDomain() {
    if (this.domainBindingPromise) return false;
    const copy = this.copy();
    const hostname = normalizeCustomDomain(this.settings?.customDomain);
    if (!hostname) return true;
    if (!isDesktopEnvironment()) {
      new Notice(copy.customDomainDesktopOnly);
      return false;
    }
    this.domainBindingPromise = this.runCustomDomainUnbinding(hostname);
    try { return await this.domainBindingPromise; } finally { this.domainBindingPromise = null; }
  }

  async runCustomDomainUnbinding(hostname) {
    const copy = this.copy();
    const session = { operationId: createOperationId("domain-unbind"), remoteOutcome: "not_started", stage: "authorization", active: true, error: null, logs: [] };
    this.domainBindingSession = session;
    const progress = new Notice(copy.customDomainBinding, 0);
    const debugLog = (entry) => this.recordDebugLog(entry);
    const onStage = (stage) => {
      session.stage = stage;
      this.recordDeploymentLog({ type: "stage", stage, message: stage });
      progress.setMessage?.(copy.customDomainBinding);
      this.refreshSettingTab();
    };
    let callback;
    let accessToken = "";
    try {
      await this.loadSettings();
      const originUrl = String(this.settings.deploymentOriginUrl || "").replace(/\/$/, "");
      const workerName = this.settings.deploymentWorkerName || workerNameFromServiceUrl(originUrl);
      if (!originUrl || !workerName) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ORIGIN_MISSING", "The original Worker address is unavailable", { stage: "resources" });
      onStage("authorization");
      const authorized = await authorizeCloudflareScope(CLOUDFLARE_DOMAIN_OAUTH_SCOPE, { debugLog });
      callback = authorized.callback;
      accessToken = authorized.accessToken;
      const cf = (path, init = {}, options = {}) => cloudflareApiRequest(path, accessToken, init, { stage: session.stage, debugLog, ...options });
      onStage("accounts");
      const accounts = await cf("/accounts?per_page=50");
      if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0]?.id) throw new CloudflareProvisioningError(accounts?.length > 1 ? "MULTIPLE_ACCOUNTS" : "NO_ACCOUNT_ACCESS", "Authorize exactly one Cloudflare account to unbind this domain", { stage: session.stage });
      const accountId = String(accounts[0].id);
      onStage("resources");
      const domains = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains`);
      const currentDomains = Array.isArray(domains) ? domains : [];
      const savedDomainId = String(this.settings.customDomainId || "");
      const foundById = savedDomainId ? currentDomains.find((domain) => String(domain?.id || "") === savedDomainId) : undefined;
      const foundByHostname = currentDomains.find((domain) => normalizeCustomDomain(domain?.hostname) === hostname);
      const found = foundById || (foundByHostname && String(foundByHostname.service || "") === workerName ? foundByHostname : undefined);
      if (foundByHostname && !foundById && String(foundByHostname.service || "") !== workerName) {
        throw new CloudflareProvisioningError("CUSTOM_DOMAIN_NOT_OWNED", "This custom domain is not attached to this One-Click Publish Worker", { stage: session.stage });
      }
      const domainId = String(found?.id || savedDomainId);
      if (!domainId) {
        throw new CloudflareProvisioningError("CUSTOM_DOMAIN_NOT_FOUND", "Cloudflare could not find the saved custom domain attachment", { stage: session.stage });
      }
      const transition = {
        state: "detaching",
        operationId: session.operationId,
        hostname,
        domainId,
        originUrl,
        workerName,
        startedAt: new Date().toISOString(),
      };
      try {
        await this.saveSettings({ customDomainTransition: transition });
      } catch (saveCause) {
        throw new CloudflareProvisioningError("LOCAL_SETTINGS_SAVE_FAILED", "Could not prepare the local custom-domain state", {
          stage: "save",
          causeMessage: saveCause instanceof Error ? saveCause.message : String(saveCause),
          remoteOutcome: "not_started",
        });
      }
      onStage("domain_detach");
      session.remoteOutcome = "delete_requested";
      await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`, { method: "DELETE" });
      session.remoteOutcome = "detached";
      try {
        await this.saveSettings({
          cloudflareMode: "self",
          apiBaseUrl: originUrl,
          serviceUrl: originUrl,
          deploymentWorkerUrl: originUrl,
          deploymentOriginUrl: originUrl,
          customDomain: "",
          customDomainId: "",
          customDomainZoneName: "",
          customDomainStatus: "none",
          customDomainTransition: null,
          connectionStatus: "connected",
          deploymentStatus: "ready",
          lastPublishedUrl: rewriteUrlOrigin(this.settings.lastPublishedUrl, customDomainUrl(hostname), originUrl),
        });
      } catch (saveCause) {
        throw new CloudflareProvisioningError("LOCAL_SETTINGS_SAVE_FAILED", "Cloudflare detached the domain but local settings could not be saved", {
          stage: "save",
          causeMessage: saveCause instanceof Error ? saveCause.message : String(saveCause),
          remoteOutcome: session.remoteOutcome,
        });
      }
      new Notice(copy.customDomainUnbound);
      return true;
    } catch (cause) {
      const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("CUSTOM_DOMAIN_UNBINDING_FAILED", "Custom domain unbinding failed", {
        stage: session.stage,
        causeMessage: cause instanceof Error ? cause.message : String(cause),
        remoteOutcome: session.remoteOutcome,
      });
      if (!error.remoteOutcome) error.remoteOutcome = session.remoteOutcome;
      error.operationId = session.operationId;
      session.error = error;
      this.recordDeploymentLog({ error });
      new Notice(`${copy.customDomainUnbindingFailed}: ${customDomainFailureMessage(error, copy)}`, 12_000);
      return false;
    } finally {
      progress.hide?.();
      callback?.close();
      if (callback) await callback.closed;
      if (accessToken) {
        try { await revokeCloudflareToken(accessToken, { debugLog }); }
        catch (error) { session.cleanupError = error; this.recordDeploymentLog({ error }); new Notice(copy.oauthCleanupWarning); }
      }
      accessToken = "";
      await this.persistDeploymentLogs(session);
      await this.persistDebugLogs();
      session.active = false;
      this.refreshSettingTab();
    }
  }

  async recoverCustomDomainTransition() {
    if (this.domainBindingPromise) return false;
    const transition = normalizeCustomDomainTransition(this.settings?.customDomainTransition);
    if (!transition) return true;
    if (!isDesktopEnvironment()) {
      new Notice(this.copy().customDomainDesktopOnly);
      return false;
    }
    this.domainBindingPromise = this.runCustomDomainTransitionRecovery(transition);
    try { return await this.domainBindingPromise; } finally { this.domainBindingPromise = null; }
  }

  async runCustomDomainTransitionRecovery(transition) {
    const copy = this.copy();
    const session = { operationId: transition.operationId || createOperationId("domain-recovery"), remoteOutcome: "not_started", stage: "authorization", active: true, error: null, logs: [] };
    this.domainBindingSession = session;
    const progress = new Notice(copy.customDomainBinding, 0);
    const debugLog = (entry) => this.recordDebugLog(entry);
    const onStage = (stage) => {
      session.stage = stage;
      this.recordDeploymentLog({ type: "stage", stage, message: stage });
      progress.setMessage?.(copy.customDomainBinding);
      this.refreshSettingTab();
    };
    let callback;
    let accessToken = "";
    try {
      const originUrl = transition.originUrl || String(this.settings.deploymentOriginUrl || "").replace(/\/$/, "");
      const workerName = transition.workerName || this.settings.deploymentWorkerName || workerNameFromServiceUrl(originUrl);
      if (!originUrl || !workerName) throw new CloudflareProvisioningError("CUSTOM_DOMAIN_ORIGIN_MISSING", "The original Worker address is unavailable", { stage: "resources" });
      onStage("authorization");
      const authorized = await authorizeCloudflareScope(CLOUDFLARE_DOMAIN_OAUTH_SCOPE, { debugLog });
      callback = authorized.callback;
      accessToken = authorized.accessToken;
      const cf = (path, init = {}, options = {}) => cloudflareApiRequest(path, accessToken, init, { stage: session.stage, debugLog, ...options });
      onStage("accounts");
      const accounts = await cf("/accounts?per_page=50");
      if (!Array.isArray(accounts) || accounts.length !== 1 || !accounts[0]?.id) throw new CloudflareProvisioningError(accounts?.length > 1 ? "MULTIPLE_ACCOUNTS" : "NO_ACCOUNT_ACCESS", "Authorize exactly one Cloudflare account to recover this domain", { stage: session.stage });
      const accountId = String(accounts[0].id);
      onStage("resources");
      const domains = await cf(`/accounts/${encodeURIComponent(accountId)}/workers/domains`);
      const currentDomains = Array.isArray(domains) ? domains : [];
      const foundById = transition.domainId ? currentDomains.find((domain) => String(domain?.id || "") === transition.domainId) : undefined;
      const foundByHostname = currentDomains.find((domain) => normalizeCustomDomain(domain?.hostname) === transition.hostname);
      const found = foundById || foundByHostname;
      if (found && String(found.service || "") !== workerName) {
        throw new CloudflareProvisioningError("CUSTOM_DOMAIN_NOT_OWNED", "This custom domain is not attached to this One-Click Publish Worker", { stage: session.stage, remoteOutcome: "inspected" });
      }
      session.remoteOutcome = found ? "attached" : "detached";
      if (found) {
        await this.saveSettings({ customDomainTransition: null });
        new Notice(copy.customDomainRecoveryRestored);
      } else {
        try {
          await this.saveSettings({
            cloudflareMode: "self",
            apiBaseUrl: originUrl,
            serviceUrl: originUrl,
            deploymentWorkerUrl: originUrl,
            deploymentOriginUrl: originUrl,
            deploymentWorkerName: workerName,
            customDomain: "",
            customDomainId: "",
            customDomainZoneName: "",
            customDomainStatus: "none",
            customDomainTransition: null,
            connectionStatus: "connected",
            deploymentStatus: "ready",
            lastPublishedUrl: rewriteUrlOrigin(this.settings.lastPublishedUrl, customDomainUrl(transition.hostname), originUrl),
          });
        } catch (saveCause) {
          throw new CloudflareProvisioningError("LOCAL_SETTINGS_SAVE_FAILED", "Cloudflare has no attachment, but local settings could not be finalized", {
            stage: "save",
            causeMessage: saveCause instanceof Error ? saveCause.message : String(saveCause),
            remoteOutcome: session.remoteOutcome,
          });
        }
        new Notice(copy.customDomainRecoveryCompleted);
      }
      return true;
    } catch (cause) {
      const error = cause instanceof CloudflareProvisioningError ? cause : new CloudflareProvisioningError("CUSTOM_DOMAIN_RECOVERY_FAILED", "Custom domain state recovery failed", {
        stage: session.stage,
        causeMessage: cause instanceof Error ? cause.message : String(cause),
        remoteOutcome: session.remoteOutcome,
      });
      if (!error.remoteOutcome) error.remoteOutcome = session.remoteOutcome;
      error.operationId = session.operationId;
      session.error = error;
      this.recordDeploymentLog({ error });
      new Notice(`${copy.customDomainRecoveryFailed}: ${customDomainFailureMessage(error, copy)}`, 12_000);
      return false;
    } finally {
      progress.hide?.();
      callback?.close();
      if (callback) await callback.closed;
      if (accessToken) {
        try { await revokeCloudflareToken(accessToken, { debugLog }); }
        catch (error) { session.cleanupError = error; this.recordDeploymentLog({ error }); new Notice(copy.oauthCleanupWarning); }
      }
      accessToken = "";
      await this.persistDeploymentLogs(session);
      await this.persistDebugLogs();
      session.active = false;
      this.refreshSettingTab();
    }
  }

  async publishBundle(bundle, siteId, sourceKeyForIdempotency, connection) {
    if (!connection) { await this.loadSettings(); connection = this.connectionSnapshot(); }
    const apiBaseUrl = connection.serviceUrl.replace(/\/$/, "");
    const chunks = createUploadChunks(bundle);
    if (!connection.publishToken) throw new Error(this.settings.cloudflareMode === "self" && !isDesktopEnvironment() ? this.copy().desktopDeploymentOnly : this.copy().authenticationRequired);
    const upload = await this.requestPublish(`${apiBaseUrl}/v1/sites/uploads`, "POST", {
      siteId: siteId || undefined,
      idempotencyKey: `${sourceKeyForIdempotency}:upload:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      formatVersion: bundle.formatVersion,
      chunkProtocolVersion: 2,
      sourcePath: bundle.sourcePath,
      title: bundle.title,
      chunkCount: chunks.length,
      objectCount: bundle.pages.length + bundle.assets.length,
      totalBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    }, { connection });
    const copy = this.copy();
    const progress = new Notice(copy.uploading(0, chunks.length));
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        await this.requestPublish(`${apiBaseUrl}/v1/uploads/${encodeURIComponent(upload.uploadId)}/chunks`, "POST", {
          uploadId: upload.uploadId,
          ...chunks[index],
        }, { connection });
        progress.setMessage?.(copy.uploading(index + 1, chunks.length));
      }
      return await this.requestPublish(`${apiBaseUrl}/v1/uploads/${encodeURIComponent(upload.uploadId)}/commit`, "POST", {
        uploadId: upload.uploadId,
      }, { connection });
    } finally {
      progress.hide?.();
    }
  }

  async finishPublish(result, publishedUrl = result.url) {
    const copy = this.copy();
    try {
      await navigator.clipboard.writeText(publishedUrl);
      new Notice(copy.publishedAndCopied(publishedUrl));
    } catch {
      new Notice(copy.published(publishedUrl));
    }
  }

  async collectShareNotes(rootFile, rootMarkdown) {
    const notes = [];
    const queue = [{ file: rootFile, markdown: rootMarkdown, depth: 0 }];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current.file.path)) continue;
      seen.add(current.file.path);
      notes.push({ file: current.file, sourcePath: current.file.path, title: current.file.basename, markdown: current.markdown });
      if (!shouldFollowLinkedPage(current.depth, this.settings.linkedPageDepth)) continue;
      for (const reference of this.extractNoteReferences(current.file, current.markdown)) {
        const target = this.resolveVaultNote(reference, current.file);
        if (!target || seen.has(target.path)) continue;
        queue.push({ file: target, markdown: await this.app.vault.read(target), depth: current.depth + 1 });
      }
    }
    return notes;
  }

  extractNoteReferences(file, markdown) {
    const references = new Set(
      (this.app.metadataCache.getFileCache(file)?.links || [])
        .map((link) => link.link)
        .filter((reference) => reference && !isExternalReference(reference)),
    );
    for (const match of markdown.matchAll(/(?<!\!)\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]+)?\]\]/g)) {
      if (!isExternalReference(match[1])) references.add(match[1]);
    }
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]*)?)\)/gi)) {
      if (!isExternalReference(match[1])) references.add(match[1]);
    }
    return [...references];
  }

  resolveVaultNote(reference, sourceFile) {
    let clean = String(reference || "").split("#", 1)[0].split("^", 1)[0].trim();
    if (!clean || isExternalReference(clean)) return null;
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // Keep partially encoded names for the direct vault lookup.
    }
    if (isExternalReference(clean)) return null;
    const candidates = [];
    const resolved = this.app.metadataCache.getFirstLinkpathDest?.(clean, sourceFile.path);
    if (resolved) candidates.push(resolved);
    const direct = this.app.vault.getAbstractFileByPath(clean.replace(/^\.\//, ""));
    if (direct) candidates.push(direct);
    const parentPath = sourceFile.parent?.path ? `${sourceFile.parent.path}/${clean}` : clean;
    const relative = parentPath.split("/").reduce((parts, part) => {
      if (!part || part === ".") return parts;
      if (part === "..") parts.pop();
      else parts.push(part);
      return parts;
    }, []).join("/");
    const relativeFile = this.app.vault.getAbstractFileByPath(relative);
    if (relativeFile) candidates.push(relativeFile);
    return candidates.find((candidate) => String(candidate.extension || "").toLowerCase() === "md") || null;
  }

  async collectAssets(noteInputs) {
    const assets = [];
    const seen = new Set();
    for (const note of noteInputs) {
      const references = extractAssetReferences(note.markdown);
      for (const reference of references) {
        const file = this.resolveVaultAsset(reference, note.file);
        if (!file || seen.has(file.path)) continue;
        seen.add(file.path);
        const binary = new Uint8Array(await this.app.vault.readBinary(file));
        let binaryString = "";
        for (let offset = 0; offset < binary.length; offset += 0x8000) {
          binaryString += String.fromCharCode(...binary.subarray(offset, offset + 0x8000));
        }
        assets.push({
          sourcePath: file.path,
          path: defaultAssetPath(file.path),
          contentType: mimeTypeFor(file.extension),
          body: btoa(binaryString),
          encoding: "base64",
        });
      }
    }
    return assets;
  }

  resolveVaultAsset(reference, noteFile) {
    const cleanReference = decodeURIComponent(reference.split("#", 1)[0].trim());
    if (!cleanReference || isExternalUrl(cleanReference)) return null;
    const direct = this.app.vault.getAbstractFileByPath(cleanReference);
    if (direct && typeof direct.extension === "string" && direct.extension !== "md") return direct;
    const link = this.app.metadataCache.getFirstLinkpathDest?.(cleanReference, noteFile.path);
    if (link && typeof link.extension === "string" && link.extension !== "md") return link;
    const parentPath = noteFile.parent?.path ? `${noteFile.parent.path}/${cleanReference}` : cleanReference;
    const relative = this.app.vault.getAbstractFileByPath(parentPath);
    return relative && typeof relative.extension === "string" && relative.extension !== "md" ? relative : null;
  }

  async savePublishedMetadata(file, result, publishedUrl = result.url) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.share_site_id = result.siteId;
      frontmatter.share_link = publishedUrl;
      frontmatter.share_updated = new Date().toISOString();
    });
    await this.saveSettings({ lastPublishedUrl: publishedUrl });
  }

  openLastPublishedSite() {
    if (!this.settings.lastPublishedUrl) {
      new Notice(this.copy().noPublishedLink);
      return;
    }
    openExternalUrl(this.settings.lastPublishedUrl);
  }

  async copyLastPublishedLink() {
    if (!this.settings.lastPublishedUrl) {
      new Notice(this.copy().noPublishedLink);
      return;
    }
    try {
      await navigator.clipboard.writeText(this.settings.lastPublishedUrl);
      new Notice(this.copy().linkCopied);
    } catch {
      new Notice(this.copy().linkCopyFailed);
    }
  }
}

class SharePublisherSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.disconnectPending = false;
    this.disconnectBusy = false;
    this.customDomainInput = "";
    this.customDomainConfirmation = "";
  }

  display() {
    const { containerEl } = this;
    const copy = copyForLanguage(this.plugin.settings.language);
    const session = [this.plugin.deploymentSession, this.plugin.domainBindingSession].find((item) => item?.active)
      || this.plugin.domainBindingSession
      || this.plugin.deploymentSession;
    const cloudflareBusy = session?.active === true;
    const hasPersonal = Boolean(this.plugin.settings.deploymentWorkerUrl && this.plugin.settings.selfPublishToken);
    const personalSelected = hasPersonal && this.plugin.settings.cloudflareMode === "self";
    if (!hasPersonal) this.disconnectPending = false;
    containerEl.empty();
    containerEl.createEl("p", { text: copy.settingsIntro });
    containerEl.createEl("p", { text: copy.settingsIntroDetails });
    new Setting(containerEl)
      .setName(copy.language)
      .setDesc(copy.languageDescription)
      .addDropdown((dropdown) => dropdown
        .addOption("en", "English")
        .addOption("zh", "中文")
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = normalizeLanguage(value);
          await this.plugin.saveSettings();
          this.display();
        }));
    containerEl.createEl("h3", { text: copy.cloudflareSection });
    const cloudflareSetting = new Setting(containerEl)
      .setName(copy.deployToCloudflare)
      .setDesc(`${copy.selfCloudflareDescription} ${copy.deploymentDescription} ${!hasPersonal && !isDesktopEnvironment() ? copy.desktopDeploymentOnly : ""} ${personalSelected ? copy.selectedMode : copy.notSelectedMode} ${hasPersonal ? copy.disconnectCloudflareDescription : ""} ${this.disconnectPending ? copy.disconnectConfirm : ""}${session?.active ? ` · ${deploymentProgress(session.stage, copy)}` : ""}${session?.error ? ` · ${deploymentFailure(session.error, copy)}` : ""}`);
    if (!this.disconnectPending) cloudflareSetting.addButton((button) => button
      .setButtonText(personalSelected ? copy.updateCloudflareWorker : hasPersonal ? copy.useConnection : copy.deployToCloudflare)
      .setCta()
      .setDisabled(cloudflareBusy || (!hasPersonal && !isDesktopEnvironment()) || (personalSelected && !isDesktopEnvironment()))
      .onClick(() => void this.plugin.deployToCloudflare().then(() => this.display())));
    if (hasPersonal) cloudflareSetting.addButton((button) => button
      .setButtonText(this.disconnectPending ? copy.confirmDisconnect : copy.disconnectCloudflare)
      .setDisabled(cloudflareBusy || this.disconnectBusy)
      .onClick(() => {
        if (!this.disconnectPending) {
          this.disconnectPending = true;
          this.display();
          return;
        }
        if (this.disconnectBusy) return;
        this.disconnectBusy = true;
        void this.plugin.disconnectCloudflare()
          .then((disconnected) => {
            if (disconnected) this.disconnectPending = false;
          })
          .catch((error) => {
            new Notice(`${copy.disconnectFailed}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            this.disconnectBusy = false;
            this.display();
          });
      }));
    if (hasPersonal && this.disconnectPending) cloudflareSetting.addButton((button) => button
      .setButtonText(copy.cancelDisconnect)
      .setDisabled(cloudflareBusy || this.disconnectBusy)
      .onClick(() => {
        if (this.disconnectBusy) return;
        this.disconnectPending = false;
        this.display();
      }));
    if (personalSelected && workerVersionNeedsUpdate(this.plugin.settings)) {
      new Setting(containerEl)
        .setName(copy.workerUpdateRequiredTitle)
        .setDesc(this.plugin.settings.workerVersionStatus === "unreachable"
          ? copy.workerVersionUnavailable
          : copy.workerUpdateRequired(this.plugin.settings.workerVersion, EMBEDDED_TARGET_PLUGIN_VERSION));
    }
    const customDomain = normalizeCustomDomain(this.plugin.settings.customDomain);
    const recoveryPending = Boolean(this.plugin.settings.customDomainTransition);
    const domainBusy = Boolean(this.plugin.domainBindingPromise || this.plugin.domainBindingSession?.active || recoveryPending);
    const domainCandidate = normalizeCustomDomain(this.customDomainInput);
    const bindConfirmationPending = Boolean(domainCandidate) && this.customDomainConfirmation === `bind:${domainCandidate}`;
    const unbindConfirmationPending = Boolean(customDomain) && this.customDomainConfirmation === `unbind:${customDomain}`;
    const activePublishUrl = String(this.plugin.settings.apiBaseUrl || "").replace(/\/$/, "");
    const customDomainSetting = new Setting(containerEl)
      .setName(copy.customDomain)
      .setDesc(`${copy.customDomainDescription}${customDomain ? ` ${copy.customDomainStatus}: ${customDomain}${activePublishUrl ? ` · ${copy.customDomainActiveAddress(activePublishUrl)}` : ""}` : ""}${recoveryPending ? ` ${copy.customDomainRecoveryRequired}` : bindConfirmationPending ? ` ${copy.customDomainConfirm(domainCandidate)}` : unbindConfirmationPending ? ` ${copy.customDomainUnbindConfirm(customDomain)}` : ""}${!hasPersonal ? ` ${copy.customDomainNotConfigured}` : !isDesktopEnvironment() ? ` ${copy.customDomainDesktopOnly}` : ""}`)
      .addText((text) => {
        text.setValue(this.customDomainInput || customDomain);
        text.setPlaceholder(copy.customDomainPlaceholder);
        text.inputEl.disabled = !hasPersonal || domainBusy || Boolean(customDomain) || bindConfirmationPending || unbindConfirmationPending;
        text.onChange((value) => { this.customDomainInput = value; this.customDomainConfirmation = ""; });
      });
    if (recoveryPending) {
      customDomainSetting.addButton((button) => button
        .setButtonText(copy.customDomainRecover)
        .setCta()
        .setDisabled(!isDesktopEnvironment() || Boolean(this.plugin.domainBindingPromise))
        .onClick(() => void this.plugin.recoverCustomDomainTransition().then(() => this.display()).catch((error) => new Notice(`${copy.customDomainRecoveryFailed}: ${error instanceof Error ? error.message : String(error)}`, 12_000))));
    } else if (hasPersonal && customDomain) {
      if (unbindConfirmationPending) {
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.customDomainConfirmAction)
          .setCta()
          .setDisabled(domainBusy || !isDesktopEnvironment())
          .onClick(() => {
            this.customDomainConfirmation = "";
            void this.plugin.unbindCustomDomain().then(() => {
              this.customDomainInput = "";
              this.display();
            });
          }));
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.customDomainCancelAction)
          .setDisabled(domainBusy)
          .onClick(() => { this.customDomainConfirmation = ""; this.display(); }));
      } else {
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.customDomainUnbind)
          .setDisabled(domainBusy || !isDesktopEnvironment())
          .onClick(() => { this.customDomainConfirmation = `unbind:${customDomain}`; this.display(); }));
      }
    } else if (hasPersonal) {
      if (bindConfirmationPending) {
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.customDomainConfirmAction)
          .setCta()
          .setDisabled(domainBusy || !isDesktopEnvironment())
          .onClick(() => {
            const value = this.customDomainInput;
            this.customDomainConfirmation = "";
            void this.plugin.bindCustomDomain(value).then((bound) => {
              if (bound) this.customDomainInput = "";
              this.display();
            });
          }));
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.customDomainCancelAction)
          .setDisabled(domainBusy)
          .onClick(() => { this.customDomainConfirmation = ""; this.display(); }));
      } else {
        customDomainSetting.addButton((button) => button
          .setButtonText(copy.bindCustomDomain)
          .setCta()
          .setDisabled(domainBusy || !isDesktopEnvironment())
          .onClick(() => {
            const candidate = normalizeCustomDomain(this.customDomainInput);
            if (!candidate) {
              void this.plugin.bindCustomDomain(this.customDomainInput).then(() => this.display());
              return;
            }
            this.customDomainConfirmation = `bind:${candidate}`;
            this.display();
          }));
      }
    }
    const domainBindingSession = this.plugin.domainBindingSession;
    const domainBindingLogs = [...(domainBindingSession?.logs || [])].slice(-60);
    if (!this.plugin.settings.debugMode && domainBindingSession?.error && domainBindingLogs.length) {
      const details = containerEl.createEl("details");
      details.open = true;
      details.createEl("summary", { text: copy.customDomainDiagnostics });
      const diagnosticLogText = JSON.stringify(domainBindingLogs, null, 2);
      details.createEl("pre", { text: diagnosticLogText });
      new Setting(details)
        .addButton((button) => button.setButtonText(copy.copyTechnicalDetails).onClick(() => void copyTextToClipboard(diagnosticLogText).then((ok) => new Notice(ok ? copy.copied : copy.copyFailed))));
      new Setting(details)
        .addButton((button) => button.setButtonText(copy.clearTechnicalDetails).onClick(() => void this.plugin.clearOperationDiagnostics(domainBindingSession).then(() => this.display())));
    }
    const deploymentLogs = [...(this.plugin.settings.deploymentLogs || []), ...(session?.logs || [])].slice(-60);
    if (this.plugin.settings.debugMode && deploymentLogs.length) {
      const logDetails = containerEl.createEl("details");
      logDetails.open = Boolean(session?.active || session?.error);
      logDetails.createEl("summary", { text: copy.deploymentLogs });
      const logText = JSON.stringify(deploymentLogs, null, 2);
      logDetails.createEl("pre", { text: logText });
      new Setting(logDetails)
        .addButton((button) => button.setButtonText(copy.copyDeploymentLogs).onClick(() => void copyTextToClipboard(logText).then((ok) => new Notice(ok ? copy.copied : copy.copyFailed))))
        .addButton((button) => button.setButtonText(copy.clearDeploymentLogs).setDisabled(Boolean(session?.active)).onClick(() => void this.plugin.clearDeploymentLogs().then(() => this.display())));
    }
    const diagnostics = [session?.error, session?.cleanupError].filter(Boolean);
    if (diagnostics.length) {
      const details = containerEl.createEl("details");
      details.createEl("summary", { text: copy.technicalDetails });
      const technicalText = JSON.stringify(diagnostics.map(deploymentDiagnostic), null, 2);
      details.createEl("pre", { text: technicalText });
      new Setting(details)
        .addButton((button) => button.setButtonText(copy.copyTechnicalDetails).onClick(() => void copyTextToClipboard(technicalText).then((ok) => new Notice(ok ? copy.copied : copy.copyFailed))))
        .addButton((button) => button.setButtonText(copy.clearTechnicalDetails).onClick(() => void this.plugin.clearOperationDiagnostics(session).then(() => this.display())));
    }
    const debugLogs = [...(this.plugin.settings.debugLogs || [])].slice(-120);
    if (this.plugin.settings.debugMode) {
      const details = containerEl.createEl("details");
      details.open = Boolean(this.plugin.settings.debugMode);
      details.createEl("summary", { text: copy.debugLogs });
      const debugText = debugLogs.length ? JSON.stringify(debugLogs, null, 2) : copy.noDebugLogs;
      details.createEl("pre", { text: debugText });
      new Setting(details)
        .addButton((button) => button.setButtonText(copy.copyDebugLogs).onClick(() => void copyTextToClipboard(debugText).then((ok) => new Notice(ok ? copy.copied : copy.copyFailed))))
        .addButton((button) => button.setButtonText(copy.clearDebugLogs).onClick(() => void this.plugin.clearDebugLogs().then(() => this.display())));
    }
    containerEl.createEl("h3", { text: copy.contentSection });
    new Setting(containerEl)
      .setName(copy.linkedNoteDepth)
      .setDesc(copy.linkedNoteDepthDescription)
      .addText((text) => {
        text.setValue(String(this.plugin.settings.linkedPageDepth)).setPlaceholder("1");
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.step = "1";
        text.onChange(async (value) => {
          this.plugin.settings.linkedPageDepth = normalizeLinkedPageDepth(value);
          this.plugin.settings.includeLinkedPages = this.plugin.settings.linkedPageDepth > 0;
          text.setValue(String(this.plugin.settings.linkedPageDepth));
          await this.plugin.saveSettings();
        });
    });
    new Setting(containerEl)
      .setName(copy.nativeRenderer)
      .setDesc(copy.nativeRendererDescription)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useNativeRenderer !== false).onChange(async (value) => {
        this.plugin.settings.useNativeRenderer = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName(copy.debugMode)
      .setDesc(copy.debugModeDescription)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.debugMode === true).onChange(async (value) => {
        this.plugin.settings.debugMode = value;
        await this.plugin.saveSettings({ debugMode: value });
        this.display();
      }));
    new Setting(containerEl)
      .setName(copy.repository)
      .setDesc(REPOSITORY_URL)
      .addButton((button) => button.setButtonText(copy.open).onClick(() => openExternalUrl(REPOSITORY_URL)));
  }
}

function deploymentStatusText(status, copy) {
  if (status === "ready") return copy.deploymentReady;
  if (status === "starting") return copy.deploymentStarting;
  if (status === "authorizing") return copy.deploymentAuthorizing;
  if (status === "provisioning") return copy.deploymentProvisioning;
  if (status === "failed") return copy.deploymentFailed;
  return copy.notDeployed;
}

function deploymentProgress(stage, copy) {
  if (stage === "authorization") return copy.deploymentAuthorizing;
  if (["initialize", "bootstrap_cleanup", "authorization_cleanup", "save", "cleanup"].includes(stage)) return copy.deploymentFinishing;
  return copy.deploymentProvisioning;
}

function deploymentFailure(error, copy) {
  const reasons = copy.deploymentReasons;
  const stage = copy.deploymentStages[error.stage] || copy.deploymentStages.resources;
  const internal = copy.deploymentStageErrors?.[error.stage] || sanitizeExternalMessage(error.message) || reasons.generic;
  let reason = reasons.generic;
  if (error.outcomeUnknown) reason = reasons.unknown;
  else if (error.code === "NETWORK_ERROR") reason = reasons.network;
  else if (error.code === "REQUEST_TIMEOUT" || error.code === "OAUTH_TIMEOUT") reason = reasons.timeout;
  else if (error.httpStatus === 401 || error.httpStatus === 403) reason = reasons.permission;
  else if (error.httpStatus === 429) reason = reasons.rate;
  else if (error.code === "INVALID_RESPONSE") reason = reasons.response;
  else if (["OAUTH_DENIED", "OAUTH_CANCELLED"].includes(error.code)) reason = reasons.denied;
  else if (["MULTIPLE_ACCOUNTS", "NO_ACCOUNT_ACCESS"].includes(error.code)) reason = reasons.account;
  else if (error.code === "OAUTH_CALLBACK_UNAVAILABLE") reason = reasons.callback;
  else if (error.code === "SETTINGS_SAVE_FAILED") reason = reasons.save;
  const external = [];
  if (error.providerMessage) external.push(error.providerMessage);
  if (error.httpStatus) external.push(`HTTP ${error.httpStatus}`);
  if (error.providerCode) external.push(`code ${error.providerCode}`);
  if (error.responseContentType) external.push(error.responseContentType);
  const externalText = external.length ? ` ${copy.deploymentExternalError}：${external.join(" · ")}` : "";
  const cleanupText = error.cleanupIncomplete && !error.outcomeUnknown ? ` ${reasons.cleanup}` : "";
  return `${copy.deploymentFailed} · ${stage}：${copy.deploymentInternalError}：${internal} ${reason}${externalText}${cleanupText}`;
}

function customDomainFailureMessage(error, copy) {
  if (error?.code === "OAUTH_DENIED"
    && error?.providerCode === "invalid_scope"
    && /workers-routes\.write/i.test(String(error?.providerMessage || ""))) {
    return copy.customDomainOAuthScopeUnavailable;
  }
  if (error?.code === "CUSTOM_DOMAIN_ZONE_NOT_FOUND" || error?.code === "CUSTOM_DOMAIN_ZONE_INACTIVE") return copy.customDomainZoneNotFound;
  if (error?.code === "CUSTOM_DOMAIN_NOT_OWNED") return copy.customDomainNotOwned;
  if (error?.code === "CUSTOM_DOMAIN_NOT_FOUND") return copy.customDomainNotFound;
  if (error?.code === "LOCAL_SETTINGS_SAVE_FAILED") {
    const cause = sanitizeExternalMessage(error?.causeMessage);
    return `${copy.customDomainLocalSaveFailed}${cause ? ` ${cause}` : ""}`;
  }
  return sanitizeExternalMessage(error?.providerMessage || error?.message) || copy.deploymentReasons.generic;
}

function deploymentDiagnostic(error) {
  return {
    stage: error.stage,
    code: error.code,
    message: sanitizeExternalMessage(error.message),
    httpStatus: error.httpStatus,
    retryable: error.retryable,
    method: error.method,
    route: error.route,
    providerCode: error.providerCode,
    providerMessage: error.providerMessage,
    responseContentType: error.responseContentType,
    causeMessage: error.causeMessage,
    remoteOutcome: error.remoteOutcome,
    operationId: error.operationId,
    internal: { code: error.code, message: sanitizeExternalMessage(error.message), stage: error.stage },
    external: { httpStatus: error.httpStatus, code: error.providerCode, message: error.providerMessage, contentType: error.responseContentType },
    outcomeUnknown: error.outcomeUnknown,
    cleanupIncomplete: error.cleanupIncomplete,
  };
}

function deploymentLogRecord(input = {}) {
  const diagnostic = input.error ? deploymentDiagnostic(input.error) : input;
  return {
    timestamp: String(input.timestamp || new Date().toISOString()).slice(0, 40),
    operationId: normalizeOperationId(input.operationId || diagnostic.operationId),
    type: sanitizeExternalMessage(input.type || (input.error ? "error" : "stage")) || "event",
    stage: sanitizeExternalMessage(diagnostic.stage),
    code: sanitizeProviderCode(diagnostic.code),
    message: sanitizeExternalMessage(diagnostic.message || input.message),
    httpStatus: Number(diagnostic.httpStatus || 0),
    retryable: diagnostic.retryable === true,
    method: sanitizeProviderCode(diagnostic.method),
    route: sanitizeExternalMessage(diagnostic.route),
    providerCode: sanitizeProviderCode(diagnostic.providerCode || diagnostic.external?.code),
    providerMessage: sanitizeExternalMessage(diagnostic.providerMessage || diagnostic.external?.message),
    responseContentType: sanitizeExternalMessage(diagnostic.responseContentType || diagnostic.external?.contentType),
    causeMessage: sanitizeExternalMessage(diagnostic.causeMessage),
    remoteOutcome: sanitizeProviderCode(diagnostic.remoteOutcome),
    outcomeUnknown: diagnostic.outcomeUnknown === true,
    cleanupIncomplete: diagnostic.cleanupIncomplete === true,
  };
}

function normalizeDeploymentLogs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-60).map((entry) => deploymentLogRecord(entry)).filter((entry) => entry.stage || entry.message || entry.code || entry.providerMessage);
}

function debugLogRecord(input = {}) {
  const error = input.error;
  const source = error ? { ...error, ...input } : input;
  return {
    timestamp: String(input.timestamp || new Date().toISOString()).slice(0, 40),
    operationId: normalizeOperationId(input.operationId || source.operationId),
    type: sanitizeExternalMessage(input.type || "event") || "event",
    stage: sanitizeExternalMessage(source.stage || input.stage),
    method: sanitizeProviderCode(source.method || input.method),
    route: serviceRoute(source.route || input.route),
    transport: sanitizeProviderCode(source.transport || input.transport),
    endpointOrigin: safeEndpointOrigin(source.endpointOrigin || input.endpointOrigin),
    requestBodyBytes: Number.isFinite(source.requestBodyBytes || input.requestBodyBytes) ? Math.max(0, Math.round(source.requestBodyBytes || input.requestBodyBytes)) : undefined,
    hasAuthorization: source.hasAuthorization === true || input.hasAuthorization === true,
    attempt: Number.isInteger(input.attempt) ? input.attempt : undefined,
    httpStatus: Number(source.httpStatus || source.status || input.httpStatus || input.status || 0),
    code: sanitizeProviderCode(source.code || input.code),
    message: sanitizeExternalMessage(input.message || error?.message || source.message),
    providerCode: sanitizeProviderCode(source.providerCode || input.providerCode),
    providerMessage: sanitizeExternalMessage(source.providerMessage || input.providerMessage),
    errorName: sanitizeProviderCode(source.errorName || input.errorName),
    errorCode: sanitizeProviderCode(source.errorCode || input.errorCode),
    errorMessage: sanitizeExternalMessage(source.errorMessage || input.errorMessage),
    responseContentType: sanitizeExternalMessage(source.responseContentType || input.responseContentType),
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : undefined,
    retryable: source.retryable === true || input.retryable === true,
    outcomeUnknown: source.outcomeUnknown === true || input.outcomeUnknown === true,
  };
}

function normalizeDebugLogs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-120).map((entry) => debugLogRecord(entry)).filter((entry) => entry.stage || entry.route || entry.message || entry.code || entry.providerMessage);
}

// Keep compatibility with both direct CommonJS loaders and default-export loaders.
module.exports = SharePublisherPlugin;
module.exports.default = SharePublisherPlugin;
module.exports.__testing = {
  CloudflareProvisioningError,
  choosePersonalCloudflareNames,
  createLoopbackOAuthCallback,
  hmacSha256Base64Url,
  isDesktopEnvironment,
  provisionPersonalCloudflare,
  sha256Base64Url,
  splitMigrationStatements,
  deploymentRequest,
  encodeWorkerMultipart,
  deploymentDiagnostic,
  deploymentFailure,
  copyForLanguage,
  copyTextToClipboard,
  deploymentLogRecord,
  normalizeDeploymentLogs,
  debugLogRecord,
  normalizeDebugLogs,
  normalizeSettings,
  packConnections,
  createNativeStylesheetAsset,
};

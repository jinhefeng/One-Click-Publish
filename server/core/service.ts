import { normalizeRelativePath, siteUrl } from "../../src/shared/paths.ts";
import { ServiceError } from "./errors.ts";
import {
  hashPassword,
  normalizeEmail,
  normalizePassword,
  normalizeTokenName,
  randomSecret,
  randomId,
  recoveryCode,
  hmacSha256,
  constantTimeEqual,
  sha256,
  verifyPassword,
} from "./crypto.ts";
import type { AccountRecord, CommitUploadInput, DeviceAuthorizationRecord, PublishResultRecord, SessionRecord, SiteRecord, StorageUsage, TokenRecord, UploadRecord } from "./models.ts";
import type { PublishStorage } from "./storage.ts";

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_TTL_MS = 10 * 60 * 1000;

export interface ServiceConfig {
  storage: PublishStorage;
  publicBaseUrl?: string;
  bootstrapSecret?: string;
  now?: () => Date;
}

export interface AuthContext {
  account: AccountRecord;
  token?: TokenRecord;
}

export interface PublishTokenView {
  id: string;
  name: string;
  scope: "publish:write";
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export class PublishService {
  readonly storage: PublishStorage;
  private readonly now: () => Date;
  private readonly publicBaseUrl: string;
  private readonly bootstrapSecret?: string;

  constructor(config: ServiceConfig) {
    this.storage = config.storage;
    this.now = config.now ?? (() => new Date());
    this.publicBaseUrl = String(config.publicBaseUrl || "").replace(/\/$/, "");
    this.bootstrapSecret = config.bootstrapSecret;
  }

  currentIso(): string {
    return this.now().toISOString();
  }

  async register(input: { email: string; password: string }): Promise<{ account: AccountRecord; recoveryCode: string }> {
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);
    validateEmail(email);
    validatePassword(password);
    if (await this.storage.getAccountByEmail(email)) throw new ServiceError(409, "CONFLICT", "Registration unavailable");
    const account: AccountRecord = { id: randomId(18), email, passwordHash: await hashPassword(password), createdAt: this.currentIso() };
    const plainRecoveryCode = recoveryCode();
    const recovery = { id: randomId(16), accountId: account.id, codeHash: await sha256(plainRecoveryCode), createdAt: account.createdAt };
    await this.storage.createAccount(account, recovery);
    return { account, recoveryCode: plainRecoveryCode };
  }

  async login(input: { email: string; password: string }): Promise<{ account: AccountRecord; session: SessionRecord }> {
    const account = await this.storage.getAccountByEmail(normalizeEmail(input.email));
    if (!account || !(await verifyPassword(normalizePassword(input.password), account.passwordHash))) {
      throw new ServiceError(401, "UNAUTHORIZED", "Invalid email or password");
    }
    const session: SessionRecord = {
      id: randomSecret("", 32),
      accountId: account.id,
      createdAt: this.currentIso(),
      expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS).toISOString(),
    };
    await this.storage.createSession(session);
    return { account, session };
  }

  async accountForSession(sessionId: string | undefined): Promise<AuthContext | undefined> {
    if (!sessionId) return undefined;
    const session = await this.storage.getSession(sessionId);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      await this.storage.deleteSession(session.id);
      return undefined;
    }
    const account = await this.storage.getAccount(session.accountId);
    return account ? { account } : undefined;
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.storage.deleteSession(sessionId);
  }

  async recover(input: { email: string; recoveryCode: string; newPassword: string }): Promise<void> {
    const account = await this.storage.getAccountByEmail(normalizeEmail(input.email));
    const newPassword = normalizePassword(input.newPassword);
    validatePassword(newPassword);
    if (!account) throw new ServiceError(401, "UNAUTHORIZED", "Recovery failed");
    const codeHash = await sha256(String(input.recoveryCode || "").trim().toUpperCase());
    const consumed = await this.storage.consumeRecoveryCode(account.id, codeHash, this.currentIso());
    if (!consumed) throw new ServiceError(401, "UNAUTHORIZED", "Recovery failed");
    await this.storage.updateAccountPassword(account.id, await hashPassword(newPassword));
    await this.storage.revokeAccountSessions(account.id);
    await this.storage.revokeAccountTokens(account.id, this.currentIso());
  }

  async authenticatePublishToken(value: string | undefined): Promise<AuthContext> {
    const token = String(value || "");
    if (!token.startsWith("pn_")) throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized");
    const record = await this.storage.getTokenByHash(await sha256(token));
    if (!record || record.revokedAt || (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime())) {
      throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized");
    }
    const account = await this.storage.getAccount(record.accountId);
    if (!account) throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized");
    await this.storage.touchToken(record.id, this.currentIso());
    return { account, token: record };
  }

  async createToken(accountId: string, name = "Obsidian plugin", expiresAt?: string): Promise<{ token: string; view: PublishTokenView }> {
    const account = await this.storage.getAccount(accountId);
    if (!account) throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized");
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new ServiceError(400, "BAD_REQUEST", "Invalid token expiry");
    const token = randomSecret("pn_", 32);
    const record: TokenRecord = {
      id: randomId(16), accountId, name: normalizeTokenName(name), tokenHash: await sha256(token), scope: "publish:write", createdAt: this.currentIso(), expiresAt,
    };
    await this.storage.createToken(record);
    return { token, view: tokenView(record) };
  }

  async listTokens(context: AuthContext): Promise<PublishTokenView[]> {
    return (await this.storage.listTokens(context.account.id)).map(tokenView);
  }

  async revokeToken(context: AuthContext, tokenId: string): Promise<void> {
    if (!(await this.storage.revokeToken(context.account.id, tokenId, this.currentIso()))) throw new ServiceError(404, "NOT_FOUND", "Token not found");
  }

  async startDeviceAuthorization(): Promise<{ deviceCode: string; verificationUrl: string; expiresIn: number; interval: number }> {
    const deviceCode = randomSecret("", 24);
    const createdAt = this.currentIso();
    const expiresAt = new Date(this.now().getTime() + DEVICE_TTL_MS).toISOString();
    const record: DeviceAuthorizationRecord = { id: randomId(16), deviceCodeHash: await sha256(deviceCode), status: "pending", createdAt, expiresAt };
    await this.storage.createDeviceAuthorization(record);
    return { deviceCode, verificationUrl: `${this.publicBaseUrl}/connect?code=${encodeURIComponent(deviceCode)}`, expiresIn: DEVICE_TTL_MS / 1000, interval: 2 };
  }

  async approveDeviceAuthorization(context: AuthContext, deviceCode: string, tokenName?: string): Promise<void> {
    const hash = await sha256(String(deviceCode || ""));
    const ok = await this.storage.approveDeviceAuthorization(hash, context.account.id, "", normalizeTokenName(tokenName || "Obsidian plugin"), this.currentIso());
    if (!ok) throw new ServiceError(400, "BAD_REQUEST", "Device code is invalid, expired, or already used");
  }

  async pollDeviceAuthorization(deviceCode: string): Promise<{ status: string; publishToken?: string }> {
    const hash = await sha256(String(deviceCode || ""));
    const current = await this.storage.getDeviceAuthorization(hash);
    if (!current) return { status: "expired" };
    if (Date.parse(current.expiresAt) <= this.now().getTime()) return { status: "expired" };
    if (current.status !== "approved") return { status: current.status };
    const approved = await this.storage.consumeApprovedDeviceAuthorization(hash);
    if (!approved?.accountId) return { status: approved?.status || "expired" };
    const issued = await this.createToken(approved.accountId, approved.tokenName || "Obsidian plugin");
    return { status: "approved", publishToken: issued.token };
  }

  async setup(input: { bootstrapSecret: string; email: string; password: string }): Promise<{ account: AccountRecord; recoveryCode: string }> {
    if (!this.bootstrapSecret || input.bootstrapSecret !== this.bootstrapSecret || await this.storage.isBootstrapConsumed()) {
      throw new ServiceError(403, "FORBIDDEN", "Bootstrap is unavailable");
    }
    const result = await this.register({ email: input.email, password: input.password });
    if (!(await this.storage.consumeBootstrap(this.currentIso()))) {
      await this.storage.deleteAccount(result.account.id);
      throw new ServiceError(409, "CONFLICT", "Bootstrap is unavailable");
    }
    return result;
  }

  async initializeProvisioning(input: { provisionSecret: string; ownerKey: string; expiresAt: string; signature: string; tokenName?: string }): Promise<{ accountId: string; publishToken: string }> {
    const expiresAt = Date.parse(String(input.expiresAt || ""));
    if (!this.bootstrapSecret || input.provisionSecret !== this.bootstrapSecret || await this.storage.isBootstrapConsumed() || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime() || expiresAt > this.now().getTime() + 10 * 60 * 1000) {
      throw new ServiceError(403, "FORBIDDEN", "Provisioning is unavailable");
    }
    const ownerKey = String(input.ownerKey || "").trim();
    if (!ownerKey || !input.signature || !constantTimeEqual(await hmacSha256(this.bootstrapSecret, `${ownerKey}\n${input.expiresAt}`), String(input.signature))) {
      throw new ServiceError(403, "FORBIDDEN", "Provisioning is unavailable");
    }
    const suffix = ownerKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || randomId(8);
    const email = `owner-${suffix}@selfhosted.publish-note.invalid`;
    const password = randomSecret("", 32);
    const result = await this.register({ email, password });
    const issued = await this.createToken(result.account.id, input.tokenName || "Obsidian plugin");
    if (!(await this.storage.consumeBootstrap(this.currentIso()))) {
      await this.storage.deleteAccount(result.account.id);
      throw new ServiceError(409, "CONFLICT", "Provisioning is unavailable");
    }
    return { accountId: result.account.id, publishToken: issued.token };
  }

  async reconnectProvisioning(input: { provisionSecret: string; ownerKey: string; expiresAt: string; signature: string; tokenName?: string }): Promise<{ accountId: string; publishToken: string }> {
    const expiresAt = Date.parse(String(input.expiresAt || ""));
    if (!this.bootstrapSecret || input.provisionSecret !== this.bootstrapSecret || !await this.storage.isBootstrapConsumed() || !Number.isFinite(expiresAt) || expiresAt <= this.now().getTime() || expiresAt > this.now().getTime() + 10 * 60 * 1000) {
      throw new ServiceError(403, "FORBIDDEN", "Reconnection is unavailable");
    }
    const ownerKey = String(input.ownerKey || "").trim();
    if (!ownerKey || !input.signature || !constantTimeEqual(await hmacSha256(this.bootstrapSecret, `${ownerKey}\n${input.expiresAt}`), String(input.signature))) {
      throw new ServiceError(403, "FORBIDDEN", "Reconnection is unavailable");
    }
    const account = await this.storage.findProvisioningAccount();
    if (!account) throw new ServiceError(404, "NOT_FOUND", "Reconnection account is unavailable");
    const issued = await this.createToken(account.id, input.tokenName || "Obsidian plugin");
    return { accountId: account.id, publishToken: issued.token };
  }

  async startUpload(context: AuthContext, input: {
    siteId?: string; idempotencyKey: string; formatVersion: 1; chunkProtocolVersion: 2; sourcePath: string; title: string; chunkCount: number; objectCount: number; totalBytes: number;
  }): Promise<{ uploadId: string; siteId: string; revision: number }> {
    validateUploadStart(input);
    const existingUpload = await this.storage.findUpload(context.account.id, input.idempotencyKey);
    if (existingUpload) return { uploadId: existingUpload.uploadId, siteId: existingUpload.siteId, revision: existingUpload.revision };
    const existingSite = input.siteId ? await this.storage.getSite(context.account.id, input.siteId) : undefined;
    if (input.siteId && !existingSite) throw new ServiceError(404, "NOT_FOUND", "Site not found");
    const siteId = existingSite?.siteId || randomId(16);
    const revision = (existingSite?.currentRevision || 0) + 1;
    const createdAt = this.currentIso();
    const upload: UploadRecord = {
      uploadId: randomId(18), accountId: context.account.id, siteId, revision, sourcePath: String(input.sourcePath), title: String(input.title), idempotencyKey: input.idempotencyKey,
      formatVersion: 1, chunkProtocolVersion: 2, expectedChunkCount: input.chunkCount, expectedObjectCount: input.objectCount, declaredBytes: input.totalBytes,
      status: "open", createdAt, expiresAt: new Date(this.now().getTime() + UPLOAD_TTL_MS).toISOString(),
    };
    await this.storage.createUpload(upload);
    return { uploadId: upload.uploadId, siteId, revision };
  }

  async uploadChunk(context: AuthContext, input: { uploadId: string; chunkProtocolVersion: 2; kind: "page" | "asset"; path: string; contentType: string; encoding: "utf8" | "base64"; chunkIndex: number; chunkCount: number; byteLength: number; body: string }): Promise<{ uploadId: string; path: string; chunkIndex: number; receivedChunks: number }> {
    const upload = await this.authorizedUpload(context, input.uploadId);
    if (upload.status !== "open") throw new ServiceError(409, "CONFLICT", "Upload is no longer open");
    validateChunk(input);
    const path = normalizeRelativePath(input.path);
    const bytes = decodeChunk(input.encoding, input.body);
    if (bytes.byteLength !== input.byteLength) throw new ServiceError(400, "BAD_REQUEST", "Upload chunk byteLength does not match body");
    const result = await this.storage.putUploadChunk({ upload, object: { kind: input.kind, path, contentType: input.contentType, encoding: input.encoding, chunkCount: input.chunkCount }, chunkIndex: input.chunkIndex, byteLength: input.byteLength, bytes });
    return { uploadId: upload.uploadId, path, chunkIndex: input.chunkIndex, receivedChunks: result.receivedChunks };
  }

  async commitUpload(context: AuthContext, uploadId: string, publicBaseUrl = this.publicBaseUrl): Promise<{ siteId: string; url: string; revision: number; uploadedPaths: string[] }> {
    const upload = await this.authorizedUpload(context, uploadId);
    if (upload.result) return this.resultFor(upload, upload.result, publicBaseUrl);
    if (upload.status !== "open") throw new ServiceError(409, "CONFLICT", "Upload is no longer open");
    const objects = await this.storage.listUploadObjects(upload.uploadId);
    if (objects.length !== upload.expectedObjectCount || objects.length === 0) throw new ServiceError(400, "BAD_REQUEST", "Upload is incomplete");
    let totalBytes = 0;
    const uploadedPaths: string[] = [];
    for (const object of objects) {
      const chunks = await this.storage.listUploadChunks(upload.uploadId, object.objectId);
      if (chunks.length !== object.chunkCount || chunks.some((chunk, index) => chunk.chunkIndex !== index)) throw new ServiceError(400, "BAD_REQUEST", `Upload object is incomplete: ${object.path}`);
      const byteSize = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      if (byteSize !== object.byteSize) throw new ServiceError(400, "BAD_REQUEST", `Upload object size mismatch: ${object.path}`);
      totalBytes += byteSize;
      uploadedPaths.push(object.path);
      if (object.kind === "page" && object.encoding !== "utf8") throw new ServiceError(400, "BAD_REQUEST", "Pages must use UTF-8 chunks");
      if (object.kind === "asset" && object.encoding !== "base64") throw new ServiceError(400, "BAD_REQUEST", "Assets must use base64 chunks");
    }
    if (totalBytes !== upload.declaredBytes) throw new ServiceError(400, "BAD_REQUEST", "Upload byte size does not match the declared total");
    const input: CommitUploadInput = { byteSize: totalBytes, objectCount: objects.length, now: this.currentIso(), publicBaseUrl: this.publicBaseUrl };
    const site = await this.storage.commitUpload(upload.uploadId, input);
    const result: PublishResultRecord = { siteId: site.siteId, revision: site.currentRevision, uploadedPaths: [...uploadedPaths].sort() };
    return this.resultFor({ ...upload, result }, result, publicBaseUrl);
  }

  async getUsage(accountId: string): Promise<StorageUsage> { return this.storage.getUsage(accountId); }
  async listSites(accountId: string): Promise<SiteRecord[]> { return this.storage.listSites(accountId); }
  async deleteSite(context: AuthContext, siteId: string): Promise<void> {
    if (!(await this.storage.deleteSite(context.account.id, siteId))) throw new ServiceError(404, "NOT_FOUND", "Site not found");
  }

  async viewer(siteId: string, path: string) {
    return this.storage.getViewerObject(siteId, normalizeRelativePath(path || "index.html"));
  }

  async cleanup(): Promise<{ uploads: number; objects: number }> {
    const now = this.currentIso();
    return { uploads: await this.storage.expireUploads(now), objects: await this.storage.cleanupOrphanedObjects(now) };
  }

  bootstrapConfigured(): boolean { return Boolean(this.bootstrapSecret); }

  private async authorizedUpload(context: AuthContext, uploadId: string): Promise<UploadRecord> {
    const upload = await this.storage.getUpload(uploadId);
    if (!upload || upload.accountId !== context.account.id) throw new ServiceError(404, "NOT_FOUND", "Upload not found");
    if (Date.parse(upload.expiresAt) <= this.now().getTime() && upload.status === "open") throw new ServiceError(410, "UPLOAD_EXPIRED", "Upload session expired");
    return upload;
  }

  private resultFor(upload: UploadRecord, result: PublishResultRecord, publicBaseUrl = this.publicBaseUrl) {
    const base = String(publicBaseUrl || "").replace(/\/$/, "");
    return { siteId: result.siteId, url: siteUrl(result.siteId, base || "https://share.example.com"), revision: result.revision, uploadedPaths: [...result.uploadedPaths] };
  }
}

function tokenView(token: TokenRecord): PublishTokenView {
  return { id: token.id, name: token.name, scope: token.scope, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, expiresAt: token.expiresAt, revokedAt: token.revokedAt };
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new ServiceError(400, "BAD_REQUEST", "A valid email is required");
}

function validatePassword(password: string): void {
  if (password.length < 10 || password.length > 200) throw new ServiceError(400, "BAD_REQUEST", "Password must be 10 to 200 characters");
}

function validateUploadStart(input: { idempotencyKey: string; sourcePath: string; title: string; chunkCount: number; objectCount: number; totalBytes: number; chunkProtocolVersion: number }): void {
  if (input.chunkProtocolVersion !== 2 || !String(input.sourcePath || "").trim() || !String(input.title || "").trim() || !String(input.idempotencyKey || "").trim()) throw new ServiceError(400, "BAD_REQUEST", "Invalid upload metadata");
  if (!Number.isInteger(input.chunkCount) || input.chunkCount < 1 || !Number.isInteger(input.objectCount) || input.objectCount < 1 || !Number.isInteger(input.totalBytes) || input.totalBytes < 1) throw new ServiceError(400, "BAD_REQUEST", "Invalid upload sizes");
}

function validateChunk(input: { chunkProtocolVersion: number; kind: string; encoding: string; chunkIndex: number; chunkCount: number; byteLength: number; body: string }): void {
  if (input.chunkProtocolVersion !== 2 || !["page", "asset"].includes(input.kind) || !["utf8", "base64"].includes(input.encoding)) throw new ServiceError(400, "BAD_REQUEST", "Invalid upload chunk metadata");
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || !Number.isInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkIndex >= input.chunkCount || !Number.isInteger(input.byteLength) || input.byteLength < 0 || typeof input.body !== "string") throw new ServiceError(400, "BAD_REQUEST", "Invalid upload chunk");
}

function decodeChunk(encoding: "utf8" | "base64", body: string): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(body);
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ServiceError(400, "BAD_REQUEST", "Binary asset chunk is not valid base64");
  }
}

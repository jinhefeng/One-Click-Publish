export type ServiceErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "QUOTA_EXCEEDED"
  | "UPLOAD_EXPIRED"
  | "INTERNAL_ERROR";

export class ServiceError extends Error {
  readonly status: number;
  readonly code: ServiceErrorCode;

  constructor(status: number, code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

export function asServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Bad request");
}

export function jsonError(error: unknown): Response {
  const normalized = asServiceError(error);
  const safeMessage = normalized.status >= 500 ? "Internal server error" : normalized.message;
  return new Response(JSON.stringify({ error: safeMessage, code: normalized.code }), {
    status: normalized.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

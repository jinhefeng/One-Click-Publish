import { PublishService } from "../core/service.ts";
import { CloudflareD1R2Storage } from "../storage/cloudflare-d1-r2/index.ts";

export interface WorkerEnv {
  DB: ConstructorParameters<typeof CloudflareD1R2Storage>[0];
  CONTENTS?: ConstructorParameters<typeof CloudflareD1R2Storage>[1];
  BOOTSTRAP_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  PUBLISH_NOTE_VERSION?: string;
}

export function createService(env: WorkerEnv, request: Request): PublishService {
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  return new PublishService({ storage: new CloudflareD1R2Storage(env.DB, env.CONTENTS, "default"), publicBaseUrl, bootstrapSecret: env.BOOTSTRAP_SECRET });
}

import { env as workerEnv } from 'cloudflare:workers';
import type { S3Env } from './s3';

/** Cloudflare bindings/secrets arrive via `cloudflare:workers`' `env` export (Astro.locals.runtime.env was removed in Astro v6 / @astrojs/cloudflare v14). USE_FIXTURES is a Node-only local-dev toggle, read straight from process.env so it never needs to exist as a Cloudflare var. */
export function getEnv(): S3Env {
  const runtimeEnv = workerEnv as unknown as Record<string, string | undefined>;
  return {
    AWS_ACCESS_KEY_ID: runtimeEnv.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY_ID: runtimeEnv.AWS_SECRET_ACCESS_KEY_ID,
    AWS_REGION: runtimeEnv.AWS_REGION,
    S3_BUCKET: runtimeEnv.S3_BUCKET,
    USE_FIXTURES: runtimeEnv.USE_FIXTURES ?? (typeof process !== 'undefined' ? process.env.USE_FIXTURES : undefined),
  };
}

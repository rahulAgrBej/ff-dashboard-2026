import type { S3Object } from './s3';
import type { Dateline } from './dateline';

const LISTING_TTL_S = 300;
const BODY_TTL_S = 60 * 60 * 24 * 365; // 1 year — safe because the cache key embeds the ETag

const LISTING_CACHE_KEY = 'https://internal/listing/reports';

/** The response header this dashboard sends on every page: fresh at the edge for 60s, servable stale for another 300s while a background revalidation runs. */
export const PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

function defaultCache(): Cache | undefined {
  // `caches.default` only exists inside the Cloudflare Workers runtime
  // (workerd, including the wrangler platform proxy `astro dev` uses).
  // Guard it so a plain Node dev server or a test runner doesn't throw.
  const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return c?.default;
}

/**
 * One `ListObjectsV2` per 300s, cached via the Cache API. `bypass` (the
 * `?nocache=1` escape hatch) skips the read but still repopulates the
 * cache with the fresh result — bypass-and-repopulate, never a purge.
 */
export async function getCachedListing(
  bypass: boolean,
  loader: () => Promise<S3Object[]>
): Promise<S3Object[]> {
  const cache = defaultCache();
  const cacheKey = new Request(LISTING_CACHE_KEY);

  if (cache && !bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return (await cached.json()) as S3Object[];
  }

  const objects = await loader();

  if (cache) {
    const res = new Response(JSON.stringify(objects), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${LISTING_TTL_S}`,
      },
    });
    await cache.put(cacheKey, res);
  }

  return objects;
}

/**
 * Rendered report bodies cached under `report/<key>@<etag>` at a 1-year
 * TTL. Because the listing supplies the ETag, a same-day re-run of the
 * upstream report (which it explicitly tolerates) produces a new ETag,
 * hence a new cache key, hence correct content — with no purge logic
 * anywhere. Max staleness is bounded by the listing's own 300s TTL.
 */
export async function getCachedBody(
  key: string,
  etag: string,
  bypass: boolean,
  render: () => Promise<string>
): Promise<string> {
  const cache = defaultCache();
  const cacheKey = new Request(`https://internal/report/${encodeURIComponent(key)}@${encodeURIComponent(etag)}`);

  if (cache && !bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached.text();
  }

  const html = await render();

  if (cache) {
    const res = new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': `max-age=${BODY_TTL_S}, immutable`,
      },
    });
    await cache.put(cacheKey, res);
  }

  return html;
}

/**
 * Parsed datelines cached under `dateline/<key>@<etag>` at the same
 * 1-year/ETag-in-key scheme as `getCachedBody` — a same-day upstream re-run
 * gets a new ETag, hence a new cache key, hence correct content, with no
 * purge logic anywhere. `parse` may return `undefined` to signal "skipped,
 * don't cache this" (e.g. a per-request fetch budget ran out) — the caller
 * gets `null` back but the miss is retried on a later request instead of
 * being cached as "no dateline" forever.
 */
export async function getCachedDateline(
  key: string,
  etag: string,
  bypass: boolean,
  parse: () => Promise<Dateline | null | undefined>
): Promise<Dateline | null> {
  const cache = defaultCache();
  const cacheKey = new Request(`https://internal/dateline/${encodeURIComponent(key)}@${encodeURIComponent(etag)}`);

  if (cache && !bypass) {
    const cached = await cache.match(cacheKey);
    if (cached) return (await cached.json()) as Dateline | null;
  }

  const dateline = await parse();
  if (dateline === undefined) return null;

  if (cache) {
    const res = new Response(JSON.stringify(dateline), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${BODY_TTL_S}, immutable`,
      },
    });
    await cache.put(cacheKey, res);
  }

  return dateline;
}

import { listObjects, getObject, type S3Env, type S3Object } from './s3';
import { getCachedListing, getCachedBody, SUMMARY_LISTING_CACHE_KEY } from './cache';
import type { ReportMeta } from './reports';

/**
 * The upstream pipeline writes one JSON envelope per report under the
 * bucket's `summaries/` prefix (`espn_ff/ai/summarize.py:envelope`). Only
 * the fields this dashboard renders are typed here; the envelope carries
 * more (`prior_reports`, `prompt_sha256`, `usage`, `report.source`) that
 * nothing on the page needs yet.
 */
export interface SummaryEnvelope {
  schema_version: number;
  season: number;
  week: number;
  day: string;
  report: {
    path: string;
    sha256: string;
    title?: string | null;
  };
  summary_markdown: string;
  model: string;
  generated_at: string;
}

export interface ReportSummary extends SummaryEnvelope {
  /** The summary was generated against a different render of this report — `report.sha256` no longer matches the markdown on the page. */
  stale: boolean;
}

/** The only schema this renderer understands. A future version is treated as absent rather than rendered on guessed field names. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * A report's summary key is its own key with the prefix and extension
 * swapped — the summary tree mirrors the report tree exactly
 * (`espn_ff/ai/reports.py:summary_path`), so no lookup table is needed:
 *
 *   reports/2026/week-02/2026-09-15-tuesday-waiver-wire.md
 *   summaries/2026/week-02/2026-09-15-tuesday-waiver-wire.json
 *
 * Returns null for a key that isn't a report key, so a caller can never
 * silently build a summary key out of something else.
 */
export function summaryKeyFor(reportKey: string): string | null {
  if (!reportKey.startsWith('reports/') || !reportKey.endsWith('.md')) return null;
  return `summaries/${reportKey.slice('reports/'.length, -'.md'.length)}.json`;
}

/** Hex SHA-256, matching the pipeline's `_sha256` over the report's full markdown text. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The `summaries/` listing, keyed by object key. Cached for 300s under its
 * own key, exactly like the reports listing.
 *
 * Listing before fetching is what keeps a missing summary cheap: a report
 * that has no summary yet — normal for ~20 minutes after it publishes, and
 * permanent if a generation failed — resolves to a map miss rather than a
 * 404 on every render. It also supplies the ETag that makes the envelope
 * body cacheable for a year.
 */
async function loadSummaryIndex(env: S3Env, bypassCache: boolean): Promise<Map<string, S3Object>> {
  const objects = await getCachedListing(
    bypassCache,
    () => listObjects(env, 'summaries/'),
    SUMMARY_LISTING_CACHE_KEY
  );
  return new Map(objects.map((obj) => [obj.key, obj]));
}

function isRenderable(value: unknown): value is SummaryEnvelope {
  const env = value as SummaryEnvelope | null;
  return (
    !!env &&
    env.schema_version === SUPPORTED_SCHEMA_VERSION &&
    typeof env.summary_markdown === 'string' &&
    env.summary_markdown.trim().length > 0 &&
    !!env.report &&
    typeof env.report.sha256 === 'string'
  );
}

/**
 * The summary for one report, or null when there isn't one to show.
 *
 * Never throws. A summary is additive — the same reasoning that makes
 * `espn_ff summarize` always exit 0 applies on this side of the bucket: a
 * missing, unreadable, malformed or future-schema envelope must cost the
 * report page nothing.
 *
 * `markdown` is the report body already fetched by the page. Hashing it
 * against the envelope's `report.sha256` is how a summary that describes an
 * earlier render of the same key is caught — the upstream repo's "freshness
 * from the artifact, never from mtime" rule, read back.
 */
export async function loadSummary(
  env: S3Env,
  report: ReportMeta,
  markdown: string,
  bypassCache: boolean
): Promise<ReportSummary | null> {
  const key = summaryKeyFor(report.key);
  if (!key) return null;

  try {
    const index = await loadSummaryIndex(env, bypassCache);
    const object = index.get(key);
    if (!object) return null;

    const body = await getCachedBody(object.key, object.etag, bypassCache, () =>
      getObject(env, object.key)
    );
    const envelope = JSON.parse(body) as unknown;
    if (!isRenderable(envelope)) return null;

    return { ...envelope, stale: (await sha256Hex(markdown)) !== envelope.report.sha256 };
  } catch {
    return null;
  }
}

/**
 * The envelope's `generated_at` is ISO 8601 that already carries an ET
 * offset (`2026-09-15T21:20:11-04:00`), so it is formatted off its own
 * offset rather than converted. `reports.ts`'s `formatGeneratedAt` is for
 * S3's UTC `LastModified` and would shift this by four hours.
 *
 * Returns the raw string unchanged if it doesn't parse — a display helper
 * should degrade to showing the value, never to throwing.
 */
export function formatSummaryTimestamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day, hh, mm] = match;
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const name = months[Number(month) - 1];
  if (!name) return iso;
  return `${Number(day)} ${name} ${year}, ${hh}:${mm} ET`;
}

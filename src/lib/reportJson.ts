import { getObject, listObjects, type S3Env, type S3Object } from './s3';
import { getCachedListing, getCachedBody, REPORT_JSON_LISTING_CACHE_KEY } from './cache';
import { rekey, type ReportMeta } from './reports';

/**
 * The upstream pipeline writes one structured JSON object per report under
 * the bucket's `reports-json/` prefix (`espn_ff/report/payload.py`), beside
 * the markdown it was rendered from.
 *
 * It is a strict **superset** of that markdown: tables arrive as arrays of
 * typed row objects, prose as string arrays, section order is preserved, and
 * the original markdown is embedded verbatim in `markdown`. Anything the
 * structuring missed is therefore still recoverable, and `markdown_sha256`
 * says whether the embedded copy matches the `.md` in the bucket.
 *
 * Reading it replaces four regexes in `render.ts` with field access, and it
 * carries three things the markdown could not express at all: a real `stale`
 * boolean per feed, `insufficient` as a state rather than a string sentinel,
 * and `null` as distinct from zero in a table cell.
 */

/** Declared, not validated — upstream names the semantic type a consumer should expect but nothing asserts the rows match it. Coerce defensively. */
export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date';

export interface TableColumn {
  key: string;
  label: string;
  type: ColumnType;
}

/**
 * `null` is the one value that carries meaning on its own: the markdown had
 * three separate vocabularies for missing data (`insufficient data`, `--`, an
 * em dash) and all three collapse to `null` here. It means "no reading" and
 * is never zero.
 */
export type CellValue = string | number | boolean | null;

export type TableRow = Record<string, CellValue>;

export interface FreshnessFeed {
  feed: string;
  at: number | null; // epoch seconds; null means the feed has never been read
  at_display: string; // "never" when `at` is null
  stale: boolean;
}

export type SectionKind = 'freshness' | 'table' | 'prose' | 'list' | 'insufficient' | 'blocks';

interface SectionBase {
  /** Fixed string, and the only safe thing to route on. Two reports build their headings at render time (Saturday's `## Tier changes since <date>`, Thursday's `## Canonical usage -- week N`), so heading-text matching breaks on Saturday every day and on Thursday every week. */
  id: string;
  /** Display text. `null` on a child block, which makes it a layout instruction rather than an unnamed section. */
  heading: string | null;
  level: number | null;
  /** The facts the rows do not hold — numbers the markdown states only inside a sentence. Keys are per-section and stable within a schema version, but the full set is not enumerated upstream. */
  data?: Record<string, CellValue> | null;
}

export interface FreshnessSection extends SectionBase {
  kind: 'freshness';
  feeds: FreshnessFeed[];
  notes?: string[] | null;
}

export interface TableSection extends SectionBase {
  kind: 'table';
  columns: TableColumn[];
  rows: TableRow[];
  /** The report's own phrasing, kept verbatim — these are words, not data. */
  notes?: string[] | null;
}

export interface ProseSection extends SectionBase {
  kind: 'prose';
  /** Lines carrying markdown markup: bold, italics and bullet prefixes are preserved so the report's own emphasis is recoverable. */
  body: string[];
  /** True when the markdown itself bolds the section, so a front end can style it without pattern-matching on `**`. */
  emphasis?: boolean;
}

export interface ListSection extends SectionBase {
  kind: 'list';
  items: string[];
}

/** A section that **could not be computed**, with the why. A first-class state, not an empty table — and the same `id` can arrive as either kind depending on whether the inputs were there. */
export interface InsufficientSection extends SectionBase {
  kind: 'insufficient';
  reason: string;
}

/** The single composite kind, and it recurses: a block is itself a section. */
export interface BlocksSection extends SectionBase {
  kind: 'blocks';
  blocks: Section[];
}

export type Section =
  | FreshnessSection
  | TableSection
  | ProseSection
  | ListSection
  | InsufficientSection
  | BlocksSection;

export interface ReportWeekWindow {
  /** ISO 8601 with an ET offset, or null when the calendar was unavailable. */
  start: string | null;
  end: string | null;
  /** The literal string "insufficient data" when start/end are null — absent and unavailable stay distinguishable. */
  display: string;
}

/**
 * The dateline. Along with the freshness section this is the **only** place
 * carrying both a raw value and a pre-formatted display string; everywhere
 * else the rule is raw values only. Use `*_display` to show the exact string
 * the markdown showed, and the raw field to compute.
 */
export interface ReportJsonHeader {
  title: string;
  covers: string;
  week: number;
  week_window: ReportWeekWindow;
  rendered_at: number; // epoch seconds
  rendered_display: string;
}

export interface ReportEnvelope {
  schema_version: number;
  season: number;
  week: number;
  /** The report **key**, e.g. "tuesday-waivers". Not the same as `day_label`, which both Tuesday reports share — this is the field that tells them apart. */
  day: string;
  day_label: string;
  slug: string;
  stem: string;
  generated_at: string;
  header: ReportJsonHeader;
  sections: Section[];
  /** The exact bytes of the `.md` beside this object. */
  markdown: string;
  markdown_sha256: string;
  related: {
    markdown_path: string;
    /** **Derived**, not a claim of existence: it names where the summary will live if one is produced. The summarizer runs hours later and may never run at all. */
    summary_path: string;
  };
}

/**
 * The schemas this renderer understands.
 *
 * Kept as a set rather than a scalar from the outset. `summaries.ts` learned
 * this the hard way: a version pinned to `1` there silently dropped every
 * envelope the pipeline wrote after the news layer shipped. Widen as new
 * versions land; a version beyond this set is treated as absent rather than
 * rendered on guessed field names.
 *
 * Note the granularity: `schema_version` covers the **envelope** only. A
 * section gaining a column or a `data` key does so silently within version 1,
 * which is safe for additive changes and not for a rename.
 */
const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * A report's JSON key is its markdown key with the prefix and extension
 * swapped — the two trees mirror each other exactly:
 *
 *   reports/2026/week-02/2026-09-15-tuesday-waiver-wire.md
 *   reports-json/2026/week-02/2026-09-15-tuesday-waiver-wire.json
 *
 * Both directions are needed: the daily view links out to the archive, and
 * the archive links back in when a JSON twin exists.
 */
export function reportJsonKeyFor(markdownKey: string): string | null {
  return rekey(markdownKey, 'reports', 'reports-json');
}

export function markdownKeyFor(jsonKey: string): string | null {
  return rekey(jsonKey, 'reports-json', 'reports');
}

/**
 * The `reports-json/` listing, keyed by object key, cached 300s under its own
 * key exactly like the other two prefixes.
 *
 * Listing before fetching is what keeps a missing twin cheap: the reports
 * rendered before this prefix existed have no JSON and there is no backfill
 * command, so those resolve to a map miss rather than a 404 on every render.
 * It also supplies the ETag that makes the envelope body cacheable for a year.
 */
export async function loadReportJsonIndex(
  env: S3Env,
  bypassCache: boolean
): Promise<Map<string, S3Object>> {
  const objects = await getCachedListing(
    bypassCache,
    () => listObjects(env, 'reports-json/'),
    REPORT_JSON_LISTING_CACHE_KEY
  );
  return new Map(objects.map((obj) => [obj.key, obj]));
}

function isSection(value: unknown): value is Section {
  const section = value as Section | null;
  return !!section && typeof section === 'object' && typeof section.id === 'string' && typeof section.kind === 'string';
}

/**
 * Whether an envelope is worth rendering at all.
 *
 * Deliberately shallow, for the same reason `isRenderableNews` is: it checks
 * the envelope and the one container the renderer walks, not every field of
 * every section. A section with a malformed row renders as that section's
 * problem — dropping a whole report over one bad cell would lose the other
 * seven sections, which are fine.
 */
export function isRenderableEnvelope(value: unknown): value is ReportEnvelope {
  const env = value as ReportEnvelope | null;
  return (
    !!env &&
    typeof env === 'object' &&
    SUPPORTED_SCHEMA_VERSIONS.has(env.schema_version) &&
    !!env.header &&
    typeof env.header.title === 'string' &&
    Array.isArray(env.sections) &&
    env.sections.every(isSection) &&
    typeof env.markdown === 'string'
  );
}

/**
 * The structured envelope for one report, or null when there isn't one.
 *
 * Never throws, on the same reasoning as `loadSummary`: this prefix started
 * mid-season and has no backfill, so "no JSON for this report" is an ordinary
 * answer rather than an error. A caller that gets null has a report it cannot
 * render structurally, and should send the reader to the archive.
 *
 * Accepts a `ReportMeta` from **either** prefix and resolves the JSON key
 * from it, so a page can start from whichever listing it happens to hold.
 */
export async function loadReportJson(
  env: S3Env,
  report: ReportMeta,
  bypassCache: boolean
): Promise<ReportEnvelope | null> {
  const key = report.prefix === 'reports-json' ? report.key : reportJsonKeyFor(report.key);
  if (!key) return null;

  try {
    const index = await loadReportJsonIndex(env, bypassCache);
    const object = index.get(key);
    if (!object) return null;

    const body = await getCachedBody(object.key, object.etag, bypassCache, () =>
      getObject(env, object.key)
    );
    const envelope = JSON.parse(body) as unknown;
    if (!isRenderableEnvelope(envelope)) return null;
    return envelope;
  } catch {
    return null;
  }
}

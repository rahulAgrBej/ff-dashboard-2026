import { listObjects, getObject, type S3Env, type S3Object } from './s3';
import {
  getCachedListing,
  getCachedBody,
  getCachedDateline,
  REPORTS_LISTING_CACHE_KEY,
  REPORT_JSON_LISTING_CACHE_KEY,
} from './cache';
import { parseDateline, type Dateline } from './dateline';

/**
 * The two bucket prefixes that hold one object per report. They share the
 * same `<season>/week-NN/<stem>` path and differ only in prefix and
 * extension, which is why one parser serves both and why any one of them
 * addresses the others with a string swap rather than a lookup table.
 *
 * `reports/` is the older of the two and is complete; `reports-json/` began
 * mid-season, so early reports exist under `reports/` alone.
 */
export type ReportPrefix = 'reports' | 'reports-json';

export interface ReportMeta {
  key: string;
  prefix: ReportPrefix; // which listing this came from — `key` alone would need re-parsing to tell
  season: number;
  week: number;
  date: string; // YYYY-MM-DD, from the filename — never derived from `day`
  day: string; // report-type token, e.g. "monday" — NOT a calendar weekday, see quirk #2
  slug: string; // opaque URL segment; never used to derive a title
  stem: string; // `<date>-<day>-<slug>`, the join key across all three prefixes. NOT an identity — see `dedupeRenders`.
  etag: string;
  lastModified: string;
  dateline?: Dateline | null; // parsed **Covers**/**Week N**/**Rendered** block; undefined until attachDatelines runs, null when absent or unfetched
}

// Capture groups, both patterns: 1 season, 2 week, 3 stem, 4 date, 5 day_label, 6 slug.
// The stem is captured as a whole *and* decomposed, so callers that need the
// join key don't have to reassemble it and risk drifting from the real one.
const KEY_RES: Record<ReportPrefix, RegExp> = {
  reports: /^reports\/(\d{4})\/week-(\d{2})\/((\d{4}-\d{2}-\d{2})-([a-z]+)-(.+))\.md$/,
  'reports-json': /^reports-json\/(\d{4})\/week-(\d{2})\/((\d{4}-\d{2}-\d{2})-([a-z]+)-(.+))\.json$/,
};

const EXTENSIONS: Record<ReportPrefix, string> = {
  reports: '.md',
  'reports-json': '.json',
};

const LISTING_CACHE_KEYS: Record<ReportPrefix, string> = {
  reports: REPORTS_LISTING_CACHE_KEY,
  'reports-json': REPORT_JSON_LISTING_CACHE_KEY,
};

/**
 * Parses one S3 key into its report metadata. Returns null for anything that
 * doesn't match the path convention — malformed keys are skipped, never
 * thrown on, so one bad object can't take down the whole index.
 *
 * `day` here is the filename's `day_label`, which both Tuesday reports share
 * (quirk #2). The report *type* that tells them apart lives in the JSON
 * envelope's own `day` field and must never be written back over this one:
 * `schedule.ts:matchSlot` disambiguates Tuesday's pair by slug and depends on
 * the `day_label` reading.
 */
export function parseReportKey(obj: S3Object, prefix: ReportPrefix = 'reports'): ReportMeta | null {
  const m = KEY_RES[prefix].exec(obj.key);
  if (!m) return null;
  const [, season, week, stem, date, day, slug] = m;
  return {
    key: obj.key,
    prefix,
    season: Number(season),
    week: Number(week),
    date,
    day,
    slug,
    stem,
    etag: obj.etag,
    lastModified: obj.lastModified,
  };
}

export function parseReportKeys(objects: S3Object[], prefix: ReportPrefix = 'reports'): ReportMeta[] {
  const parsed: ReportMeta[] = [];
  for (const obj of objects) {
    const meta = parseReportKey(obj, prefix);
    if (meta) parsed.push(meta);
  }
  return parsed;
}

/**
 * Rewrites a report key from one prefix to another — the same string swap
 * `summaries.ts:summaryKeyFor` does, generalized. All three prefixes mirror
 * one tree, so this needs no lookup and no listing.
 *
 * Returns null when the key doesn't belong to `from`, so a caller can never
 * silently build a key out of something else.
 */
export function rekey(key: string, from: ReportPrefix, to: ReportPrefix): string | null {
  const fromExt = EXTENSIONS[from];
  if (!key.startsWith(`${from}/`) || !key.endsWith(fromExt)) return null;
  const middle = key.slice(from.length + 1, -fromExt.length);
  return `${to}/${middle}${EXTENSIONS[to]}`;
}

/** Title comes from the report's own H1, never the slug — the slug is a hardcoded, opaque URL segment upstream (see quirk #1). */
export function extractTitle(markdown: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  if (!m) return 'Report';
  return m[1].trim();
}

/**
 * The two read surfaces, both keyed on `(season, week, slug)`.
 *
 * Deliberately **not** on `stem`: a stem embeds the filename date, and
 * upstream re-running a report writes a new date onto the same slot — so a
 * stem-keyed URL would change under a re-render. `slug` is this repo's stable
 * report identity, which is exactly what `dedupeRenders` below collapses on.
 *
 * `/r/*` renders the structured `reports-json/` envelope; `/archive/*`
 * renders the markdown, and is the only surface where a report with no JSON
 * twin appears at all.
 */
export function dailyUrl(meta: ReportMeta): string {
  return `/r/${meta.season}/${meta.week}/${meta.slug}`;
}

export function archiveUrl(meta: ReportMeta): string {
  return `/archive/${meta.season}/${meta.week}/${meta.slug}`;
}

/**
 * Orders two renders of what `reportUrl` treats as the same report, newest
 * first. `date` — the report's own filename date — leads because upstream
 * can re-run a report and write a new filename date onto an object that
 * keeps the exact same S3 LastModified as its predecessor (a batch upload);
 * a `lastModified`-only comparison sees a tie in that case and falls back to
 * listing order. `lastModified` breaks ties `date` can't, and `key` is a
 * deterministic last resort.
 */
export function compareRenderRecency(a: ReportMeta, b: ReportMeta): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  if (a.lastModified !== b.lastModified) return b.lastModified.localeCompare(a.lastModified);
  return b.key.localeCompare(a.key);
}

/**
 * Collapses re-rendered duplicates — objects that share `reportUrl`'s
 * identity of `(season, week, slug)` — down to the newest render of each,
 * preserving the incoming order of the survivors. A superseded render stops
 * being reachable anywhere in the UI; that's the point, since it was never
 * independently addressable (it shares its successor's URL) and, until
 * deduped, was the version actually being served.
 */
export function dedupeRenders(reports: ReportMeta[]): ReportMeta[] {
  const bestByUrl = new Map<string, ReportMeta>();
  for (const r of reports) {
    const url = `${r.season}/${r.week}/${r.slug}`;
    const existing = bestByUrl.get(url);
    if (!existing || compareRenderRecency(r, existing) < 0) {
      bestByUrl.set(url, r);
    }
  }
  const winners = new Set(bestByUrl.values());
  return reports.filter((r) => winners.has(r));
}

/**
 * The listing is the single source that drives the sidebar, latest selection,
 * and every object's ETag/LastModified — fetched at most once per 300s via
 * the Cache API, under a cache key of its own per prefix.
 *
 * `prefix` picks the surface: `reports/` backs the markdown archive and is
 * complete, `reports-json/` backs the daily view and starts mid-season. A
 * report present in only one of them is simply absent from the other's
 * index — that asymmetry is the data, not a failure to reconcile.
 */
export async function loadReports(
  env: S3Env,
  bypassCache: boolean,
  prefix: ReportPrefix = 'reports'
): Promise<ReportMeta[]> {
  const objects = await getCachedListing(
    bypassCache,
    () => listObjects(env, `${prefix}/`),
    LISTING_CACHE_KEYS[prefix]
  );
  return dedupeRenders(parseReportKeys(objects, prefix));
}

// Cloudflare's per-request subrequest limit, not a design choice — reports
// beyond this many misses just fall back to the filename date and are
// picked up automatically once their body cache warms on a later request.
const MAX_DATELINE_FETCHES = 12;

/**
 * Attaches a parsed dateline to every report. On a cache miss this reuses
 * `getCachedBody` — the same cache entry the page body fetch already
 * populates for the latest report — so warm steady-state costs zero extra
 * GETs. Never throws: a failed GET just leaves `dateline: null`.
 */
export async function attachDatelines(
  env: S3Env,
  reports: ReportMeta[],
  bypassCache: boolean
): Promise<ReportMeta[]> {
  const ordered = [...reports].sort((a, b) => {
    if (a.season !== b.season) return b.season - a.season;
    if (a.week !== b.week) return b.week - a.week;
    return b.lastModified.localeCompare(a.lastModified);
  });

  let fetchBudget = MAX_DATELINE_FETCHES;

  const withDatelines = await Promise.all(
    ordered.map(async (report) => {
      const dateline = await getCachedDateline(report.key, report.etag, bypassCache, async () => {
        if (fetchBudget <= 0) return undefined; // capped out — retry on a later request, don't cache
        fetchBudget--;
        try {
          const markdown = await getCachedBody(report.key, report.etag, bypassCache, () =>
            getObject(env, report.key)
          );
          return parseDateline(markdown);
        } catch {
          return null;
        }
      });
      return { ...report, dateline };
    })
  );

  const byKey = new Map(withDatelines.map((r) => [r.key, r]));
  return reports.map((r) => byKey.get(r.key) ?? r);
}

export function summaryCaption(reports: ReportMeta[]): string {
  const weeks = new Set(reports.map((r) => `${r.season}-${r.week}`));
  const reportWord = reports.length === 1 ? 'report' : 'reports';
  const weekWord = weeks.size === 1 ? 'week' : 'weeks';
  return `One report per day, two on Tuesdays · ${reports.length} ${reportWord} across ${weeks.size} ${weekWord}.`;
}

function nthSundayUtc(year: number, month1to12: number, n: number): number {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSunday + (n - 1) * 7;
}

function isEasternDst(date: Date): boolean {
  const year = date.getUTCFullYear();
  const marchSunday = nthSundayUtc(year, 3, 2);
  const novemberSunday = nthSundayUtc(year, 11, 1);
  const start = new Date(Date.UTC(year, 2, marchSunday, 7)); // 2am ET (EST, UTC-5) = 07:00 UTC
  const end = new Date(Date.UTC(year, 10, novemberSunday, 6)); // 2am ET (EDT, UTC-4) = 06:00 UTC
  return date >= start && date < end;
}

/** S3's LastModified converted to America/New_York wall-clock, e.g. "12 Sep 2026, 00:12 ET". */
export function formatGeneratedAt(isoUtc: string): string {
  const utc = new Date(isoUtc);
  const offsetHours = isEasternDst(utc) ? 4 : 5;
  const et = new Date(utc.getTime() - offsetHours * 3600000);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const day = et.getUTCDate();
  const month = months[et.getUTCMonth()];
  const year = et.getUTCFullYear();
  const hh = String(et.getUTCHours()).padStart(2, '0');
  const mm = String(et.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hh}:${mm} ET`;
}

/** `.find` is safe here only because `loadReports` already ran `dedupeRenders` — a `(season, week, slug)` triple is unique in any list built that way. A caller that assembles `reports` some other way must dedupe first, or this silently reverts to first-match-wins. */
export function findReport(
  reports: ReportMeta[],
  season: number,
  week: number,
  slug: string
): ReportMeta | undefined {
  return reports.find((r) => r.season === season && r.week === week && r.slug === slug);
}

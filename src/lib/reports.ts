import { listObjects, getObject, type S3Env, type S3Object } from './s3';
import { getCachedListing, getCachedBody, getCachedDateline } from './cache';
import { parseDateline, type Dateline } from './dateline';

export interface ReportMeta {
  key: string;
  season: number;
  week: number;
  date: string; // YYYY-MM-DD, from the filename — never derived from `day`
  day: string; // report-type token, e.g. "monday" — NOT a calendar weekday, see quirk #2
  slug: string; // opaque URL segment; never used to derive a title
  etag: string;
  lastModified: string;
  dateline?: Dateline | null; // parsed **Covers**/**Week N**/**Rendered** block; undefined until attachDatelines runs, null when absent or unfetched
}

const KEY_RE = /^reports\/(\d{4})\/week-(\d{2})\/(\d{4}-\d{2}-\d{2})-([a-z]+)-(.+)\.md$/;

/** Parses one S3 key into its report metadata. Returns null for anything that doesn't match the path convention — malformed keys are skipped, never thrown on, so one bad object can't take down the whole index. */
export function parseReportKey(obj: S3Object): ReportMeta | null {
  const m = KEY_RE.exec(obj.key);
  if (!m) return null;
  const [, season, week, date, day, slug] = m;
  return {
    key: obj.key,
    season: Number(season),
    week: Number(week),
    date,
    day,
    slug,
    etag: obj.etag,
    lastModified: obj.lastModified,
  };
}

export function parseReportKeys(objects: S3Object[]): ReportMeta[] {
  const parsed: ReportMeta[] = [];
  for (const obj of objects) {
    const meta = parseReportKey(obj);
    if (meta) parsed.push(meta);
  }
  return parsed;
}

/** Title comes from the report's own H1, never the slug — the slug is a hardcoded, opaque URL segment upstream (see quirk #1). */
export function extractTitle(markdown: string): string {
  const m = /^#\s+(.+)$/m.exec(markdown);
  if (!m) return 'Report';
  return m[1].trim();
}

export function reportUrl(meta: ReportMeta): string {
  return `/reports/${meta.season}/${meta.week}/${meta.slug}`;
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

/** The listing is the single source that drives the sidebar, latest selection, and every object's ETag/LastModified — fetched at most once per 300s via the Cache API. */
export async function loadReports(env: S3Env, bypassCache: boolean): Promise<ReportMeta[]> {
  const objects = await getCachedListing(bypassCache, () => listObjects(env, 'reports/'));
  return dedupeRenders(parseReportKeys(objects));
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

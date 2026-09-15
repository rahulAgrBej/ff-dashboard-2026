import { listObjects, type S3Env, type S3Object } from './s3';
import { getCachedListing } from './cache';

export interface ReportMeta {
  key: string;
  season: number;
  week: number;
  date: string; // YYYY-MM-DD, from the filename — never derived from `day`
  day: string; // report-type token, e.g. "monday" — NOT a calendar weekday, see quirk #2
  slug: string; // opaque URL segment; never used to derive a title
  etag: string;
  lastModified: string;
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

/** (date, week, season) descending, tiebroken on LastModified descending — semantic order first, upload time only breaks a same-day double-report tie (e.g. Tuesday's two reports). */
export function sortReports(reports: ReportMeta[]): ReportMeta[] {
  return [...reports].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.week !== b.week) return a.week - b.week < 0 ? 1 : -1;
    if (a.season !== b.season) return a.season - b.season < 0 ? 1 : -1;
    return a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0;
  });
}

export function latestReport(reports: ReportMeta[]): ReportMeta | undefined {
  return sortReports(reports)[0];
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

/** The listing is the single source that drives the sidebar, latest selection, and every object's ETag/LastModified — fetched at most once per 300s via the Cache API. */
export async function loadReports(env: S3Env, bypassCache: boolean): Promise<ReportMeta[]> {
  const objects = await getCachedListing(bypassCache, () => listObjects(env, 'reports/'));
  return parseReportKeys(objects);
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

export function findReport(
  reports: ReportMeta[],
  season: number,
  week: number,
  slug: string
): ReportMeta | undefined {
  return reports.find((r) => r.season === season && r.week === week && r.slug === slug);
}

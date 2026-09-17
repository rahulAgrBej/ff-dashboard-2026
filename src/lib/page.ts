import type { S3Env } from './s3';
import { getObject, S3Error } from './s3';
import { getCachedBody } from './cache';
import {
  attachDatelines,
  extractTitle,
  findReport,
  formatGeneratedAt,
  loadReports,
  type ReportMeta,
} from './reports';
import { loadReportJson, loadReportJsonIndex, reportJsonKeyFor, type ReportEnvelope } from './reportJson';
import { loadSummary, sha256Hex, type ReportSummary } from './summaries';
import { buildRosterNews, isRenderableNews, type NewsBlock, type RosterNews } from './news';
import { splitSections, weekWindowSeed, type SplitSections } from './sections';
import {
  buildWeekSummaries,
  collectWeekWindows,
  latestReport,
  nextReportNote,
  weekDateRange,
  type MergedSlot,
  type WeekSummary,
} from './schedule';
import { renderReport, type RenderedReport } from './render';

/**
 * The two read surfaces load almost identically, and before this module they
 * did so in four near-duplicate page frontmatters. Everything a page needs is
 * assembled here so each `.astro` file is markup.
 *
 * Both loaders share three contracts with the pages that came before them:
 * they never throw (an `S3Error` becomes `emptyReason`), a missing summary or
 * news layer costs the page nothing, and `bypass` is threaded all the way
 * down so `?nocache=1` reaches every cache read.
 */

/** Which report a page wants: the newest, or one addressed by URL. */
export type Selector = { kind: 'latest' } | { kind: 'slug'; season: number; week: number; slug: string };

/**
 * Why a page has nothing to render. Distinguishing these is the point: a
 * denied prefix is a configuration fix, an empty prefix is the data being
 * honest, and neither should read like the other.
 */
export type EmptyKind = 'denied' | 'unreachable' | 'unreadable' | 'empty' | 'not-found';

interface PageBase {
  /** Non-null means render nothing but the empty state. Never a thrown error. */
  emptyReason: string | null;
  /** Which kind of nothing, for choosing an icon and whether to offer a way out. */
  emptyKind?: EmptyKind;
  /** The underlying technical string — the S3 error, verbatim — for whoever has to fix it. Never the whole explanation. */
  emptyDetail?: string | null;
  /**
   * Where to send the reader when this surface has nothing.
   *
   * On a `not-found` the report is identified by the URL even though it is
   * absent from this listing, so the link can point at that exact report in
   * the archive rather than at the archive index — which is the whole reason
   * a reader reached a structured URL for a markdown-only report.
   */
  archiveHref?: string;
  reports: ReportMeta[];
  current?: ReportMeta;
  weeks: WeekSummary[];
  currentWeek?: WeekSummary;
  currentSlot?: MergedSlot;
  upcoming?: MergedSlot;
  isLatest: boolean;
  /** True when the URL named a report that isn't in the listing — the page should also set a 404. */
  notFound: boolean;
}

export interface DailyPage extends PageBase {
  envelope?: ReportEnvelope;
  sections?: SplitSections;
  summary: ReportSummary | null;
  newsBlock: NewsBlock | null;
  rosterNews: RosterNews | null;
  newsError: string | null;
  /**
   * Whether the envelope's embedded `markdown` matches its own
   * `markdown_sha256`. This is an internal-consistency check on one object
   * and costs nothing — deliberately **not** a claim that the `.md` in the
   * bucket matches, which would need a second fetch and would defeat the
   * point of reading the structured form.
   */
  markdownConsistent: boolean | null;
}

export interface ArchivePage extends PageBase {
  markdown: string;
  title: string;
  rendered: RenderedReport | null;
  generatedAt: string;
  weekWindowLabel?: string;
  covers: string | null;
  summary: ReportSummary | null;
  newsBlock: NewsBlock | null;
  rosterNews: RosterNews | null;
  newsError: string | null;
  /**
   * Whether this report actually has an object under `reports-json/`.
   *
   * Checked against the listing rather than inferred from the key: the key
   * swap always succeeds for a well-formed report key, so inferring it would
   * offer a link into the daily view for the four reports that predate the
   * structured prefix and send the reader to a 404. The listing is cached on
   * the same 300s cycle as the others, so this costs nothing per request.
   */
  hasStructuredTwin: boolean;
}

function pick(reports: ReportMeta[], selector: Selector): ReportMeta | undefined {
  return selector.kind === 'latest'
    ? latestReport(reports)
    : findReport(reports, selector.season, selector.week, selector.slug);
}

function reason(err: unknown, fallback: string): string {
  return err instanceof S3Error ? err.message : fallback;
}

/**
 * Classifies a listing failure so the page can say something true about it.
 *
 * `AccessDenied` on `reports-json/` is the one worth calling out by name: the
 * prefix is listed under its own IAM grant, so it can be denied while
 * `reports/` and `summaries/` stay readable — which is exactly the shape of
 * failure that took the site's homepage down while `/archive` kept working.
 */
function classify(err: unknown, prefix: string): { kind: EmptyKind; reason: string; detail: string | null } {
  const detail = err instanceof S3Error ? err.message : null;
  if (err instanceof S3Error && err.code === 'AccessDenied') {
    return {
      kind: 'denied',
      reason: `The bucket's ${prefix} prefix is not readable with the credentials this site is using, so there is nothing to list. The markdown archive reads a different prefix and is unaffected.`,
      detail,
    };
  }
  return { kind: 'unreachable', reason: reason(err, 'S3 is unreachable.'), detail };
}

/**
 * The daily view: one report read from `reports-json/`.
 *
 * The listing is the structured prefix's, so a report with no JSON twin is
 * absent here by construction rather than by a filter — which is the point.
 * Those reports are reachable only through the archive.
 *
 * Note what this does *not* do: `attachDatelines`. The envelope's header
 * carries the covered range and the render time already, and its
 * `week_window` seeds every other week's label in the sidebar, so the
 * markdown surface's fan-out of body fetches is not needed here at all.
 */
export async function loadDailyPage(
  env: S3Env,
  bypass: boolean,
  selector: Selector
): Promise<DailyPage> {
  const empty: DailyPage = {
    emptyReason: null,
    reports: [],
    weeks: [],
    isLatest: false,
    notFound: false,
    summary: null,
    newsBlock: null,
    rosterNews: null,
    newsError: null,
    markdownConsistent: null,
  };

  let reports: ReportMeta[];
  try {
    reports = await loadReports(env, bypass, 'reports-json');
  } catch (err) {
    const { kind, reason: why, detail } = classify(err, 'reports-json/');
    return { ...empty, emptyReason: why, emptyKind: kind, emptyDetail: detail };
  }

  const current = pick(reports, selector);
  if (!current) {
    return {
      ...empty,
      reports,
      notFound: selector.kind === 'slug',
      emptyKind: selector.kind === 'slug' ? 'not-found' : 'empty',
      archiveHref:
        selector.kind === 'slug'
          ? `/archive/${selector.season}/${selector.week}/${selector.slug}`
          : '/archive',
      emptyReason:
        selector.kind === 'slug'
          ? 'No structured report matches this URL — most likely a report that predates the structured prefix, which has no twin and no backfill. The markdown archive is where it lives.'
          : 'No structured reports were found in the bucket. Reports rendered before the structured prefix existed have no twin, and there is no backfill — those are in the markdown archive.',
    };
  }

  const envelope = await loadReportJson(env, current, bypass);
  if (!envelope) {
    // The listing said the object was there, so this is a read or a schema
    // problem rather than an absence — worth naming, not worth throwing.
    return {
      ...empty,
      reports,
      current,
      emptyKind: 'unreadable',
      emptyReason: 'This report’s structured form could not be read — the listing found the object but its contents did not parse, or its schema version is one this build does not understand. The markdown archive still has it.',
    };
  }

  // Hashing the embedded copy rather than fetching the `.md`: it is the same
  // text the summarizer hashed, so the staleness badge works with no extra
  // request. `sha256Hex` is the same primitive the pipeline uses.
  const summary = await loadSummary(env, current, envelope.markdown, bypass);

  const newsBlock = summary && isRenderableNews(summary.news) ? summary.news : null;
  const rosterNews = newsBlock ? buildRosterNews(newsBlock) : null;
  const newsError = summary && !newsBlock && summary.news_error ? summary.news_error : null;

  let markdownConsistent: boolean | null = null;
  if (typeof envelope.markdown_sha256 === 'string' && envelope.markdown_sha256.length === 64) {
    try {
      markdownConsistent = (await sha256Hex(envelope.markdown)) === envelope.markdown_sha256;
    } catch {
      markdownConsistent = null;
    }
  }

  // The markdown listing, purely to annotate slots the structured listing
  // could not fill. Best-effort: this prefix has its own IAM grant and its
  // own 300s cache entry, and losing it costs the sidebar its "markdown only"
  // rows, never the page. Deliberately *after* the envelope loaded, so a
  // denied `reports/` can never take down a working daily view.
  let markdownReports: ReportMeta[] = [];
  try {
    markdownReports = await loadReports(env, bypass, 'reports');
  } catch {
    markdownReports = [];
  }

  const weeks = buildWeekSummaries(reports, new Date(), {
    seedWindows: weekWindowSeed(envelope),
    fallbackReports: markdownReports,
  });
  const currentWeek = weeks.find((w) => w.season === current.season && w.week === current.week);
  const currentSlot = currentWeek?.slots.find((s) => s.report?.key === current.key);

  return {
    emptyReason: null,
    reports,
    current,
    envelope,
    sections: splitSections(envelope.sections),
    summary,
    newsBlock,
    rosterNews,
    newsError,
    markdownConsistent,
    weeks,
    currentWeek,
    currentSlot,
    upcoming: currentWeek ? nextReportNote(currentWeek.slots, currentSlot) : undefined,
    isLatest: latestReport(reports)?.key === current.key,
    notFound: false,
  };
}

/**
 * The markdown archive: one report read from `reports/`, rendered the way it
 * always was. This is the existing page's frontmatter, moved — including
 * `attachDatelines`, which the markdown surface genuinely needs because the
 * covered date lives only inside each body.
 */
export async function loadArchivePage(
  env: S3Env,
  bypass: boolean,
  selector: Selector
): Promise<ArchivePage> {
  const empty: ArchivePage = {
    emptyReason: null,
    reports: [],
    weeks: [],
    isLatest: false,
    notFound: false,
    markdown: '',
    title: 'Report',
    rendered: null,
    generatedAt: '',
    covers: null,
    summary: null,
    newsBlock: null,
    rosterNews: null,
    newsError: null,
    hasStructuredTwin: false,
  };

  let reports: ReportMeta[];
  try {
    reports = await loadReports(env, bypass, 'reports');
    reports = await attachDatelines(env, reports, bypass);
  } catch (err) {
    const { kind, reason: why, detail } = classify(err, 'reports/');
    return { ...empty, emptyReason: why, emptyKind: kind, emptyDetail: detail };
  }

  const current = pick(reports, selector);
  if (!current) {
    return {
      ...empty,
      reports,
      notFound: selector.kind === 'slug',
      emptyKind: selector.kind === 'slug' ? 'not-found' : 'empty',
      emptyReason:
        selector.kind === 'slug'
          ? 'No report matches this URL.'
          : 'No reports were found in the bucket.',
    };
  }

  let markdown: string;
  try {
    markdown = await getCachedBody(current.key, current.etag, bypass, () =>
      getObject(env, current.key)
    );
  } catch (err) {
    return { ...empty, reports, current, emptyReason: reason(err, 'Could not read this report.') };
  }

  const summary = await loadSummary(env, current, markdown, bypass);
  const newsBlock = summary && isRenderableNews(summary.news) ? summary.news : null;
  const rosterNews = newsBlock ? buildRosterNews(newsBlock) : null;
  const newsError = summary && !newsBlock && summary.news_error ? summary.news_error : null;

  const weeks = buildWeekSummaries(reports, new Date());
  const currentWeek = weeks.find((w) => w.season === current.season && w.week === current.week);
  const currentSlot = currentWeek?.slots.find((s) => s.report?.key === current.key);
  const rendered = renderReport(markdown);

  // Best-effort, like every other cross-prefix read here: a listing failure
  // costs the reader the cross-link, not the page.
  const twinKey = reportJsonKeyFor(current.key);
  let hasStructuredTwin = false;
  if (twinKey) {
    try {
      hasStructuredTwin = (await loadReportJsonIndex(env, bypass)).has(twinKey);
    } catch {
      hasStructuredTwin = false;
    }
  }

  return {
    emptyReason: null,
    reports,
    current,
    markdown,
    title: extractTitle(markdown),
    rendered,
    generatedAt: rendered.dateline?.renderedAt ?? formatGeneratedAt(current.lastModified),
    weekWindowLabel: weekDateRange(current.season, current.week, collectWeekWindows(reports))?.label,
    covers: rendered.dateline?.covers ?? null,
    summary,
    newsBlock,
    rosterNews,
    newsError,
    hasStructuredTwin,
    weeks,
    currentWeek,
    currentSlot,
    upcoming: currentWeek ? nextReportNote(currentWeek.slots, currentSlot) : undefined,
    isLatest: latestReport(reports)?.key === current.key,
    notFound: false,
  };
}

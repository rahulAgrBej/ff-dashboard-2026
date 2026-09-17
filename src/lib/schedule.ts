import type { ReportMeta } from './reports';
import { compareRenderRecency } from './reports';
import { slotDateFor, dayOffsetInTueWeek } from './dateline';

export type SlotState = 'published' | 'pending' | 'planned';

export interface ScheduleSlot {
  order: number;
  day: string; // report-type token, matches ReportMeta['day']
  timeEt: string; // "HH:MM"
  key: string;
  title: string;
  short?: string; // disambiguates two slots sharing a day, e.g. Tuesday's pair
}

/** Transcribed from docs/report-weekly-schedule.md. Eight slots, every week, always — the schedule only ever adds rows to what the bucket has. */
export const SCHEDULE: ScheduleSlot[] = [
  { order: 1, day: 'monday', timeEt: '10:30', key: 'monday_night_call', title: 'Monday night call' },
  { order: 2, day: 'tuesday', timeEt: '10:00', key: 'week_in_review', title: 'Week in review', short: 'week review' },
  { order: 3, day: 'tuesday', timeEt: '11:00', key: 'waiver_wire', title: 'Waiver wire and opening market', short: 'waiver wire' },
  { order: 4, day: 'wednesday', timeEt: '10:00', key: 'availability_watchlist', title: 'Availability watchlist' },
  { order: 5, day: 'thursday', timeEt: '11:00', key: 'usage_and_market', title: 'Usage and market' },
  { order: 6, day: 'friday', timeEt: '11:00', key: 'lineup_lock', title: 'Lineup lock' },
  { order: 7, day: 'saturday', timeEt: '10:00', key: 'contingency_check', title: 'Contingency check' },
  { order: 8, day: 'sunday', timeEt: '11:30', key: 'pre_lock_call', title: 'Pre-lock call' },
];

/**
 * Widen as upstream ships days. Without this, every week would read "1 of 8,
 * seven failures" for reports that were never built.
 *
 * Wednesday and Thursday were added once the bucket began carrying
 * `availability-watchlist` and `usage-and-market` objects — before that they
 * rendered as `planned`, i.e. "not built upstream yet", which was no longer
 * true.
 */
export const IMPLEMENTED_DAYS: string[] = ['monday', 'tuesday', 'wednesday', 'thursday'];

/** Read STALE_AFTER_HOURS below before tightening — only Monday and Tuesday are implemented, so reports land twice a week. */
export const STALE_AFTER_HOURS = 192;

/** One anchor Tuesday per season, matching the pipeline's Tue 03:00 ET -> Tue 03:00 ET window (`espn_ff/weeks.py`); week N spans anchor + (N-1)*7 for 7 days. Last-resort fallback only — a real window parsed from any report's dateline (see `weekDateRange`) always wins. */
export const WEEK_1_START: Record<number, string> = {
  2026: '2026-09-08',
};

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function isoFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDayMonth(date: Date): { day: number; month: string } {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return { day: date.getUTCDate(), month: months[date.getUTCMonth()] };
}

export interface WeekRange {
  start: Date; // the week's opening Tuesday
  end: Date; // inclusive — the Monday the following Tuesday 03:00 window closes out
  label: string; // e.g. "15–21 Sep" or "31 Aug–6 Sep"
}

export interface WeekWindow {
  start: string; // YYYY-MM-DD, exclusive-end Tue->Tue window as named by a report's own **Week N** line
  end: string;
}

/** Every report's dateline names its own week's Tue->Tue window. Collected once per (season, week) so `weekDateRange` can source real windows instead of guessing from an anchor — first report wins, but reports naming the same week always agree since they come from the same pipeline run. */
export function collectWeekWindows(reports: ReportMeta[]): Map<string, WeekWindow> {
  const windows = new Map<string, WeekWindow>();
  for (const r of reports) {
    const dl = r.dateline;
    if (!dl || dl.week === null || !dl.weekStart || !dl.weekEnd) continue;
    const key = `${r.season}-${dl.week}`;
    if (!windows.has(key)) windows.set(key, { start: dl.weekStart, end: dl.weekEnd });
  }
  return windows;
}

function rangeFromWindow(window: WeekWindow): WeekRange {
  const start = parseIsoDate(window.start);
  const inclusiveEnd = addDaysUtc(parseIsoDate(window.end), -1);
  const s = formatDayMonth(start);
  const e = formatDayMonth(inclusiveEnd);
  const label =
    s.month === e.month
      ? `${s.day}–${e.day} ${e.month}`
      : `${s.day} ${s.month}–${e.day} ${e.month}`;
  return { start, end: inclusiveEnd, label };
}

/**
 * Week N's Tue-through-Mon range (the pipeline's own Tue 03:00 ET -> Tue
 * 03:00 ET window, rendered inclusive of the last covered day). Never by
 * snapping report dates to weekdays (quirk #2: `day` is a report type, not
 * a calendar weekday) — instead, in order:
 *  1. a window named directly by a report's own dateline for this week;
 *  2. extrapolated ±7n days from any other known window in that season;
 *  3. the season's `WEEK_1_START` anchor;
 *  4. `null` (a season/week with no data at all keeps its bare label).
 */
export function weekDateRange(season: number, week: number, windows?: Map<string, WeekWindow>): WeekRange | null {
  const direct = windows?.get(`${season}-${week}`);
  if (direct) return rangeFromWindow(direct);

  if (windows) {
    for (const [key, window] of windows) {
      const sep = key.lastIndexOf('-');
      const windowSeason = Number(key.slice(0, sep));
      const windowWeek = Number(key.slice(sep + 1));
      if (windowSeason !== season) continue;
      const deltaDays = (week - windowWeek) * 7;
      return rangeFromWindow({
        start: isoFromDate(addDaysUtc(parseIsoDate(window.start), deltaDays)),
        end: isoFromDate(addDaysUtc(parseIsoDate(window.end), deltaDays)),
      });
    }
  }

  const anchor = WEEK_1_START[season];
  if (!anchor) return null;
  const start = addDaysUtc(parseIsoDate(anchor), (week - 1) * 7);
  const end = addDaysUtc(start, 7);
  return rangeFromWindow({ start: isoFromDate(start), end: isoFromDate(end) });
}

export interface MergedSlot {
  order: number;
  day: string;
  timeEt: string;
  key: string;
  title: string;
  short?: string;
  state: SlotState;
  report?: ReportMeta;
  /**
   * A report filling this slot under a *different* prefix than the one
   * `state` describes.
   *
   * Set only when the caller supplies `fallbackReports`, and only on a slot
   * that is not `published` in its own listing. The daily surface uses it to
   * say "this report exists as markdown but has no structured twin", which is
   * a different fact from "upstream has not produced it yet" — and with the
   * structured prefix starting mid-season, the second reading would be wrong
   * for most of the week.
   */
  markdownReport?: ReportMeta;
  slotDate: string | null; // YYYY-MM-DD this slot represents — from the report's dateline when published, else the week window's slot day
}

/** The one slot a report belongs to: by day token, disambiguated by slug when a day holds more than one slot (Tuesday). Report-driven (one report → its slot) rather than slot-driven, so a single report can never end up claimed by two slots. */
function matchSlot(day: string, slug: string): ScheduleSlot | undefined {
  const daySlots = SCHEDULE.filter((s) => s.day === day);
  if (daySlots.length <= 1) return daySlots[0];
  return daySlots.find((s) => s.key.split('_').every((part) => slug.includes(part))) ?? daySlots[0];
}

/** Merges the 8-slot schedule against real reports for one (season, week). An unmatched (or slot-colliding) real report is appended, never dropped — a real report is never hidden by the schedule model. */
export interface MergeOptions {
  windows?: Map<string, WeekWindow>;
  /** Reports from the other prefix, used only to annotate slots this listing could not fill. Never affects `state`. */
  fallbackReports?: ReportMeta[];
}

export function mergeSlots(
  reports: ReportMeta[],
  season: number,
  week: number,
  now: Date,
  options: MergeOptions = {}
): MergedSlot[] {
  const { windows, fallbackReports } = options;
  const weekReports = reports.filter((r) => r.season === season && r.week === week);
  const range = weekDateRange(season, week, windows);

  // Resolved through the same `matchSlot` the primary listing uses, so a
  // fallback lands in exactly the slot its own prefix would have claimed —
  // including the Tuesday pair, which is disambiguated by slug.
  const fallbackBySlotKey = new Map<string, ReportMeta>();
  for (const r of fallbackReports ?? []) {
    if (r.season !== season || r.week !== week) continue;
    const slot = matchSlot(r.day, r.slug);
    if (!slot) continue;
    const existing = fallbackBySlotKey.get(slot.key);
    if (!existing || compareRenderRecency(r, existing) < 0) fallbackBySlotKey.set(slot.key, r);
  }

  const bySlotKey = new Map<string, ReportMeta>();
  const extras: ReportMeta[] = [];
  for (const r of weekReports) {
    const slot = matchSlot(r.day, r.slug);
    if (!slot) {
      extras.push(r);
      continue;
    }
    const existing = bySlotKey.get(slot.key);
    if (!existing) {
      bySlotKey.set(slot.key, r);
    } else if (compareRenderRecency(r, existing) < 0) {
      bySlotKey.set(slot.key, r);
      extras.push(existing); // displaced by a newer report claiming the same slot — still rendered, not dropped
    } else {
      extras.push(r);
    }
  }

  const merged: MergedSlot[] = SCHEDULE.map((slot) => {
    const match = bySlotKey.get(slot.key);
    let state: SlotState;
    if (match) {
      state = 'published';
    } else if (!IMPLEMENTED_DAYS.includes(slot.day)) {
      state = 'planned';
    } else {
      const slotDateTime = range ? slotDateTimeEt(range.start, slot) : null;
      state = slotDateTime && slotDateTime <= now ? 'pending' : 'planned';
    }

    const slotDate = match
      ? (slotDateFor(match, slot.day) ?? match.date)
      : range
        ? isoFromDate(addDaysUtc(range.start, dayOffsetInTueWeek(slot.day)))
        : null;

    return {
      order: slot.order,
      day: slot.day,
      timeEt: slot.timeEt,
      key: slot.key,
      title: slot.title,
      short: slot.short,
      state,
      report: match,
      markdownReport: match ? undefined : fallbackBySlotKey.get(slot.key),
      slotDate,
    };
  });

  // Real reports the schedule model didn't match (unimplemented day, an
  // upstream naming drift, or a slot collision above) still render — the
  // schedule only ever adds rows.
  for (const r of extras) {
    merged.push({
      order: SCHEDULE.length + merged.length,
      day: r.day,
      timeEt: '',
      key: r.slug,
      title: dayLabel(r.day),
      state: 'published',
      report: r,
      slotDate: slotDateFor(r, r.day) ?? r.date,
    });
  }

  return merged;
}

/** ET wall-clock time treated as UTC-5 year-round — the schedule doc notes these are EventBridge crons pinned to America/New_York, and this dashboard only ever compares against "has this slot's time passed today", not an exact deadline. */
function slotDateTimeEt(weekStart: Date, slot: ScheduleSlot): Date {
  const date = addDaysUtc(weekStart, dayOffsetInTueWeek(slot.day));
  const [h, m] = slot.timeEt.split(':').map(Number);
  return new Date(date.getTime() + (h + 5) * 3600000 + m * 60000);
}

/** The next non-published slot after `after`, in schedule order — used for "Tuesday report lands 10:00 ET." */
export function nextReportNote(slots: MergedSlot[], after: MergedSlot | undefined): MergedSlot | undefined {
  const startOrder = after?.order ?? 0;
  return slots.find((s) => s.order > startOrder && s.state !== 'published');
}

export interface WeekSummary {
  season: number;
  week: number;
  label: string; // "Week 3 · 7–13 Sep"
  slots: MergedSlot[];
}

/**
 * One group per distinct (season, week) that appears in the reports list,
 * newest first.
 *
 * `seedWindows` lets a caller supply week windows it already holds instead of
 * paying for them. The markdown surface has to parse them out of datelines
 * (`collectWeekWindows`, which needs `attachDatelines` to have fetched every
 * body); the structured surface gets one exact window free in the envelope's
 * `header.week_window`, and `weekDateRange` extrapolates every other week in
 * the season from it — so one object labels the whole sidebar and the
 * dateline fan-out can be skipped entirely.
 */
export interface WeekSummaryOptions extends MergeOptions {
  /** Week windows the caller already holds, avoiding the dateline fetches `collectWeekWindows` depends on. */
  seedWindows?: Map<string, WeekWindow>;
}

export function buildWeekSummaries(
  reports: ReportMeta[],
  now: Date,
  options: WeekSummaryOptions = {}
): WeekSummary[] {
  const { seedWindows, fallbackReports } = options;
  const windows = seedWindows?.size ? seedWindows : collectWeekWindows(reports);
  // Weeks come from both listings: a week present only in the fallback still
  // deserves a group, or the daily sidebar would silently omit a week whose
  // reports all exist as markdown alone.
  const seen = new Map<string, { season: number; week: number }>();
  for (const r of [...reports, ...(fallbackReports ?? [])]) {
    seen.set(`${r.season}-${r.week}`, { season: r.season, week: r.week });
  }
  const weeks = Array.from(seen.values()).sort((a, b) => b.season - a.season || b.week - a.week);

  return weeks.map(({ season, week }) => {
    const range = weekDateRange(season, week, windows);
    return {
      season,
      week,
      label: range ? `Week ${week} · ${range.label}` : `Week ${week}`,
      slots: mergeSlots(reports, season, week, now, { windows, fallbackReports }),
    };
  });
}

export function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * Most recent (season, week), then furthest-along SCHEDULE slot within that
 * week — never the raw `date` field, which is when a report was *generated*,
 * not necessarily which calendar day it represents (the `day` token is a
 * report type, not a derivable weekday — see quirk #2). Two backfilled
 * reports can share an identical date and even an identical S3
 * LastModified; `lastModified` only breaks a true same-slot tie (e.g. a
 * same-day re-run), never a cross-slot one.
 */
export function latestReport(reports: ReportMeta[]): ReportMeta | undefined {
  if (reports.length === 0) return undefined;
  return [...reports].sort((a, b) => {
    if (a.season !== b.season) return b.season - a.season;
    if (a.week !== b.week) return b.week - a.week;
    const orderA = matchSlot(a.day, a.slug)?.order ?? SCHEDULE.length + 1;
    const orderB = matchSlot(b.day, b.slug)?.order ?? SCHEDULE.length + 1;
    if (orderA !== orderB) return orderB - orderA;
    return compareRenderRecency(a, b);
  })[0];
}

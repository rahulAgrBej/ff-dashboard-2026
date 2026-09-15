import type { ReportMeta } from './reports';

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

/** Widen as upstream ships days. Without this, every week would read "1 of 8, seven failures" for reports that were never built. */
export const IMPLEMENTED_DAYS: string[] = ['monday'];

/** Read STALE_AFTER_HOURS below before tightening — only Monday is implemented, so reports land weekly. */
export const STALE_AFTER_HOURS = 192;

/** One anchor Monday per season; week N spans anchor + (N-1)*7 for 7 days. */
export const WEEK_1_MONDAY: Record<number, string> = {
  2026: '2026-09-07',
};

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function formatDayMonth(date: Date): { day: number; month: string } {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return { day: date.getUTCDate(), month: months[date.getUTCMonth()] };
}

export interface WeekRange {
  start: Date;
  end: Date;
  label: string; // e.g. "14–20 Sep" or "31 Aug–6 Sep"
}

/** Week N's Monday-through-Sunday range, derived from the season anchor — never by snapping report dates to Mondays (quirk #2: `day` is a report type, not a weekday). */
export function weekDateRange(season: number, week: number): WeekRange | null {
  const anchor = WEEK_1_MONDAY[season];
  if (!anchor) return null;
  const monday = addDaysUtc(parseIsoDate(anchor), (week - 1) * 7);
  const sunday = addDaysUtc(monday, 6);
  const start = formatDayMonth(monday);
  const end = formatDayMonth(sunday);
  const label =
    start.month === end.month
      ? `${start.day}–${end.day} ${end.month}`
      : `${start.day} ${start.month}–${end.day} ${end.month}`;
  return { start: monday, end: sunday, label };
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
}

/** The one slot a report belongs to: by day token, disambiguated by slug when a day holds more than one slot (Tuesday). Report-driven (one report → its slot) rather than slot-driven, so a single report can never end up claimed by two slots. */
function matchSlot(day: string, slug: string): ScheduleSlot | undefined {
  const daySlots = SCHEDULE.filter((s) => s.day === day);
  if (daySlots.length <= 1) return daySlots[0];
  return daySlots.find((s) => s.key.split('_').every((part) => slug.includes(part))) ?? daySlots[0];
}

/** Merges the 8-slot schedule against real reports for one (season, week). An unmatched (or slot-colliding) real report is appended, never dropped — a real report is never hidden by the schedule model. */
export function mergeSlots(
  reports: ReportMeta[],
  season: number,
  week: number,
  now: Date
): MergedSlot[] {
  const weekReports = reports.filter((r) => r.season === season && r.week === week);
  const range = weekDateRange(season, week);

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
    } else if (r.lastModified > existing.lastModified) {
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

    return {
      order: slot.order,
      day: slot.day,
      timeEt: slot.timeEt,
      key: slot.key,
      title: slot.title,
      short: slot.short,
      state,
      report: match,
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
    });
  }

  return merged;
}

/** ET wall-clock time treated as UTC-5 year-round — the schedule doc notes these are EventBridge crons pinned to America/New_York, and this dashboard only ever compares against "has this slot's time passed today", not an exact deadline. */
function slotDateTimeEt(weekMonday: Date, slot: ScheduleSlot): Date {
  const dayOffset = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(
    slot.day
  );
  const date = addDaysUtc(weekMonday, dayOffset < 0 ? 0 : dayOffset);
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

/** One group per distinct (season, week) that appears in the reports list, newest first. */
export function buildWeekSummaries(reports: ReportMeta[], now: Date): WeekSummary[] {
  const seen = new Map<string, { season: number; week: number }>();
  for (const r of reports) {
    seen.set(`${r.season}-${r.week}`, { season: r.season, week: r.week });
  }
  const weeks = Array.from(seen.values()).sort((a, b) => b.season - a.season || b.week - a.week);

  return weeks.map(({ season, week }) => {
    const range = weekDateRange(season, week);
    return {
      season,
      week,
      label: range ? `Week ${week} · ${range.label}` : `Week ${week}`,
      slots: mergeSlots(reports, season, week, now),
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
    return b.lastModified.localeCompare(a.lastModified);
  })[0];
}

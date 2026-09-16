import type { ReportMeta } from './reports';

export interface Dateline {
  covers: string | null; // raw prose after **Covers**
  coversDate: string | null; // YYYY-MM-DD, only when **Covers** names one explicitly
  week: number | null; // N from **Week N**
  weekStart: string | null; // YYYY-MM-DD from the window
  weekEnd: string | null;
  renderedAt: string | null; // raw, e.g. "Tue 2026-09-15 20:38 ET"
}

const COVERS_RE = /^\*\*Covers\*\*\s+(.+)$/m;
const WEEK_RE = /^\*\*Week\s+(\d+)\*\*\s+(.+)$/m;
const RENDERED_RE = /^\*\*Rendered\*\*\s+(.+)$/m;

// Only when the `**Covers**` value *leads* with a weekday+date, e.g. "Mon
// 2026-09-21 -- week 2's Monday-night game". Deliberately not "first date
// anywhere in the line": the waiver report's first date is the *previous*
// week's window start.
const COVERS_LEADING_DATE_RE = /^\w{3}\s+(\d{4}-\d{2}-\d{2})/;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/** Parses the three-line dateline block from a report body. Returns null when no `**Covers**`/`**Week N**`/`**Rendered**` line matches, so old-format reports flow through untouched. */
export function parseDateline(markdown: string): Dateline | null {
  const coversMatch = COVERS_RE.exec(markdown);
  const weekMatch = WEEK_RE.exec(markdown);
  const renderedMatch = RENDERED_RE.exec(markdown);

  if (!coversMatch && !weekMatch && !renderedMatch) return null;

  const covers = coversMatch ? coversMatch[1].trim() : null;
  const coversDate = covers ? (COVERS_LEADING_DATE_RE.exec(covers)?.[1] ?? null) : null;

  const week = weekMatch ? Number(weekMatch[1]) : null;
  // `weekMatch[2]` reads "insufficient data" when ESPN's calendar isn't on
  // disk — no dates to pull, nulls rather than a guess.
  const weekDates = weekMatch ? weekMatch[2].match(ISO_DATE_RE) : null;
  const weekStart = weekDates?.[0] ?? null;
  const weekEnd = weekDates?.[1] ?? null;

  const renderedAt = renderedMatch ? renderedMatch[1].trim() : null;

  return { covers, coversDate, week, weekStart, weekEnd, renderedAt };
}

// Offsets inside a Tue-anchored week: the pipeline's window runs Tue 03:00 ET
// -> Tue 03:00 ET, so Tuesday is day 0.
const TUE_ANCHORED_DAY_ORDER = ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'monday'];

/** A `day` token's offset from the Tuesday that opens its schedule week. Unknown tokens fall back to 0, same guard `slotDateTimeEt` uses. */
export function dayOffsetInTueWeek(day: string): number {
  const offset = TUE_ANCHORED_DAY_ORDER.indexOf(day);
  return offset < 0 ? 0 : offset;
}

function addDaysToIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar date a report's schedule slot represents.
 *  1. `dateline.coversDate` when present (Monday's explicit game date).
 *  2. Otherwise the report's *filing* week window, shifted by the gap
 *     between the filing week and the week the dateline names — the body
 *     names the *subject* week, which is not always the filing week (the
 *     week-in-review is filed under week N+1 but names week N) — plus the
 *     slot's offset inside a Tue-anchored week.
 *  3. `null` when neither is derivable — callers fall back to the filename
 *     date.
 */
export function slotDateFor(meta: ReportMeta, day: string): string | null {
  const dateline = meta.dateline;
  if (!dateline) return null;

  if (dateline.coversDate) return dateline.coversDate;

  if (dateline.week === null || !dateline.weekStart) return null;

  const shiftDays = (meta.week - dateline.week) * 7 + dayOffsetInTueWeek(day);
  return addDaysToIso(dateline.weekStart, shiftDays);
}

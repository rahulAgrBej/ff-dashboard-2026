import type {
  CellValue,
  ColumnType,
  FreshnessSection,
  ListSection,
  ReportEnvelope,
  Section,
  TableColumn,
  TableRow,
} from './reportJson';

/**
 * Display shaping for a report envelope's `sections`.
 *
 * Pure shaping — no S3, no cache, no fetching, on the same reasoning as
 * `news.ts`: the envelope is already in hand by the time a page needs it, so
 * reading it costs nothing beyond the GET the page already paid for.
 *
 * Three rules from the upstream contract are enforced here rather than left
 * to each component:
 *
 *  1. **Route on `id`, display `heading`.** Section ids are fixed strings.
 *     Two reports build their headings at render time, so a consumer matching
 *     on heading text breaks on Saturday every day and Thursday every week.
 *  2. **Switch on `kind`, never on presence.** Most ids can arrive as a
 *     `table`, a `prose`, a `blocks` *or* an `insufficient` for the same id,
 *     depending on whether the inputs were there.
 *  3. **`null` is "no reading" and is never zero.** The markdown had three
 *     vocabularies for missing data and all three are `null` here. A bye
 *     week's `offense_pct` is null, not 0.0; a count that could not be
 *     computed is null, never 0. "No starters are out" and "we could not find
 *     out" are opposite answers and must not render identically.
 */

/** The `id` of the per-feed staleness strip every report opens with. */
export const FRESHNESS_ID = 'freshness';

/** The `id` of the closing "What this report cannot see" list — a `list` section present in all eight report types, hence a shared footer rather than a body section. */
export const CANNOT_SEE_ID = 'cannot-see';

export interface SplitSections {
  /** Null when this report had no freshness section at all — not the same as a freshness section whose feeds are all stale. */
  freshness: FreshnessSection | null;
  /** Everything between the chrome, in render order. */
  body: Section[];
  cannotSee: ListSection | null;
}

/**
 * Lifts the two sections that get their own treatment out of the body, so
 * the middle can render generically.
 *
 * This mirrors what `renderReport` already does for markdown — it pulls the
 * same two sections out with regexes — except that here they are addressed by
 * id, and the freshness entries arrive with a real `stale` boolean the
 * markdown never carried.
 *
 * Each is matched by id and by kind together: an id arriving as the wrong
 * kind (a `freshness` id that came back `insufficient`, say) falls through to
 * the body, where the generic dispatcher renders it honestly, rather than
 * being coerced into a strip it cannot fill.
 */
export function splitSections(sections: Section[]): SplitSections {
  let freshness: FreshnessSection | null = null;
  let cannotSee: ListSection | null = null;
  const body: Section[] = [];

  for (const section of sections) {
    if (!freshness && section.id === FRESHNESS_ID && section.kind === 'freshness') {
      freshness = section;
    } else if (!cannotSee && section.id === CANNOT_SEE_ID && section.kind === 'list') {
      cannotSee = section;
    } else {
      body.push(section);
    }
  }

  return { freshness, body, cannotSee };
}

export interface Cell {
  text: string;
  /** True only for a genuine `null` — "we have no reading". Never true for `0`, `0.0`, `false` or an empty string, each of which is a real value. */
  isNull: boolean;
}

/** What a null cell reads as. One phrase everywhere, so a reader learns it once. */
export const NO_READING = 'no reading';

/**
 * One table cell, formatted.
 *
 * `type` is a hint, not a guarantee — upstream declares it and nothing
 * asserts the rows match — so the value's own runtime type wins and `type`
 * only decides presentation among plausible readings. A number arriving as a
 * numeric string still formats as a number; a string arriving in a `number`
 * column is shown as itself rather than coerced to `NaN`.
 */
export function formatCell(value: CellValue | undefined, type?: ColumnType): Cell {
  // `undefined` is a row that simply lacks the key, which is the same
  // absence of a reading as an explicit null.
  if (value === null || value === undefined) return { text: NO_READING, isNull: true };

  if (typeof value === 'boolean') return { text: value ? 'yes' : 'no', isNull: false };

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: NO_READING, isNull: true };
    return { text: formatNumber(value, type), isNull: false };
  }

  const text = String(value);
  // A numeric string in a numeric column is a number that survived JSON as
  // text; format it as one so the column stays alignable. An empty string is
  // left alone — it is a real, if uninformative, value.
  if (isNumericType(type) && text.trim() !== '' && Number.isFinite(Number(text))) {
    return { text: formatNumber(Number(text), type), isNull: false };
  }
  return { text, isNull: false };
}

function isNumericType(type?: ColumnType): boolean {
  return type === 'number' || type === 'integer';
}

/**
 * Integers print bare; everything else keeps the precision the envelope sent
 * rather than being rounded to a house number of decimals. `0` and `0.0` are
 * real zeros and must stay visually distinct from `NO_READING` — that is the
 * whole point of this module.
 */
function formatNumber(value: number, type?: ColumnType): string {
  if (type === 'integer' || Number.isInteger(value)) return String(value);
  return String(value);
}

/**
 * Whether a column should be rendered mono and right-aligned.
 *
 * Checked against the rows, not just the declared `type`, because `type` is
 * unvalidated: a column declared `number` whose cells are all strings would
 * otherwise get numeric alignment it cannot use. Requires the declaration
 * *and* at least one real number, and tolerates nulls — a mostly-empty
 * numeric column is still a numeric column.
 */
export function isNumericColumn(column: TableColumn, rows: TableRow[]): boolean {
  if (!isNumericType(column.type)) return false;
  return rows.some((row) => {
    const value = row?.[column.key];
    if (typeof value === 'number') return Number.isFinite(value);
    return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  });
}

export interface DataChip {
  key: string;
  cell: Cell;
}

/**
 * A section's `data` map as ordered chips.
 *
 * `data` is not a summary of the rows — it is the facts the rows do not hold.
 * Several numbers exist in the markdown only inside a sentence (Wednesday's
 * waiver-outcome counts, Tuesday's points left on the table, Friday's
 * held-open slots, Sunday's minutes to kickoff), and they ride here so the UI
 * does not have to parse prose.
 *
 * Nulls are kept rather than dropped, and for the reason this whole module
 * exists: a null count means the figure could not be computed, which is worth
 * showing. Dropping it would render as "this report never mentioned it".
 */
export function dataChips(section: Section): DataChip[] {
  const data = section.data;
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data).map((key) => ({ key, cell: formatCell(data[key]) }));
}

/**
 * Whether a child block is a continuation of its parent rather than a
 * section of its own.
 *
 * Upstream uses `heading: null` as a layout instruction: Wednesday's
 * Watchlist prints a table, an italic note, then a second table, all under
 * one `##`. Rendering such a child with its own heading slot would invent a
 * section break the report does not have.
 */
export function isContinuation(section: Section): boolean {
  return section.heading === null || section.heading === undefined;
}

/**
 * How deep `blocks` nesting is followed before a section is rendered flat.
 *
 * Upstream only ever nests `###` inside `##`, so two is already one more
 * level than the data uses. The cap exists so a malformed or future envelope
 * cannot drive unbounded recursion in a component that renders itself.
 */
export const MAX_BLOCK_DEPTH = 3;

/**
 * The report's own section count, for the "8 sections in render order"
 * caption — chrome included, since that is what the reader sees.
 */
export function sectionCount(envelope: ReportEnvelope): number {
  return envelope.sections.length;
}

/**
 * The week window as a seed for `schedule.ts`'s week labelling, or null when
 * the calendar was unavailable upstream.
 *
 * `weekDateRange` extrapolates ±7n days from any one known window in a
 * season, so one envelope is enough to label every week in the sidebar —
 * which is what lets the daily view skip `attachDatelines` and its fan-out of
 * body fetches entirely.
 *
 * Guarded on the raw fields, never on `display`: when start/end are null,
 * `display` holds the literal string "insufficient data", and seeding a
 * window from that would invent a calendar.
 */
export function weekWindowSeed(envelope: ReportEnvelope): Map<string, { start: string; end: string }> {
  const seed = new Map<string, { start: string; end: string }>();
  const window = envelope.header?.week_window;
  const week = envelope.header?.week ?? envelope.week;
  if (!window?.start || !window.end || typeof week !== 'number') return seed;

  const start = window.start.slice(0, 10);
  const end = window.end.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return seed;

  seed.set(`${envelope.season}-${week}`, { start, end });
  return seed;
}

import { formatSummaryTimestamp } from './summaries';

/**
 * The grounded roster-news layer of a v2 summary envelope
 * (`espn_ff/ai/summarize.py:generate_news`).
 *
 * This module is pure shaping — no S3, no cache, no fetching. The envelope
 * is already in hand by the time a page needs news, so reading it costs
 * nothing beyond the GET the summary card already paid for.
 *
 * Three upstream guarantees shape everything below:
 *
 *  1. **Every rostered player appears.** `parse_players` reconciles the
 *     model's answer against the roster it was given, materialising anyone
 *     the model skipped with `found: false` and a `note`. "We looked and
 *     found nothing" and "the model never answered" are different findings,
 *     and neither may render as a finding.
 *  2. **`grounded: false` is the layer working, not failing.** It means the
 *     search tool never fired and those items came from model recall —
 *     roughly one call in four, per upstream's live notes. It has to be
 *     surfaced, not swallowed.
 *  3. **News is never a lineup call.** Its house rules forbid it, because
 *     the report beside it owns that decision and cannot see what the
 *     search found. Nothing here may frame news as advice.
 */

export interface NewsPlayer {
  player_id: number;
  player_name: string | null;
  position: string | null;
  pro_team: string | null;
  lineup_slot: string | null;
  group: string;
  espn_injury_status: string | null;
  found: boolean;
  headline: string | null;
  detail: string | null;
  as_of: string | null;
  /** Present only when `found` is false; says which kind of nothing this is. */
  note?: string;
}

export interface NewsSource {
  uri: string;
  title: string;
}

/** A group either ran (and carries provenance) or was skipped (and carries only a reason). */
export interface NewsGroup {
  players?: number;
  grounded?: boolean;
  search_queries?: string[];
  sources?: NewsSource[];
  search_entry_point?: string;
  skipped?: string;
}

export interface NewsBlock {
  model: string;
  grounded: boolean;
  generated_at: string;
  roster_week: number;
  roster_export: string | null;
  prompt_sha256: string;
  search_query_count: number;
  players: NewsPlayer[];
  groups: Record<string, NewsGroup>;
}

/** Fixed display order. Never taken from `players` array order, which follows the roster export. */
const GROUP_ORDER = ['starters', 'bench', 'ir'] as const;

const GROUP_LABELS: Record<string, string> = {
  starters: 'Starters',
  bench: 'Bench',
  ir: 'Injured reserve',
};

/**
 * What each group was actually asked, in the UI's words.
 *
 * The three groups get different questions upstream, and that is why
 * grouping matters for presentation rather than being cosmetic: a mostly
 * empty bench is the design working, not a gap, and IR is a status strip
 * rather than news. Showing the question alongside the answers is what makes
 * an empty group legible instead of looking broken.
 */
const GROUP_ASKS: Record<string, string> = {
  starters: 'the most recent item before kickoff',
  bench: 'one line only where something changed',
  ir: 'designation and return timeline only',
};

export interface RosterNewsGroup {
  key: string;
  label: string;
  /** The question this group was asked, or null for a group key this renderer doesn't know. */
  ask: string | null;
  players: NewsPlayer[];
  foundCount: number;
  totalCount: number;
  /** The upstream skip reason, e.g. "no players in the ir group for week 2". */
  skipped: string | null;
  /** False when this group's search never fired. A skipped group has no opinion, hence null. */
  grounded: boolean | null;
  /** How many distinct sources the API's grounding metadata returned for this group. Zero on an ungrounded group by definition. */
  sourceCount: number;
}

export interface RosterNews {
  groups: RosterNewsGroup[];
  foundCount: number;
  totalCount: number;
}

/**
 * Whether a `news` value is worth rendering at all.
 *
 * Deliberately shallow: it checks the two containers this renderer walks,
 * not every field of every player. A player missing `headline` renders as
 * "no news found", which is already the correct answer for it — dropping
 * the whole block over one soft field would lose fifteen good entries.
 */
export function isRenderableNews(value: unknown): value is NewsBlock {
  const news = value as NewsBlock | null;
  return (
    !!news &&
    Array.isArray(news.players) &&
    news.players.length > 0 &&
    !!news.groups &&
    typeof news.groups === 'object'
  );
}

/**
 * The news block regrouped for display: starters, then bench, then IR,
 * preserving roster order within each group.
 *
 * A group present in `groups` but with no players — the skipped case — is
 * kept rather than dropped, because "IR was empty this week" is a real
 * answer and rendering nothing would be indistinguishable from the group
 * having failed. A group in neither `groups` nor `players` is omitted.
 *
 * Any group key upstream adds later that this file doesn't know about is
 * appended after the three known ones rather than silently discarded.
 */
export function buildRosterNews(news: NewsBlock): RosterNews {
  const byGroup = new Map<string, NewsPlayer[]>();
  for (const player of news.players) {
    if (!player || typeof player !== 'object') continue;
    const key = typeof player.group === 'string' ? player.group : 'other';
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(player);
    else byGroup.set(key, [player]);
  }

  const keys = [
    ...GROUP_ORDER.filter((key) => byGroup.has(key) || key in news.groups),
    ...[...byGroup.keys(), ...Object.keys(news.groups)]
      .filter((key) => !GROUP_ORDER.includes(key as (typeof GROUP_ORDER)[number]))
      .filter((key, i, all) => all.indexOf(key) === i),
  ];

  const groups: RosterNewsGroup[] = keys.map((key) => {
    const players = byGroup.get(key) ?? [];
    const meta = news.groups[key] ?? {};
    return {
      key,
      label: GROUP_LABELS[key] ?? key,
      ask: GROUP_ASKS[key] ?? null,
      players,
      foundCount: players.filter((p) => p.found).length,
      totalCount: players.length,
      skipped: typeof meta.skipped === 'string' ? meta.skipped : null,
      grounded: typeof meta.grounded === 'boolean' ? meta.grounded : null,
      sourceCount: Array.isArray(meta.sources) ? meta.sources.length : 0,
    };
  });

  return {
    groups,
    foundCount: groups.reduce((n, g) => n + g.foundCount, 0),
    totalCount: groups.reduce((n, g) => n + g.totalCount, 0),
  };
}

/**
 * Which kind of nothing a `found: false` row is.
 *
 * Both causes null out `headline`/`detail`/`as_of` and add a `note`, but they
 * are opposite findings and upstream's whole reason for materialising skipped
 * players is to keep them apart:
 *
 *  - `searched-empty` — a search ran and found nothing. **A real finding**,
 *    and the normal state for a bench, which is asked only about change.
 *  - `not-covered` — the model returned no entry for this player at all. **A
 *    coverage gap**: nobody looked, so nothing was learned.
 *
 * Silence and "no news" must not render identically, which is exactly what
 * they did while both showed one shared "No news found" line.
 *
 * Matched on the note's stable substring rather than the full string, and
 * with an explicit `unknown` for anything else — a reworded note upstream
 * should degrade to a neutral treatment, never be asserted as one of the two.
 */
export type NoFindingKind = 'searched-empty' | 'not-covered' | 'unknown';

export function noFindingKind(player: NewsPlayer): NoFindingKind {
  const note = typeof player.note === 'string' ? player.note.toLowerCase() : '';
  if (note.includes('grounded search returned nothing')) return 'searched-empty';
  if (note.includes('returned no entry')) return 'not-covered';
  return 'unknown';
}

/**
 * The groups whose search never fired, by label — so the page can name them
 * instead of stating that "a group" was unsourced and leaving the reader to
 * guess which.
 *
 * Top-level `grounded: false` means at least one group in the block is
 * unsourced; the per-group flag is where the answer actually is. A skipped
 * group has no opinion and is not counted: it ran nothing, so it failed at
 * nothing.
 */
export function ungroundedGroups(news: RosterNews): RosterNewsGroup[] {
  return news.groups.filter((group) => !group.skipped && group.grounded === false);
}

/**
 * Every distinct source behind this block, deduped by URI.
 *
 * Attribution upstream is **group-level only** — `groundingSupports` exists
 * in the API response but isn't mapped into the envelope — so these are
 * shown as one list for the whole block. Rendering them per player would
 * imply an attribution the artifact does not carry.
 */
export function collectSources(news: NewsBlock): { uri: string; title: string; host: string }[] {
  const seen = new Map<string, { uri: string; title: string; host: string }>();
  for (const group of Object.values(news.groups ?? {})) {
    for (const source of group?.sources ?? []) {
      if (!source?.uri || seen.has(source.uri)) continue;
      seen.set(source.uri, {
        uri: source.uri,
        title: source.title || '',
        host: hostOf(source.uri),
      });
    }
  }
  return [...seen.values()];
}

/** The display host for a source link, falling back to the raw URI when it won't parse. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return uri;
  }
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * A player item's `as_of` date, `"2026-09-16"` -> `"16 Sep"`.
 *
 * Null in, null out — and that matters: upstream's rule 2 requires an
 * undated item leave `as_of` empty rather than default to today, so a
 * missing date is a deliberate signal that the date is unknown. Inventing
 * one here would undo that.
 */
export function formatAsOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, , month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (!name) return iso;
  return `${Number(day)} ${name}`;
}

/**
 * The news layer's own `generated_at`, which carries an ET offset exactly
 * like the summary's, so it formats through the same helper. It is a
 * separate timestamp on purpose: a news-only backfill moves this while the
 * summary's stays put, naming when each layer was actually written.
 */
export function formatNewsTimestamp(iso: string): string {
  return formatSummaryTimestamp(iso);
}

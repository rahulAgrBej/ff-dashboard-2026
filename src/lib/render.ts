import { marked, Renderer, type Tokens } from 'marked';
import { parseDateline, type Dateline } from './dateline';

export interface FreshnessEntry {
  feed: string;
  timestamp: string;
}

export interface RenderedReport {
  bodyHtml: string;
  freshness: FreshnessEntry[];
  cannotSeeHtml: string | null;
  dateline: Dateline | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * Recognizes the literal `insufficient data` sentinel as its own inline
 * token, so the match happens before HTML exists — an attribute value can
 * never be caught by it the way a post-render regex could catch one.
 */
const sentinelExtension = {
  name: 'insufficientData',
  level: 'inline' as const,
  start(src: string) {
    return src.match(/insufficient data/)?.index;
  },
  tokenizer(src: string) {
    const match = /^insufficient data/.exec(src);
    if (!match) return undefined;
    return { type: 'insufficientData', raw: match[0], text: match[0] };
  },
  renderer(token: { text: string }) {
    return `<span class="stale">${token.text}</span>`;
  },
};

marked.use({
  extensions: [sentinelExtension],
  renderer: {
    // Reports are ours, but escaping raw HTML at the token level costs one
    // line and removes the injection class without a sanitizer dependency.
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    heading(token: Tokens.Heading) {
      const inner = this.parser.parseInline(token.tokens);
      const id = slugify(token.text);
      return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
    },
    // A nine-column waiver table cannot fit the article's measure. Wrapping is
    // what lets the table keep `display: table` -- and therefore real column
    // distribution for the narrow tables -- while still scrolling when wide.
    table(token: Tokens.Table) {
      return `<div class="md-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
    },
  },
});

// `(?![\s\S])` is a true end-of-string assertion — plain `$` under the `/m`
// flag matches the end of *any* line, which truncated these captures to
// their first bullet.
const FRESHNESS_RE = /^##\s+Freshness\s*\n([\s\S]*?)\n*(?=\n##\s|(?![\s\S]))/m;
const CANNOT_SEE_RE = /^##\s+What this report cannot see\s*\n([\s\S]*?)\n*(?=\n##\s|(?![\s\S]))/m;
const FRESHNESS_LINE_RE = /^-\s*([\w.]+):\s*(.+)$/gm;
// Anchored to the very top of the body (right after the H1) — the pipeline
// always emits Covers/Week N/Rendered in this order, all three or none.
const DATELINE_BLOCK_RE = /^\n*\*\*Covers\*\*.*\n\*\*Week\s+\d+\*\*.*\n\*\*Rendered\*\*.*\n?/;

function parseFreshnessEntries(section: string): FreshnessEntry[] {
  const entries: FreshnessEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = FRESHNESS_LINE_RE.exec(section))) {
    entries.push({ feed: m[1], timestamp: m[2].trim() });
  }
  return entries;
}

/**
 * Four markdown-aware touches, each guarded so a report day that omits
 * the section simply renders normally:
 *  1. Lift the Covers/Week N/Rendered dateline out of the body.
 *  2. Lift `## Freshness` out of the body into a compact row.
 *  3. Mark the `insufficient data` sentinel (via the extension above).
 *  4. Set off `## What this report cannot see` as a closing callout.
 */
export function renderReport(markdown: string): RenderedReport {
  let body = markdown.replace(/^#\s+.+\n?/, '');

  let dateline: Dateline | null = null;
  const datelineMatch = DATELINE_BLOCK_RE.exec(body);
  if (datelineMatch) {
    dateline = parseDateline(datelineMatch[0]);
    body = body.slice(0, datelineMatch.index) + body.slice(datelineMatch.index + datelineMatch[0].length);
  }

  let freshness: FreshnessEntry[] = [];
  const freshnessMatch = FRESHNESS_RE.exec(body);
  if (freshnessMatch) {
    freshness = parseFreshnessEntries(freshnessMatch[1]);
    body = body.slice(0, freshnessMatch.index) + body.slice(freshnessMatch.index + freshnessMatch[0].length);
  }

  let cannotSeeHtml: string | null = null;
  const cannotSeeMatch = CANNOT_SEE_RE.exec(body);
  if (cannotSeeMatch) {
    cannotSeeHtml = marked.parse(cannotSeeMatch[1].trim(), { async: false }) as string;
    body = body.slice(0, cannotSeeMatch.index) + body.slice(cannotSeeMatch.index + cannotSeeMatch[0].length);
  }

  const bodyHtml = marked.parse(body.trim(), { async: false }) as string;

  return { bodyHtml, freshness, cannotSeeHtml, dateline };
}

/**
 * An AI summary envelope's `summary_markdown`, rendered with the same
 * `marked` configuration as the reports — so the token-level HTML escaping
 * above covers model output too, which is the one input here nobody in
 * this repo wrote.
 *
 * The upstream output contract (`espn_ff/ai/prompt.py`) asks for prose with
 * no heading and no table, but nothing enforces it, so this deliberately
 * runs the full parser rather than a prose-only subset: a summary that
 * breaks its contract should render imperfectly, never as raw markup.
 */
export function renderSummary(markdown: string): string {
  return marked.parse(markdown.trim(), { async: false }) as string;
}

/**
 * A report-JSON section's `body[]` lines, rendered as markdown.
 *
 * Runs on the **same** configured `marked` instance as the reports above, and
 * deliberately so: the token-level HTML escaping at `html()` and the
 * `insufficient data` sentinel extension both apply, so a structured section
 * gets exactly the treatment its markdown twin got. A second `marked`
 * configuration would drift from this one silently.
 *
 * Lines are joined rather than rendered one at a time because consecutive
 * bullet lines are a single list, and rendering each alone would emit a
 * separate one-item `<ul>` per bullet.
 */
export function renderProse(body: string[] | string): string {
  const text = Array.isArray(body) ? body.join('\n') : body;
  return marked.parse(text.trim(), { async: false }) as string;
}

/**
 * A single line of markdown with **no** block wrapper — for a table's
 * `notes[]` and a continuation block's italic aside, which are phrases inside
 * an existing element rather than paragraphs of their own.
 *
 * Notes keep the report's own phrasing verbatim (there the words *are* the
 * data), so the emphasis in them has to survive; `parseInline` keeps it
 * without wrapping the phrase in a `<p>` the caller would have to unwrap.
 */
export function renderInline(text: string): string {
  return marked.parseInline(text.trim(), { async: false }) as string;
}

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

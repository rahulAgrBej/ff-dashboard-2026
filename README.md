# Down to the Wire — reports

Read surface for the reports produced by [`espn-fantasy-football-sandbox`](https://github.com/rahulAgrBej/espn-fantasy-football-sandbox). Astro (SSR) on Cloudflare Workers, reading a private S3 bucket at request time — no build step or webhook needed to publish a new report.

## How it fits together

```
browser → Cloudflare Worker (Astro SSR)
            ├─ Cache API  (listing 300s / bodies immutable-by-etag)
            └─ aws4fetch SigV4 → s3://espn-ff-data-2026/{reports,reports-json,summaries}/**
```

One object per report under each of three prefixes, all sharing one
`<season>/week-NN/<stem>` path, so any one of them addresses the other two by
string swap with no lookup table:

| prefix | what it holds | completeness |
|---|---|---|
| `reports/` | the rendered markdown | complete |
| `reports-json/` | the same report as structured data | **starts mid-season** |
| `summaries/` | the AI summary envelope, carrying two independent layers | lags each report by hours; may never appear |

### Two read surfaces

**Daily (`/`, `/r/<season>/<week>/<slug>`)** is the homepage, and it reads
`reports-json/`. The envelope is a strict superset of the markdown beside it —
typed table rows, section kinds, a real `stale` boolean per feed, and the
counts the prose states only inside a sentence — so this surface needs none of
the markdown parsing below. Three things it can express that markdown could
not: `insufficient` as a state rather than a string sentinel, `null` as
distinct from zero in a table cell, and the week window as a raw value rather
than a display string.

**Markdown archive (`/archive`, `/archive/<season>/<week>/<slug>`)** is the
original pipeline, unchanged. It is not a fallback: `reports-json/` began
mid-season, upstream has no command to backfill it, and so the earliest
reports exist under `reports/` **alone**. Those are absent from the Daily
index by construction — its listing is the structured prefix's — and the
archive is the only place they can be read. Each archive report links into the
structured view only when a twin is actually in the listing, never on the key
swap alone, so the link can't lead to a 404.

Both surfaces key their URLs on `(season, week, slug)` and never on `stem`: a
stem embeds the filename date, and upstream re-running a report writes a new
date onto the same slot, so a stem-keyed URL would move under exactly the case
`dedupeRenders` exists to collapse. `/reports/**` 301s to `/archive/**` — the
identity behind those URLs is unchanged, so it is a pure path rewrite.

The upstream repo is never modified. The Worker reads
`reports/<season>/week-<NN>/<date>-<day>-<slug>.md` (and its
`reports-json/…​.json` twin) out of the bucket on every request, listing each
prefix once per 300s under its own cache key and caching each body forever
under a key that includes its S3 ETag — so a same-day re-run of a report
(which upstream explicitly tolerates) is served correctly with no purge logic
anywhere.

### Structured reports

`src/lib/reportJson.ts` types the envelope and loads it exactly as
`summaries.ts` loads a summary: list the prefix, look the key up in the map,
never throw. A report with no structured twin is a map miss rather than a 404
on every render. `schema_version` is a **set** of supported versions from the
outset — the same field was a scalar pinned to `1` in `summaries.ts` and
silently dropped every envelope the pipeline wrote after the news layer
shipped.

`src/lib/sections.ts` holds the display rules the contract is strict about:

- **Route on `id`, display `heading`.** Section ids are fixed strings. Two
  report types build their headings at render time — Saturday's `## Tier
  changes since <date>` and Thursday's `## Canonical usage -- week N` — so a
  consumer matching on heading text breaks on Saturday every day and on
  Thursday every week.
- **Switch on `kind`, never on presence.** Most ids can arrive as a `table`, a
  `prose`, a `blocks` *or* an `insufficient` for the same id, depending on
  whether the inputs were there.
- **`null` means "no reading", and it is never zero.** The markdown had three
  separate vocabularies for missing data (`insufficient data`, `--`, an em
  dash) and all three are `null` here. A bye week's `offense_pct` is null, not
  `0.0`; a count that could not be computed is null, never `0`. "No starters
  are out" and "we could not find out" are opposite answers, so a null cell
  renders as `no reading` in disabled grey and a real zero renders as a
  number.

Two digests are checked, and neither costs a request. The summary's
`report.sha256` is compared against the envelope's **embedded** `markdown` —
the same bytes the summariser hashed — so the staleness badge works on the
Daily surface with no markdown fetch at all. `markdown_sha256` is compared
against that same embedded copy, which is an internal-consistency check on one
object and deliberately **not** a claim that the `.md` in the bucket still
matches; verifying that would cost a second fetch and defeat the point of
reading the structured form.

Because `header` carries the covered range, the render time and the week
window, the Daily surface skips `attachDatelines` entirely — the markdown
surface's fan-out of up to 12 body fetches per request, which exists only
because the covered date lives inside each markdown body. One envelope's
`week_window` seeds `weekDateRange`, which extrapolates every other week in
the season from it, so one object labels the whole sidebar.

### AI summaries

Upstream also writes one Gemini-generated JSON envelope per report under `summaries/`, at the report's own key with `reports/` → `summaries/` and `.md` → `.json`. `src/lib/summaries.ts` derives that key by string swap — there is no lookup table — lists the prefix on the same 300s cycle, and renders `summary_markdown` in a card between the freshness row and the report body.

Three properties of that upstream design shape this side:

- **Absence is normal.** Summaries are produced by a separate workflow that trails each report by up to ~20 minutes and writes nothing when a generation fails. A report with no summary renders alone, with no placeholder — `loadSummary` returns `null` and never throws, so a missing, malformed, or future-schema envelope costs the page nothing.
- **Staleness is checked against the artifact, not the clock.** The envelope stores `report.sha256` over the report's full markdown. The Worker hashes the body it is about to render and marks the card stale on mismatch, so a summary describing an earlier render of the same key is labelled rather than silently trusted.
- **The summary is never part of the report.** It is not spliced into `markdown`, so `#dttw-raw` and Copy markdown stay byte-identical to the S3 object. The card is hidden in Markdown view and in print.

### Grounded roster news

The same envelope carries a **second, independent layer**. Every feed the reports are built from lags the real world by hours to days, and the summary layer is forbidden by its own house rules from supplying outside knowledge — so upstream added three Google-Search-grounded calls per report (starters / bench / IR) returning the latest news on every rostered player. The result is stored as a `news` field beside `summary_markdown`, never merged into it.

It shares the report's key, the `summaries/` prefix and the 300s listing, so **it costs no extra request and needs no IAM change** — `src/lib/news.ts` shapes a block that `loadSummary` has already fetched. The card renders directly below the report header, above everything else on the page.

The envelope is `schema_version: 2`; v1 carried the summary alone. The bump was strictly additive — every v1 key kept its name, position and meaning — so `src/lib/summaries.ts` accepts both and a v1 envelope simply has no news to show. A version beyond the supported set is still treated as absent rather than rendered on guessed field names.

Three upstream guarantees shape how this renders:

- **Every rostered player appears.** Upstream reconciles the model's answer against the roster it was given, materialising anyone the model skipped with `found: false` and a note. "We looked and found nothing" and "the model never answered" are different findings, and neither may render as a finding — so every player is shown, and only the visual weight differs.
- **`grounded: false` is the layer working, not failing.** It means the search tool never fired and those items came from model recall — roughly one call in four upstream. The card carries an alert badge and an explicit warning rather than hiding it, because it is the one failure nobody can detect by reading the text.
- **News is never a lineup call.** Its house rules forbid it, because the report beside it owns that decision and cannot see what the search found. Nothing in the card's copy frames news as advice.
- **`found: false` has two opposite causes, and they render differently.** A search that ran and returned nothing is **a real finding** — and the normal state for a bench, which is asked only about change. A player the model returned no entry for is **a coverage gap**: nobody looked, so nothing is known either way. `noFindingKind` in `src/lib/news.ts` keys on the note upstream attaches, with an `unknown` fallback so a reworded note degrades to a neutral treatment rather than being asserted as one of the two. The bench collapse folds only searched-and-empty rows for the same reason — folding a coverage gap under "no change reported" would state it as a quiet week.

The two layers fail independently upstream and degrade independently here: a dead grounded call stores `news: null` with a `news_error`, which renders as one muted line — distinct from "not generated yet", which stays silent — while the summary and report beside it render normally.

**Known gap:** Google's grounding terms ask that the Search Suggestions blob (`search_entry_point`) be displayed wherever grounded results are shown. It is stored in every envelope but not rendered — its Google-styled chips clash with this site's design. Honouring it later is a component-only change; the data is already there. The per-group `sources` **are** rendered, as a deduped host list. Attribution upstream is group-level only, so they are shown once for the whole block rather than per player.

`src/lib/schedule.ts` encodes the eight-report weekly schedule from `docs/report-weekly-schedule.md` so every week always renders all eight slots — published, pending (scheduled, still missing), or planned (not built upstream yet). Widen `IMPLEMENTED_DAYS` there as upstream ships the rest; it currently covers Monday through Thursday.

On the **daily** sidebar a slot with no structured twin but a real markdown report behind it renders as **markdown only**, linking into the archive, rather than as `pending` or `planned`. With the structured prefix starting mid-season, "upstream has not produced this" would be the wrong reading for most of a week, and it is a different fact from "produced, no structured twin" — the same distinction `noFindingKind` draws in the news layer. The archive sidebar is unaffected: its own listing is the complete one.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
```

Two ways to run it:

`fixtures/` stands in for the bucket, bundled at build time via Vite's glob
import — workerd has no filesystem, so fixtures can't be read with `node:fs`
at request time even in local dev.

**`fixtures/reports-json/**` is hand-authored** from the JSON handoff spec, and
each file says so in a `_fixture_note`. It is shaped to hit the states real
data will not reliably cover on any given week — a null and a real `0.0` in one
column, a freshness array missing `odds`, a `blocks` section with both a named
and a `heading: null` child, an `insufficient` section. Its `markdown` and
`markdown_sha256` **are** real: the markdown is the exact bytes of the `.md`
beside it and the digest is its true SHA-256, so the digest checks are
exercised rather than decorative. Replace these with real objects when
convenient. Note that `fixtures/reports/**` deliberately contains two reports
with **no** structured twin, which is what keeps the markdown-only path
covered.

**Against fixtures (no AWS access needed).** Edit `.dev.vars` and set `USE_FIXTURES=1`, then:

```sh
npm run dev
```

This serves `fixtures/reports/**` and `fixtures/summaries/**` — a synthetic 3-group tree exercising a Tuesday double-report, a re-rendered duplicate (same `(season, week, slug)`, newer `**Rendered**` timestamp, to exercise `dedupeRenders`), a deliberate gap (to see the `pending` state), and a cross-season sort — instead of calling S3. The summary fixtures cover every state of both layers. Summary: a matching `report.sha256` (fresh card), a deliberately wrong digest (stale marker), and reports with no envelope at all (no card). News: one grounded block with a mix of findings and honest blanks and an empty IR group (`skipped`), one ungrounded block (`grounded: false`, the unsourced warning), and one `news: null` with a `news_error` (the muted unavailable line).

Note: the waiver summary fixture is keyed to the **2026-09-16** render, not the 09-15 one beside it. `dedupeRenders` collapses that pair to the newer render, so a summary keyed to the older date is unreachable at every URL — a fixture keyed that way looks like a broken summary card rather than a stale fixture. It's the only way to exercise the index/sidebar/week-grouping logic today, since the real bucket holds a handful of reports.

Note: the fixture slug `waiver-wire-and-opening-market` has drifted from the bucket's `waiver-wire` — that's intentional, not a bug to fix; the two are free to diverge since fixtures only need to be internally consistent with each other.

Note: `USE_FIXTURES` must be set in `.dev.vars`, not as a shell env var prefix (`USE_FIXTURES=1 npm run dev` does *not* work) — the dev server runs on workerd via the wrangler platform proxy, which only sees vars wrangler loads from `.dev.vars`, not the host shell's environment.

**Against the real bucket.** Fill in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY_ID` in `.dev.vars` (see "AWS bootstrap" below to obtain them), leave `USE_FIXTURES` unset, then `npm run dev`. The Cloudflare adapter runs on workerd via the wrangler platform proxy, so the Cache API and secrets behave the same as in production.

Either way: `?nocache=1` on any URL bypasses the Cache API read for that request (and repopulates the cache with the fresh result — never a purge).

## AWS bootstrap (one-time, manual)

1. Confirm the bucket's region: `aws s3api get-bucket-location --bucket espn-ff-data-2026`.
2. Create an IAM user, e.g. `ff-dashboard-reader`, with an inline policy granting only:
   - `s3:GetObject` on `arn:aws:s3:::espn-ff-data-2026/reports/*`, `arn:aws:s3:::espn-ff-data-2026/reports-json/*` **and** `arn:aws:s3:::espn-ff-data-2026/summaries/*`
   - `s3:ListBucket` on `arn:aws:s3:::espn-ff-data-2026`, scoped with `Condition: { StringLike: { "s3:prefix": ["reports/*", "reports-json/*", "summaries/*"] } }`

   All three prefixes are required, and a too-narrow policy **degrades quietly rather than erroring** — which is exactly what makes it worth checking explicitly:

   - Without `summaries/*`, every report renders with no summary and no news card. `loadSummary` swallows the listing failure by design.
   - Without `reports-json/*`, the **homepage goes empty** while `/archive` keeps working, because the Daily surface's whole listing is that prefix. This one is easy to miss locally: fixtures make it pass under `USE_FIXTURES=1` and it only fails against the real bucket.

   This is read-only and prefix-scoped — it has no reach into the bucket's `state/`, `archive/`, or `logs/` prefixes. The bucket stays private; nothing here changes its Block Public Access settings.
3. Generate an access key for that user and put it in `.dev.vars` for local dev, and in Cloudflare (see Deploy) for production. **The key never goes in `wrangler.jsonc`, `.dev.vars.example`, or any commit** — `.dev.vars` is gitignored.

### Rotating the key

1. Create a second access key for `ff-dashboard-reader` (IAM allows two active keys per user).
2. `wrangler secret put AWS_ACCESS_KEY_ID` and `wrangler secret put AWS_SECRET_ACCESS_KEY_ID` with the new key's values.
3. Confirm the deployed Worker is healthy (`/` renders), then deactivate and delete the old key in IAM.

## Deploy

**Cloudflare Workers Builds** (recommended): connect this repo in the Cloudflare dashboard under Workers & Pages → your worker → Settings → Builds. A push to `main` builds and deploys automatically, and the AWS secret only ever lives in Cloudflare, never in this repo's CI.

Set the two secrets once, in the dashboard or via Wrangler:

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY_ID
```

`AWS_REGION` and `S3_BUCKET` are plain vars already set in `wrangler.jsonc`.

**Manual deploy:**

```sh
npm run build
npx wrangler deploy
```

## Troubleshooting

**The homepage is empty with `ListObjectsV2 failed for prefix "reports-json/": 403 Forbidden (AccessDenied)`.**
The reader's IAM policy does not grant that prefix. This is the failure the
bootstrap section warns about, and it happened once already: the policy was
created with `reports/*` and `summaries/*` before the structured prefix
existed, and **`reports-json/` does not match `reports/*`** — IAM's
`StringLike` reads that pattern as the literal characters `reports/` followed
by anything, and the real prefix has `reports-` at that position.

Both statements need widening. Granting only `ListBucket` moves the 403 from
the listing to the first `GetObject`. Diagnose it without guessing:

```sh
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<account>:user/ff-dashboard-reader \
  --action-names s3:ListBucket \
  --resource-arns arn:aws:s3:::espn-ff-data-2026 \
  --context-entries 'ContextKeyName=s3:prefix,ContextKeyValues=reports-json/,ContextKeyType=string' \
  --query 'EvaluationResults[0].EvalDecision' --output text
```

`implicitDeny` confirms it. Apply the policy from the bootstrap section above;
IAM is evaluated per request, so **no redeploy or purge is needed** — the 300s
listing TTL bounds how long the failure is still served, and `?nocache=1`
skips it.

Both `listObjects` and `getObject` name the prefix or key **and** S3's own
error code from the response body, and `S3Error.code` carries it so callers
can branch on the cause. `loadDailyPage` uses that to tell a denied prefix
(a configuration fix, with the archive still working) from an unreachable
bucket and from an honestly empty prefix. There is deliberately **no**
automatic fallback to rendering markdown at `/`: that would hide exactly this
misconfiguration.

## Verification checklist

- **Fixtures**: `USE_FIXTURES=1` in `.dev.vars`, then check ordering (newest report first), the sidebar's week grouping and date ranges, and all three slot states (published / pending / planned).
- **Real S3**: confirm `/` renders the live Monday report, `Freshness` is lifted into its own row, `insufficient data` renders in the alert color, and the closing "What this report cannot see" callout is set off from the body.
- **Caching**: `npx wrangler tail` while reloading — one `ListObjectsV2` per 300s, no repeat `GetObject` for an unchanged report; `?nocache=1` forces both.
- **Interactions**: toggle Rendered/Markdown (the raw view must match the source byte-for-byte), Copy markdown, Print, and that the view choice survives a reload.
- **AI summaries**: the card sits between the freshness row and the body; the waiver summary is on the waiver report and the week-in-review summary on its own (never swapped); the wrong-digest fixture shows the stale marker; a report with no envelope shows no card; and the card disappears in Markdown view and in print. Corrupting a summary fixture must leave the report rendering at HTTP 200 with no card.
- **Roster news**: the card sits directly below the report header, above the freshness row, the AI summary and the body. Every rostered player in the fixture appears — `found: false` players render as muted "No news found" lines, visibly distinct from real findings; the IR group shows its skip reason; the group counts read "N of M with news". The monday fixture (`grounded: false`) shows the alert badge, the alert-toned border and the unsourced warning; the waiver fixture does not. The week-in-review fixture shows the one-line "unavailable" note and still renders its summary card and body normally. The card disappears in Markdown view and in print.
- **News degradation**: setting a fixture's `news` to a string, or removing its `players` array, must leave the page at HTTP 200 with the summary and report intact and no news card. Bumping `schema_version` past the supported set must drop **both** cards and still render the report.
- **No extra cost**: `npx wrangler tail` while reloading — the news must add no `ListObjectsV2` and no `GetObject`, since it rides the envelope the summary card already fetched.

Note: `import.meta.glob` is eager, so **adding or removing a fixture file needs a dev-server restart**, and the 300s listing cache survives that restart — use `?nocache=1` after changing which fixture keys exist, or the listing will still describe the old set.
- **Surface separation**: `/` and `/r/**` list only reports with a structured twin; the two fixtures without one are absent there and present in `/archive`. `/r/2026/1/availability-watchlist` must 404 with a pointer at the archive, and `/archive/2026/1/availability-watchlist` must render *without* the "Open the structured view" button. `/reports/**` must 301 to `/archive/**`.
- **Structured rendering**: in the settlements table, the null bid/projection row must read `no reading` in grey and the `0.0` row must read `0` — same column, visibly different. Check the `insufficient` section renders as its own dashed state, the `blocks` section shows one named child and one unlabelled continuation, the freshness strip shows three feeds with `nflverse` stale, and the null `data` chip reads `no reading` rather than being dropped.
- **Layer states**: the waiver report has grounded news (per-group badges, one `Not covered` row that is never folded into the bench collapse); the Monday report is ungrounded on all three groups (an alert naming all three, plus three `Ungrounded` badges); the week-in-review has `news_error` (one muted line) and a stale summary (a negative alert plus a `Digest mismatch` badge).
- **View preference does not leak**: set Markdown view on an archive report, then load `/`. Sections 01 and 02 must still be visible — the mode is mirrored onto `<html>` and `global.css` uses it to hide those cards, so the daily view must ignore the stored value.
- **Failure path**: an invalid/missing AWS secret renders a clean empty state, never a 500.
- **Responsive**: check both the desktop (topbar, two-column layout) and mobile (compact header, bottom tabs, no view toggle) layouts.

## Project structure

```
src/
├── lib/           s3.ts, reports.ts, reportJson.ts, summaries.ts, news.ts,
│                  sections.ts, schedule.ts, cache.ts, render.ts, page.ts, env.ts
├── layouts/       Shell.astro
├── components/    Topbar, ReportHeader, FreshnessRow, AiSummary, RosterNews,
│                  NewsUnavailable, ReportArticle, ReportIndex, NextReportNote,
│                  MobileTabs, EmptyState, ui/*
│   └── report/    DailyView, DailyHeader, DailyAside, StructuredReport,
│                  ReportSections, ReportSection, SectionTable, SectionProse,
│                  SectionList, SectionInsufficient, SectionHeader,
│                  FreshnessStrip, DataChips
├── styles/        tokens.css, global.css, print.css
└── pages/         index.astro, r/[season]/[week]/[slug].astro,
                   archive/index.astro, archive/[season]/[week]/[slug].astro
```

`src/lib/s3.ts`, `src/lib/reports.ts`, `src/lib/reportJson.ts`, and `src/lib/summaries.ts` are the only files that know what a bucket, key, or signature is (`src/lib/news.ts` and `src/lib/sections.ts` are pure shaping over an envelope already fetched) — pages and components work entirely in terms of `ReportMeta`, envelopes, and rendered HTML.

`src/lib/page.ts` assembles everything a page needs, so each `.astro` route is markup. Before it existed the four routes carried ~95% duplicated frontmatter.

`src/components/report/ReportSection.astro` self-imports: a `blocks` section's children are themselves sections, so the dispatcher is the thing that recurses. `MAX_BLOCK_DEPTH` bounds it, and a section past the cap renders its children flat rather than being dropped — upstream only nests one level, so hitting the cap means the envelope changed, and losing content is worse than losing hierarchy.

## Out of scope

Charts, R2, auth, dark mode, search, RSS, multi-league support, a settings page. (JSON ingestion is in scope only for the `reports-json/` and `summaries/` envelopes described above — all three layers they carry — and no other JSON is read.)

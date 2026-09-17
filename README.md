# Down to the Wire — reports

Read surface for the reports produced by [`espn-fantasy-football-sandbox`](https://github.com/rahulAgrBej/espn-fantasy-football-sandbox). Astro (SSR) on Cloudflare Workers, fetching Markdown reports from a private S3 bucket at request time — no build step or webhook needed to publish a new report.

## How it fits together

```
browser → Cloudflare Worker (Astro SSR)
            ├─ Cache API  (listing 300s / bodies immutable-by-etag)
            └─ aws4fetch SigV4 → s3://espn-ff-data-2026/{reports,summaries}/**
```

One object per report under each prefix. The `summaries/` envelope carries two independent AI layers — the summary, and the grounded roster news — at one key.

The upstream repo is never modified. The Worker reads `reports/<season>/week-<NN>/<date>-<day>-<slug>.md` out of the bucket on every request, listing once per 300s and caching each rendered report body forever under a key that includes its S3 ETag — so a same-day re-run of a report (which upstream explicitly tolerates) is served correctly with no purge logic anywhere.

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

The two layers fail independently upstream and degrade independently here: a dead grounded call stores `news: null` with a `news_error`, which renders as one muted line — distinct from "not generated yet", which stays silent — while the summary and report beside it render normally.

**Known gap:** Google's grounding terms ask that the Search Suggestions blob (`search_entry_point`) be displayed wherever grounded results are shown. It is stored in every envelope but not rendered — its Google-styled chips clash with this site's design. Honouring it later is a component-only change; the data is already there. The per-group `sources` **are** rendered, as a deduped host list. Attribution upstream is group-level only, so they are shown once for the whole block rather than per player.

`src/lib/schedule.ts` encodes the eight-report weekly schedule from `docs/report-weekly-schedule.md` so every week always renders all eight slots — published, pending (scheduled, still missing), or planned (not built upstream yet) — even though only Monday's report is implemented today. Widen `IMPLEMENTED_DAYS` there as upstream ships the rest.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
```

Two ways to run it:

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
   - `s3:GetObject` on `arn:aws:s3:::espn-ff-data-2026/reports/*` **and** `arn:aws:s3:::espn-ff-data-2026/summaries/*`
   - `s3:ListBucket` on `arn:aws:s3:::espn-ff-data-2026`, scoped with `Condition: { StringLike: { "s3:prefix": ["reports/*", "summaries/*"] } }`

   `summaries/*` is required for the AI summary cards. A key that predates them can still read reports: the summary listing fails, `loadSummary` swallows it, and every report renders without a card — so a too-narrow policy degrades quietly rather than erroring, and is worth checking explicitly if no card ever appears.

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
- **Failure path**: an invalid/missing AWS secret renders a clean empty state, never a 500.
- **Responsive**: check both the desktop (topbar, two-column layout) and mobile (compact header, bottom tabs, no view toggle) layouts.

## Project structure

```
src/
├── lib/           s3.ts, reports.ts, summaries.ts, news.ts, schedule.ts, cache.ts, render.ts, env.ts
├── layouts/       Shell.astro
├── components/    Topbar, ReportHeader, FreshnessRow, AiSummary, RosterNews,
│                  NewsUnavailable, ReportArticle, ReportIndex, NextReportNote,
│                  MobileTabs, EmptyState, ui/*
├── styles/        tokens.css, global.css, print.css
└── pages/         index.astro, reports/index.astro, reports/[season]/[week]/[slug].astro
```

`src/lib/s3.ts`, `src/lib/reports.ts`, and `src/lib/summaries.ts` are the only files that know what a bucket, key, or signature is (`src/lib/news.ts` is pure shaping over an envelope already fetched) — pages and components work entirely in terms of `ReportMeta` and rendered HTML.

## Out of scope

Charts, R2, auth, dark mode, search, RSS, multi-league support, a settings page. (JSON ingestion is in scope only for the `summaries/` envelopes described above — both layers they carry — and no other JSON is read.)

# Down to the Wire — reports

Read surface for the reports produced by [`espn-fantasy-football-sandbox`](https://github.com/rahulAgrBej/espn-fantasy-football-sandbox). Astro (SSR) on Cloudflare Workers, fetching Markdown reports from a private S3 bucket at request time — no build step or webhook needed to publish a new report.

## How it fits together

```
browser → Cloudflare Worker (Astro SSR)
            ├─ Cache API  (listing 300s / bodies immutable-by-etag)
            └─ aws4fetch SigV4 → s3://espn-ff-data-2026/reports/**
```

The upstream repo is never modified. The Worker reads `reports/<season>/week-<NN>/<date>-<day>-<slug>.md` out of the bucket on every request, listing once per 300s and caching each rendered report body forever under a key that includes its S3 ETag — so a same-day re-run of a report (which upstream explicitly tolerates) is served correctly with no purge logic anywhere.

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

This serves `fixtures/reports/**` — a synthetic 3-group tree exercising a Tuesday double-report, a deliberate gap (to see the `pending` state), and a cross-season sort — instead of calling S3. It's the only way to exercise the index/sidebar/week-grouping logic today, since the real bucket holds exactly one report.

Note: `USE_FIXTURES` must be set in `.dev.vars`, not as a shell env var prefix (`USE_FIXTURES=1 npm run dev` does *not* work) — the dev server runs on workerd via the wrangler platform proxy, which only sees vars wrangler loads from `.dev.vars`, not the host shell's environment.

**Against the real bucket.** Fill in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.dev.vars` (see "AWS bootstrap" below to obtain them), leave `USE_FIXTURES` unset, then `npm run dev`. The Cloudflare adapter runs on workerd via the wrangler platform proxy, so the Cache API and secrets behave the same as in production.

Either way: `?nocache=1` on any URL bypasses the Cache API read for that request (and repopulates the cache with the fresh result — never a purge).

## AWS bootstrap (one-time, manual)

1. Confirm the bucket's region: `aws s3api get-bucket-location --bucket espn-ff-data-2026`.
2. Create an IAM user, e.g. `ff-dashboard-reader`, with an inline policy granting only:
   - `s3:GetObject` on `arn:aws:s3:::espn-ff-data-2026/reports/*`
   - `s3:ListBucket` on `arn:aws:s3:::espn-ff-data-2026`, scoped with `Condition: { StringLike: { "s3:prefix": "reports/*" } }`

   This is read-only and prefix-scoped — it has no reach into the bucket's `state/`, `archive/`, or `logs/` prefixes. The bucket stays private; nothing here changes its Block Public Access settings.
3. Generate an access key for that user and put it in `.dev.vars` for local dev, and in Cloudflare (see Deploy) for production. **The key never goes in `wrangler.jsonc`, `.dev.vars.example`, or any commit** — `.dev.vars` is gitignored.

### Rotating the key

1. Create a second access key for `ff-dashboard-reader` (IAM allows two active keys per user).
2. `wrangler secret put AWS_ACCESS_KEY_ID` and `wrangler secret put AWS_SECRET_ACCESS_KEY` with the new key's values.
3. Confirm the deployed Worker is healthy (`/` renders), then deactivate and delete the old key in IAM.

## Deploy

**Cloudflare Workers Builds** (recommended): connect this repo in the Cloudflare dashboard under Workers & Pages → your worker → Settings → Builds. A push to `main` builds and deploys automatically, and the AWS secret only ever lives in Cloudflare, never in this repo's CI.

Set the two secrets once, in the dashboard or via Wrangler:

```sh
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
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
- **Failure path**: an invalid/missing AWS secret renders a clean empty state, never a 500.
- **Responsive**: check both the desktop (topbar, two-column layout) and mobile (compact header, bottom tabs, no view toggle) layouts.

## Project structure

```
src/
├── lib/           s3.ts, reports.ts, schedule.ts, cache.ts, render.ts, env.ts
├── layouts/       Shell.astro
├── components/    Topbar, ReportHeader, FreshnessRow, ReportArticle, ReportIndex,
│                  NextReportNote, MobileTabs, EmptyState, ui/*
├── styles/        tokens.css, global.css, print.css
└── pages/         index.astro, reports/index.astro, reports/[season]/[week]/[slug].astro
```

`src/lib/s3.ts` and `src/lib/reports.ts` are the only files that know what a bucket, key, or signature is — pages and components work entirely in terms of `ReportMeta` and rendered HTML.

## Out of scope

JSON ingestion, charts, R2, auth, dark mode, search, RSS, multi-league support, a settings page.

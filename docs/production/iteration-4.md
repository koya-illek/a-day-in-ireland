# Production Iteration 4 Plan (2026-08-22)

Branch: `production/iteration-4` (from `ox-round3-baseline`, commit `4c39d48`). Scope: fresh-eyes review after rounds 1–3, focused on verified defects rather than style churn. Every item below was reproduced in source (and, for the light-theme items, numerically and in the running build) before being planned.

## Baseline established

- `npm test`: 154/154 pass.
- `npx playwright test`: 154 passed, 22 skipped, 2 failed. Both failures (`boot refresh uses canonical weather stations…`, `connection state settles truthfully…`, mobile project) pass consistently in isolation; same parallel-load flakiness the round-3 log recorded. Not treated as a regression.
- Live check of https://day.illek.ie (read-only): all six API endpoints healthy with correct method boundaries, cache tiers and validation. **The deployed Worker predates the round-1 fixes**: served pages carry `lang="en"` (round 1 set `en-IE`), unknown paths return an empty-body 404 instead of the branded page, and `/privacy` lacks the round-3 theme-storage disclosure. The branch is ahead of production; deployment is outside this iteration's remit and is recorded as the top release blocker.

## Confirmed findings and intended changes

### A. Reliability and correctness

**A1. No React error boundary exists anywhere (high).**
`app/` has no `error.tsx`/`global-error.tsx`; one render throw (for example from a malformed stored history snapshot reaching numeric formatting such as `item.level.toFixed(2)`) unmounts the entire root: map, dialogs, footer, everything.
Change: add `app/error.tsx` and `app/global-error.tsx` matching the info-page design language, each with an honest message and a reset control.

**A2. Transit enrichment can roll back fresher vehicle positions (medium).**
`components/IrelandExperience.tsx` (enrichment effect) captures `liveSnapshotRef.current.transit` before awaiting `enrichTransitDestinations`. If the 65 s transit poll commits a newer array while the manifest fetch is in flight, the queued updater compares only destination fields, sees a difference, and commits the stale captured array — map shows one-poll-old positions labelled live until the next poll.
Change: apply resolved destinations onto the *current* snapshot array by trip id inside the updater instead of committing the captured array. Extract the merge into an exported helper `applyTransitDestinations` in `lib/browser-live.ts` so it is unit-testable; loop guard semantics preserved (unresolved trips still do not loop).

**A3. National forecast is discarded whenever warnings are not exactly "live" (medium).**
`lib/browser-live.ts:707-709`: `forecastStatus = warningStatus === "live" ? statusFor(...) : "unavailable"`. Warnings and forecast are independent upstreams server-side with independent status state; any warnings degradation (partial/stale/fallback) throws away an already-validated forecast and mislabels provenance.
Change: `const forecastStatus = statusFor("forecast", Boolean(incomingForecast), true);`. Regression test: payload with `warningsStatus: "partial"` plus a valid forecast keeps forecast live.

**A4. One missed maintenance tick permanently loses an hourly rollup and leaks raw rows past retention (medium).**
`platform/history.js maintainHistory` rolls up only the single hour preceding the tick, and only when `getUTCMinutes() === 15`. A failed/late/skipped tick means that hour never gets an hourly row; `pruneHistory` refuses to delete expired raw rows without a complete covering hourly row, so those rows survive indefinitely. The daily rollup has the same single-shot shape at Dublin midnight.
Change: make maintenance self-healing within a bounded window — each maintenance tick re-rolls incomplete or missing hourly buckets that still have raw rows within the last 48 h (idempotent via `replace: true`), and ensures the previous Dublin day has a complete daily row on every tick rather than only at midnight. Tests simulate a missed tick and assert repair.

**A5. Tapping the history scrubber without moving it closes dialogs and refetches the same instant (low-medium).**
`HistoryControls.submitScrubber` fires on plain pointer-up; after each load completes the dedupe ref resets to null, so a valueless tap re-requests the currently displayed time while `loadHistoryAt` unconditionally clears selection, comparison, radar playback and timeline selection.
Change: skip submission when the scrubber value equals the committed selection seconds.

### B. Accessibility

**B1. FreshnessStrip re-announces the entire strip about once a minute (medium).**
The container is `role="status"` (implicit polite + atomic) while chip text ("checked HH:MM", "observed N minutes ago") mutates every minute — the same storm class round 2 fixed in the topbar but missed here.
Change: container becomes a plain labelled region; a narrow polite live region wraps only the connection-state words; volatile ages/timestamps stay static text.

**B2. Keyboard focus drops to `<body>` when the focused marker's id leaves the set (medium).**
The restore effect returns early when the remembered id is gone (layer toggle, preset switch, data expiry). React removes the focused element; nothing refocuses; keyboard users restart from the top of the page.
Change: when the old id is gone and its element is disconnected, move focus to the first surviving marker, else the map container, and clear the memory.

### C. Light theme readability sweep three (WCAG 1.4.3 failures)

Verified numerically against computed light surfaces (card `#fefefb`, red strip `#ab8d83`). Prior sweeps converted container surfaces but missed pale text literals inside them:

| Element | Literal | Measured | Fix |
| --- | --- | --- | --- |
| `.place-picker h2` | `#f0ffff` | 1.02:1 | `var(--ink)` |
| `.warning-strip.red` headline | `#fff6ec` | 2.86:1 | readable light strip surface, headline `#5d2018` (4.1:1) |
| `.warning-actions a/summary` | `#dffef3` | 2.85:1 | `#223041` (4.4:1) |
| `.history-picker label`, `.history-scrubber`, `.history-ambiguity label` | `#dffef3` | 1.06:1 | `#263d35` |
| `.history-period-summary dd` | `#dffef3` | 1.06:1 | `#223041` |
| `.timeline-data-list > summary` | `#dffef3` | 1.06:1 | `#263d35` |
| guidance statuses relevant/limited/no-signal/live/connecting | `#ff9194`/`#c4b9ff`/`#65cbff` | 1.77–2.14:1 | `#8b392a` / `#34527a` (≥7.6:1) |
| `.place-limits` (both variants) | `#b7c8dd` | 1.69:1 | `var(--muted)` (6.1:1) |
| `footer nav a` (+hover `white`) | `#8cecdf` | 1.37:1 | `var(--green)` / dark hover |
| `.detail-emblem.warning` | `#ff9194` | 2.14:1 (large glyph, fails even 3:1) | `var(--warning-strong)` |

Refuted during verification: `.info-introduction` was suspected invisible in light mode but a later base rule sets it to `var(--muted)`; `.pulse-card.trains > span` was suspected but two later rules give it `var(--movement-accent)`, which is already remapped. No change needed for either.

### D. SEO and share metadata

**D1. Info pages share without an image and with wrong Twitter copy (medium).**
`/about`, `/data`, `/privacy`, `/contact` define their own `openGraph` object which replaces the root one wholesale, dropping `og:image`; their Twitter tags fall back to homepage title/description.
Change: shared metadata helper that composes per-page title/description/canonical with the common image and Twitter fields.

**D2. 404 page emits duplicate robots meta and claims the homepage canonical (low).**
`out/404.html` has two robots tags and `<link rel="canonical" href="https://day.illek.ie/">`.
Change: `alternates: { canonical: null }` in `not-found.tsx`.

### E. UX polish (small, evidence-backed)

**E1. Share button double announcement:** accessible name swaps to "Share link copied" while a nested `role="status"` announces the same sentence. Keep one channel (stable label + the live region).
**E2. ExplorePanel heading says "Live layers" in historical mode** while the dialog labels itself "historical". Make the heading time-aware.
**E3. Dead CSS traps:** `.context-actions`, `.map-custom-view`, `.hero-copy` blocks are referenced by no component and contain hover states that would fail contrast if ever revived. Delete them.

## Files expected to change

`app/globals.css`, `app/error.tsx` (new), `app/global-error.tsx` (new), `app/not-found.tsx`, `app/about/page.tsx`, `app/contact/page.tsx`, `app/data/page.tsx`, `app/privacy/page.tsx`, new shared metadata module, `components/IrelandExperience.tsx`, `components/FreshnessStrip.tsx`, `components/HistoryControls.tsx`, `components/ExplorePanel.tsx`, `lib/browser-live.ts`, `platform/history.js`, `tests/*` (new regression coverage), `docs/production/iteration-4.md`.

## User impact

Light-theme users regain readable place names, official warning headlines/actions, history controls and statuses. Keyboard users keep their place when markers change. Screen-reader users stop hearing the freshness strip every minute. Everyone gets fewer dead-page outcomes (error boundary), fresher transit positions during enrichment, and a national forecast that survives unrelated warnings degradation. History survives missed cron ticks without permanent holes or unbounded retention.

## Risk

CSS changes are additive overrides following the existing light-block patterns; verified by computed-style assertions. Behavioural changes (A2–A5, B1–B2) are guarded by new unit/e2e tests. The error boundary is additive. Maintenance backfill touches the D1 pipeline but only through the existing idempotent `rollupPeriod`; tests cover repair and no-op paths. No security posture changes; no dependency changes anticipated.

## Verification

`npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:budgets`, full `npx playwright test`, axe specs at desktop and narrow widths, computed-color assertions for every remapped literal, manual keyboard/theme/responsive passes at 390/768/1440 CSS pixels, `scripts/audit-html.mjs` on affected canonical pages.

## Explicit non-goals (carried skips, with reasons)

- Split the 642 KB main chunk / trim prerendered SVG: structural refactor needing measured budget work (skipped rounds 1–3).
- Hash-based CSP inline allowances: requires build-integrated header generation; flight-data scripts vary per page per build, and half-measures risk breaking script execution on the live site.
- Rebuild transit dictionary from pinned GTFS archive: external artifact work, tracked since the original review.
- Extract shared worker dispatch module: cross-cutting entrypoint refactor; concrete divergences already fixed directly.
- `resolveHistory` aggregate-query optimization: needs real-D1 latency measurement (prior skip stands).
- Print styles, cross-tab theme sync, "(opens in a new tab)" announcements: marginal value, prior skips stand.
- Production deployment of the branch: not permitted in this iteration; recorded as the primary release blocker.

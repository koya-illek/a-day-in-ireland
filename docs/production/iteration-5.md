# Production Iteration 5 Plan (2026-08-22)

Branch: `production/iteration-5` (identical to `production/iteration-4`, commit `a341a96`). Scope: fresh-eyes review after iteration 4, restricted to defects reproduced in source or by executable reproduction against the repo's own modules. No style churn; every item below cites the mechanism.

## Baseline established

- `npm test`: all pass. `npx tsc --noEmit`: clean. `npm run lint`: clean.
- Live check of https://day.illek.ie (read-only): homepage, `/api/health`, `/api/living`, `/api/contexts` (with `x-robots-tag`), `/api/transit`, `/api/history/range` (1,638 raw snapshots through 2026-08-23T02:00Z) all healthy. **The deployed Worker still predates round 1**: unknown paths return a bare 0-byte 404 instead of the branded page, and `/api/living` lacks CORS headers the branch has shipped since round 2. Deployment remains outside this iteration's remit and stays the top release blocker.
- Two deep source sweeps (client layer; worker/history/platform layer) plus manual verification of every candidate. Four candidate findings were refuted during verification and dropped (see non-goals).

## Confirmed findings and intended changes

### A. Data honesty and correctness

**A1. A lifted EPA bathing advisory keeps rendering as current for up to 48 hours (medium).**
`lib/browser-live.ts` `mergeBathingAlerts` re-adds every retained alert id absent from the incoming payload regardless of incoming status. When the EPA feed answers live with an empty list (all-clear — a state the server explicitly pins as `bathing: "live"` in `tests/data-trust.test.mjs:1439`), the client resurrects all cached alerts until their `expiresAt`. For a safety-adjacent signal this is exactly the "cached data presented as current" mislabel the codebase guards against elsewhere. The anti-flap merge only makes sense when the payload is degraded.
Change: trust the incoming list wholesale when status is `live`; keep the retained-id merge-back for `partial`/`stale`/`fallback` tiers where an incomplete provider list is plausible. Unit tests pin: live-empty drops retained alerts; partial keeps them; newer-`updatedAt` swaps preserved.

**A2. River gauge dedupe collapses distinct stations sharing a coarse spatial cell (high — silent data loss).**
`platform/river-source.js` `deduplicate` keys readings by `${round(lon*4)}:${round(lat*5)}` (~16×22 km cells at Irish latitudes) keeping the newest `observedAt`. Two distinct gauges ~1.3 km apart (e.g. adjacent Dodder/Liffey gauges) collapse into one row; the survivor is arbitrary by timestamp. Reproduced with the repo's own function. Every downstream consumer under-reports: map markers, `summary.riverStations`, coordinator snapshots, history captures. Readings already carry validated unique station ids (`normalizeRiverReadings` rejects empty ids), so identity-based dedupe is exact.
Change: dedupe by reading `id`, newest wins per id. Unit tests pin: two nearby stations both survive; a duplicated id keeps the newer observation.

**A3. Partially-collected hours leak rows forever, violating retention promises (medium).**
Two interacting leaks, reproduced end-to-end against the real migration schema:
1. Raw rows are pruned only under a *complete* covering hourly row (`collected_samples >= expected_samples`). An outage hour (say 2-of-4 samples) can never become complete — repairs re-roll from surviving raws only — so its raw rows survive past the 30-day raw retention indefinitely.
2. Hourly rows are pruned only when the covering daily row's `collected_at_ms >= hourly.collected_at_ms`. Iteration-4 repairs keep bumping an incomplete hour's `collected_at_ms` on each tick within their 48 h lookback, which outlives the Dublin-midnight daily rollup; the comparison permanently inverts, so the incomplete hourly row also survives past its 365-day retention.
Change (`platform/history-store.js` `pruneHistory`, with the repair lookback shared as one exported constant):
- Raw rows past their retention window are deleted unconditionally. Safety argument: raw retention (30 d) is far beyond the 48 h repair reach, so no future aggregation can ever read them; eligibility rules already stop serving raw data at that age; complete hours already accept exactly this compaction (hourly keeps one representative). Keeping outage-hour raws "just in case" contradicts the documented retention contract while preserving nothing durable.
- Hourly rows past their retention window are deleted once they are outside the 48 h repair-mutation window AND a complete covering daily row exists — replacing the inverted timestamp comparison with a real stability guarantee. Tests simulate the outage-hour lifecycle end-to-end (capture → repair → prune at +400 days) asserting nothing leaks, and assert recent incomplete hours are not pruned early.

**A4. Background contexts poll yanks the radar frame slider back to the newest frame (low-medium).**
Every 5-minute `updateCurrentContexts` commit ends with `setRadarFrameIndex(last)` even when the user parked on an older frame with replay paused — background churn overriding explicit selection, the same class as the iteration-4 scrubber fix. Frames carry stable `observedAt` stamps.
Change: capture the selected frame's instant before committing; afterwards restore the index by matching that instant in the refreshed frame set, falling back to the newest frame only when it no longer exists. Selection logic extracted as a pure exported helper and unit-tested; playing state unaffected.

**A5. Unknown `/api/*` paths crash the alternate adapter or soft-200 through SPA fallback (low, dev/alternate adapter).**
`platform/server-entry.js` `API_PATHS` omits the history paths and has no unknown-API branch: GET `/api/history` falls into `env.ASSETS.fetch`, throwing without a binding or returning HTML 200 with one. Production dispatches these paths directly and is unaffected, but the adapter contradicts its own JSON-only API surface.
Change: answer unmatched `/api/*` paths with a JSON 404 (CORS + no-store + noindex) before asset fallthrough. Test pins the response.

### B. Reliability and error contract

**B1. `/api/transit` and `/api/contexts` failures escape as bare Cloudflare 1101 HTML (low-medium).**
Iteration 3 wrapped `/api/history` and `/api/living`; the comment at `cloudflare-entry.js:407-408` promises that contract for storage/coordinator failures generally. But `/api/transit` awaits the coordinator unwrapped and `/api/contexts` awaits `apiWorker.fetch` unwrapped, so a transient Durable-Object storage fault rejects to the runtime error page without CORS/noindex/no-store. The twin adapter wraps both paths.
Change: same try/catch → `apiErrorResponse(...)` shape as the wrapped paths. Test drives the exported worker fetch with a rejecting coordinator stub and asserts JSON 503 + headers.

### C. Accessibility

**C1. Keyboard focus falls to `<body>` when an open detail card auto-closes because its marker vanished (medium).**
Trace: activating a marker focuses the card's close button; the document `focusin` listener clears the focused-marker memory because the button is not inside `[data-map-marker]`; the next poll drops the item; the invalidation effect clears the selection; the card's cleanup restores opener focus only `if (previouslyFocused.isConnected)` — the marker element was removed in the same commit; the parent parking effect early-returns on the cleared memory. Trains/transit churn on 30–65 s polls makes this the most common dialog flow. Iteration 4 fixed the sibling case (focus directly on a vanishing marker), not the modal path.
Change: `DetailCard` gains an optional focus-restoration callback invoked when the remembered opener is gone; the experience root parks keyboard users on the first surviving map marker (same policy as the iteration-4 fix), deferred past the commit so the modal/inert teardown has settled. E2E test: open a fixture train detail, expire it from the feed, assert focus lands on a `[data-map-marker]` rather than `<body>`.

**C2. Lone heading-order skip: `<h4>` directly under `<h2>` (low).**
The history daily-summary block renders `<h4 id="history-period-summary-heading">` inside the section headed by `<h2 id="history-controls-heading">` with no intervening level — the only skip in the outline (WCAG 1.3.1).
Change: promote to `<h3>`; update the `.history-period-summary h4` selector.

### D. Subtractive cleanup

**D1. Dead hidden decorations inside pulse-card buttons (low).**
`.pulse-card .signal-bars/-line/-wave { display:none }` outranks the styling rules that follow, so the three decorative elements rendered inside pulse-card buttons are permanently invisible — dead DOM (including seven generated `<i>` nodes) and ~45 lines of unreachable CSS. The line/wave variants are also `<div>` children of `<button>`, a content-model violation.
Change: delete the three elements and the orphaned CSS blocks. Fix by subtraction; no replacement styling.

## Files expected to change

`lib/browser-live.ts`, `components/IrelandExperience.tsx`, `components/MapPanels.tsx`, `components/HistoryControls.tsx`, `app/globals.css`, `platform/river-source.js`, `platform/history-store.js`, `platform/history.js` (constant move only), `platform/cloudflare-entry.js`, `platform/server-entry.js`, `tests/*` (new regression coverage), `docs/production/iteration-5.md`.

## User impact

Lifted bathing advisories disappear from maps and guidance as soon as the provider says so instead of lingering up to two days. Dense river networks show every gauge again, on the live map and in stored history counts. Retention promises hold: outage hours stop accumulating immortal rows. Keyboard users are no longer dumped to the page top when a vehicle or train they were inspecting expires. Parked radar frames stay put across background refreshes. Screen-reader heading navigation is sequential; the DOM sheds invisible decoration.

## Risk

Behavioural changes are guarded by new unit/e2e tests; the pruning change touches the D1 pipeline but only DELETE predicates whose safety argument (retention ≫ repair reach) is pinned by simulation tests using the repo's schema helper. The river dedupe change strictly increases reported stations; consumers already handle arbitrary counts. CSS/markup deletions target provably invisible nodes. No dependency changes; no security-posture changes; CSP, headers, and cache tiers untouched.

## Verification

`npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run check:budgets`, full `npx playwright test`, axe specs at desktop and narrow widths, `scripts/audit-html.mjs` equivalent checks on affected canonical pages if present, manual keyboard/theme/responsive passes at 390/768/1440 CSS pixels, live-site read-only re-check.

## Explicit non-goals (carried skips and refuted candidates)

- Splitting the 642 KB main chunk / trimming prerendered SVG: structural refactor needing measured budget work (skipped rounds 1–4).
- Hash-based CSP inline allowances: requires build-integrated header generation (skipped rounds 1–4).
- Rebuilding the transit dictionary from a pinned GTFS archive: external artifact work, tracked since the original review.
- Extracting a shared worker dispatch module: cross-cutting entrypoint refactor; concrete divergences continue to be fixed directly.
- `resolveHistory` aggregate-query optimization: needs real-D1 latency measurement (prior skip stands).
- HSTS/nosniff on Worker JSON responses: hardening nit touching every response path; not worth the churn this round.
- Stale-river labelling inside history captures and `mergeSourceStatus` counting cosmetics: verified deliberate/cosmetic.
- Refuted during investigation: `/api/contexts` allegedly missing `x-robots-tag` (the production wrapper sets it); a suspected ExplorePanel focus-memory hazard (panel does not inert the background but the detail-card fix is scoped to `.station-card`); suspected DST drift in Dublin bucket math (verified correct across 2026–2027 transitions); suspected ISS night-window mismatch (verified consistent).
- Production deployment of the branch: not permitted in this iteration; recorded as the primary release blocker.

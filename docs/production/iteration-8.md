# Production iteration 8 plan (2026-08-22)

Branch: `production/iteration-8` (from `production/iteration-7` tip `6364a99`).
Final planned round. Scope decided after re-verifying the live site read-only,
re-running every local gate at the branch tip, a fresh audit of the round-7
shared API core and both worker entries, two targeted client audits, and a
quantitative re-evaluation of every item carried from earlier rounds.

## Baseline evidence

- Local gates green at the branch tip: `npm test` 183/183,
  `npx playwright test` 165 passed / 23 skipped / 0 failed, `npm run lint`
  clean, `npx tsc --noEmit` clean after a build (the bare invocation fails on
  missing `.next/types` before any build has run; environment artefact, not
  code), `npm run check:budgets` exit 0 (largest JS 250,025 B of 320 KB,
  largest HTML 47,697 B of 120 KB, 16 of 24 initial requests).
- Live https://day.illek.ie (read-only curl): `/` 200; `/api/health`,
  `/api/living`, `/api/contexts`, `/api/transit`,
  `/api/history?at=2026-08-23T03:15:00Z` all 200 with healthy payloads;
  `/api/history/range` reports 1,653 raw snapshots through 2026-08-23T05:45Z.
  Unknown paths still answer bare 0-byte 404s and health still reports
  `"unknown"` provenance, so **the deployed Worker still predates round 1;
  deploying remains the top release blocker**, unchanged since iteration 4.

## Carried items re-evaluated (decisions)

| Item | Decision | Evidence |
| --- | --- | --- |
| Deeper client chunk splitting | Declined on measurement | Page chunk is 250 KB raw / 71.5 KB gzip: d3-geo ≈36 KB, satellite.js ≈25 KB minified, remainder is application code that hydration needs immediately. The only conditionally rendered surfaces are the small dialogs (MapPanels variants) and ExplorePanel; splitting them moves roughly 30-40 KB raw (~10 KB gzip) off first load while adding a network fetch to the first dialog open. HistoryControls and FreshnessStrip always render, so they cannot leave the initial chunk. Round 6 already removed the real weight (61% roads); remaining headroom against the 320 KB ceiling is large and Lighthouse performance is dominated by framework chunks no split can shrink. |
| Lazy-loading satellite.js | Declined again, now quantified | ~24.6 KB raw / ~7 KB gzip is 10% of one chunk but under 4% of first-load JavaScript; its consumers are async provider refresh paths that run within the first second anyway, so a dynamic import resolves at effectively the same moment while adding indirection to well-tested synchronous ISS maths. Third consecutive skip; rationale now recorded. |
| Rebuild transit dictionary from pinned GTFS | Confirmed infeasible here | The historical public URLs (`transportforireland.ie/transitData/Data/GTFS_Ireland.zip`, `gtfs-api.transportforireland.ie/v1/gtfs/static/latest`) answer 404; NTA distributes static GTFS only through the credentialed developer portal. Skip stands for a fifth round; tracked since round 1 in IMPLEMENTATION_REPORT.md. |
| Cold-isolate contexts warm-up / TTL changes | Skip stands | Still no production traffic data; speculative without it. |
| Deploy | Not permitted this round | Remains the primary release blocker. |

## Confirmed findings

Fresh audit findings, each reproduced by reading the exact code paths:

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | A completed comparison fetch resurrects the comparison panel after navigation dropped it. `loadHistoryAt` resets `historyComparison` to idle but never aborts `comparisonRequestRef`; `compareHistoryWithNow`'s only guard is `controller.signal.aborted`. Click "Compare with latest stored", drag the scrubber while the fetch is in flight, and the table pops back in about a second later over the new time. `enterPast` (line 613) has the same unguarded reset; `returnToNow` aborts correctly. | `components/IrelandExperience.tsx:563-608, 611-613, 654-681` |
| F2 | A pending keyboard-scrubber submit timer survives an explicit pointer submission and re-submits the older instant from its stale closure: keyup schedules a 300 ms timer capturing scrubber value A; a pointer-up at value B within that window submits B, then the orphaned timer fires, sees `A !== submittedScrubberRef(B)` and `A !== selectedSeconds(T0)`, and requests A. The view jumps back after the user released at B. | `components/HistoryControls.tsx:126-151, 209-211` |
| F3 | Walk-caveat plural disagreement: `${n} active activity-relevant Met Éireann notice${n===1?"":"s"} ${… "is localized…" : "applies…"}` renders "2 notices is localized" / "notices applies" whenever two warnings are relevant. The travel card at line 351 handles plurals correctly. | `lib/activity-guidance.ts:180` |
| F4 | Coast-caveat plural disagreement: `notice${n===1?"":"s"} is represented` renders "2 notices is represented". Line 249 in the same list handles plurals correctly. | `lib/activity-guidance.ts:253` |
| F5 | A nearby station whose CSV row lacks a temperature renders "Unavailable°": the degree sign is appended outside the null check (`?? "Unavailable"` then `°`), unlike the rain cell directly below which unit-checks correctly. | `components/PlaceContext.tsx:120` vs `:128` |
| F6 | The freshness chip maps every non-loading/ready history status to "No stored record is available for the selected time", so a fetch `error` asserts absence of a record while the history panel for the same state says "Historical conditions could not be loaded" - two visible texts contradict each other about whether data is missing or the load failed. | `components/FreshnessStrip.tsx:68`; statuses in `components/experience-model.ts:104` |

Refuted during verification (no change): deep-linked `?at=` loads do NOT fire a
live-refresh burst (the mount-time refresh effect early-returns because
`initialHistoryAtRef` is initialised from the URL during render, before any
effect runs); the client's trains-stale asymmetry in `hasProviderSuccess` is
unreachable because `buildLivingPayload` only ever emits trains
`live`/`unavailable`.

## Intended change

### A. History interaction race safety (F1, F2)

- `loadHistoryAt` and `enterPast` abort `comparisonRequestRef.current` when
  they reset the comparison state, matching what `returnToNow` already does.
- `submitScrubber` clears any pending keyboard-submit timer at entry so an
  explicit submission always supersedes the debounced one regardless of which
  closure fires next.

Files: `components/IrelandExperience.tsx`, `components/HistoryControls.tsx`.
Risk: low; both are additive guards on paths with existing coverage.

### B. Honesty and copy corrections (F3-F6)

- Plural verb agreement in both caveats.
- Temperature null check wraps the degree sign like the rain cell.
- The freshness chip gains an explicit error branch ("Stored conditions could
  not be loaded") instead of claiming the record does not exist; gap/idle keep
  the existing wording.

Files: `lib/activity-guidance.ts`, `components/PlaceContext.tsx`,
`components/FreshnessStrip.tsx`. Risk: minimal; user-visible strings change
only in the states described.

### C. Regression lock-in

- Unit tests: two-warning walk caveat and coast caveat assert plural verbs;
  temperature-less station renders "Unavailable" without a degree sign (via the
  component-level contract where an existing suite covers it, otherwise e2e).
- E2E: a slow comparison response that lands after a scrubber navigation must
  not reopen the comparison table; a keyboard submit timer that lands after a
  pointer submission must not override it. Both fail against the unfixed build.
- E2E: the freshness chip shows the failure wording when a snapshot request
  errors.

## Verification plan

- `npm test`, `npx tsc --noEmit` (after build), `npm run lint`,
  `npm run build`, `npm run check:budgets`, `npm run check:release`.
- `npx playwright test` full desktop + mobile suites including axe.
- Skill `audit-html.mjs` on canonical pages; Lighthouse on the built site.
- Responsive/keyboard probes at 390/768/1440 CSS px incl. 200%-text and
  reduced-motion checks already covered by the suites.
- `npx wrangler dev --config wrangler.api.toml --local` smoke against the
  production config: health, method boundary, unknown API JSON, branded 404,
  living/transit through both coordinators.
- New e2e tests verified to fail against the unfixed build first.

## Non-goals

- Deploying (not permitted); remains the top release blocker.
- Client chunk splitting and satellite.js lazy-loading (declined on
  measurement above, not deferred for lack of effort).
- GTFS dictionary rebuild (credentialed external download; external gate).
- Cold-isolate warm-up policy (needs production traffic measurement).

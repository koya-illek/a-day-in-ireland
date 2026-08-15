# A Day in Ireland implementation report

Date: 2026-08-15

## Implemented

- Added strict `GET`, `HEAD`, and `OPTIONS` API boundaries for local and Cloudflare routes. Unsupported methods return `405`, `OPTIONS` returns `204`, and `/api/health` is a cheap no-provider health response with binding and build provenance fields.
- Added coordinated context refresh state with per-source TTLs, deterministic jitter, in-flight coalescing, circuit backoff, stale-if-error behavior, generation ordering, source status, and source provenance. Partial context responses remain cacheable when at least one source is usable; all-unavailable responses remain `no-store`.
- Preserved source-level truth for live, partial, stale, fallback, and unavailable data in the browser snapshot and context refresh path.
- Made transit destination metadata lazy and immutable at runtime. The browser loads a small manifest first, fetches the dictionary only when a live trip needs a destination, and keeps the timetable metadata separate from the live vehicle position. The manifest records the NTA source, parser, row counts, generated time, and asset hash.
- Added build provenance generation, content-hashed transit output, immutable asset headers, and performance budgets for JavaScript, HTML, transit data, gzip size, and initial request count.
- Added a release-state check and wired it into deploy scripts. It fails closed for a dirty worktree or untracked input rather than producing an unverifiable deployment.
- Repaired metadata, manifest theme colors, stable sitemap metadata, route-specific Open Graph URLs, neutral/light theme consistency, utility-label styling, prohibited eyebrow markup, and em-dash copy.
- Kept the narrow map hierarchy usable by adapting the projection and map height at constrained widths. Updated the affected responsive and unavailable-state assertions.
- Fixed static directory resolution so local `/data` and manifest requests resolve to the expected index or JSON asset.
- Added API boundary and copy/style unit coverage, plus source refresh, cache, satellite race, and transit provenance coverage in the existing tests.

## Verification

The following checks passed after the implementation changes:

- `npm run lint`
- `npx tsc --noEmit`
- `npm run build`
- `npm run check:budgets`
- `npm test`: 140 passed, 0 failed
- Targeted post-repair browser run for unavailable states, retry/cache state, and 320px at 200 percent text: 5 passed, 1 mobile skip
- Earlier focused map and accessibility run: 14 passed, 12 skipped across desktop and mobile projects

The build budget observations were: largest JavaScript 642,026 bytes, largest HTML 390,312 bytes, transit JSON 3,767,748 raw bytes and 385,171 gzip bytes, with 24 initial requests. The generated provenance correctly marks the local build as dirty and not deployed.

A complete desktop/mobile Playwright run before the final assertion repairs recorded 141 passed, 22 skipped, and 9 failures. Four failures were stale expectations for the approved `Unavailable` copy and theme action count; the targeted post-repair run passed those cases. The remaining lower-priority browser work is the existing deep-link local-storage fixture and the history fixture's date/timezone expectation. A later all-run was intentionally stopped after those history failures reproduced and environment-sensitive fixture waits appeared; it is not represented as a completed suite.

## Deferred and external gates

- No deployment, Wrangler deploy, remote D1 change, DNS change, or other destructive external call was made.
- No new Durable Object migration was added. Root should confirm that the existing history D1 migration and production `HISTORY_DB` binding are applied and available before release. This is the only database migration gate introduced by this implementation.
- The release check remains intentionally unavailable while the shared worktree contains pre-existing and current uncommitted changes. After review and commit, run the release check, then a true dry-run or equivalent configuration validation, followed by the production `/api/health`, `/api/contexts`, `/api/living`, and `/api/transit` smoke checks.
- The checked-in transit dictionary is a legacy generated artifact. Its manifest records the exact asset hash, but `feedVersion` and archive hash are null. Before a provenance-sensitive production release, rebuild it from a pinned NTA GTFS archive with those source fields populated.
- Production source availability, Cloudflare bindings, scheduled history capture, D1 retention, and DNS remain external validation gates. The implementation does not claim those live checks.

## Files touched or added

Application and platform code:

`README.md`, `app/about/page.tsx`, `app/contact/page.tsx`, `app/data/page.tsx`, `app/globals.css`, `app/layout.tsx`, `app/manifest.ts`, `app/privacy/page.tsx`, `app/sitemap.ts`, `components/ExplorePanel.tsx`, `components/HistoryControls.tsx`, `components/InfoPage.tsx`, `components/IrelandExperience.tsx`, `components/MapCanvas.tsx`, `components/MapLayers.tsx`, `components/MapPanels.tsx`, `components/OfficialNotices.tsx`, `components/PlaceContext.tsx`, `components/SkyBriefing.tsx`, `components/WeatherTimeline.tsx`, `components/WorkspaceHeading.tsx`, `components/experience-model.ts`, `lib/browser-live.ts`, `lib/presentation.js`, `lib/types.ts`, `package.json`, `platform/cloudflare-entry.js`, `platform/server-entry.js`, `public/_headers`, `scripts/static-server.mjs`, `wrangler.api.toml`, and `wrangler.history.local.toml`.

Build and data artifacts:

`public/data/transit-destinations.json`, `public/data/transit-destinations.manifest.json`, `scripts/build-transit-destinations.mjs`, `scripts/check-performance-budget.mjs`, `scripts/check-release-state.mjs`, and `scripts/write-build-provenance.mjs`.

Tests:

`tests/api-boundary.test.mjs`, `tests/copy-style.test.mjs`, `tests/data-trust.test.mjs`, `tests/experience.spec.ts`, `tests/live-data.test.mjs`, and `tests/presentation.test.mjs`.

Pre-existing dirty theme and transit destination work was preserved and integrated; no commit was created.

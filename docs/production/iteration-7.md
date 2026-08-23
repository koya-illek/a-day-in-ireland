# Production iteration 7 plan (2026-08-22)

Branch: `production/iteration-7` (from `production/iteration-6` tip `55ca9f0`).
Scope decided after re-verifying the live site read-only, re-running every local
gate at the branch tip, and re-auditing the two Worker entrypoints that prior
rounds kept patching individually.

## Baseline evidence

- Local gates green at the branch tip before work began: `npm test` 178/178,
  `npx tsc --noEmit` clean, `npm run lint` clean.
- Live https://day.illek.ie (read-only curl): `/` 200 (391 KB HTML),
  `/api/health` 200 with every build field `"unknown"`, unknown paths still bare
  0-byte 404s. The deployed Worker predates round 1; **deploying remains the top
  release blocker**, unchanged since iteration 4.
- Both entrypoints are real deployment targets: `wrangler.api.toml` points at
  `platform/cloudflare-entry.js`; the build copies `platform/server-entry.js`
  to `dist/server/index.js` for the OpenAI hosting target
  (`.openai/hosting.json`). Neither can be deleted; they must share one core.

## Confirmed findings

The original review's finding #10 ("extract the shared dispatch module") has
been deferred five times while its symptoms were fixed piecemeal (rounds 1, 3,
5 fixed seven concrete divergences). Re-reading both files shows the drift
class is still open on this branch:

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | Alternate adapter `/api/living` caches every outcome for 60 s, including all-unavailable responses, contradicting the documented "all-unavailable is `no-store`" contract; it also omits `x-robots-tag` and the partial-tier distinction | `platform/server-entry.js:65-75,779-786` (`json()` defaults) vs `platform/cloudflare-entry.js:17-40,297-332` |
| F2 | 405 responses diverge: Cloudflare answers `text/plain` without content-type or no-store; the alternate adapter answers JSON | `cloudflare-entry.js:51-61` vs `server-entry.js:1075-1087` |
| F3 | Unknown `/api/*` GET diverges: Cloudflare serves the branded HTML 404 page for an API namespace; the alternate adapter answers JSON 404. Unknown-API `OPTIONS`/POST fall through differently on each side | `cloudflare-entry.js:42-49,453-495` vs `server-entry.js:1073,1130-1145` |
| F4 | Transit failure contract diverges: Cloudflare wraps coordinator faults as JSON 503; the alternate adapter catches internally and answers 200 | `iteration5-api.test.mjs` vs `server-entry.js:1063-1070` |
| F5 | Health diverges: only the Cloudflare path reports shipped build provenance; the alternate adapter cannot and hardcodes a different runtime label; header sets differ | `cloudflare-entry.js:63-120` vs `server-entry.js:1089-1105` |
| F6 | Two parallel implementations of `/api/living` exist (`livingResponse` and `livingLayers`) plus duplicated method/health/dispatch scaffolding; every divergence above is a symptom of this duplication | Both files end-to-end |
| F7 | Contexts error wrappers differ in headers (Cloudflare adds `x-robots-tag` via `apiErrorResponse`; the alternate adapter's `json()` does not) | `cloudflare-entry.js:441-451` vs `server-entry.js:1119-1127` |

## Intended change

### A. One shared API core, thin adapters (F1-F7)

New `platform/api-core.js`, receiving the entirety of the shared Worker API
surface moved out of `server-entry.js`:

- Every provider fetcher (Irish Rail XML, Met warnings, OPW acquisition incl.
  Browser Run and configured bridge fallbacks, marine, radar, air, tides,
  bathing, satellite resolver machinery, earthquakes, ISS TLE, NTA
  acquisition/normalisation) - moved verbatim.
- The context refresh state machine, policies, and `currentContexts` - moved
  verbatim.
- One HTTP contract: a single JSON responder carrying content-type, CORS,
  `x-robots-tag`, and explicit cache tiers; one 405 handler; one JSON 503 error
  wrapper; one JSON 404 for unknown API paths.
- Unified endpoint responders: `healthResponse(env, provenance)`,
  `livingResponse({loadTrains, loadRivers})` with the production cache-tier
  matrix, `resolveTransit` + `transitResponse` + the shared transit route,
  `currentContexts` + the shared contexts route.
- `handleApiRequest(request, env, adapters)`: any `/api/*` URL gets the method
  boundary first (GET/HEAD/OPTIONS only), then dispatch; unknown API paths
  answer JSON 404. Returns `undefined` for non-API paths so each adapter keeps
  its own static-serving behaviour (Cloudflare: plain asset passthrough with
  wrangler's branded 404 page; alternate: asset serving with SPA fallback).

`platform/cloudflare-entry.js` keeps only genuinely edge-specific code: the two
Durable Object classes, build-provenance loading through ASSETS, history
endpoints and snapshots, the paid history tick, the scheduled handler, and the
static passthrough. Its exported `livingResponse` wraps the shared core with
coordinator-backed loaders, preserving the existing test-injectable signature.

`platform/server-entry.js` shrinks to the alternate adapter: shared dispatch
with direct-loader wiring, plus the SPA fallback for non-API documents.

Behavioural fixes that fall out (intended, tested):

- Alternate `/api/living` gains the production cache-tier matrix (partial tier
  when either source carries data; `no-store` only when nothing is usable) and
  `x-robots-tag`.
- Both adapters answer 405, unknown APIs, and unexpected failures with one JSON
  contract.
- Cloudflare unknown `/api/*` GET answers JSON 404 instead of an HTML document.

Files: `platform/api-core.js` (new), `platform/cloudflare-entry.js`,
`platform/server-entry.js`, `package.json` (copy the new module into
`dist/server`), tests, `README.md`, `ARCHITECTURE.md`.

User impact: none visible on the Cloudflare production path beyond consistent
error/cache headers; the alternate adapter stops violating documented caching
and honesty contracts. Risk: medium (every API response path); mitigated by a
new cross-adapter parity suite driving both workers through identical stubs,
the existing 178-test unit surface (updated where it pinned old internals),
and the full browser suites.

### B. Regression lock-in

New `tests/iteration7.test.mjs`:

- A parity matrix driving BOTH workers with equivalent stubs across
  health/living/contexts/transit/unknown-API/405/OPTIONS, asserting equal
  statuses and the full shared header contract.
- Alternate-adapter living tiers (partial kept when trains fail; no-store when
  nothing usable; `x-robots-tag` present).
- Cloudflare unknown-API JSON 404; alternate transit fault answered with the
  JSON 503 contract.
- A structural drift guard: exactly one definition of the context policies and
  payload assembly across `platform/`, and both entrypoints delegating through
  `handleApiRequest`.

Update the handful of tests that pinned pre-consolidation internals (import
paths move to `api-core`; the transit-upstream-failure test now pins the
production 503 contract; the "shared payload builder" source-text assertion
pins delegation instead).

## Verification plan

- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`,
  `npm run check:budgets`, `npm run check:release`.
- `npx playwright test` full desktop + mobile suites (the enforcing local
  server proxies `/api/*` through the slimmed alternate adapter under
  `LIVE_CONTEXTS=1` mode and serves generated `_headers` otherwise).
- `npx wrangler dev` smoke against the production config: `/api/health`,
  method boundaries, unknown API JSON, static assets, and the branded 404 -
  closing the "needs wrangler-dev-level verification" objection from earlier
  rounds.
- Skill `audit-html.mjs` on canonical pages; Lighthouse on the built site;
  responsive/keyboard probes at 390/768/1440 CSS px.

## Non-goals

- Deploying (not permitted this round); remains the top release blocker.
- Rebuilding the transit dictionary from a pinned NTA GTFS archive (requires a
  credentialed external download; tracked since round 1).
- Further client bundle splitting (real, structural; measurable against the
  tightened budgets next round).
- Cold-isolate contexts warm-up or TTL changes (needs production traffic
  measurement).
- Lazy-loading satellite.js (small next to the risk of async indirection in
  well-tested synchronous ISS maths).

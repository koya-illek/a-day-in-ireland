# Production iteration 6 plan (2026-08-22)

Branch: `production/iteration-6` (from `production/iteration-5` tip `3fd8962).
Scope decided after re-verifying the live site read-only and re-measuring the
built output. The three carried structural items from rounds 1-5 were
re-examined; two are now implemented because their earlier blockers (measured
bundle data, build-integrated header generation) have practical solutions.

## Baseline evidence

- Live https://day.illek.ie (read-only curl): `/`, `/api/health`, `/api/living`,
  `/api/contexts`, `/api/transit` all 200; unknown paths still bare 404s
  (deployed Worker predates round 1; deployment remains a documented blocker,
  not a code defect on this branch).
- Fresh `npm run build`: landing page route reports 185 kB gzipped JS; the
  single `app/page-*.js` chunk is 644,796 bytes raw. 395,366 bytes of it
  (61.3%) is the embedded `public/map/major-roads.json` FeatureCollection.
- Built `out/index.html` is 388 KB raw; ~347 KB of that is SVG path `d`
  attributes projected from the same road geometry during prerender. The road
  network is therefore shipped twice per visit: once in HTML path data, once
  as JSON inside the JavaScript bundle.
- Lighthouse performance has been stuck at 55 across rounds 1-5 with this
  chunk cited as the cause each time.
- Live `/api/health` returns `"commitSha":"unknown","builtAt":"unknown",…` for
  every build field. Source shows these come from `env.BUILD_COMMIT_SHA`,
  `env.BUILD_TIMESTAMP`, `env.BUILD_CONFIG_SHA256`, `env.BUILD_DATA_SHA256`,
  `env.DEPLOYMENT_ID`; no deploy path or config file ever provides them. At the
  same time `dist/client/build-provenance.json` is written by every build,
  deployed with the assets, publicly served (verified live), and ignored by
  the Worker.
- Live CSP still carries `script-src 'self' 'unsafe-inline' …`. Rounds 1-5
  skipped hash-based allowances because Next's inline flight scripts vary per
  page per build and fixed hashes in `public/_headers` would break deploys.
  The local static server (`scripts/static-server.mjs`) now enforces
  `_headers` exactly, so a generated-CSP mistake fails hundreds of e2e tests
  loudly instead of silently breaking production.

## Confirmed findings

| # | Finding | Evidence |
| --- | --- | --- |
| F1 | Road geometry double-shipped in bundle + prerendered HTML; 61% of the main chunk | Byte measurement above; `components/IrelandExperience.tsx:18,1001-1008`; roads layer is decorative and `aria-hidden` |
| F2 | Health endpoint's build provenance is permanently "unknown" while truthful provenance sits unused in the deployed assets | Live response; `platform/cloudflare-entry.js:63-86`; nothing sets those env vars; `scripts/write-build-provenance.mjs` output ships but is unread |
| F3 | CSP allows arbitrary inline script execution via `'unsafe-inline'` | `public/_headers:3`; live header check |

## Intended changes

### A. Stop shipping road geometry twice (F1)

- Delete the `major-roads.json` import from the bundle. Fetch
  `/map/major-roads.json?v=<content-hash>` once after mount, validate the
  parsed shape at the boundary, project when present.
- Version the asset URL with a sha256 prefix computed in `next.config.ts` and
  add an immutable `_headers` rule for `/map/major-roads.json`. Content change
  changes URL, so immutable caching is safe without renaming files.
- Prerendered HTML keeps the island outline (bundled 11 KB `island.json`),
  sky, sea and all text content; roads fade in as a decorative overlay. No
  layout shift is possible inside the fixed-viewBox SVG.
- Failed fetch leaves roads absent; no retry loop, no error surface for a
  purely decorative layer.
- Update the one e2e test that counted road paths synchronously to await
  them, preserving its intent.
- Tighten `check-performance-budget.mjs` ceilings around the new observed
  sizes so the win cannot quietly regress.

Files: `components/IrelandExperience.tsx`, `next.config.ts`, `public/_headers`,
`tests/experience.spec.ts`, `scripts/check-performance-budget.mjs`.

User impact: ~395 KB less JavaScript and ~340 KB less HTML on first load;
main chunk drops from 645 KB to roughly 250 KB raw. Risk: low-medium (render
path of the flagship screen); mitigated by the existing roads e2e test plus
full suite.

### B. Truthful health provenance (F2)

- `healthResponse` reads `/build-provenance.json` through the `ASSETS`
  binding, memoised per isolate with a short failure retry window, and maps
  its fields onto the existing response shape. Missing binding or unreadable
  asset degrades to today's `"unknown"` values.
- No new information becomes public: the file is already served verbatim.

Files: `platform/cloudflare-entry.js`, new unit tests driving the exported
worker fetch with stub ASSETS bindings.

User impact: operators get real deployed-commit visibility from the documented
liveness endpoint. Risk: low; response shape unchanged.

### C. Hash-based CSP inline allowances (F3)

- New postbuild step `scripts/write-csp-headers.mjs`: scan every built HTML
  document in `dist/client`, hash each inline `<script>` body (sha256, base64),
  and rewrite only the `script-src` segment of the CSP line in
  `dist/client/_headers`, replacing `'unsafe-inline'` with the deduplicated
  hash list. Pure functions exported for unit tests; CLI entry guarded.
- `public/_headers` stays valid standalone; if the generator never runs, the
  site behaves exactly as today. Fail-open to current behaviour, never broken.
- style-src `'unsafe-inline'` intentionally remains (inline style attributes
  would need 'unsafe-hashes' and carry far lower risk).

Files: `scripts/write-csp-headers.mjs` (new), `package.json` build chain,
new unit tests, new header assertions in an e2e spec.

User impact: injected inline scripts can no longer execute on any page;
documented CSP hardening goal from the original review closes. Risk: medium if
hashing misses a script; mitigated by hashing every built page including
404.html, unit tests on the rewrite logic, and the enforcing local server
running the whole browser suite under the new CSP.

## Verification plan

- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`,
  `npm run check:budgets`, `npm run check:release`.
- `npx playwright test` full desktop + mobile suites (server enforces the
  generated `_headers`, exercising the new CSP under Chromium).
- New unit tests: boundary validation of fetched road JSON; health provenance
  mapping and degradation; CSP extraction/rewrite purity and idempotence.
- Lighthouse against the built site via the repo static server.
- Skill `audit-html.mjs` on all canonical pages.
- Responsive/keyboard probes at 390, 768, 1440 CSS px: roads appear, no
  horizontal overflow, map keyboard flow intact.

## Non-goals

- Deploying (not permitted this round); remains the top release blocker.
- Rebuilding the transit dictionary from a pinned GTFS archive (external
  artifact work, tracked since round 1).
- Extracting the shared worker dispatch module (concrete divergences keep
  being fixed directly; consolidation still needs wrangler-dev-level e2e).
- Lazy-loading satellite.js (~25 KB gz estimated) - real but secondary next to
  the 61% chunk reduction; adds async complexity to well-tested ISS maths.
- Changing cache TTLs or adding warm-ups for cold-isolate fan-out (needs
  production traffic measurement).

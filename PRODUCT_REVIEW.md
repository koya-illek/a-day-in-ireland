# A Day in Ireland product review

Review date: 2026-08-14  
Follow-up: 2026-09-11 (implementation; see the matching pull request)

The 2026-08-14 review below is the original read-only snapshot. Later work, including this follow-up, addressed the High items and several Medium/Low items: API methods are GET/HEAD/OPTIONS only, `/api/health` exists and reports Cloudflare version metadata, context refresh is a Durable Object snapshot with `sources` applied before fan-out, NTA vehicle truncation is raised and still labelled `partial`, transit destinations have refresh tooling and a clearly marked stale manifest, GitHub Actions runs unit/type/lint, OPW Browser Rendering is a circuit-broken fallback rather than a second dataset, OpenAPI history no longer advertises a retained rail `trains` array, and the privacy page no longer claims a Web Analytics beacon that is not shipped. MCP was removed entirely. The original findings remain below as the evidence of that review.

## Executive verdict

A Day in Ireland is a strong, unusually coherent public-data product. It turns a large set of Irish observations, models, forecasts, warnings, transport feeds, and derived context into a single living map and history surface. The product has a real point of view: source provenance, observation time, freshness, partial coverage, unavailable fields, and derived values are usually visible instead of being silently presented as facts. The live transit destination join and the dark/light themes improve the core experience.

The product should be kept and hardened. It is not ready to be treated as a reliability-sensitive public information service until its request boundary, context refresh architecture, release provenance, and large transit metadata payload are addressed. No Critical finding was confirmed. Four High findings are operational or performance risks that are straightforward to contain.

The most important positive result is semantic honesty. The live page showed Online · live, an observed weather age of about 16 minutes, a partial river source with a Browser Run fallback, a live rail refresh, an official warning with scope and expiry, and null grid fields where the source did not provide values. History explicitly exposed gaps for rail, imagery, measured air, and other data that are not retained. This is substantially better than a dashboard that labels every value simply “live.”

The most important negative result is that the expensive public APIs are reachable with POST and OPTIONS as well as GET. The Worker dispatches those routes before the method guard, and direct probes returned the full payload for POST. Context requests also fan out to fourteen providers and are effectively uncached when any source is partial or unavailable. That creates avoidable abuse, cost, and availability risk.

## Evidence and tests run

### Repository and deployment

- Repository: /home/koya/a-day-in-ireland.
- Branch: main, at commit dcb943e (Complete shared runtime packaging).
- Local branch is ahead of origin/main by 42 commits.
- The worktree is dirty: nine tracked product/config/test files are modified and there are untracked public/data/ and scripts/build-transit-destinations.mjs paths. These changes were pre-existing to this review and were not altered.
- Cloudflare deployment history shows the latest deployment at 2026-08-14T20:36:14.616Z, version 7a6e1c88-d211-47e0-ae3b-10afe49c1142, with source shown as Unknown (deployment) and no message.
- wrangler.api.toml uses the custom domain route day.illek.ie, workers_dev=false, preview_urls=false, a D1 binding, two Durable Objects, Browser Rendering, assets, and a fifteen-minute cron. No pages.dev or workers.dev deployment was found in the reviewed configuration.

The deployment is live and functional, but the combination of an unknown deployment source, an uncommitted worktree, and a production artifact containing behavior represented by those uncommitted changes means the exact production revision cannot be reconstructed from the repository state. This is a release-control finding, not proof that the current artifact is wrong.

### Automated checks

- npm test: 137 passed, 0 failed, 0 skipped.
- npm run lint: passed.
- npx tsc --noEmit: passed.
- Playwright targeted run with desktop and mobile projects: 60 passed, 5 failed, 17 skipped out of 82 selected tests.
- The five failures were classified. Two were local clean-route failures for /data caused by the test static server, two were fixture timing failures expecting four temporary Connecting states but receiving Unavailable, and one was a stale 320px text-size assertion expecting two header action buttons after the theme button added a third. These failures should still be repaired or explicitly quarantined because they reduce confidence in the release gate.
- Desktop axe coverage and the narrow mobile axe coverage passed. Focus, reduced-motion, forced-colors, touch, overflow, history, map, and data-trust checks passed in the selected run.

### Live HTTP and browser checks

Production was checked at https://day.illek.ie on desktop 1280x900 and mobile 390x844 using Chromium.

- /, /about, /data, /privacy, /contact, and /sitemap.xml returned 200. /robots.txt returned the expected API-disallow rules and custom-domain sitemap.
- /api/living, /api/transit, and /api/contexts returned 200. The browser received no console errors or failed requests in the live run.
- The root and mobile layouts had no horizontal body overflow. The page loaded live state, and theme switching changed the document from dark to light with a correctly labelled control.
- The default weather view showed nine station markers. Movement showed seven transit markers and fourteen clusters. All layers showed 31 river markers, 33 air markers, and six transit clusters after decluttering.
- A live transit detail displayed route 2, destination Wexford, a southwest heading, approximately 76 km/h, a refresh time, and an explicit statement that the speed was estimated from positions.
- The live history range exposed raw fifteen-minute, hourly, and daily resolutions. A raw snapshot at 22:00Z contained an aggregate transit count and explicit gaps rather than invented values. A daily request resolved to a daily summary and declared its five retained hourly representatives.
- Performance samples: cached home TTFB was about 48 to 72ms; the first living miss was about 1.5s and later cache hits were about 60ms; contexts took about 464 to 590ms because they are no-store; transit took about 60 to 90ms.
- The initial home HTML was about 390KB and the main JavaScript chunk about 640KB. The transit destination dictionary was 3,767,748 bytes uncompressed, about 376KB when gzip encoded.

## Architecture and data semantics

The Cloudflare configuration is appropriate for the product shape: a Worker entrypoint, static assets, D1 history, Durable Objects for NTA and river coordination, Browser Rendering for sources that need it, and a custom domain. The main concern is the refresh topology rather than the selected services.

Observed semantics were generally well designed:

- Weather rows are fixed Met Éireann stations, browser-fetched, timestamped, and bounded by freshness rules. The live page showed observed values rather than pretending forecast values were measurements.
- Rail data is refresh-stamped, with details separate from the compact summary.
- NTA positions are coordinated and timestamped. Speed is labelled as derived, and the destination join is visibly useful.
- River data can report partial coverage and identify Browser Run fallback.
- Marine buoys and coastal observations are distinct from weather stations.
- Radar has seven recent five-minute frames and masks or checks tiles rather than treating a missing tile as rainfall.
- Measured and modelled air are separate concepts. The edge context response can report measured air unavailable while the browser path still provides a modelled air layer.
- Tides retain partial status and null storm-surge fields rather than zero-filling.
- Bathing alerts and official warnings retain scope, severity, and expiry. The current Blight Advisory was not misrepresented as a general walking warning.
- Grid fields such as carbon intensity and interconnector values remain null when unavailable.
- Aurora is presented as a probability or guidance signal, while satellite imagery is labelled as an archived NASA frame. ISS is calculated in the browser from a live TLE rather than presented as an unverified observation.
- History distinguishes raw, hourly, and daily resolutions and records non-retained sources. This is a strong trust feature.

## Findings

Severity reflects user harm, operational risk, exploitability, and effort to contain. Findings are ordered by severity and then impact.

### High

#### H1. Expensive API routes accept non-GET methods

Evidence:

- platform/cloudflare-entry.js:314-334 dispatches /api/history, /api/transit, /api/living, and /api/contexts before the GET/HEAD method check.
- platform/server-entry.js:65-74 returns public JSON with Access-Control-Allow-Origin: *.
- Direct production probes showed POST to /api/living, /api/contexts, and /api/transit returning 200 and full current JSON. OPTIONS also returned a full /api/living JSON response. POST to / was correctly rejected with 405, which demonstrates that the API routing path is the exception.

Impact:

Anyone can use POST or OPTIONS to invoke the same provider fan-out as a normal read. There is no authentication requirement for this public product, so method confusion and request amplification are the realistic risks. CORS being public is reasonable for public data; it does not remove the need for a strict method contract and rate or cost protection.

Recommendation:

Reject every method except GET and HEAD at the API boundary. Handle OPTIONS with a small, explicit response only if cross-origin preflight is required. Add a no-provider health path and per-route request budgets. Test every API route for GET, HEAD, OPTIONS, POST, PUT, and DELETE behavior.

#### H2. Context refresh is an uncached fourteen-provider fan-out

Evidence:

- platform/server-entry.js:760-826 calls fourteen context providers through Promise.allSettled.
- The edge path intentionally disables measured air at line 761, reports it unavailable at line 797, and returns cacheSeconds: 0 when any context is non-live or fallback at line 826.
- Production /api/contexts is no-store and measured requests took about 464 to 590ms on repeated calls. A live response included partial river data and unavailable or partial fields even while the rest of the product was healthy.
- The Worker configuration allows 100 subrequests and 1000ms CPU. The architecture therefore places a high fan-out inside a bounded request budget.

Impact:

Every browser refresh, retry, or abusive non-GET call can repeat the provider fan-out. A slow, rate-limited, or intermittently broken source makes the entire context request pay the latency cost and removes edge caching. This is a likely availability and provider-quota risk as traffic grows, even though the current page performed acceptably.

Recommendation:

Move source refresh to a coordinator with per-source TTLs, jitter, circuit breakers, and stale-if-error values. Publish one compact context snapshot with a short edge cache TTL. Keep source-level status and age in the payload. Do not make an unavailable measured-air source disable caching for unrelated context data.

#### H3. The deployed revision is not reproducible from the reviewed source state

Evidence:

- The worktree has extensive tracked modifications and untracked generated data and build scripts.
- main is ahead of origin/main by 42 commits, while the latest deployment source is shown as Unknown (deployment) and has no deployment message.
- Production contains the new theme control and transit destination behavior that correspond to local uncommitted changes. There is no recorded revision, artifact digest, or build input in the reviewed deployment output that ties those changes to a specific commit.

Impact:

An incident cannot be reproduced reliably from the checkout, and a rollback target cannot be selected from a clear release record. The product includes live-data semantics, generated transit metadata, and platform bindings, so source-only provenance is insufficient.

Recommendation:

Deploy only from a clean, immutable commit. Record commit SHA, generated-data version and checksum, build timestamp, Wrangler configuration hash, and deployment ID in a small public or operator-only manifest. Make the deployment pipeline fail when tracked changes or untracked build inputs are present.

#### H4. The transit destination join downloads a 3.77MB dictionary to the browser

Evidence:

- lib/browser-live.ts:37-45 creates a global promise to load /data/transit-destinations.json.
- lib/browser-live.ts:729-753 fetches that file alongside /api/transit and joins vehicle.tripId to the destination.
- The deployed file is 3,767,748 bytes uncompressed, contains 139,833 keys, and is served with Cache-Control: public, max-age=0, must-revalidate. Gzip reduces transfer to about 376KB, but parsing and memory cost remain.
- The join is static GTFS-derived metadata, while the live positions refresh frequently. The product currently pays for the static dictionary as part of the live browser path.

Impact:

This is a material first-load and mobile-cache cost for a feature that may be used only when the movement layer is opened. It also couples a generated schedule artifact to every client without a source date or checksum.

Recommendation:

Lazy-load the dictionary when movement details need destination enrichment, or replace it with a compact indexed structure or route-level chunks. Give immutable generated files content-hashed names and long-lived caching. Add feed version, generated-at time, and a clear “scheduled destination” semantic to the artifact and UI.

### Medium

#### M1. The local clean-route server breaks /data, reducing e2e confidence

Evidence:

- Two targeted Playwright failures expected /data but received chrome-error://chromewebdata/.
- scripts/static-server.mjs:35-70 checks the directory dist/client/data as a file and attempts to stream it before trying data.html. The clean /data route therefore returns a local 500 even though production /data returns 200.

Impact:

The test harness reports a product navigation failure that is actually an environment defect. This can conceal a real regression and leaves the release gate red.

Recommendation:

Resolve directory paths to their index or clean-route HTML before opening a stream. Add a direct static-server test for /data, /about, and every clean route. Keep the production browser test as a separate job.

#### M2. Public copy still uses the prohibited eyebrow pattern and em dashes

Evidence:

- app/data/page.tsx:28-47 renders an eyebrow, uses em-dash separators, and includes a sentence that contrasts what the page is not.
- app/about/page.tsx:14-29 renders an eyebrow and uses an em dash in public copy.
- components/IrelandExperience.tsx:2052-2058 includes an em dash in the share text.
- The same eyebrow class appears across the main experience, history controls, explore panel, map panels, place context, sky briefing, and information pages. A production scan found repeated eyebrow elements and em-dash characters.

Impact:

This conflicts with the project-wide copy rules and creates a repeated visual label treatment that adds hierarchy without always adding meaning. It is also an automated quality regression waiting to happen because the current lint and tests do not enforce the rule.

Recommendation:

Replace decorative eyebrow labels with ordinary headings or short utility labels where they carry necessary meaning. Rewrite em-dash copy with commas, periods, or parentheses. Add a source and rendered-page text lint check that fails on the banned patterns.

#### M3. Generated transit metadata has no provenance contract

Evidence:

- scripts/build-transit-destinations.mjs:33-51 accepts a GTFS ZIP, parses trips, and writes the dictionary.
- The generated output does not include source URL, feed version, downloaded-at timestamp, checksum, or collision count.
- The live UI correctly labels speed as estimated, but destination semantics are not equally explicit about being schedule-derived.

Impact:

A stale or changed feed can silently produce an apparently live destination. A collision or route variation is difficult to diagnose after deployment.

Recommendation:

Emit a sidecar manifest or top-level metadata with source, feed date, generated-at, checksum, row count, collision count, and parser version. Display “scheduled destination” when the value comes from static GTFS metadata and retain the live position timestamp separately.

#### M4. The default map is visually too small at 390px

Evidence:

- At 390x844 production viewport, the map canvas was approximately 335x256px.
- The island path occupied about 130x172px and default station text measured roughly 6.6x4px in the browser geometry. The map is technically responsive and accessible controls work, but the primary geography is small relative to the available panel.
- A 390px screenshot showed the map as a useful overview only after deliberate zooming; the default weather view leaves substantial unused space.

Impact:

The product’s central visual promise is weaker on the common narrow viewport. Markers and labels are harder to scan, while the surrounding controls retain a large share of the vertical space.

Recommendation:

Use a narrow-viewport fit or a modest mobile zoom multiplier while preserving the whole-island context. Make the selected marker and layer density the priority. Validate 320, 360, 390, and 430px widths with real marker labels and touch targets.

#### M5. Page metadata and manifest do not fully follow the theme or route

Evidence:

- /data has the correct canonical https://day.illek.ie/data, but its inherited Open Graph URL remains https://day.illek.ie from app/layout.tsx.
- app/layout.tsx:17-66 defines root social metadata and openGraph.url: / without route-specific overrides.
- app/manifest.ts:12-13 uses dark-only background and theme colors even though the site now supports light mode.

Impact:

Sharing the data page can resolve to the home page in social metadata, and installed-app chrome can clash with the selected system or site theme.

Recommendation:

Define route metadata for /data and other information pages, including title, description, canonical, and Open Graph URL. Provide light and dark manifest colors or use a theme-aware strategy supported by the target clients.

### Low

#### L1. There is no lightweight health endpoint

Evidence:

- Production GET /api/health returned 404.
- The available living and context endpoints invoke or depend on data work and are unsuitable as a cheap liveness check.

Recommendation:

Add a no-provider health route that reports Worker build and storage binding health without fan-out. Keep provider freshness in a separate diagnostics response.

#### L2. CSP still permits unsafe inline script and style

Evidence:

- public/_headers permits script-src unsafe-inline and style-src unsafe-inline.
- Other headers are strong: HSTS with preload, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, strict referrer policy, a restrictive frame policy, and a limited Permissions Policy.

Recommendation:

When the framework output permits it, replace inline allowances with nonces or hashes. Treat this as defense-in-depth; no live injection was observed in this review.

#### L3. Sitemap last-modified values are build-time values

Evidence:

- app/sitemap.ts:5-11 uses new Date() for each route while the sitemap is force-static.

Recommendation:

Use a stable content or deployment timestamp, or omit lastModified when a meaningful per-page content timestamp does not exist. This avoids implying that every page changed on every build.

#### L4. There is no normal performance regression budget

Evidence:

- The package scripts cover tests, lint, type checking, build, and e2e, but no bundle-size, route-TTFB, payload-size, or mobile-load budget.
- The current transit dictionary and main JavaScript chunk are measurable costs that passed functional tests without a regression assertion.

Recommendation:

Add CI checks for key asset size, compressed transfer size, route TTFB on a local fixture, and the number of network requests before first usable map. Keep budgets separate from live-provider availability tests.

## Product and market assessment

### Product value

The strongest product is a living public atlas for Ireland, with a useful answer to “what is happening across the country right now?” It is more than a weather page because it joins weather, radar, wind, rivers, marine conditions, tides, warnings, bathing, air, energy, sky conditions, satellite, earthquakes, ISS, rail, and public transport in one place. The history layer gives the product a memory, while explicit provenance makes it usable for checking rather than merely browsing.

The likely audiences are residents who want situational awareness, educators and students, journalists and civic-data users, visitors planning a day, and technically minded users who care where a value came from. It is not a replacement for Met Éireann, Irish Rail, NTA, local authority warnings, or emergency services. The product should continue to link and defer to those authorities for decisions with safety consequences.

### Differentiation

The differentiation is synthesis and trust semantics, not an individual feed. Many sources have a dedicated official view; fewer products put them on one map, preserve observation age, distinguish forecast from observation, label derived calculations, and show partial or unavailable state. The current transit detail is a particularly good example because it provides a human destination while retaining live position and estimated-speed semantics.

The product feels more distinctive when it explains data state than when it adds another novelty layer. The map should remain the centre of gravity. The eighteen-layer catalogue is already close to the point where discovery and prioritization matter more than adding more sources.

### Features to keep, remove, or add

Keep the living map, provenance and freshness, history resolutions, official warning scope and expiry, derived-value labels, transit movement, and the dark/light theme.

Improve discoverability of the most useful layers through a small “conditions now” set and a separate catalogue for specialist layers. Keep specialist layers available, but do not make first-time users understand every source before they can interpret the map.

Consider adding source-level update timelines, a shareable current-view state, and a plain-language “what changed since the last refresh” summary. These strengthen the existing trust model without requiring a new data category.

Do not add high-risk decision features such as route safety, flood prediction, or delay guarantees unless they have a separate validation, liability, and authority review. The product should present evidence and context, not imply operational certainty.

## Recommended implementation plan

### 1. Contain request abuse and fan-out risk

Impact: very high. Effort: low to medium.

Fix the method boundary, define OPTIONS behavior, add cheap health, and add route-level request and subrequest budgets. Tests should cover every method and ensure unsupported methods do not call providers.

### 2. Publish coordinated, cacheable context snapshots

Impact: very high. Effort: medium to high.

Use a coordinator or Durable Object for per-source refresh, stale-if-error retention, backoff, and circuit breaking. Serve the latest compact context snapshot from the edge with source ages and statuses. A single provider being partial must not make all otherwise-valid context data no-store.

### 3. Make deployment and generated data reproducible

Impact: high. Effort: medium.

Require a clean commit, record deployment ID and commit SHA, version the transit feed input, checksum generated assets, and expose enough provenance for operators to reproduce a release. Add a deployment manifest and a rollback procedure.

### 4. Reduce transit startup cost

Impact: high on mobile. Effort: medium.

Lazy-load destination enrichment, compact or partition the dictionary, and serve immutable content-hashed artifacts. Preserve live position time separately from schedule metadata.

### 5. Repair the test harness and add product quality gates

Impact: medium to high. Effort: low to medium.

Fix local clean-route serving, stabilize connection-state fixtures, update the 320px assertion for the theme control, and add rendered-copy checks. Add asset and mobile-performance budgets to CI.

### 6. Improve narrow-map hierarchy and route metadata

Impact: medium. Effort: low to medium.

Tune mobile fit and labels, add route-specific social metadata, and make the manifest theme-aware. Verify with 320 to 430px screenshots and screen-reader checks.

### 7. Validate demand before expanding the catalogue

Impact: medium. Effort: low.

Instrument only privacy-preserving aggregate interactions or run lightweight user trials. Measure whether people return for current conditions, history, transit, warnings, or specialist layers. Use that evidence to choose one or two improvements rather than adding more feeds.

## Explicit do-not-implement list

- Do not add flights, generic road traffic, or a generic trip planner. They would dilute the living-atlas proposition and compete with mature products.
- Do not add route planning, fares, delay guarantees, or safety/flood advice without authoritative semantics, operational ownership, and a separate risk review.
- Do not retain raw Irish Rail data or other restricted source data until permission, retention, and licensing are explicit.
- Do not add accounts, social feeds, ads, behavioral profiles, or invasive analytics to a public-data product whose value is currently trust and immediacy.
- Do not add more novelty feeds before measuring whether current layers are discovered and used.
- Do not promise full offline functionality while the experience depends on live sources and large map/data assets.
- Do not deploy to pages.dev or workers.dev. Keep the custom-domain deployment.
- Do not revive Azure Platform Designer; it is retired and unrelated to this product.

## Final decision

Keep the product and continue investment. The core idea is differentiated enough to warrant hardening, and the live evidence shows a credible, useful experience rather than a collection of disconnected feeds. The next release should prioritize API method containment, coordinated context caching, reproducible deployment provenance, and transit payload reduction. After those controls are in place, spend the next product cycle on mobile map hierarchy, route metadata, and evidence-led discovery of the layers people actually return to.

# Improvement Plan — Round 3 (2026-08-22)

Fresh-eyes review after rounds 1–2 (`315b9ae`, `1b82333`…`c0b6f8d`). Every item was verified against current source before planning. Branch: `rerun3/review-2026-08-22`. Verification for all items: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus Playwright where surfaces changed. Items skipped in rounds 1–2 (chunk splitting, hash CSP, GTFS rebuild, dispatch extraction, clock-render isolation, D1 recovery policy) are not re-litigated here.

## Technical

### T1. Infinite transit-enrichment render loop and unbackoffed manifest refetch (high)
- Where: `components/IrelandExperience.tsx:855-869`, `lib/browser-live.ts:38-73`
- What: the enrichment effect keys on `snapshot.transit` identity; `enrichTransitDestinations` always returns a new array, so if any vehicle still has `tripId && !destination` after enrichment (trip missing from the static manifest, or the manifest fetch failed) the guard stays true forever: render → effect → setState → render… When the load fails, the round-2 memo clear turns this into a zero-backoff request hammer. Separately, `loadTransitDestinations` resolves `{}` on a non-ok manifest or asset response, which memoizes that failure for the page lifetime (the round-2 retry fix only covers rejected promises).
- How: throw on non-ok responses inside `loadTransitDestinations` so failures clear the memo; in the effect, skip the `setLiveSnapshot` commit when enrichment filled nothing (compare destinations element-wise). Retry then happens naturally on the next 65 s transit poll.

### T2. Wheel zoom's preventDefault is a no-op under React's passive listener (medium)
- Where: `components/use-map-gestures.ts:118-121`, `components/MapCanvas.tsx:64`
- What: React registers `wheel` as passive at the root, so `event.preventDefault()` throws and the document scrolls while the map also zooms.
- How: register a native `wheel` listener with `{ passive: false }` on the SVG element inside `useMapGestures`; drop the React `onWheel` prop.

### T3. Polling and the 1-second clock ignore tab visibility (medium)
- Where: `components/IrelandExperience.tsx:719-722, 819-834`
- What: four refresh intervals (~2,700 requests/day/tab) and the per-second clock tick run while the tab is hidden; the 20 s recovery refresh can also fire while hidden.
- How: gate interval callbacks on `document.hidden`; on `visibilitychange` to visible, resync the clock and run a full refresh when the last attempt is older than 90 s.

### T4. Interrupted pan swallows the next marker tap (medium-low)
- Where: `components/use-map-gestures.ts:27, 62, 87, 107-128`
- What: `mapDidPanRef` resets only when a click is suppressed; a gesture that ends without a click (`pointercancel`, release outside the window) leaves it set, so the user's next tap is eaten. Clearing at pointer end instead would break legitimate post-pan click suppression.
- How: replace the boolean with a pan timestamp consumed through a short window (400 ms); stale flags expire on their own.

### T5. History scrubber fires one request per keyboard step (low)
- Where: `components/HistoryControls.tsx:182-186`
- What: `onKeyUp={submitScrubber}` submits on every arrow press, fetching a snapshot per step and flashing "Loading…" between them.
- How: debounce keyboard submissions ~300 ms with an immediate flush on blur; keep pointer-up immediate.

### T6. Unbounded upstream bodies in the `/api/contexts` loaders (medium)
- Where: `platform/server-entry.js` warnings (:130), weather/coastal buoys (:265,:276), radar (:304), modelled air (:328), tides (:379-381), bathing locations (:441), NASA domains XML (:538), earthquakes (:646), aurora/Kp (:752,:759)
- What: raw `response.json()` / `.text()` bypasses the repo's own bounded-IO discipline used everywhere else (including `history-sources.js` twins of these collectors); a misbehaving upstream can buffer unbounded bytes before parse.
- How: route each through `readBoundedJsonResponse` / `readBoundedTextResponse` with caps mirroring `history-sources.js`.

### T7. `/api/living` serves degraded rivers under `no-store` whenever trains are down (medium)
- Where: `platform/cloudflare-entry.js:269-271`
- What: the header tier checks only `riverResult.status === "live"`; with Irish Rail down and rivers `partial`/`stale`/`fallback` (all carry data), `anyLive` is false and the payload ships `no-store`, defeating the degradation tiers exactly during the flakiest upstream's outage.
- How: treat any river status with readings (`live|partial|stale|fallback`) as usable for the partial tier.

### T8. Unhandled errors escape as bare 1101 pages on `/api/history` and `/api/living` (low-medium)
- Where: `platform/cloudflare-entry.js:264-266, 393-395, 400-402`
- What: the production adapter lacks the JSON error wrappers its twin has (`server-entry.js:1112-1127`), and the coordinator body parse sits outside the settled region, so a corrupt row or malformed coordinator body returns Cloudflare HTML instead of the JSON/CORS/no-store contract.
- How: mirror server-entry's try/catch wrappers; move `riverResponse.value.json()` into guarded handling that degrades to the unavailable fallback.

### T9. `captureCutoff` fallback is dead code (low)
- Where: `platform/cloudflare-entry.js:88-91`
- What: `Number(null)` is 0, so an absent/empty `captureBucketStartMs` returns epoch 0, never the fallback, silently recording empty captures; arbitrarily large future values are accepted too.
- How: treat null/empty/non-numeric/out-of-range as absent; bound against now.

### T10. XML entity decode order double-decodes `&amp;` sequences (low)
- Where: `platform/server-entry.js:77-84`
- What: `value()` replaces `&amp;` first, turning provider-escaped literal text into markup characters (train `PublicMessage`, status, direction); sibling `decodeHtml` does it correctly.
- How: reorder so `&amp;` is replaced last.

### T11. History point-query misses are edge-cached for 300 s (low)
- Where: `platform/history.js:389`
- What: a `snapshot: null` miss (normal right after deployment or an outage) becomes resolvable within minutes yet is cached `s-maxage=300`.
- How: branch cache headers on whether a snapshot resolved.

### T12. No-snapshot history response claims the wrong resolution (nit)
- Where: `platform/history-store.js:302-314,326`
- What: `resolutionMinutes` is overwritten every loop iteration, so misses report the last allowed resolution (e.g. 1440 for a raw-eligible query).
- How: keep the initialized value unless a candidate is selected.

### T13. Dead ternary branch and hardcoded attribution year (nit)
- Where: `platform/sky-source.js:410`, `platform/history-sources.js:567`
- What: `freshness === "future" ? "unavailable" : "unavailable"` collapses to one value; captured transit aggregates permanently record "© 2025 NTA".
- How: collapse the ternary; derive the year from the capture date.

### T14. Test static server cannot reproduce the branded 404 or per-path cache rules (low-medium)
- Where: `scripts/static-server.mjs:6-22,56-62`
- What: unknown extension-less paths fall back to `index.html` with 200 (soft 404), and the `_headers` parser keeps only the `/*` block, so no local test can exercise the round-1 branded 404 or the `/data/*`, `/social/*` rules.
- How: serve `404.html` with status 404; parse path-specific blocks (exact paths and trailing-`*` prefixes).

## UI/UX

### U1. Light theme dark-on-dark surfaces, batch two (high)
- Where: `app/globals.css` light block (~4580+) vs `.guidance-card` (+hover :1662/:1679), `.notable-signals button, .all-quiet` (:1123), `.history-result` (+`.error/.gap`, retry, link colors :3053-3087), `.history-comparison`/:3083, `.history-period-summary`/:3092, `.movement-browser`/:2116 + results/pagination buttons, `.timeline-selection`/:1721, `.official-notices-empty`/:1816, `.warning-key-facts dt` (#f1c76f literal :2649), `.history-ambiguity legend` (#f1c76f literal :3041)
- What: these keep hardcoded dark-navy backgrounds while text variables flip dark in light mode (≈1.2-2.5:1): activity guidance cards, notable signal buttons, history result/comparison/period summary, transport browser, timeline selection, empty-notices state.
- How: extend the existing `html[data-theme="light"]` overrides with light surfaces and remapped accent literals, following the round-1/2 pattern.

### U2. Map overlays unreadable in light mode (high)
- Where: `app/globals.css` `.map-notice`/:926, `.map-data-panel`/:1039 (+ `dl div` #101d33), `.live-signal-dock`/:970, `.radar-control` (rgba(9,23,41,.95))
- What: overlays sit on the now-light map canvas but keep dark backgrounds while their text uses flipped variables — the radar notice, grid/aurora/ISS panels and live-signal strip become invisible in light mode.
- How: light surfaces for these overlays matching the established light map language (as already done for `.map-navigation`).

### U3. ExplorePanel modal trap leaks (high)
- Where: `components/ExplorePanel.tsx:60-100`
- What: the keydown handler is scoped to the panel `<aside>`, the backdrop button sits outside it, and the app root is never inerted — once focus lands on the backdrop or behind the overlay, Tab walks the hidden page and Escape stops working.
- How: attach the keydown handler to `document` (the DetailCard pattern, `MapPanels.tsx:110+`) and extend the existing inert effect in `IrelandExperience.tsx:871-876` to cover the open panel.

### U4. Zoom readout still announces every step (medium)
- Where: `components/MapCanvas.tsx:123`
- What: `<output>` maps to ARIA role=status (implicit polite live region); wheel/pinch changes announce continuously despite the round-2 intent.
- How: render the percentage in a plain span (class `zoom-readout`), updating the CSS selectors that target `.map-navigation output`.

### U5. Cluster-count labels fail contrast in light mode (medium-low)
- Where: `app/globals.css:315-319, 869-875`
- What: near-black digits on `--green`/`--water-accent` circles whose fills flip darker in light mode (≈2.5-3:1); unlike sibling labels they have no stroke halo.
- How: give both label styles the same `paint-order: stroke` halo pattern as other marker text.

### U6. Heading level skip h1 → h3 (low)
- Where: `components/HistoryControls.tsx:147`
- What: "Now or past conditions" is an `h3` directly under the page `h1` and before any `h2`.
- How: demote to `h2` (id and styles unchanged).

### U7. Radar/satellite groups expose no accessible name (low)
- Where: `components/MapLayers.tsx:258,296`
- What: `aria-label` on a `<g>` without a role is ignored by most mappings, so the satellite image date is unreachable for screen readers.
- How: add `role="img"` to those groups (matching the root SVG pattern).

### U8. HTML validity odds and ends (nit)
- Where: `components/IrelandExperience.tsx:2885,2892`, `components/PlaceContext.tsx:117-146`
- What: `<div>` inside `<button>` (signal bars); `<small>` directly inside `dl > div` (only dt/dd allowed there).
- How: use a span (class styling unchanged, ensure display survives); move each note inside its `<dd>`.

## Other

### O1. Branded 404 page is indexable with a homepage canonical (low)
- Where: `app/not-found.tsx`
- What: it inherits root metadata wholesale, emitting the homepage canonical/description and `index: true`.
- How: add a robots noindex via metadata export (verify the emitted `out/404.html`; fall back to a React 19 hoisted meta tag if Next ignores metadata exports here).

### O2. `/map/*.json` geography ships with no caching rule (low-medium)
- Where: `public/_headers`
- What: `island.json`/`major-roads.json` get heuristic caching only, revalidating ~400 KB of build-stable bytes on repeat visits.
- How: add a `/map/*` rule with a bounded long max-age (7 days, matching `/social/*`).

### O3. Copy, privacy, and config honesty nits (nit bundle)
- Where: `lib/activity-guidance.ts:183` ("2 notices … its category does not change"), `app/privacy/page.tsx:21` (theme preference undisclosed), `app/about/page.tsx:22` (external link missing the site-wide `rel="noreferrer"` convention), `app/manifest.ts` (`theme_color` matches neither viewport color), `scripts/check-performance-budget.mjs` (declares `initialRequestBudget` but never enforces it)
- How: grammar agreement fix; one privacy clause; link attributes; align `theme_color` with the declared dark UI chrome; count script/style requests in the built index and fail over budget.

## Deliberate skips this round

| Item | Reason |
| --- | --- |
| Split the 642 KB main chunk / trim prerendered SVG | Rounds 1-2 skip stands: structural refactor needing measured budget work. |
| Hash-based CSP inline allowances | Round-1 skip stands: requires build-integrated header generation. |
| Rebuild transit dictionary from pinned GTFS | Round-1 skip stands (tracked in IMPLEMENTATION_REPORT.md). |
| Extract shared worker dispatch module | Round-1 skip stands; concrete divergences fixed directly (T7/T8). |
| Full isolation of the 1-second clock render | Round-2 skip stands; T3 removes the hidden-tab cost instead. |
| Cross-tab theme sync via storage events | Polish nit with no failure mode; not worth the surface area this round. |
| "(opens in a new tab)" announcements | Site-wide convention change across ~15 links for marginal SR value; Referrer-Policy already caps leakage. |
| Print styles | Out of scope for a live dashboard round; no reported need. |
| Maskable PNG icons | The icon's glyph relies on a named serif font that renders inconsistently through local rasterization; shipping unpredictable binaries is worse than the nit. `theme_color` alignment done instead. |

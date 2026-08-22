# Improvement Plan — Round 2 (2026-08-22)

Fresh-eyes review after the round-1 fixes (`315b9ae`). Every item below was verified against source before planning. Branch: `improve/review-2026-08-22`. Verification for all items: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.

## P0 — Technical correctness / data honesty

### T1. Sort hourly weather timeline chronologically
- Where: `lib/weather-timeline.js:34-39`
- What: buckets are emitted in `Map` insertion order; a station that first reports an early hour late in its array appends out-of-order hours (e.g. `…15:00, 07:00`). The chart and data table render array order as "Hour of day · Irish time".
- How: sort the mapped result by `time` (zero-padded `HH:MM`, lexicographic = chronological). Extend `tests/weather-timeline.test.mjs` with an out-of-order fixture.

### T2. Delete the dead Met Éireann CSV fallback fetch
- Where: `lib/browser-live.ts:366-386`
- What: when any prodapi endpoint fails, the client fetches the full met.ie CSV and parses it with `observedAt = null`; `parseLatestObservations` then marks every row `fresh: false` (`isWeatherObservationFresh(null)` → NaN) and line 393 filters them all out. Pure wasted bandwidth/parse in degraded conditions; removing it cannot change outcomes (`!valid.length` already retains last good).
- How: delete the block and `fallbackStations`; keep the `retainLastGoodWeather` early return keyed on `!valid.length`.

### T3. Make provider request generations monotonic
- Where: `lib/browser-live.ts:97-122`
- What: generations derive from the prior map entry, so after a completed request deletes itself the next request reuses the same number. A slow superseded request whose continuation runs after a newer one registered passes `isCurrent()`, stores a stale fallback into `lastProviderResults`, and deletes the live entry.
- How: module-scoped counter `let nextProviderGeneration = 0; generation: ++nextProviderGeneration;`

### T4. Filter stale trains on the `/api/living` path like transit does
- Where: `lib/browser-live.ts:557-564`
- What: transit vehicles get an individual 30-minute freshness gate client-side; trains are committed verbatim, so hour-old positions would render as-is if upstream regressed.
- How: filter `next.trains` with the existing `isRecent(train.observedAt, 30 * 60_000)` before `addCalculatedSpeeds`.

### T5. Don't publish grid as "live" with a destroyed timestamp; stop viewer-local time guessing
- Where: `lib/browser-live.ts:211-218, 674-681`
- What: if both parsers fail, `normalizeGridTimestamp` returns null but the payload still counts as valid, so one cycle publishes grid labelled live with `observedAt: null`. Also the `Date.parse` fallback interprets zoneless strings in the viewer's timezone.
- How: pass `Boolean(incomingGrid && incomingGrid.observedAt)` as the validity flag; restrict the parse fallback to strings carrying explicit zone info (`Z` or `±HH:MM`/`±HHMM`).

### T6. Validate bathing-alert rows and expire end-less alerts
- Where: `lib/browser-live.ts:223-231`
- What: rows cast to `BathingAlert` with only dates checked — a row missing `id` throws inside `mergeBathingAlerts`' `localeCompare` (contained by the blanket catch, silently degrading the whole contexts refresh). An alert without usable `endsAt` passes the freshness gate forever.
- How: require non-empty string `id` and `updatedAt`/`startedAt`; treat missing/unparseable `endsAt` as expiring 48 h after `startedAt` (server derives real ends from `expectedDuration`; this bounds malformed rows only).

### T7. Retry the transit destinations manifest after failure
- Where: `lib/browser-live.ts:37-53`
- What: the module-level promise caches failure for the page lifetime (`.catch(() => ({})`) — one transient network error permanently disables destination lookup.
- How: reset `transitDestinationsPromise = null` inside the rejection path so the next enrichment tick refetches.

### T8. Prototype-safe destination lookup
- Where: `lib/browser-live.ts:60`
- What: `destinations[vehicle.tripId]` resolves inherited members (`constructor`, `toString`, …) for externally-supplied trip IDs, putting a function object into UI text.
- How: `Object.hasOwn(destinations, vehicle.tripId)` guard.

### T9. Hoist the ISS Dublin-hour formatter out of the pass loop
- Where: `lib/browser-live.ts:835-837`
- What: `Intl.DateTimeFormat` constructed per completed pass inside `scanIssPasses`.
- How: module-level constant next to the other formatters.

## P1 — Platform

### S1. Add CORS headers to production living/transit responses
- Where: `platform/cloudflare-entry.js:10-29`
- What: `responseHeaders`, `partialHeaders`, `transitLiveHeaders`, `transitUnavailableHeaders` lack `access-control-allow-origin` while health/history/method endpoints send it — internally contradictory posture, opaque failures for third-party consumers exactly on the degraded endpoints most likely polled elsewhere.
- How: add `"access-control-allow-origin": "*"` (+ allow-methods/headers) to the four constants.

### S2. Share satellite discovery in flight
- Where: `platform/server-entry.js:778`
- What: `shareInFlight: false` means concurrent cold `/api/contexts` requests each run their own NASA availability + frame probe (1 GET + up to 7 HEADs); fastest route to the 100-subrequest cap under burst.
- How: drop the flag so `refreshContextSource` coalesces via `state.inFlight` like every other source; the resolver's own success/failure cache still prevents redundant work afterwards.

### S3. Cap the solar day cache
- Where: `platform/sky-source.js:221, 267`
- What: one entry per requested Dublin-day window grows unbounded over isolate lifetime.
- How: evict oldest inserted keys beyond 8 entries.

### S4. Harden the configured river bridge (round-1 follow-up)
- Where: `platform/server-entry.js:200-215`, `tests/review-fixes.test.mjs`
- What: (a) `startsWith("https://")` admits malformed URLs and the bridge fetch isn't wrapped, so a bad config value escapes as a bare TypeError instead of the contextual `OPW returned X … fallback unavailable` shape; (b) an ok-but-garbage bridge body throws the raw codec error with no OPW context.
- How: validate with `new URL()` (protocol https:, hostname present); wrap the whole bridge attempt in try/catch folding failures into the standard message. Extend tests: malformed URL rejected, garbage body yields contextual error.

### S5. Align alternate-adapter transit response with production semantics
- Where: `platform/server-entry.js:1019-1023`
- What: coordinator "stale" results carry vehicles but the alternate adapter sends them cacheable=nothing (`max-age=0`) with vehicles attached, while production strips non-usable vehicles and edge-caches live at s-maxage=60. Divergent caching/status vocabulary for the same endpoint.
- How: mirror production `transitResponse`: strip vehicles unless status is live/partial; live → `max-age=15, s-maxage=60`, partial → partial-tier 15/15, else no-store.

## P1 — UI/UX

### U1. Light-theme text palette (critical contrast cluster)
- Where: `app/globals.css` — hardcoded pale text colors used across themes: `#dffeff` (freshness chips 1484, timeline table th 2795, layer-group headings 1817, place summary 1757, dd values 1053, timeline-selection 1709, map-legend summary 1986), `#f7e5a5` (workspace facts 721, hero strongs 1055, station temperature 1066, rail metrics 698, pulse-card i 1171, live-signal-dock time 981), `#f4f7ff` (warning copy heads 2606, 2635), `#c7d2e2` (table td 2644, 2796), `#f8edd4` (official notices/warning badges 4007-4011). The light block (4474+) whitens these containers but never remaps the pale text → ≈1.1–1.4:1 unreadable.
- How: introduce custom properties (`--accent-ice`, `--accent-gold`, `--accent-warn-head`, `--accent-table-dim`, `--accent-cream`) defined in `:root` (current dark values) and overridden in `html[data-theme="light"]` with dark equivalents meeting AA on light surfaces. Replace **color usages only** — SVG fills/strokes/borders/filters/backgrounds stay hex. Verify each match site individually.

### U2. Light-theme form controls keep dark backgrounds with theme-flipped text
- Where: `app/globals.css:2109-2118` (.movement-browser-filters input/select), `2953-2956` (.history-mode-toggle), `2995-3007` (.history-picker input)
- What: `background: #071426` hardcoded with `color: var(--ink)`; dark theme `--ink: #f5efdf` works, light theme `--ink: #12251f` gives ~2:1 dark-on-dark.
- How: add `html[data-theme="light"]` overrides giving these controls light surfaces consistent with the rest of the light theme.

### U3. Light-theme hover/active overrides lose specificity to base rules
- Where: `app/globals.css:4588` vs base `.section-nav a:hover` (3565), `.layer-list > button.active` (1320, 4162), `.panel-presets button.active` (2178)
- What: `html[data-theme="light"] :where(...)` computes (0,1,1) and is beaten by (0,2,1)/(0,2,2) base rules — hover/active feedback stays invisible translucent-white on white cards.
- How: drop `:where()` from the hover/active rule so it inherits `[data-theme="light"]` specificity; extend the selector list with `.panel-presets button.active`, `.source-directory a:hover/:active`, `.section-nav a[aria-current="location"]`.

### U4. Restore page scrolling over the map at scale 1
- Where: `app/globals.css:728-737`, `components/use-map-gestures.ts`
- What: `touch-action: none` blocks native scrolling over the full-width mobile map even at scale 1 where drags do nothing (constrain clamps x/y to 0) — a large dead scroll zone at the top of the page.
- How: `.ireland-map { touch-action: pan-y }` and `.ireland-map.is-zoomed { touch-action: none }` (the class already toggles by scale). Wheel zoom keeps preventDefault; +/- buttons unaffected.

### U5. Always capture pointers on the SVG root
- Where: `components/use-map-gestures.ts:63-72`
- What: drags starting on markers skip `setPointerCapture`; releasing outside the SVG leaks the pointer id and keeps panning until another click lands on the SVG.
- How: capture unconditionally (keep try/catch); pointer capture retargets pointer events, not the derived click, so marker activation survives and `suppressClickAfterPan` still guards accidental pans.

### U6. Prevent iOS zoom-on-focus (inputs < 16px)
- Where: `app/globals.css:2109-2118` (search/type inputs, no font-size → ~13.3px default), `2995-3007` (.history-picker input at .875rem = 14px)
- What: iOS Safari auto-zooms the viewport when focusing sub-16px text inputs.
- How: set `font-size: 1rem` on movement-browser-filters input/select; raise history-picker input to 1rem.

### U7. Heading order: h1 arrives after several h2s
- Where: `components/WorkspaceHeading.tsx:22` (h1 mounted at IrelandExperience.tsx:2676) vs earlier `<h2>`s (map stage 2235, panels)
- What: heading navigation hits h2s first and the page title mid-page.
- How: promote the map-stage heading to the page's `<h1>` ("Ireland on the map" → becomes the document title heading) and demote WorkspaceHeading's h1 to an h2, preserving visual styling via CSS. Check `aria-labelledby`/copy-style tests referencing moment-heading.

### U8. Remove aria-live from the detail dialog root
- Where: `components/MapPanels.tsx:126`
- What: the whole dialog announces politely on every internal change (typing, paging, ~65 s background refresh ticks).
- How: remove `aria-live`; focus management and the stack counter already cover state changes.

### U9. Stop announcing every wheel-tick zoom change
- Where: `components/MapCanvas.tsx:123`
- What: `<output aria-live="polite">` streams announcements during pinch/wheel gestures.
- How: drop `aria-live` (visual output; zoom buttons remain keyboard-accessible).

### U10. Keep volatile clock text out of the atomic live-status region
- Where: `components/IrelandExperience.tsx:2147-2166`
- What: `aria-atomic="true"` re-reads the whole strip including `Checked HH:MM:SS` roughly every refresh (~65 s).
- How: scope role/aria-live/aria-atomic to the state spans only; move `<time>` outside the live region (CSS unchanged visually).

### U11. Radar notice: announce transitions, not tile events
- Where: `components/IrelandExperience.tsx:2287-2294` (detail built at 1446-1476)
- What: long notice sentences re-announced per radar tile load event.
- How: remove aria-live from the visible notice; add a visually-hidden polite region that announces once per coarse transition (loading → partial/live/unavailable).

### U12. Dismiss control meets target size on all viewports
- Where: `app/globals.css:934-944` (44px only ≤600px)
- What: map-notice close button ≈16×18px on desktop/tablet.
- How: apply ≥24px hit area (with spacing to reach ~44px) unconditionally.

### U13. History error gets a retry affordance
- Where: `components/HistoryControls.tsx:125-129, 190-193`
- What: errors render prose only; the scrubber guard blocks same-value resubmission, so there is no recovery path.
- How: "Try again" button beside the error paragraph calling `onRequest` for the currently selected time and clearing `submittedScrubberRef` so slider resubmission works too.

### U14. Brand subtitle degrades honestly
- Where: `components/IrelandExperience.tsx:2145`
- What: "Live island view" persists while offline/cached — the one label that never downgrades in an otherwise honest interface.
- How: derive from `serviceDisplayState` like the adjacent chip ("Saved island view" when cached/offline, "Island view" when unavailable; keep "Live island view" for live/connecting/partial).

### U15. Clean up share-button timers
- Where: `components/IrelandExperience.tsx:2091, 2097`
- What: `setTimeout(setShareStatus("idle"), 1800)` handles never stored/cleared → setState after unmount.
- How: store handles in a ref, clear in an unmount effect and before setting anew.

### U16. Move the radar frame-key ref mutation out of render
- Where: `components/IrelandExperience.tsx:1315`
- What: top-level side effect in the render body; unsafe under concurrent rendering.
- How: assign inside `useEffect` (consumers are async callbacks that run post-commit).

### U17. Throttle history.replaceState during pan
- Where: `components/IrelandExperience.tsx:1790-1816`
- What: effect depends on `mapView` identity → dozens of replaceState calls per drag gesture.
- How: trailing debounce (~150 ms) keyed off serialized view; flush on cleanup.

### U18. Raise content-bearing micro-copy off ~9px
- Where: `app/globals.css` — `.guidance-status` (.55rem, 1666), `.guidance-reason/.caveat` (.61rem, 1682), `.layer-group-heading p` (.59rem, 1826), `.movement-results small` (.6rem, 2144), `.workspace-facts small` (.6rem, 722), `.map-navigation output` (.55rem, 766)
- What: statuses/caveats/provider notes at 8.8–9.8px despite the stylesheet's own declared 12px practical floor.
- How: raise these content-bearing selectors to ≥ .72rem (~11.5px); leave decorative repetition alone.

### U19. Decorative SVG groups hidden from the accessibility tree
- Where: `components/IrelandExperience.tsx:2346-2350` (road-network `role="img"`), sun/day-arc/night-shade shapes, duplicated describedby vs MapCanvas.tsx:57
- What: decoration announced as images inside an already-described map; doubled descriptions.
- How: `aria-hidden="true"` on road-network/day-arc/sun/night-shade groups; keep svg-level describedby on one element only.

## Deferred (not in this round)

| Item | Reason |
| --- | --- |
| Split the 642 KB main chunk / trim prerendered SVG | Round-1 skip stands: structural refactor of a live product needing measured budget work (`check:budgets`, Playwright perf suite). |
| CSP hash-based inline allowances | Round-1 skip stands: Next static export injects build-varying inline scripts; needs build-integrated header generation. |
| History bucket recovery / late-capture rollup resync / writeSnapshot race | D1/cron recovery policy needs production verification and its own PR; unit tests can't exercise delayed-event delivery faithfully here. |
| Drop redundant `history_snapshots_time` index | Needs a new applied migration; bundling an unapplied migration file creates deploy ambiguity. Defer to the next planned migration wave. |
| `resolveHistory` serial D1 round-trips | Query-shape change needing real-D1 latency measurement. |
| Full memoization/isolation of the 1-second clock re-render | Contained memoization of the expensive derivations is included where trivially safe; moving the clock to leaf components touches the whole 2,961-line tree — separate effort. |
| Rebuild transit dictionary from pinned GTFS | Round-1 skip stands (tracked in IMPLEMENTATION_REPORT.md). |
| Extract shared worker dispatch | Round-1 skip stands; symptoms fixed directly (S5 closes another divergence instance). |

## Implementation order

1. Technical batch (T1-T9) + tests → commit.
2. Platform batch (S1-S5) + tests → commit.
3. UI/UX CSS batches (U1-U3, U6, U12, U18) → commit.
4. UI/UX component batches (U4-U5, U7-U11, U13-U17, U19) → commit.
5. Full verification suite; append log.

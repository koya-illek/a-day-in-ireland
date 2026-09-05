# September experience changes

The first screen introduces the national portrait and lets visitors find their
area before exploring layers. The map and presets remain the central interaction.
Secondary source counts, historical gaps and comparison controls use disclosures.

Map symbols retain their screen size while geographic positions follow the map.
National views show fewer stations and city labels; zoom reveals more. Temperature
is a line and rainfall uses bars with shared colour tokens. The hourly view starts
at the latest observations and provides explicit start/latest controls and a table.

Town search uses GeoNames populated places with a reported population of at least
500 in Ireland and Northern Ireland. `python3 scripts/build-places.py` refreshes
`lib/towns.json` explicitly. The initial September directory contains 663 entries;
existing city IDs remain stable. GeoNames data is CC BY 4.0 and attributed beside
the picker. Town-centre coordinates locate nearby readings, not a county-wide
measurement. The directory is not a complete gazetteer of every settlement.

Morning comparisons match station or gauge IDs and require increasing observation
timestamps and usable source states. They label capture time and gaps and do not
claim a change is unusual. Grid comparisons use percentage points. A missing or
daily-only morning record cannot support this comparison. The saved HTML briefing
contains national facts, provenance times and current/historical status. It omits
visitor coordinates and does not claim to update after download.

The drawer, comparison UI and saved-briefing writer load on demand. Orbital code
loads after the context response requires a prediction. Map presets and orbital
calculation have separate modules; styling for the daily layout is in
`app/experience.css`, with superseded rules removed from `globals.css`.

The product remains an independent public-data portrait. It links to official
sources for specialist weather, transport and safety decisions. No visitor study or external alert installation is included in these changes.

## Short visitor study

Use three to five volunteers after arranging consent. Ask each person to:

1. Explain what is happening in Ireland today after viewing the first screen.
2. Find a town and identify how far away its weather observation was measured.
3. Find yesterday's available conditions and explain what transport history lacks.
4. Save or share one useful fact and identify when it was observed.

Record completion, misunderstandings and whether the person would return tomorrow.
Ask what they would return for before suggesting features. Do not collect precise
location or unnecessary personal information. No participants have been contacted
and no visitor-research results are claimed.

## Alternate living atlas, September 2026

The `/v2` preview gives the map and a contextual reading panel the first screen.
The original `/` remains available. Links between the two retain the selected
town, theme, zoom and historical time. Neither version becomes a saved preference;
visitors can compare both without replacing their usual entry point.

The atlas uses an Atlantic map, an off-white reading surface and amber time
selection. Weather, Movement and Water are the main themes. The reading panel
separates the national portrait, nearby observations, an equivalent searchable map
list and source status. Map selections update this panel without a desktop modal.
On mobile, an explicit reading-sheet control expands and collapses the details.
Covered map content becomes inert while the sheet is expanded; visible search and
theme controls remain available. Panel navigation returns the reading scroll to
the start of the selected subject.

History explains retained subjects before the date controls. Movement opens
recorded feed totals instead of an empty vehicle map, while weather can show
retained observations and the hourly chart. Missing retained values remain
unavailable. Orange and red official notices open by default; lower-level notices
show their headline and expand to their original scope, timing and source text.
The same source rules power both modes. A concise overview, matched-source morning
comparison, electricity, official outlook and daylight remain in the reading pane.

Sharing a selected v2 reading includes its public provider ID and the current
view. It resolves against observations available when the link is opened; a live
reading can expire and is not a frozen archive. GPS coordinates remain excluded.
The existing escaped HTML briefing export is available in v2. Both routes retain
source attributions and link to full licences and methodology.

The controller, normalisation, map geometry and historical APIs are shared.
`components/atlas/AtlasFrame.tsx` owns the alternate presentation and its mobile
sheet; its CSS module loads with that presentation. No new data store, feed or
tracking service was introduced. The shared chart now gives the hour buttons and
temperature line the same horizontal extent. Hidden maps retain their last
non-zero dimensions so returning from aggregate history cannot inflate markers.

Validation covers real-feed browser paths at 390, 768 and 1440 pixels, marker and
list selection, town lookup, reading links, briefing download contents, historical
movement totals, chart alignment, and targeted accessibility states. Existing
shared-link and modal-focus checks protect the original. This remains a design
comparison, with no visitor research results or preference tracking claimed.

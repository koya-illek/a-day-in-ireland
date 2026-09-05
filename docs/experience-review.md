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
sources for specialist weather, transport and safety decisions. No deployment,
visitor study or external alert installation is included in these local changes.

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

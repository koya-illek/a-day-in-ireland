# A Day in Ireland visual system

Preserve the editorial portrait: serif display and forecast copy, sans-serif controls, monospace measurements. The original uses moss/sea themes; v2 pairs a teal geographic canvas with a warm-paper reading surface.

## Surface contracts
- Original components consume `--panel`, `--ink`, `--muted` and `--surface-line` together. Recovery controls own a matched panel/ink pair, never an accent inherited on a legacy surface.
- Atlas owns `--atlas-paper`, `--atlas-ink`, `--atlas-line`, `--atlas-sea` and `--atlas-sea-panel`; its shared cards inherit these surfaces rather than the original theme.
- Forecast prose is capped at 72ch. Functional Atlas captions are at least 12px; touch controls at least 44px high.
- Temperature and rain axes remain outside the horizontally scrolling hourly data.

## Interaction and data truth
Local observations lead after selecting a place; national background remains explicitly Across Ireland. Selecting a town does not expand the phone sheet; Read more is deliberate. Source status and retry remain reachable during feed failure. Preserve current/modelled/stored distinctions, coverage caveats and official-source links. Layers is a named custom dialog with inert background and tested focus containment/restoration.

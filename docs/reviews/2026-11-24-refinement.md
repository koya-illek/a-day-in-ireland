# Review refinements, 24 November 2026

Applied the confirmed original/Atlas findings while preserving both visual systems:

- Layers uses a valid generic dialog container, retaining tested inert background, keyboard containment and opener focus restoration.
- Refresh and local-reading panels use matched semantic surfaces in both themes.
- Fixed the duplicated distance suffix; selected-place briefing leads, with separate Across Ireland national background and progressive coverage/activity disclosures.
- Hourly scales stay outside the scrollable data; values-list and per-hour controls remain.
- Forecast and footer prose have a 72ch measure.
- Atlas functional captions/timestamps have a 12px floor, primary touch controls a 44px floor. Wind detail remains available through readings without tiny duplicate speed annotations.
- Selecting a town leaves the phone map visible. Expansion is an explicit Read more action. Feed failures expose retry/source status even in the collapsed sheet.
- Atlas palette ownership is documented in DESIGN.md and shared surface tokens; removed unused preset/plot selectors.

Release reconciles newer GitHub dependencies, preserving remote history. Kept webpack output and existing (unchanged) size budgets. Provider acquisition and secondary reading UI load after hydration; native document links avoid unnecessary client-router/prefetch overhead for static destinations. This is not a framework downgrade or budget waiver.

Unrelated uncommitted transit-cache work remains in the original working copy and is not included in this release. No provider credentials or infrastructure access changed.

# A Day in Ireland 2.0

A living, near-real-time portrait of weather, water and movement across Ireland.

## Data

- Met Éireann observations and warnings, licensed under CC BY 4.0.
- Marine Institute Irish Weather Buoy Network observations, licensed under CC BY 4.0.
- Iarnród Éireann current train positions.
- OPW near-real-time river gauges, licensed under CC BY 4.0.
- TII traffic-counter locations and latest signed-off average annual daily traffic, licensed under CC BY 4.0.
- Solar position and daylight state are calculated locally.

Live weather refreshes every five minutes, train positions every minute, and OPW river levels are refreshed on a fifteen-minute upstream cache. TII AADT is context rather than live congestion. Missing or stale values are not represented as zero.

## Development

```bash
npm install
npm run dev
npm test
npm run test:e2e
npm run build
```

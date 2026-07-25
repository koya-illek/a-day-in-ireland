# A Day in Ireland 2.0

A living, near-real-time portrait of weather, water, energy and movement across Ireland.

## Data

- Met Éireann observations, warnings and five-minute rainfall-radar tiles, licensed under CC BY 4.0.
- Marine Institute offshore weather buoys and coastal observatories, licensed under CC BY 4.0.
- Iarnród Éireann current train positions.
- OPW near-real-time river gauges, licensed under CC BY 4.0.
- EirGrid all-island operational demand, generation, wind, carbon, frequency and interconnection data.
- Open-Meteo air-quality fields derived from the CAMS regional model. These are labelled as model estimates, not sensor readings.
- NOAA SWPC OVATION aurora probability and planetary K-index guidance.
- Solar position and daylight state are calculated locally.

Weather, radar and the additional island contexts refresh every five minutes; train positions refresh every minute. OPW normally publishes river levels about every fifteen minutes, and deployed readings automatically expire after three hours if an upstream refresh is unavailable. Marine observations expire after six hours. Missing or stale values are not represented as zero.

## Development

```bash
npm install
npm run dev
npm test
npm run test:e2e
npm run build
```

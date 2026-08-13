# A Day in Ireland 2.0

A living, near-real-time portrait of weather, water, energy and movement across Ireland.

## Data

- Met Éireann observations, warnings and five-minute rainfall-radar tiles, licensed under CC BY 4.0.
- Marine Institute offshore weather buoys, coastal observatories, real-time tide gauges, predicted high/low water and storm-surge guidance, licensed under CC BY 4.0.
- Iarnród Éireann current train positions.
- OPW near-real-time river gauges, licensed under CC BY 4.0.
- EirGrid all-island operational demand, generation, wind, carbon, frequency and interconnection data.
- EEA up-to-date monitoring-station air quality, alongside Open-Meteo fields derived from the CAMS regional model. Measurements and model estimates are explicitly distinguished.
- NOAA SWPC OVATION aurora probability and planetary K-index guidance.
- EPA active bathing-water restrictions and advisories, licensed under CC BY 4.0.
- NASA GIBS VIIRS near-real-time true-colour imagery.
- USGS detected earthquakes from the previous seven days around Ireland.
- CelesTrak ISS orbital elements, with 48-hour passes calculated locally for central Ireland.
- NTA GTFS-Realtime vehicle positions when an `NTA_API_KEY` production environment variable is configured.
- Sunrise-Sunset.org API v2 sunrise, twilight, golden/blue-hour, solar-position and lunar events for the Ireland centre point, with visible attribution. The Worker fetches a short Dublin-date window, not a whole calendar year.
- Met Éireann live national text forecast, shown verbatim with the current official warnings feed.

Weather, radar and the additional island contexts refresh every five minutes; train positions refresh every minute. OPW normally publishes river levels about every fifteen minutes, and deployed readings automatically expire after three hours if an upstream refresh is unavailable. Marine observations expire after six hours. Missing or stale values are not represented as zero.

The NTA integration is credential-aware: without `NTA_API_KEY`, the UI explains that developer access is required and never substitutes scheduled or historical positions. Create a free key at [developer.nationaltransport.ie](https://developer.nationaltransport.ie/), then store it as an encrypted deployment secret.

## Cloudflare deployment

The Cloudflare production architecture uses:

- Pages for the static export in `dist/client`.
- A Worker custom domain on `day.illek.ie` that serves the API and edge-caches the Pages origin. This lets Cloudflare provision DNS without a separate DNS-write credential.
- A SQLite-backed Durable Object as the single global NTA refresh coordinator.
- A 65-second upstream refresh floor and 60-second edge response cache, satisfying the NTA token limit across Cloudflare locations.
- Independent weather, living and context state merges plus two-attempt browser refreshes prevent a single slow upstream from clearing unrelated healthy layers. Failed providers are marked unavailable instead of being kept live by a stale whole-response cache.
- Browser-side EEA monitoring-station retrieval, keeping heavy CSV processing outside the Worker context endpoint.
- Direct OPW river retrieval where supported, with a globally coordinated 15-minute Cloudflare Browser Run fallback because `waterlevel.ie` currently rejects ordinary Cloudflare Worker HTTPS requests with a contradictory-scheme proxy error.
- The non-Cloudflare server adapter uses the hosted OpenAI river bridge for that same OPW fallback; treat that bridge as an operational dependency rather than an origin of truth for the data.

The checked-in Worker candidate is configured for Workers Paid, with one direct `*/15` history Cron and a 1,000 ms CPU ceiling. This describes the local deployment configuration only; it does not imply that the candidate has been deployed. Requests on the custom hostname pass through the Worker, while immutable Next.js assets are cached for a year at the edge and HTML is cached for five minutes. The direct `pages.dev` origin remains available as a fallback.

The Pages origin is configured as `PAGES_ORIGIN` in `wrangler.api.toml` so changing the Pages project does not require editing the Worker source.

The `/api/living` response includes `sourceStatus` and `sourceProvenance` for rail and river feeds. River provenance distinguishes direct OPW data, the Cloudflare Browser Run fallback, the hosted bridge fallback, cached stale data, and an unavailable source.

```bash
npm run build
npm run deploy:cloudflare:api
npx wrangler secret put NTA_API_KEY --config wrangler.api.toml
npm run deploy:cloudflare:pages
```

Never place the NTA key in `wrangler.api.toml` `[vars]`, `.dev.vars` committed to git, `.env`, or source control. For local Worker runs, copy `.dev.vars.example` to `.dev.vars`. For production, use `wrangler secret put` so Cloudflare stores the encrypted secret.

## Development

```bash
npm install
npm run dev
npm test
npm run test:e2e
npm run build
```

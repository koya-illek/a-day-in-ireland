import InfoPage from "../../components/InfoPage";
import { infoPageMetadata } from "../../lib/info-metadata";

export const metadata = infoPageMetadata({
  title: "Data & methodology",
  description: "Sources, update intervals and interpretation used by A Day in Ireland.",
  path: "/data"
});

const sources = [
  ["Met Éireann", "Weather observations, official warnings and five-minute rain radar", "https://www.met.ie/about-us/specialised-services/open-data"],
  ["Iarnród Éireann", "Current train positions, service direction and public messages", "https://api.irishrail.ie/realtime/"],
  ["Transport for Ireland / NTA", "GTFS-Realtime public-transport vehicle positions", "https://developer.nationaltransport.ie/"],
  ["OPW waterlevel.ie", "Near-real-time river and water-level gauges", "https://waterlevel.ie/page/api/"],
  ["Marine Institute", "Weather buoys, coastal observatories, tide gauges and predictions", "https://erddap.marine.ie/erddap/index.html"],
  ["EirGrid", "All-island demand, generation, wind, carbon, frequency and interconnection", "https://www.smartgriddashboard.com/"],
  ["EEA and Open-Meteo CAMS", "Measured and explicitly labelled modelled air quality", "https://open-meteo.com/en/docs/air-quality-api"],
  ["EPA", "Current bathing-water alerts", "https://data.epa.ie/api-list/bathing-water-open-data/"],
  ["NOAA", "Aurora forecast guidance", "https://www.swpc.noaa.gov/products/aurora-30-minute-forecast"],
  ["NASA GIBS", "Latest complete daylight satellite imagery", "https://earthdata.nasa.gov/gibs/"],
  ["CelesTrak", "Orbital elements used to calculate ISS positions and passes", "https://celestrak.org/NORAD/elements/"],
  ["USGS", "Seismic detections around Ireland", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/"],
  ["Sunrise-Sunset.org", "Authoritative Dublin sunrise, twilight and lunar events", "https://sunrise-sunset.org/api"],
  ["Met Éireann live text forecast", "Official national forecast copy; displayed verbatim with current notices", "https://data.gov.ie/dataset/met-eireann-live-text-forecast-data"],
  ["OpenStreetMap", "Road and island boundary context", "https://www.openstreetmap.org/copyright"]
] as const;

export default function DataPage() {
  return (
    <InfoPage
      current="data"
      sectionLabel="Data & methodology"
      title="What the map knows, and what it does not."
      introduction="A Day in Ireland combines sources with different meanings and update schedules. The interface keeps observations, models, forecasts and local calculations distinct."
    >
      <section>
        <h2>Freshness</h2>
        <p>Weather and movement are checked roughly every minute where provider limits allow. Radar is normally issued every five minutes. Solar events use a bounded Dublin-day response and are reused for the current date. The official text forecast follows its issued timestamp and a short official-feed cache. Marine, river, tide, air-quality and grid sources update on their own schedules and may be delayed.</p>
        <p>A timestamp describes the underlying observation or model time whenever the source provides one. Irish Rail positions are stamped at refresh because the realtime XML has no per-train observation clock. A service can be online while an individual measurement is older than expected.</p>
      </section>
      <section>
        <h2>River acquisition</h2>
        <p>OPW gauge readings are requested from waterlevel.ie. When that origin rejects ordinary Cloudflare Worker requests, the Worker may use Cloudflare Browser Run or a hosted bridge as a temporary fetch path. Those fallbacks are labelled in the interface; they do not change the meaning of the OPW levels, and they are not a second dataset.</p>
      </section>
      <section>
        <h2>Historical coverage and retention</h2>
        <p>History is collected every 15 minutes once collection begins. Fifteen-minute snapshots, the raw history tier, not copies of every provider payload, are kept for 30 days. Hourly rollups are kept for 12 months, and daily summaries are retained thereafter.</p>
        <p>Exact cross-provider playback begins when collection starts. Missing provider observations and collection gaps remain missing; they are never inferred as zero. Hourly rollups and daily summaries describe the available observations rather than recreating every value that was visible at the time.</p>
        <p>Transport history contains only national or route-level NTA summaries. It does not retain raw train or public-transport vehicle positions, vehicle identifiers or public messages. Radar and satellite image bytes are not archived, so historical imagery is not guaranteed.</p>
        <p>Solar events and official forecast text are not retained in history v1; a historical view exposes an explicit gap rather than substituting today&apos;s sky or forecast.</p>
        <p>Historical Iarnród Éireann / Irish Rail data is not retained while permission for archival and derivative display remains pending.</p>
      </section>
      <section>
        <h2>Calculated values</h2>
        <p>Transport speeds marked with ≈ are estimated from the distance and elapsed time between successive positions. Unrealistic jumps are rejected. ISS passes are calculated locally from published orbital elements. Neither should be treated as a provider-issued measurement.</p>
      </section>
      <section>
        <h2>Safety and limitations</h2>
        <p>River readings are gauge measurements, not flood warnings. Tide levels are not coastal-flood forecasts. Modelled air quality is regional guidance rather than a local sensor reading. Solar times describe astronomical events, not visibility. Aurora probability is not a promise of visibility. This project is not suitable for safety-critical decisions.</p>
      </section>
      <section>
        <h2>Sources</h2>
        <div className="source-directory">
          {sources.map(([name, purpose, url]) => (
            <a href={url} key={name} target="_blank" rel="noreferrer">
              <b>{name}</b>
              <span>{purpose}</span>
              <i aria-hidden="true">↗</i>
            </a>
          ))}
        </div>
      </section>
      <section>
        <h2>Attribution</h2>
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Met Éireann forecast copy is shown verbatim after safe markup/entity normalization and is displayed with current official warnings. Sunrise and lunar events are attributed to <a href="https://sunrise-sunset.org/" target="_blank" rel="noreferrer">Sunrise-Sunset.org</a>. Contains Irish Public Sector Information from waterlevel.ie, the Marine Institute and EPA. Road and boundary data © OpenStreetMap contributors, ODbL.</p>
        <p>
          Contains NTA GTFS data © 2025 NTA, licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. Source: <a href="https://developer.nationaltransport.ie/" target="_blank" rel="noreferrer">NTA Developer Portal</a>. The data is aggregated and normalized by A Day in Ireland; changes were made. GTFS data is provided “as is”, and NTA is not responsible for errors or inaccuracies. A Day in Ireland is independent and is not endorsed by NTA.
        </p>
      </section>
    </InfoPage>
  );
}

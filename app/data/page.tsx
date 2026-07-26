import type { Metadata } from "next";
import InfoPage from "../../components/InfoPage";

export const metadata: Metadata = {
  title: "Data & methodology",
  description: "Sources, update intervals and interpretation used by A Day in Ireland.",
  alternates: { canonical: "/data" }
};

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
  ["OpenStreetMap", "Road and island boundary context", "https://www.openstreetmap.org/copyright"]
] as const;

export default function DataPage() {
  return (
    <InfoPage
      eyebrow="Data & methodology"
      title="What the map knows—and what it does not."
      introduction="A Day in Ireland combines sources with different meanings and update schedules. The interface keeps observations, models, forecasts and local calculations distinct."
    >
      <section>
        <h2>Freshness</h2>
        <p>Weather and movement are checked roughly every minute where provider limits allow. Radar is normally issued every five minutes. Marine, river, tide, air-quality and grid sources update on their own schedules and may be delayed.</p>
        <p>A timestamp describes the underlying observation or model time whenever the source provides one. A service can be online while an individual measurement is older than expected.</p>
      </section>
      <section>
        <h2>Calculated values</h2>
        <p>Transport speeds marked with ≈ are estimated from the distance and elapsed time between successive positions. Unrealistic jumps are rejected. ISS passes are calculated locally from published orbital elements. Neither should be treated as a provider-issued measurement.</p>
      </section>
      <section>
        <h2>Safety and limitations</h2>
        <p>River readings are gauge measurements, not flood warnings. Tide levels are not coastal-flood forecasts. Modelled air quality is regional guidance rather than a local sensor reading. Aurora probability is not a promise of visibility. This project is not suitable for safety-critical decisions.</p>
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
        <p>Copyright Met Éireann; source met.ie; CC BY 4.0; presentation modified. Contains Irish Public Sector Information from waterlevel.ie, the Marine Institute and EPA. NTA GTFS data is licensed under CC BY 4.0, provided “as is”, and the NTA is not responsible for errors or inaccuracies. Road and boundary data © OpenStreetMap contributors, ODbL.</p>
      </section>
    </InfoPage>
  );
}

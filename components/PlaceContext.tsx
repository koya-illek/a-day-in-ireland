import type { AirQualityReading, RiverReading, StationReading } from "../lib/types";
import { formatIrelandHistoryTime } from "../lib/history";
import {
  formatAge,
  formatDistance,
  NEARBY_RADIUS_KM,
  type NearbyReading,
  type Place,
  type TimeMode
} from "./experience-model";

const formatLocalObservation = (
  provider: string,
  item: { name: string; observedAt: string | null },
  distanceKm: number,
  now: Date,
  historical = false
) => {
  const timing = historical
    ? item.observedAt
      ? `observed ${formatIrelandHistoryTime(item.observedAt)}`
      : "observation time unavailable"
    : formatAge(item.observedAt, now);
  return `${provider} · ${item.name} · ${formatDistance(distanceKm)} · ${timing}`;
};

export function PlaceContext({
  selectedPlace,
  selectedPlaceIsEphemeral,
  placeOptions,
  placeMessage,
  onChoosePlace,
  onLocate,
  localStation,
  localRiver,
  localAir,
  timeMode,
  isConnectingWithoutSnapshot,
  online,
  weatherAvailable,
  riversAvailable,
  riversCached,
  airAvailable,
  weatherGap,
  riverGap,
  airGap,
  now
}: {
  selectedPlace: Place;
  selectedPlaceIsEphemeral: boolean;
  placeOptions: Place[];
  placeMessage: string;
  onChoosePlace: (placeId: string) => void;
  onLocate: () => void;
  localStation: NearbyReading<StationReading> | null;
  localRiver: NearbyReading<RiverReading> | null;
  localAir: NearbyReading<AirQualityReading> | null;
  timeMode: TimeMode;
  isConnectingWithoutSnapshot: boolean;
  online: boolean;
  weatherAvailable: boolean;
  riversAvailable: boolean;
  riversCached: boolean;
  airAvailable: boolean;
  weatherGap: string | null;
  riverGap: string | null;
  airGap: string | null;
  now: Date;
}) {
  const placeControls = (
    <>
      <label htmlFor="place-select">Nearby context</label>
      <div className="place-controls">
        <select id="place-select" value={selectedPlace.id} onChange={(event) => onChoosePlace(event.target.value)}>
          {selectedPlaceIsEphemeral && <option value="nearby">Your area · this session</option>}
          {placeOptions.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
        </select>
        <button type="button" className="locate-button" onClick={onLocate}><span aria-hidden="true">⌖</span> Use my location</button>
      </div>
      <small id="place-message" aria-live="polite">{placeMessage || "Saved as a place ID; GPS coordinates are never stored or shared."}</small>
      <small className="place-limits">{selectedPlaceIsEphemeral
        ? "Session-only location: nearest available readings are shown with distance; the share link remains an Ireland view."
        : `Nearby limits: weather ${NEARBY_RADIUS_KM.weather} km · rivers ${NEARBY_RADIUS_KM.river} km · air ${NEARBY_RADIUS_KM.air} km.`}</small>
    </>
  );

  return (
    <section
      className={`place-context ${selectedPlace.id === "island" ? "island-context place-context-compact" : "local-context"}`}
      data-place-id={selectedPlace.id}
      aria-labelledby="my-place-heading"
    >
      {selectedPlace.id === "island" ? (
        <div className="place-picker place-picker-compact">
          <div className="place-compact-copy">
            <p className="utility-label">My Place</p>
            <h2 id="my-place-heading">What’s it like near you?</h2>
            <p className="place-context-summary">Choose a place or use your location for nearby weather, river and air observations.</p>
          </div>
          <div className="place-compact-controls">{placeControls}</div>
        </div>
      ) : (
        <>
          <div className="place-picker">
            <p className="utility-label">My Place</p>
            <h2 id="my-place-heading">{selectedPlace.name}</h2>
            <p className="place-context-summary">{selectedPlaceIsEphemeral
              ? "Nearest available observations to the coordinates you shared for this session. Distances are shown so far-away readings are never presented as local."
              : `Nearby observations for ${selectedPlace.name}. Each source has its own radius; outside it, no local reading is shown.`}</p>
            {placeControls}
          </div>
          <div
            className="place-observations"
            aria-label={timeMode === "past" ? `Historical local observations near ${selectedPlace.name}` : `Local observations near ${selectedPlace.name}`}
          >
            <p className="utility-label">{timeMode === "past" ? `Historical local observations near ${selectedPlace.name}` : `Local observations near ${selectedPlace.name}`}</p>
            <dl>
              <div>
                <dt>Temperature</dt>
                <dd><span className="place-observation-value">{localStation?.item.temperature ?? "Unavailable"}°</span>
                <small>{localStation
                  ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now, timeMode === "past")
                  : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} weather observations…` : timeMode === "past" ? weatherGap ?? `No point weather observation was retained within ${NEARBY_RADIUS_KM.weather} km for this historical record.` : !online ? "Offline; saved weather is not used as a current nearby condition." : weatherAvailable ? selectedPlaceIsEphemeral ? "No current weather observation is available." : `No nearby weather observation within ${NEARBY_RADIUS_KM.weather} km.` : "Weather observations are unavailable; nearby conditions cannot be assessed."}</small>
              </dd>
              </div>
              <div>
                <dt>Rain</dt>
                <dd><span className="place-observation-value">{localStation?.item.rainfall == null ? "Unavailable" : `${localStation.item.rainfall} mm`}</span>
                <small>{localStation
                  ? formatLocalObservation("Met Éireann", localStation.item, localStation.distanceKm, now, timeMode === "past")
                  : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} rain observations…` : timeMode === "past" ? weatherGap ?? `No point rain observation was retained within ${NEARBY_RADIUS_KM.weather} km for this historical record.` : !online ? "Offline; saved rain observations are not used as current nearby rainfall." : weatherAvailable ? selectedPlaceIsEphemeral ? "No current rain observation is available." : `No nearby rain observation within ${NEARBY_RADIUS_KM.weather} km.` : "Rain observations are unavailable; nearby rainfall cannot be assessed."}</small>
              </dd>
              </div>
              <div>
                <dt>River</dt>
                <dd><span className="place-observation-value">{localRiver ? `${localRiver.item.level.toFixed(2)} m` : "Unavailable"}</span>
                <small>{localRiver
                  ? formatLocalObservation("OPW", localRiver.item, localRiver.distanceKm, now, timeMode === "past")
                  : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} river gauges…` : timeMode === "past" ? riverGap ?? `No point river observation was retained within ${NEARBY_RADIUS_KM.river} km for this historical record.` : riversAvailable ? selectedPlaceIsEphemeral ? "No current river observation is available." : `No nearby river observation within ${NEARBY_RADIUS_KM.river} km.` : riversCached ? "The river feed is unavailable; cached readings are not used as current local conditions." : "River readings are unavailable; nearby levels cannot be assessed."}</small>
              </dd>
              </div>
              <div>
                <dt>Air</dt>
                <dd><span className="place-observation-value">{localAir?.item.europeanAqi == null ? "Unavailable" : `AQI ${localAir.item.europeanAqi}`}</span>
                <small>{localAir
                  ? formatLocalObservation(localAir.item.source === "measured" ? "EEA measured" : "CAMS modelled", localAir.item, localAir.distanceKm, now, timeMode === "past")
                  : isConnectingWithoutSnapshot ? `${timeMode === "past" ? "Loading stored" : "Connecting to"} air-quality sources…` : timeMode === "past" ? airGap ?? `No point air-quality observation was retained within ${NEARBY_RADIUS_KM.air} km for this historical record.` : !online ? "Offline; saved air-quality data is not used as a current nearby condition." : airAvailable ? selectedPlaceIsEphemeral ? "No current measured or modelled air context is available." : `No nearby air observation within ${NEARBY_RADIUS_KM.air} km.` : "Air-quality sources are unavailable; nearby conditions cannot be assessed."}</small>
              </dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}

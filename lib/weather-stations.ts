export type WeatherStationDefinition = {
  id: string;
  endpoint: string;
  providerName: string;
  csvName: string;
  name: string;
  latitude: number;
  longitude: number;
};

export const WEATHER_STATIONS: readonly WeatherStationDefinition[] = [
  { id: "malin-head", endpoint: "malin-head", providerName: "Malin Head", csvName: "Malin Head", name: "Malin Head", latitude: 55.371, longitude: -7.339 },
  { id: "finner", endpoint: "finner", providerName: "Finner", csvName: "Finner", name: "Finner", latitude: 54.494, longitude: -8.243 },
  { id: "belmullet", endpoint: "belmullet", providerName: "Belmullet", csvName: "Belmullet", name: "Belmullet", latitude: 54.228, longitude: -10.007 },
  { id: "athenry", endpoint: "athenry", providerName: "Athenry", csvName: "Athenry", name: "Athenry", latitude: 53.289, longitude: -8.786 },
  { id: "dublin-airport", endpoint: "dublin", providerName: "Dublin Airport", csvName: "Dublin", name: "Dublin", latitude: 53.428, longitude: -6.241 },
  { id: "gurteen", endpoint: "gurteen", providerName: "Gurteen", csvName: "Gurteen", name: "Gurteen", latitude: 53.034, longitude: -8.005 },
  { id: "valentia", endpoint: "valentia", providerName: "Valentia", csvName: "Valentia", name: "Valentia", latitude: 51.938, longitude: -10.241 },
  { id: "cork-airport", endpoint: "cork", providerName: "Cork", csvName: "Cork", name: "Cork", latitude: 51.847, longitude: -8.486 },
  { id: "johnstown-castle", endpoint: "johnstown-castle", providerName: "Johnstown Castle", csvName: "Johnstown Castle", name: "Wexford", latitude: 52.298, longitude: -6.497 }
] as const;

export const WEATHER_OBSERVATION_MAX_AGE_MS = 3 * 60 * 60 * 1000;

const normalizeStationName = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase("en-IE");

export function matchesWeatherStationIdentity(station: WeatherStationDefinition, providerName: unknown) {
  return normalizeStationName(providerName) === normalizeStationName(station.providerName);
}

export function isWeatherObservationFresh(observedAt: string | null, now = Date.now()) {
  const timestamp = Date.parse(String(observedAt ?? ""));
  const age = now - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < WEATHER_OBSERVATION_MAX_AGE_MS;
}

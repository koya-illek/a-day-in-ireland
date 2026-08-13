export type WeatherStationDefinition = {
  id: string;
  endpoint: string;
  providerName: string;
  csvName: string;
  name: string;
  latitude: number;
  longitude: number;
};

export const WEATHER_STATIONS: readonly WeatherStationDefinition[];
export const WEATHER_OBSERVATION_MAX_AGE_MS: number;
export function matchesWeatherStationIdentity(
  station: WeatherStationDefinition,
  providerName: unknown
): boolean;
export function isWeatherObservationFresh(observedAt: string | null, now?: number): boolean;

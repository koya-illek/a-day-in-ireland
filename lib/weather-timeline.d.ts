export type HourlyStationObservation = {
  time: string;
  temperature: number | null;
  rainfall: number | null;
  windSpeed: number | null;
};

export function aggregateHourlyWeather(
  histories: ReadonlyArray<ReadonlyArray<HourlyStationObservation>>
): HourlyStationObservation[];

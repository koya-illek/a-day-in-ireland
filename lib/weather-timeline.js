const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const mean = (values) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length
  : null;

/**
 * Aggregate same-hour station observations without treating a missing report as
 * zero. Temperature, rain and wind are each the mean of their available station
 * values. In particular, rain is not summed across geographically separate
 * gauges: that total has no useful physical meaning for Ireland.
 */
export function aggregateHourlyWeather(histories) {
  const buckets = new Map();
  for (const history of histories) {
    for (const point of history) {
      const time = String(point?.time ?? "").trim();
      if (!time) continue;
      const bucket = buckets.get(time) ?? { temperatures: [], rainfall: [], winds: [] };
      const temperature = finiteNumber(point?.temperature);
      const rainfall = finiteNumber(point?.rainfall);
      const windSpeed = finiteNumber(point?.windSpeed);
      if (temperature !== null) bucket.temperatures.push(temperature);
      if (rainfall !== null) bucket.rainfall.push(rainfall);
      if (windSpeed !== null) bucket.winds.push(windSpeed);
      buckets.set(time, bucket);
    }
  }

  return [...buckets].map(([time, values]) => ({
    time,
    temperature: mean(values.temperatures),
    rainfall: mean(values.rainfall),
    windSpeed: mean(values.winds)
  }));
}

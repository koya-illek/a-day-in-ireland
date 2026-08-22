import assert from "node:assert/strict";
import test from "node:test";

import { aggregateHourlyWeather } from "../lib/weather-timeline.js";

test("hourly rain is the mean of available station observations, never their geographic sum", () => {
  const timeline = aggregateHourlyWeather([
    [
      { time: "09:00", temperature: 10, rainfall: 2, windSpeed: 10 },
      { time: "10:00", temperature: 12, rainfall: null, windSpeed: null }
    ],
    [
      { time: "09:00", temperature: 14, rainfall: 4, windSpeed: 20 },
      { time: "10:00", temperature: null, rainfall: null, windSpeed: 30 }
    ],
    [{ time: "09:00", temperature: null, rainfall: null, windSpeed: null }]
  ]);

  assert.deepEqual(timeline, [
    { time: "09:00", temperature: 12, rainfall: 3, windSpeed: 15 },
    { time: "10:00", temperature: 12, rainfall: null, windSpeed: 30 }
  ]);
  assert.notEqual(timeline[0].rainfall, 6, "separate gauges must not be added into a fictional Ireland total");
});

test("hourly buckets stay chronological when stations report early hours late", () => {
  const timeline = aggregateHourlyWeather([
    [
      { time: "14:00", temperature: 15, rainfall: 0, windSpeed: 8 },
      { time: "15:00", temperature: 16, rainfall: 1, windSpeed: 9 }
    ],
    [
      { time: "13:00", temperature: 14, rainfall: 2, windSpeed: 7 },
      { time: "14:00", temperature: 14.5, rainfall: null, windSpeed: null }
    ]
  ]);

  assert.deepEqual(
    timeline.map((point) => point.time),
    ["13:00", "14:00", "15:00"],
    "chart order must follow the hour of day, not station array order"
  );
});

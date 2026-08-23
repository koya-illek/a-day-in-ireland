import { expect, test, type Page, type Route } from "@playwright/test";
import { createInitialSnapshot } from "../lib/initial-snapshot";

const selectedAt = "2026-08-04T17:45:00.000Z";
const latestAt = "2026-08-04T23:45:00.000Z";

const storedSnapshot = () => {
  const snapshot = createInitialSnapshot(selectedAt);
  const station = {
    id: "history-station",
    name: "Stored Station",
    latitude: 53.3,
    longitude: -7.6,
    temperature: 16.5,
    rainfall: 1.2,
    windSpeed: 18,
    windDirection: "W",
    description: "Stored bright intervals",
    observedAt: selectedAt,
    fresh: true
  };
  return {
    ...snapshot,
    lastSuccessAt: selectedAt,
    sourceStatus: "live" as const,
    stations: [station],
    rivers: [{
      id: "history-river",
      name: "Stored River",
      latitude: 53.1,
      longitude: -8.1,
      level: 1.42,
      observedAt: selectedAt,
      fresh: true
    }],
    grid: {
      observedAt: selectedAt,
      demandMW: 4_000,
      generationMW: 4_050,
      windMW: 1_800,
      windSharePercent: 45,
      carbonIntensity: 210,
      carbonEmissions: 100,
      frequencyHz: 50,
      interconnectorMW: 50
    },
    sourceProvenance: {
      ...snapshot.sourceProvenance!,
      rivers: {
        provider: "OPW waterlevel.ie",
        endpoint: "https://waterlevel.ie/geojson/latest/",
        status: "live" as const,
        fetchedAt: selectedAt,
        latestObservedAt: selectedAt,
        fallback: null
      }
    },
    contextStatus: {
      ...snapshot.contextStatus,
      grid: "live" as const,
      warnings: "live" as const
    },
    summary: {
      warmest: station,
      wettest: station,
      windiest: station,
      reporting: 1,
      runningTrains: 0,
      riverStations: 1
    },
    timeline: [{ time: "18:00", temperature: 16.5, rainfall: 1.2, windSpeed: 18 }]
  };
};

const rangeBody = {
  schemaVersion: 1,
  availableFrom: "2026-07-06T00:00:00.000Z",
  availableTo: latestAt,
  resolutionMinutes: 15,
  snapshotCount: 2_880,
  resolutions: [{
    name: "raw",
    resolutionMinutes: 15,
    availableFrom: "2026-07-06T00:00:00.000Z",
    availableTo: latestAt
  }]
};

const gaps = [{
  source: "Iarnród Éireann",
  scope: "positions",
  reason: "not-retained",
  detail: "Rail history is not retained — permission pending."
}, {
  source: "NASA satellite",
  scope: "imagery",
  reason: "not-collected",
  detail: "Satellite pixels were not archived."
}];

const envelope = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestedAt: selectedAt,
  resolvedAt: selectedAt,
  availableFrom: rangeBody.availableFrom,
  availableTo: rangeBody.availableTo,
  previousAt: "2026-08-04T17:30:00.000Z",
  nextAt: "2026-08-04T18:00:00.000Z",
  resolutionMinutes: 15,
  snapshotCount: rangeBody.snapshotCount,
  snapshot: storedSnapshot(),
  movementSummary: { rail: null, transit: { vehicles: 810, routes: 96 } },
  gaps,
  ...overrides
});

async function installUnavailableLiveRoutes(page: Page) {
  let calls = 0;
  await page.route("**/api/living", (route) => { calls += 1; return route.fulfill({ status: 503, body: "unavailable" }); });
  await page.route("**/api/contexts", (route) => { calls += 1; return route.fulfill({ status: 503, body: "unavailable" }); });
  await page.route("**/api/transit", (route) => { calls += 1; return route.fulfill({ status: 503, body: "unavailable" }); });
  await page.route("https://prodapi.metweb.ie/**", (route) => { calls += 1; return route.fulfill({ status: 503, body: "unavailable" }); });
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => { calls += 1; return route.fulfill({ status: 503, body: "unavailable" }); });
  return () => calls;
}

async function installHistoryRoutes(page: Page, handler: (route: Route) => Promise<void> | void) {
  await page.route("**/api/history/range", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(rangeBody) }));
  await page.route("**/api/history?at=*", handler);
}

test("deep-linked Past mode stays separate from live refresh, shares at, compares, and returns to Now", async ({ page }) => {
  const liveCalls = await installUnavailableLiveRoutes(page);
  let historyCalls = 0;
  await installHistoryRoutes(page, (route) => {
    historyCalls += 1;
    const isComparison = historyCalls > 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope(isComparison ? {
        requestedAt: new URL(route.request().url()).searchParams.get("at"),
        resolvedAt: latestAt,
        snapshot: { ...storedSnapshot(), generatedAt: latestAt, lastSuccessAt: latestAt },
        previousAt: selectedAt,
        nextAt: null
      } : {}))
    });
  });

  await page.goto(`/?at=${encodeURIComponent(selectedAt)}&place=cork&view=weather`);
  await expect(page.getByRole("button", { name: "Past", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".history-result")).toContainText("Showing Tue 4 Aug 2026");
  await expect(page.locator(".workspace-heading")).toContainText("Ireland then");
  await expect(page.locator("#live-map")).toHaveAttribute("aria-label", "Historical map of Ireland");
  await expect(page.locator(".live-state")).toContainText("Stored observations");
  await expect(page.locator(".history-result")).toContainText("Rail history is not retained — permission pending.");
  await expect.poll(liveCalls).toBe(0);
  expect(new URL(page.url()).searchParams.get("at")).toBe(selectedAt);

  await page.getByRole("button", { name: "Compare with latest stored" }).click();
  await expect(page.locator(".history-comparison")).toContainText("Latest stored");
  await expect(page.locator(".history-comparison")).toContainText("Unavailable");
  await expect(page.locator(".station-marker")).toHaveCount(1);

  await page.context().setOffline(true);
  await expect(page.locator(".history-result")).toContainText("Showing Tue 4 Aug 2026");
  await expect(page.locator(".station-marker")).toHaveCount(1);
  await expect(page.locator(".live-state")).toContainText("Stored historical snapshot");
  await page.context().setOffline(false);

  await page.getByRole("button", { name: "Now", exact: true }).click();
  await expect(page.getByRole("button", { name: "Now", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workspace-heading")).toContainText("Ireland now");
  await expect.poll(liveCalls).toBeGreaterThan(0);
  expect(new URL(page.url()).searchParams.has("at")).toBe(false);
});

test("a failed scrubber point can be retried without moving to another time", async ({ page }) => {
  await installUnavailableLiveRoutes(page);
  let selectedCalls = 0;
  await installHistoryRoutes(page, (route) => {
    const requestedAt = new URL(route.request().url()).searchParams.get("at");
    if (requestedAt === selectedAt) {
      selectedCalls += 1;
      if (selectedCalls === 1) return route.fulfill({ status: 503, body: "temporary history failure" });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({
        requestedAt,
        resolvedAt: requestedAt,
        snapshot: { ...storedSnapshot(), generatedAt: requestedAt, lastSuccessAt: requestedAt }
      }))
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Past", exact: true }).click();
  await expect(page.locator(".history-result.ready")).toContainText("Showing Wed 5 Aug 2026");

  const scrubber = page.locator(".history-scrubber input[type=range]");
  await scrubber.fill(String(Math.floor(Date.parse(selectedAt) / 1000)));
  await scrubber.dispatchEvent("pointerup");
  await expect(page.locator(".history-result.error")).toContainText("temporary history failure");
  // A failed load must be reported as a failure, not as a missing record.
  await expect(page.locator(".connection-chip")).toContainText("Stored conditions could not be loaded");

  await scrubber.dispatchEvent("pointerup");
  await expect(page.locator(".history-result.ready")).toContainText("Showing Tue 4 Aug 2026");
  expect(selectedCalls).toBe(2);
});

test("a slow comparison response cannot reopen the table a navigation dropped", async ({ page }) => {
  await installUnavailableLiveRoutes(page);
  await installHistoryRoutes(page, async (route) => {
    const requestedAt = new URL(route.request().url()).searchParams.get("at") ?? selectedAt;
    if (requestedAt === latestAt) {
      // Only the comparison fetch targets the latest stored instant; make it
      // outlast the navigation that should supersede it.
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    try {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(envelope({
          requestedAt,
          resolvedAt: requestedAt,
          snapshot: { ...storedSnapshot(), generatedAt: requestedAt, lastSuccessAt: requestedAt },
          previousAt: selectedAt,
          nextAt: null
        }))
      });
    } catch {
      // The superseded request is deliberately aborted by the client.
    }
  });

  await page.goto(`/?at=${encodeURIComponent(selectedAt)}&place=cork`);
  await expect(page.locator(".history-result.ready")).toContainText("Showing Tue 4 Aug 2026");

  await page.getByRole("button", { name: "Compare with latest stored" }).click();
  await expect(page.getByRole("button", { name: /Loading comparison…|Refresh latest stored comparison/ })).toBeVisible();

  // Navigate while the comparison fetch is still in flight; the reset must
  // also abort it instead of letting the stale response repopulate the table.
  const scrubber = page.locator(".history-scrubber input[type=range]");
  await scrubber.fill(String(Math.floor(Date.parse("2026-08-04T17:30:00.000Z") / 1000)));
  await scrubber.dispatchEvent("pointerup");
  await expect(page.locator(".history-result.ready")).toContainText("18:30");

  await page.waitForTimeout(1_000);
  await expect(page.locator(".history-comparison")).toHaveCount(0);
});

test("a pending keyboard submit cannot override a later pointer submission", async ({ page }) => {
  await installUnavailableLiveRoutes(page);
  const requestedTimes: string[] = [];
  await installHistoryRoutes(page, (route) => {
    const requestedAt = new URL(route.request().url()).searchParams.get("at")!;
    requestedTimes.push(requestedAt);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({
        requestedAt,
        resolvedAt: requestedAt,
        snapshot: { ...storedSnapshot(), generatedAt: requestedAt, lastSuccessAt: requestedAt }
      }))
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Past", exact: true }).click();
  await expect(page.locator(".history-result.ready")).toContainText("Showing Wed 5 Aug 2026");

  const keyboardInstant = new Date(Date.parse(selectedAt) + 900_000).toISOString();
  const pointerInstant = new Date(Date.parse(latestAt) - 900_000).toISOString();
  const scrubber = page.locator(".history-scrubber input[type=range]");
  await scrubber.focus();
  await scrubber.fill(String(Math.floor(Date.parse(selectedAt) / 1000)));
  // Keyup schedules a debounced submit for the keyboard instant.
  await scrubber.press("ArrowRight");
  // An explicit pointer submission within the debounce window supersedes it.
  await scrubber.fill(String(Math.floor(Date.parse(pointerInstant) / 1000)));
  await scrubber.dispatchEvent("pointerup");

  await page.waitForTimeout(700);
  const lastRequested = requestedTimes[requestedTimes.length - 1];
  expect(lastRequested).toBe(pointerInstant);
  expect(requestedTimes.indexOf(keyboardInstant)).toBeLessThan(requestedTimes.length - 1);
});

test("daily history is summary-only, preserves gaps, and never falls back to live map evidence", async ({ page }) => {
  const liveCalls = await installUnavailableLiveRoutes(page);
  await installHistoryRoutes(page, (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(envelope({
      requestedAt: "2026-07-01T12:00:00.000Z",
      resolvedAt: "2026-06-30T23:00:00.000Z",
      periodStartAt: "2026-06-30T23:00:00.000Z",
      periodEndAt: "2026-07-01T23:00:00.000Z",
      resolutionMinutes: 1440,
      snapshot: null,
      movementSummary: { rail: null, transit: null },
      periodSummary: {
        basis: "retained-hourly-representatives",
        representedSamples: 20,
        weather: {
          highestTemperatureC: 18.4,
          highestWindSpeedKmh: 42,
          highestStationRainfallMm: null
        },
        grid: {
          minWindSharePercent: 25,
          maxWindSharePercent: 61,
          minDemandMW: 3_100,
          maxDemandMW: 4_900
        },
        transit: { maxVehicles: null, maxRoutes: 104 },
        distinctCounts: { officialWarnings: 2, bathingAlerts: null, earthquakes: 1 }
      }
    }))
  }));

  await page.goto(`/?at=${encodeURIComponent("2026-07-01T12:00:00.000Z")}`);
  await expect(page.locator(".history-result")).toContainText("daily summary");
  await expect(page.locator(".history-result")).toContainText("full retained period");
  await expect(page.locator(".history-result")).toContainText("not conditions at the selected clock time");
  await expect(page.locator(".history-result")).not.toContainText("nearest stored record at or before");
  await expect(page.locator(".history-result")).toContainText("do not reconstruct a point-by-point map");
  await expect(page.locator(".history-map-gap")).toContainText("Point map unavailable for this daily summary");
  await expect(page.locator(".history-period-summary")).toContainText("Across 20 retained hourly representatives");
  await expect(page.locator(".history-period-summary")).toContainText("18.4 °C");
  await expect(page.locator(".history-period-summary")).toContainText("25%–61%");
  await expect(page.locator(".history-period-summary")).toContainText("Unavailable");
  await expect(page.getByRole("button", { name: "Comparison unavailable for daily summary" })).toBeDisabled();
  await expect(page.locator(".history-compare-actions")).toContainText("Comparison is available for point-in-time and hourly records");
  await expect(page.locator(".ireland-map [data-map-marker]")).toHaveCount(0);
  await expect(page.locator(".official-notices-empty")).toContainText("not retained");
  await expect(page.locator(".pulse-card.trains")).toContainText("Rail history is not retained — permission pending.");
  await expect.poll(liveCalls).toBe(0);

  await page.getByRole("button", { name: "Now", exact: true }).click();
  await page.getByRole("button", { name: "Past", exact: true }).click();
  await expect(page.locator(".history-result")).toContainText("daily summary");
  await expect(page.locator(".history-result")).not.toContainText("No stored snapshot exists");
});

test("a slow historical response cannot overwrite Now and controls reflow at 320px with large text", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.setViewportSize({ width: 320, height: 844 });
  await installUnavailableLiveRoutes(page);
  await installHistoryRoutes(page, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope()) });
  });

  await page.goto(`/?at=${encodeURIComponent(selectedAt)}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Past", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Now", exact: true }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: "Now", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workspace-heading")).toContainText("Ireland now");
  expect(new URL(page.url()).searchParams.has("at")).toBe(false);

  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  for (const label of ["Now", "Past"]) {
    const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("a newer historical navigation wins over an older slow request and remains readable offline", async ({ page }) => {
  await installUnavailableLiveRoutes(page);
  const olderAt = "2026-08-04T17:30:00.000Z";
  const newerAt = "2026-08-04T18:00:00.000Z";
  const requestedTimes: string[] = [];
  await installHistoryRoutes(page, async (route) => {
    const requestedAt = new URL(route.request().url()).searchParams.get("at")!;
    requestedTimes.push(requestedAt);
    if (requestedAt === olderAt) await new Promise((resolve) => setTimeout(resolve, 350));
    if (requestedAt === newerAt) await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(envelope({
          requestedAt,
          resolvedAt: requestedAt,
          snapshot: { ...storedSnapshot(), generatedAt: requestedAt, lastSuccessAt: requestedAt }
        }))
      });
    } catch {
      // The superseded request is deliberately aborted by the client.
    }
  });

  await page.goto(`/?at=${encodeURIComponent(selectedAt)}&place=cork`);
  await expect(page.locator(".history-result")).toContainText("Showing Tue 4 Aug 2026");

  await page.evaluate(({ older, newer }) => {
    history.pushState(null, "", `/?at=${encodeURIComponent(older)}&place=cork`);
    dispatchEvent(new PopStateEvent("popstate"));
    history.pushState(null, "", `/?at=${encodeURIComponent(newer)}&place=cork`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, { older: olderAt, newer: newerAt });

  await expect(page.locator(".history-result")).toContainText("19:00");
  await expect.poll(() => new URL(page.url()).searchParams.get("at")).toBe(newerAt);
  expect(requestedTimes).toEqual(expect.arrayContaining([olderAt, newerAt]));
  await page.context().setOffline(true);
  await expect(page.locator(".live-state")).toContainText("Stored historical snapshot");
  await expect(page.locator(".workspace-heading .hero-sentence"))
    .toContainText("Tuesday 4 August, 19:00 Irish time. Evening across Ireland. This is the stored record for the selected time.");
  await expect(page.locator(".workspace-heading .moment-summary"))
    .toContainText("Stored observations from Tue 4 Aug 2026, 19:00 IST.");
  await expect(page.locator(".workspace-heading .moment-summary"))
    .toContainText("They are separated from live feeds and keep provider timestamps and recorded gaps.");
  await expect(page.locator(".workspace-heading")).not.toContainText("Live observations");
  await expect(page.locator(".place-observations")).not.toContainText(/Offline|current|live/i);

  const past = page.getByRole("button", { name: "Past", exact: true });
  await past.focus();
  await expect(past).toBeFocused();
  await expect(past).toHaveAttribute("aria-pressed", "true");
});

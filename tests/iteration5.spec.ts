import { expect, test, type Page } from "@playwright/test";

const observedAt = () => new Date(Date.now() - 60_000).toISOString();

async function installExpiringTrainFixture(page: Page, trainsDropped: () => boolean) {
  await page.route("https://prodapi.metweb.ie/observations/*/today", (route) => route.fulfill({
    contentType: "application/json",
    body: "[]"
  }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv",
    body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      trains: trainsDropped() ? [] : [{
        id: "iteration5-train", latitude: 52.15, longitude: -7.4, status: "running",
        direction: "South", message: "Iteration service", observedAt: observedAt(),
        speedKmh: null, speedSource: null
      }],
      rivers: [{
        id: "iteration5-river", name: "Iteration River", latitude: 53.35, longitude: -8.2,
        level: 1.1, observedAt: observedAt()
      }],
      sourceStatus: { trains: "live", rivers: "live" },
      sourceProvenance: {
        trains: { provider: "Iarnród Éireann", endpoint: "fixture", status: "live", fetchedAt: observedAt(), latestObservedAt: observedAt(), fallback: null },
        rivers: { provider: "OPW waterlevel.ie", endpoint: "fixture", status: "live", fetchedAt: observedAt(), latestObservedAt: observedAt(), fallback: null }
      }
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [], issTle: null,
      contextStatus: {
        marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
        modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
      }
    })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ transit: [], transitStatus: "live" })
  }));
}

test("expiring the inspected item parks keyboard focus on the map instead of <body>", async ({ page }) => {
  let trainsDropped = false;
  await installExpiringTrainFixture(page, () => trainsDropped);
  await page.clock.install({ time: new Date() });
  await page.goto("/?view=all");

  const trainMarker = page.locator(".train-marker");
  await expect(trainMarker).toHaveCount(1);
  await trainMarker.click();
  await expect(page.locator(".station-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close map details" })).toBeFocused();

  // The next living poll drops the inspected train while its dialog is open.
  trainsDropped = true;
  await page.clock.runFor(65_000);

  await expect(page.locator(".station-card")).toHaveCount(0);
  // Focus is parked on the next animation frame after the dialog unmounts.
  // Advancing the fake clock inside the poll keeps timer-driven steps moving
  // even when parallel workers slow the runner between samples.
  await expect.poll(async () => {
    await page.clock.runFor(500);
    return page.evaluate(() => document.activeElement?.tagName);
  }).not.toBe("BODY");
  await expect(page.locator("svg.ireland-map [data-map-marker]:focus")).toHaveCount(1);
});

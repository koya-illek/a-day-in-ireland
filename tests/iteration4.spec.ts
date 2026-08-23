import { expect, test, type Page } from "@playwright/test";

test("light theme keeps place names and footer links readable after the third contrast sweep", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ireland-interface-theme", "light");
    document.documentElement.dataset.theme = "light";
  });
  await page.goto("/");
  await expect(page.locator(".place-picker h2")).toBeVisible();
  const headingColor = await page.locator(".place-picker h2").evaluate((element) => getComputedStyle(element).color);
  expect(headingColor).toBe("rgb(18, 37, 31)");
  const footerLink = page.locator("footer nav a").first();
  const linkColor = await footerLink.evaluate((element) => getComputedStyle(element).color);
  expect(linkColor).toBe("rgb(63, 109, 77)");
});

const observedAt = () => new Date(Date.now() - 2 * 60_000).toISOString();

async function installMarkerFixtures(page: Page) {
  const stamp = observedAt();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-IE", {
      timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(stamp)).map((part) => [part.type, part.value])
  );
  await page.route("https://prodapi.metweb.ie/observations/*/today", (route) => {
    const endpoint = new URL(route.request().url()).pathname.split("/")[2];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        name: endpoint === "dublin" ? "Dublin Airport" : "Cork",
        date: `${parts.day}-${parts.month}-${parts.year}`,
        reportTime: `${parts.hour}:${parts.minute}`,
        temperature: "16", rainfall: "0.4", windSpeed: "12",
        cardinalWindDirection: "E", weatherDescription: "Bright intervals"
      }])
    });
  });
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      trains: [],
      rivers: [{
        id: "iteration4-river", name: "Iteration River", latitude: 53.35, longitude: -8.2,
        level: 1.1, observedAt: stamp
      }],
      sourceStatus: { trains: "live", rivers: "live" },
      sourceProvenance: {
        trains: { provider: "Iarnród Éireann", endpoint: "fixture", status: "live", fetchedAt: stamp, latestObservedAt: stamp, fallback: null },
        rivers: { provider: "OPW waterlevel.ie", endpoint: "fixture", status: "live", fetchedAt: stamp, latestObservedAt: stamp, fallback: null }
      }
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generatedAt: stamp,
      marine: [{
        id: "iteration4-buoy", name: "Iteration Buoy", kind: "weather-buoy",
        latitude: 53.8, longitude: -10.2, observedAt: stamp,
        windSpeedKnots: 8, waveHeight: 1.1, wavePeriod: 5, seaTemperature: 14
      }],
      radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
      warnings: [], warningsStatus: "unavailable", satellite: null, earthquakes: [], issTle: null,
      contextStatus: {
        marine: "live", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
        modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "unavailable"
      }
    })
  }));
}

test("keyboard focus moves to a surviving marker when its marker leaves the visible set", async ({ page }, testInfo) => {
  testInfo.skip(testInfo.project.name === "mobile");
  await installMarkerFixtures(page);
  await page.goto("/?view=water");
  const riverMarker = page.locator("[data-map-marker][data-marker-id='river:iteration4-river']");
  await expect(riverMarker).toHaveCount(1);
  await riverMarker.focus();
  await expect(riverMarker).toBeFocused();

  // Switch presets programmatically so keyboard focus stays parked on the
  // marker while React swaps the rendered marker set underneath it.
  await page.locator(".map-presets button", { hasText: "Weather" }).evaluate((element) => element.click());

  await expect(page.locator("[data-map-marker][data-marker-id='river:iteration4-river']")).toHaveCount(0);
  // The focused marker's id left the visible set; focus must not strand on body.
  await expect(page.locator("svg.ireland-map [data-map-marker]:focus")).toHaveCount(1);
});

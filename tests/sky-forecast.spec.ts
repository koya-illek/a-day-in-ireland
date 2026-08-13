import { expect, test, type Page } from "@playwright/test";

const unavailable = {
  marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [], bathingAlerts: [],
  warnings: [], warningsStatus: "live", issTle: null, satellite: null, earthquakes: [],
  solar: null, forecast: null,
  contextStatus: {
    marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
    modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
    satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live",
    solar: "unavailable", forecast: "unavailable"
  }
};

async function installFixtures(page: Page) {
  const now = new Date().toISOString();
  await page.route("https://prodapi.metweb.ie/**", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  await page.route("https://www.met.ie/latest-reports/observations/download", (route) => route.fulfill({
    contentType: "text/csv", body: "Name,Temperature,Description,Wind,Unused,Direction,Unused,Rain,Unused\n"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ generatedAt: now, trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ generatedAt: now, transit: [], transitStatus: "unavailable" })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ generatedAt: now, ...unavailable })
  }));
}

test("authoritative sky and official forecast remain compact, attributed and verbatim in the browser", async ({ page }, testInfo) => {
  await installFixtures(page);
  await page.unroute("**/api/contexts");
  const now = new Date();
  const dublinDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const issued = new Date(now.getTime() - 30 * 60_000).toISOString();
  const event = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString();
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generatedAt: now.toISOString(),
      ...unavailable,
      solar: {
        date: dublinDate, tzid: "Europe/Dublin", sunrise: event(-240), sunset: event(120),
        dawn: event(-300), dusk: event(180), firstLight: event(-360), lastLight: event(240),
        goldenHourMorning: event(-180), goldenHourEvening: event(60), blueHourMorning: event(-210), blueHourEvening: event(90),
        solarPosition: { azimuth: 140, elevation: 20 }, moonrise: null, moonset: event(300),
        moonPhase: 0.25, moonPhaseName: "First quarter", moonIllumination: 0.5,
        source: "Sunrise-Sunset.org", attributionUrl: "https://sunrise-sunset.org/"
      },
      forecast: {
        region: "National", issued, today: `Exact official copy: rain later. ${"A long official continuation remains hidden until requested. ".repeat(18)}`,
        tonight: `Exact official copy: rain later. ${"A long official continuation remains hidden until requested. ".repeat(18)}`,
        tomorrow: `Exact official copy: rain later. ${"A long official continuation remains hidden until requested. ".repeat(18)}`,
        outlook: "Official outlook.",
        source: "Met Éireann", sourceUrl: "https://www.met.ie/Open_Data/json/National.json",
        datasetUrl: "https://data.gov.ie/dataset/met-eireann-live-text-forecast-data"
      },
      contextStatus: { ...unavailable.contextStatus, solar: "live", forecast: "live" }
    })
  }));
  await page.goto("/");
  await expect(page.locator(".sky-light-strip")).toContainText("Source: Sunrise-Sunset.org");
  await expect(page.locator(".forecast-strip")).toContainText("Next across Ireland");
  await expect(page.locator(".forecast-excerpt")).toContainText(/Exact official copy/);
  await expect(page.locator(".forecast-strip")).toHaveAttribute("aria-labelledby", "forecast-heading");
  const disclosure = page.locator(".forecast-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(page.locator(".forecast-excerpt")).toHaveText(/Exact official copy: rain later\./);
  const collapsedGeometry = await page.locator(".forecast-strip").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    summaryHeight: element.querySelector("summary")?.getBoundingClientRect().height ?? 0
  }));
  expect(collapsedGeometry.height).toBeLessThanOrEqual(testInfo.project.name === "mobile" ? 320 : 180);
  expect(collapsedGeometry.summaryHeight).toBeGreaterThanOrEqual(44);
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(page.locator(".forecast-full-copy")).toContainText("A long official continuation remains hidden until requested.");
});

import { expect, test, type Page } from "@playwright/test";

async function installTransitEnrichmentFixtures(page: Page) {
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  await page.route("https://prodapi.metweb.ie/**", (route) => route.fulfill({
    contentType: "application/json",
    body: "[]"
  }));
  await page.route("**/api/living", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ trains: [], rivers: [], sourceStatus: { trains: "unavailable", rivers: "unavailable" } })
  }));
  await page.route("**/api/transit", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      transit: [{
        id: "fixture-transit", label: "7100", route: "2 NX c a", latitude: 54.75, longitude: -7.1,
        bearing: 225, speedKmh: 18, speedSource: "reported", observedAt,
        tripId: "trip-unknown-1"
      }],
      transitStatus: "live"
    })
  }));
  await page.route("**/api/contexts", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      generatedAt: observedAt,
      marine: [], radar: [], grid: null, airQuality: [], aurora: null, tides: [],
      bathingAlerts: [], warnings: [], warningsStatus: "live", issTle: null,
      satellite: null, earthquakes: [],
      contextStatus: {
        marine: "unavailable", radar: "unavailable", grid: "unavailable", measuredAir: "unavailable",
        modelledAir: "unavailable", aurora: "unavailable", tides: "unavailable", bathing: "unavailable",
        satellite: "unavailable", earthquakes: "unavailable", iss: "unavailable", warnings: "live"
      }
    })
  }));
}

test("an unresolvable trip destination does not loop renders or hammer the manifest", async ({ page }) => {
  let manifestRequests = 0;
  await installTransitEnrichmentFixtures(page);
  await page.route("**/data/transit-destinations.manifest.json", async (route) => {
    manifestRequests += 1;
    await route.fulfill({ status: 500, contentType: "text/plain", body: "unavailable" });
  });

  await page.goto("/?view=custom&layers=transit");
  const marker = page.locator("[data-marker-id='movement:transit:fixture-transit']");
  await expect(marker).toBeVisible();

  // With the loop bug, every enrichment pass refetched the failing manifest
  // and re-rendered the tree as fast as the microtask queue allowed.
  await expect.poll(() => manifestRequests).toBeGreaterThanOrEqual(1);
  const afterEnable = manifestRequests;
  await page.waitForTimeout(3_000);
  expect(manifestRequests - afterEnable).toBeLessThanOrEqual(1);

  // The map stays interactive while the destination lookup keeps failing.
  await marker.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("unknown document paths serve the branded page with a true 404 status", async ({ page }) => {
  const response = await page.goto("/not-a-real-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: /off the map/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "live map", exact: true })).toBeVisible();
});

test("path-specific cache rules from _headers apply to data assets", async ({ request }) => {
  const manifest = await request.get("/data/transit-destinations.manifest.json");
  expect(manifest.headers()["cache-control"]).toContain("max-age=300");
});

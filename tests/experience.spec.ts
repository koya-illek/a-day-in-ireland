import { expect, test } from "@playwright/test";

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Map view shortcuts" }).getByRole("button", { name: /Rail/ })
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("explore layers and station details are interactive", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Live layers" })).toBeVisible();
  const rain = page.getByRole("button", { name: /Observed rain/ });
  await rain.click();
  await expect(rain).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Close explore panel" }).click();
  await page.locator(".station-marker").first().click();
  await expect(page.locator(".station-card")).toBeVisible();
});

test("page exposes live freshness and source provenance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Live observations|Partial observations/)).toHaveCount(1);
  await expect(page.getByText(/Copyright Met Éireann/)).toBeVisible();
  await expect(page.getByText("Ireland, at a glance.")).toBeVisible();
  const timelinePoints = await page.locator(".timeline-point").count();
  if (timelinePoints === 0) {
    await expect(page.getByText(/The day is just beginning/)).toBeVisible();
  } else {
    expect(timelinePoints).toBeGreaterThanOrEqual(1);
  }
});

test("rail and water presets expose the live transport and gauge layers", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Rail/ })
    .click();
  if (await page.locator(".train-marker").count()) {
    await page.locator(".train-marker").first().click();
    await expect(page.locator(".detail-train")).toBeVisible();
  }
  await page
    .getByRole("navigation", { name: "Map view shortcuts" })
    .getByRole("button", { name: /Water/ })
    .click();
  await expect(page.locator(".river-marker").first()).toBeVisible();
  await page.locator(".river-marker").first().click();
  await expect(page.locator(".detail-river")).toBeVisible();
});

test("Stitch map workspace uses an island-only coastline and visible roads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".island-shape path")).toHaveCount(1);
  expect(await page.locator(".road-network path").count()).toBeGreaterThan(50);
  await expect(page.locator(".road-network path.motorway").first()).toBeVisible();
  if (test.info().project.name === "desktop") {
    await expect(page.getByText("Live now", { exact: true })).toBeVisible();
  }

  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const map = await page.getByLabel("Live map of Ireland").boundingBox();
  expect(heading).not.toBeNull();
  expect(map).not.toBeNull();
  expect((heading?.y ?? 0) + (heading?.height ?? 0)).toBeLessThan(map?.y ?? 0);
});

test("context cards focus one layer, explain its freshness and return to the map", async ({ page }) => {
  await page.goto("/");
  await page.locator(".pulse-card.grid").click();
  await expect(page.getByText("The all-island grid now", { exact: true })).toBeVisible();
  const gridPanel = page.locator(".grid-panel:visible");
  await expect(gridPanel).toBeVisible();
  await expect(gridPanel).toContainText("Generation");
  await expect(gridPanel.getByText("Demand", { exact: true }).locator("..").locator("dd")).not.toHaveText("0 MW");
  await expect(page.locator(".train-marker")).toHaveCount(0);

  await page.locator(".pulse-card.trains").click();
  await expect(page.getByText("Live rail positions", { exact: true })).toBeVisible();
  if (await page.locator(".train-marker").count()) {
    await expect(page.locator(".train-marker").first()).toBeVisible();
  } else {
    await expect(page.getByText(/not reporting any train positions/i)).toBeVisible();
  }
  await expect(page.getByLabel("All-island electricity grid now")).toHaveCount(0);
});

test("sea context exposes clickable buoy details", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Sea conditions/ })
    .click();
  await expect(page.getByText("Offshore conditions", { exact: true })).toBeVisible();
  if (await page.locator(".buoy").count()) {
    expect(await page.locator(".buoy").count()).toBeGreaterThanOrEqual(6);
    await page.locator(".buoy").first().click();
    await expect(page.locator(".detail-buoy")).toBeVisible();
    await expect(page.getByText(/Sea temperature/)).toBeVisible();
  } else {
    await expect(page.getByText(/No Marine Institute buoy observations/)).toBeVisible();
  }
});

test("historical traffic is removed from the live experience", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".traffic-marker")).toHaveCount(0);
  await expect(page.getByText(/historical road|AADT|traffic counter/i)).toHaveCount(0);
});

test("wind context displays measured station speeds and directions", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Observed wind/ })
    .click();
  await expect(page.getByText("Observed wind", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".wind-marker").first()).toBeVisible();
  await expect(page.locator(".wind-marker text").first()).toContainText("km/h");
  await page.locator(".wind-marker").first().click();
  await expect(page.locator(".detail-station")).toBeVisible();
  await expect(page.locator(".detail-station").getByText(/km\/h/)).toBeVisible();
});

test("radar context exposes five-minute imagery and playback controls", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "More live contexts" })
    .getByRole("button", { name: /Rainfall radar/ })
    .click();
  await expect(page.getByText("Rainfall radar", { exact: true }).first()).toBeVisible();
  if (await page.locator(".radar-tiles image").count()) {
    await expect(page.locator(".radar-tiles image").first()).toBeVisible();
    await expect(page.getByLabel("Rainfall radar timeline")).toBeVisible();
    await expect(page.getByLabel("Radar frame")).toBeEnabled();
  } else {
    await expect(page.getByText(/radar imagery is temporarily unavailable/i)).toBeVisible();
  }
});

test("air and aurora contexts preserve model and forecast caveats", async ({ page }) => {
  await page.goto("/");
  const contexts = page.getByRole("navigation", { name: "More live contexts" });
  await contexts.getByRole("button", { name: /Air & exposure/ }).click();
  await expect(page.getByText("Modelled air and exposure", { exact: true })).toBeVisible();
  if (await page.locator(".air-marker").count()) {
    await page.locator(".air-marker").first().click();
    await expect(page.locator(".detail-air")).toContainText(/model output, not a reading from a sensor/i);
  }

  await contexts.getByRole("button", { name: /Aurora chance/ }).click();
  await expect(page.locator(".aurora-panel:visible")).toBeVisible();
  await expect(page.locator(".aurora-panel:visible")).toContainText(/not a guarantee/i);
});

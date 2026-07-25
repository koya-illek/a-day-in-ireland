import { expect, test } from "@playwright/test";

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Movement/ })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("explore layers and station details are interactive", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Explore/ }).click();
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

test("movement and water presets expose the new v2 layers", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Movement/ }).click();
  await expect(page.locator(".traffic-marker").first()).toBeVisible();
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

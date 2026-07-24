import { expect, test } from "@playwright/test";

test("renders the living map and live observations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expect(page.getByText("Today so far")).toBeVisible();
  await expect(page.locator(".station-marker").first()).toBeVisible();
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
  await expect(page.getByText(/Weather data © Met Éireann/)).toBeVisible();
  expect(await page.locator(".timeline-point").count()).toBeGreaterThanOrEqual(20);
});

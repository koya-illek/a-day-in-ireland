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

test("live API has provenance fields and observations", async ({ request }) => {
  const response = await request.get("/api/live");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.generatedAt).toBeTruthy();
  expect(body.stations.length).toBeGreaterThan(3);
  expect(body.timeline.length).toBeGreaterThan(0);
  expect(Array.isArray(body.marine)).toBeTruthy();
});

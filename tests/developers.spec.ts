import { expect, test } from "@playwright/test";

test("the developers page documents every REST route and MCP tool", async ({ page }) => {
  await page.goto("/developers");
  await expect(page).toHaveTitle(/Developers · A Day in Ireland/);
  await expect(page.locator("h1")).toHaveText("The same honest data, as an API.");
  const endpointRows = page.locator(".api-doc-table").first().locator("tbody tr");
  await expect(endpointRows).toHaveCount(7);
  for (const path of ["/api/living", "/api/contexts", "/api/transit", "/api/history?at=…", "/api/openapi.json"]) {
    await expect(endpointRows.locator(`code:has-text("${path}")`)).toBeVisible();
  }
  const toolRows = page.locator(".api-doc-table").nth(1).locator("tbody tr");
  await expect(toolRows).toHaveCount(5);
  await expect(page.locator(".api-doc-code")).toHaveCount(2);
});

test("every info page's navigation reaches the developers page", async ({ page }) => {
  for (const from of ["/about", "/data", "/privacy", "/contact"]) {
    await page.goto(from);
    await page.locator(".info-nav a", { hasText: "Developers" }).click();
    await expect(page).toHaveURL(/\/developers$/);
    await expect(page.locator(".info-nav a[aria-current='page']")).toHaveText("Developers");
  }
});

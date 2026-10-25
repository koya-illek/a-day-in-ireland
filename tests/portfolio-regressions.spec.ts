import { expect, test } from "@playwright/test";

test("pre-hydration pages do not publish build-time check times or dates", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    for (const path of ["/", "/v2"]) {
      await page.goto(path);
      await expect(page.getByText("Not checked yet", { exact: false }).first()).toBeAttached();
      await expect(page.locator("body")).not.toContainText(/Checked \d{2}:\d{2}/);
      if (path === "/v2") {
        await expect(page.locator('[class*="mapFoot"] > span').first()).toHaveText("Connecting…");
      }
    }
  } finally {
    await context.close();
  }
});

test("hydration uses the current Irish date without claiming an unfinished check", async ({ page }) => {
  // Leave provider requests pending so this exercises the connecting state,
  // not the final settled provider state.
  await page.route("**/api/**", () => {});
  await page.route("https://prodapi.metweb.ie/**", () => {});
  await page.route("https://www.met.ie/**", () => {});
  await page.goto("/v2", { waitUntil: "domcontentloaded" });
  const date = new Intl.DateTimeFormat("en-IE", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Dublin"
  }).format(new Date());
  await expect(page.locator('[class*="mapFoot"] > span').first()).toHaveText(date);
  await expect(page.getByText("Not checked yet", { exact: false }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/Checked \d{2}:\d{2}/);
});

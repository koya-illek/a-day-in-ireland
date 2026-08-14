import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function expectNoSeriousAxeViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .exclude(".ireland-map")
    .analyze();
  const blocking = results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious"
  );
  expect(blocking, JSON.stringify(blocking.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.slice(0, 5).map((node) => node.target)
  })), null, 2)).toEqual([]);
}

test("the live page has no serious WCAG A/AA axe violations at desktop width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/");
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

test("the live page has no serious WCAG A/AA axe violations at 320px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.getByLabel("Live map of Ireland")).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});

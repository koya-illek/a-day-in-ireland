import { expect, test } from "@playwright/test";

const collectCspViolations = async (page: import("@playwright/test").Page) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(String(error)));
  return violations;
};

test("script CSP allows only hashed inline scripts and the app still boots", async ({ page }) => {
  const violations = await collectCspViolations(page);
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("sha256-");
  const scriptDirective = csp.match(/script-src[^;]*/)?.[0] ?? "";
  expect(scriptDirective).not.toContain("unsafe-inline");
  // The road layer arrives through a client-side fetch, so its presence
  // proves scripts execute under the hash-based policy.
  await expect(page.locator(".road-network path.motorway").first()).toBeVisible();
  expect(violations.filter((text) => /Content Security Policy|violates/i.test(text))).toEqual([]);
});

test("the branded 404 document runs under the same hash-based CSP", async ({ page }) => {
  const violations = await collectCspViolations(page);
  const response = await page.goto("/nowhere-at-all");
  expect(response?.status()).toBe(404);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("sha256-");
  expect(csp.match(/script-src[^;]*/)?.[0] ?? "").not.toContain("unsafe-inline");
  await expect(page.getByRole("link", { name: "live map", exact: true })).toBeVisible();
  expect(violations.filter((text) => /Content Security Policy|violates/i.test(text))).toEqual([]);
});

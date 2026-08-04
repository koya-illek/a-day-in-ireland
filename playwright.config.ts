import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid Playwright port: ${process.env.PLAYWRIGHT_PORT ?? process.env.PORT}`);
}
const baseURL = `http://127.0.0.1:${port}`;
const performanceMode = process.env.PLAYWRIGHT_PERFORMANCE === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: performanceMode ? 1 : undefined,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/static-server.mjs",
    url: baseURL,
    env: { ...process.env, PORT: String(port) },
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } }
  ]
});

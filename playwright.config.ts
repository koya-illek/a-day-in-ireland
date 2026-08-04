import { defineConfig, devices } from "@playwright/test";

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
if (!Number.isInteger(playwrightPort) || playwrightPort < 1 || playwrightPort > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port");
}
const playwrightBaseUrl = `http://127.0.0.1:${playwrightPort}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  use: { baseURL: playwrightBaseUrl, trace: "retain-on-failure" },
  webServer: {
    command: `PORT=${playwrightPort} node scripts/static-server.mjs`,
    url: playwrightBaseUrl,
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } }
  ]
});

import assert from "node:assert/strict";
import test from "node:test";

test("project declares production scripts", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } });
  assert.equal(packageJson.default.scripts.build, "next build");
  assert.ok(packageJson.default.scripts["test:e2e"]);
});

test("hosting project id is persisted", async () => {
  const hosting = await import("../.openai/hosting.json", { with: { type: "json" } });
  assert.match(hosting.default.project_id, /^appgprj_/);
});

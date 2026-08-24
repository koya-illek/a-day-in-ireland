import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The alternate hosting target ships dist/server/index.js as a plain ES module
// graph copied verbatim from platform/. Nothing bundles it, so every relative
// import reachable from server-entry.js must appear in the build script's
// copy list or the deployed artifact dies on first import. This pin makes the
// failure loud at unit-test time instead of at first request.
test("the build script copies every module the server entry imports", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const build = pkg.scripts.build;
  const copyMatch = build.match(/cp ((?:platform\/[\w.-]+\.js\s+)+)dist\/server\//g);
  assert.ok(copyMatch?.length, "build script must contain a cp step filling dist/server/");
  // The last cp into dist/server/ is the module-graph copy; the earlier one
  // renames server-entry.js to index.js.
  const copiedList = copyMatch[copyMatch.length - 1].replace(/^cp /, "");
  const copiedModules = new Set(copiedList.trim().split(/\s+/).map((path) => path.replace(/^platform\//, "")));
  assert.ok(copiedModules.has("api-core.js"), "api-core.js must be shipped");

  const queue = ["server-entry.js"];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    // The entry is shipped renamed as index.js; every other module must be
    // listed in the copy step verbatim.
    assert.ok(copiedModules.has(name) || name === "server-entry.js", `${name} is imported by the server graph but not copied to dist/server/`);
    const source = await readFile(new URL(`../platform/${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/from\s+"\.\/([\w.-]+\.js)"/g)) {
      if (!seen.has(match[1])) queue.push(match[1]);
    }
  }
});

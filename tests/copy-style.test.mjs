import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:tsx|ts|css)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
};

test("deployed interface source has no eyebrow markup or em-dash copy", async () => {
  const files = [...await sourceFiles("app"), ...await sourceFiles("components")];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/eyebrow|section-rail-kicker/.test(source)) violations.push(`${file}: eyebrow`);
    if (/—/.test(source)) violations.push(`${file}: em dash`);
  }
  assert.deepEqual(violations, []);
});

test("public metadata includes structured data on the homepage", async () => {
  const layout = await readFile("app/layout.tsx", "utf8");
  assert.doesNotMatch(layout, /application\/ld\+json/, "structured data is scoped to the page that describes it");
  const home = await readFile("app/page.tsx", "utf8");
  assert.match(home, /application\/ld\+json/);
  assert.match(home, /WebSite/);
  assert.match(home, /Dataset/);
  assert.match(home, /license/);
  assert.match(home, /creator/);
});

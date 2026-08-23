#!/usr/bin/env node
// Reports class selectors in app/globals.css that no source file references.
// A selector counts as referenced when its class name appears anywhere in
// component, app, lib, platform, or test source (template literals included),
// so dynamic class construction is handled conservatively.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cssPath = join(root, "app/globals.css");
const css = readFileSync(cssPath, "utf8");

const sourceDirs = ["app", "components", "lib", "platform", "scripts", "tests"];
const extensions = [".ts", ".tsx", ".js", ".mjs", ".json", ".html"];

const collectFiles = (dir) => {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      files.push(...collectFiles(full));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
};

let corpus = "";
for (const dir of sourceDirs) {
  try {
    for (const file of collectFiles(join(root, dir))) {
      corpus += readFileSync(file, "utf8");
    }
  } catch {
    // Missing optional directory.
  }
}
corpus += readFileSync(join(root, "public/_headers"), "utf8");
// Road geometry classes are applied from data (className={road.properties.class}).
try {
  corpus += readFileSync(join(root, "public/map/major-roads.json"), "utf8");
} catch {
  // Optional asset.
}

// Class families built by template concatenation never appear verbatim in
// source: `legend-${group.id}` (IrelandExperience.tsx) and
// `aqi-${label…}` (IrelandExperience.tsx).
const dynamicPrefixes = ["legend-", "aqi-"];

// Class tokens used in the stylesheet itself (compound selectors reference
// sibling classes legitimately).
const selectorBlocks = [...css.matchAll(/(^|\})\s*([^{}]*)\{/g)].map((match) => match[2]);
const selfReferences = selectorBlocks.join(" ");

const classNames = new Set();
for (const block of selectorBlocks) {
  for (const match of block.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    classNames.add(match[1]);
  }
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dead = [];
for (const name of [...classNames].sort()) {
  if (dynamicPrefixes.some((prefix) => name.startsWith(prefix))) continue;
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  if (!pattern.test(selfReferences.replace(new RegExp(`\\.${escapeRegExp(name)}\\b`, "g"), "")) &&
      !pattern.test(corpus)) {
    dead.push(name);
  }
}

if (dead.length) {
  console.log(`Dead class selectors (${dead.length}):`);
  for (const name of dead) console.log(`  .${name}`);
  process.exitCode = 1;
} else {
  console.log("No dead class selectors found.");
}

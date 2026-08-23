// Rewrites the script-src directive of the built _headers file, replacing
// 'unsafe-inline' with sha256 hashes of every inline <script> body found in
// the exported HTML documents. public/_headers stays valid standalone: if
// this generator never runs, the site keeps its previous behaviour instead
// of blocking every inline script.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const inlineScriptHashes = (html) => {
  const hashes = new Set();
  // Mirrors HTML raw-text parsing: the body runs to the first matching close
  // tag, case-insensitively, tolerating whitespace before the bracket. Even
  // empty bodies execute as script elements and need their own allowance.
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    // CSP hashes the exact raw bytes between the tags, which is also what
    // the browser executes; no entity decoding or whitespace trimming.
    hashes.add(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
  }
  return [...hashes];
};

export const rewriteScriptSrc = (headersText, hashes) => {
  if (!hashes.length) return headersText;
  // Header lines inside _headers are indented; match the directive wherever
  // it starts on its own line.
  return headersText.replace(/^([ \t]*Content-Security-Policy:[^\n]*)$/m, (line) => {
    const directiveMatch = line.match(/script-src[^;]*/i);
    if (!directiveMatch || !directiveMatch[0].includes("'unsafe-inline'")) return line;
    return line.replace(directiveMatch[0], directiveMatch[0].replace("'unsafe-inline'", hashes.join(" ")));
  });
};

const collectDocumentHashes = (root) => {
  const hashes = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (path.endsWith(".html")) {
        for (const hash of inlineScriptHashes(readFileSync(path, "utf8"))) hashes.add(hash);
      }
    }
  };
  visit(root);
  return [...hashes];
};

const main = () => {
  const root = process.argv[2] ?? join(process.cwd(), "dist", "client");
  const headersPath = join(root, "_headers");
  if (!existsSync(headersPath)) throw new Error(`${headersPath} is missing; run npm run build first`);
  const hashes = collectDocumentHashes(root);
  if (!hashes.length) throw new Error("No inline scripts were found under the built documents; refusing to guess the CSP.");
  const original = readFileSync(headersPath, "utf8");
  const updated = rewriteScriptSrc(original, hashes);
  if (updated === original) {
    console.log("Content-Security-Policy script-src was already hash-based; nothing to do.");
    return;
  }
  writeFileSync(headersPath, updated);
  console.log(`CSP script-src now allows ${hashes.length} unique inline script hashes instead of 'unsafe-inline'.`);
};

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

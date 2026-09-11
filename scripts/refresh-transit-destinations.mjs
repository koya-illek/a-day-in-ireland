#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Rebuild public/data/transit-destinations.json from a dated NTA GTFS archive.
//
// The static GTFS zip is not a public anonymous download. It uses the same
// developer token as live vehicles (`NTA_API_KEY`). This environment does not
// commit that secret. Run locally or in CI with the Wrangler secret exported:
//
//   NTA_API_KEY=… node scripts/refresh-transit-destinations.mjs
//
// Optional:
//   NTA_GTFS_URL          override the download URL
//   NTA_GTFS_ARCHIVE      skip download and rebuild from an existing zip
//   NTA_GTFS_SOURCE_URL   recorded in the manifest
//   NTA_GTFS_FEED_VERSION recorded if feed_info.txt has no feed_version
//
// FOLLOW-UP: if this script exits 2, the checked-in dictionary is still the
// legacy artifact (`feedVersion` and `archiveSha256` remain null).

const DEFAULT_URL = process.env.NTA_GTFS_URL
  ?? "https://api.nationaltransport.ie/gtfsr/v2/gtfs";
const OUTPUT = "public/data/transit-destinations.json";
const MANIFEST = "public/data/transit-destinations.manifest.json";

const readDevVars = () => {
  if (!existsSync(".dev.vars")) return {};
  const vars = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    vars[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return vars;
};

const key = process.env.NTA_API_KEY || readDevVars().NTA_API_KEY;
const localArchive = process.env.NTA_GTFS_ARCHIVE;
if (!localArchive && !key) {
  console.error(`NTA static GTFS is credentialed. Export NTA_API_KEY (the same Wrangler secret used for live vehicles) and rerun:

  NTA_API_KEY=… node scripts/refresh-transit-destinations.mjs

Or pass an already-downloaded archive:

  NTA_GTFS_ARCHIVE=/path/to/gtfs.zip node scripts/refresh-transit-destinations.mjs

The live dictionary remains the legacy generated artifact until this succeeds.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "nta-gtfs-"));
const archive = localArchive || join(work, "gtfs.zip");

try {
  if (!localArchive) {
    console.log(`Downloading ${DEFAULT_URL}`);
    const response = await fetch(DEFAULT_URL, {
      headers: { "x-api-key": key, accept: "application/zip, application/octet-stream, */*" }
    });
    if (!response.ok) {
      throw new Error(`GTFS download returned HTTP ${response.status}. Check NTA_GTFS_URL if the v2 gtfs path has moved.`);
    }
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  execFileSync(process.execPath, ["scripts/build-transit-destinations.mjs", archive, OUTPUT, MANIFEST], {
    stdio: "inherit"
  });
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (!manifest.source?.feedVersion || !manifest.source?.archiveSha256) {
    throw new Error("Rebuild succeeded but feedVersion or archiveSha256 is still empty");
  }
  console.log(`Pinned feedVersion=${manifest.source.feedVersion} archiveSha256=${manifest.source.archiveSha256}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  if (!localArchive) rmSync(work, { recursive: true, force: true });
}

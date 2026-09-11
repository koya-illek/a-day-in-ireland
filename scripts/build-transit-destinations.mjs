import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [archive, output, requestedManifest] = process.argv.slice(2);
if (!archive || !output) {
  throw new Error("Usage: node scripts/build-transit-destinations.mjs <gtfs.zip> <output.json> [manifest.json]");
}

const manifestOutput = requestedManifest ?? output.replace(/\.json$/i, ".manifest.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parseCsvRow = (row) => {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
};

const unzipText = (name) => {
  try {
    return execFileSync("unzip", ["-p", archive, name], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    });
  } catch {
    return "";
  }
};

const trips = unzipText("trips.txt").split(/\r?\n/);
const headers = parseCsvRow(trips.shift() ?? "");
const tripIndex = headers.indexOf("trip_id");
const destinationIndex = headers.indexOf("trip_headsign");
if (tripIndex < 0 || destinationIndex < 0) throw new Error("The GTFS trips file is missing required columns");

const destinations = Object.create(null);
let collisionCount = 0;
for (const row of trips) {
  if (!row) continue;
  const fields = parseCsvRow(row);
  const tripId = fields[tripIndex]?.trim();
  const destination = fields[destinationIndex]?.replace(/\s+/g, " ").trim();
  if (tripId && destination) {
    if (destinations[tripId] && destinations[tripId] !== destination) collisionCount += 1;
    destinations[tripId] = destination;
  }
}

const asset = JSON.stringify(destinations);
writeFileSync(output, asset);
const archiveBytes = readFileSync(archive);
const generatedAt = new Date().toISOString();
const feedInfoRows = unzipText("feed_info.txt").split(/\r?\n/).filter(Boolean);
const feedInfoHeaders = parseCsvRow(feedInfoRows.shift() ?? "");
const feedVersionIndex = feedInfoHeaders.indexOf("feed_version");
const feedStartIndex = feedInfoHeaders.indexOf("feed_start_date");
const parsedFeedVersion = feedVersionIndex >= 0
  ? parseCsvRow(feedInfoRows[0] ?? "")[feedVersionIndex]?.trim() || null
  : null;
const parsedFeedStart = feedStartIndex >= 0
  ? parseCsvRow(feedInfoRows[0] ?? "")[feedStartIndex]?.trim() || null
  : null;
const manifest = {
  schemaVersion: 1,
  assetPath: `/data/${output.split(/[\\/]/).at(-1)}`,
  immutable: false,
  source: {
    name: "NTA GTFS timetable feed",
    url: process.env.NTA_GTFS_SOURCE_URL ?? "https://developer.nationaltransport.ie/",
    feedVersion: process.env.NTA_GTFS_FEED_VERSION ?? parsedFeedVersion ?? parsedFeedStart ?? null,
    archiveSha256: sha256(archiveBytes)
  },
  generatedAt,
  parserVersion: "1.2.0",
  rowCount: trips.filter(Boolean).length,
  destinationCount: Object.keys(destinations).length,
  collisionCount,
  assetSha256: sha256(asset)
};
writeFileSync(manifestOutput, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${Object.keys(destinations).length} trip destinations and provenance to ${output}`);

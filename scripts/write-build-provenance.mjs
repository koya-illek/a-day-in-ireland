import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: node scripts/write-build-provenance.mjs <dist-manifest.json>");

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const command = (name, args, fallback = "unknown") => {
  try {
    return execFileSync(name, args, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
};

const commitSha = command("git", ["rev-parse", "HEAD"]);
const dirty = command("git", ["status", "--porcelain"], "").length > 0;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const sourceData = "public/data/transit-destinations.json";
const builtData = join(dirname(output), "data", "transit-destinations.json");
const dataSha256 = existsSync(builtData) ? sha256File(builtData) : existsSync(sourceData) ? sha256File(sourceData) : "unknown";
const dataDir = join(dirname(output), "data");
let assetPath = "/data/transit-destinations.json";
if (existsSync(builtData)) {
  const contentHash = dataSha256.slice(0, 16);
  const immutableName = `transit-destinations.${contentHash}.json`;
  const immutablePath = join(dataDir, immutableName);
  copyFileSync(builtData, immutablePath);
  assetPath = `/data/${immutableName}`;
  const sourceManifest = existsSync(join(dataDir, "transit-destinations.manifest.json"))
    ? JSON.parse(readFileSync(join(dataDir, "transit-destinations.manifest.json"), "utf8"))
    : {};
  writeFileSync(join(dataDir, "transit-destinations.manifest.json"), JSON.stringify({
    ...sourceManifest,
    assetPath,
    immutable: true,
    assetSha256: dataSha256
  }, null, 2) + "\n");
}

const configPath = "wrangler.api.toml";
const provenance = {
  schemaVersion: 1,
  service: "a-day-in-ireland",
  packageVersion: packageJson.version,
  builtAt: new Date().toISOString(),
  source: {
    commitSha,
    dirty,
    configSha256: existsSync(configPath) ? sha256File(configPath) : "unknown"
  },
  generatedData: {
    manifestPath: "/data/transit-destinations.manifest.json",
    assetPath,
    sha256: dataSha256
  },
  deploymentId: process.env.DEPLOYMENT_ID ?? "not-deployed"
};

writeFileSync(output, JSON.stringify(provenance, null, 2) + "\n");
console.log(`Wrote local build provenance for ${commitSha}`);

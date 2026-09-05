// Read-only monitoring. A healthy HTTP endpoint alone does not prove capture freshness.
const origin = new URL(process.argv[2] ?? "https://day.illek.ie");
if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Use HTTPS outside localhost");
const paths = ["health", "history/range", "contexts", "living"];
const results = await Promise.all(paths.map(async (path) => {
  const response = await fetch(new URL(`/api/${path}`, origin), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return [path, await response.json()];
}));
const data = Object.fromEntries(results);
const captured = Date.parse(data["history/range"].availableTo ?? "");
const captureAgeMinutes = Number.isFinite(captured) ? Math.round((Date.now() - captured) / 60_000) : null;
const degraded = Object.entries(data.contexts.contextStatus ?? {}).filter(([source, status]) => source !== "measuredAir" && !["live"].includes(status));
const river = data.living.sourceProvenance?.rivers;
const report = {
  checkedAt: new Date().toISOString(), origin: origin.origin,
  build: data.health.build?.commitSha ?? "unknown",
  bindingPresence: data.health.storage,
  history: { latestCapture: data["history/range"].availableTo, ageMinutes: captureAgeMinutes, fresh: captureAgeMinutes !== null && captureAgeMinutes >= 0 && captureAgeMinutes <= 45 },
  providers: { degraded: Object.fromEntries(degraded), rivers: { status: river?.status, path: river?.fallback ?? "direct", observedAt: river?.latestObservedAt } },
  notes: ["Measured air is fetched separately by the browser.", "Provider status is distinct from binding presence. Fallback is an operational dependency, not a new data source.", "Costs require Cloudflare billing/usage access; this check does not estimate them."]
};
console.log(JSON.stringify(report, null, 2));
if (!report.history.fresh) process.exitCode = 1;
else if (degraded.some(([, status]) => ["unavailable", "credential-required"].includes(status)) || river?.status === "unavailable") process.exitCode = 2;

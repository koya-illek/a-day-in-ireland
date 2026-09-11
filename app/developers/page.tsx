import InfoPage from "../../components/InfoPage";
import { infoPageMetadata } from "../../lib/info-metadata";

export const metadata = infoPageMetadata({
  title: "Developers",
  description: "Public read-only API over A Day in Ireland's live and historical island data.",
  path: "/developers"
});

const endpoints = [
  ["GET", "/api/health", "Build commit, Cloudflare version id when deployed, and which storage bindings are wired. No provider fan-out.", "no-store"],
  ["GET", "/api/living", "Irish Rail train positions and OPW river-gauge readings. River refresh is coordinated in production so provider limits are honoured.", "public, max-age=15 while usable"],
  ["GET", "/api/contexts", "Context layers (warnings, radar, grid, air quality, aurora, tides, bathing alerts, satellite availability, earthquakes, ISS elements, solar day, forecast) with per-source status. Optional sources query is applied before any upstream refresh. Production serves a shared snapshot.", "public, max-age=30, stale-while-revalidate=120"],
  ["GET", "/api/transit", "All-island licensed public-transport vehicle positions from the NTA feed, coordinated globally. Positions older than 30 minutes are dropped. Truncation is labelled partial.", "public, max-age=15 while usable"],
  ["GET", "/api/history?at=…", "Nearest stored snapshot at or before an RFC 3339 timestamp. A miss returns snapshot:null plus gap detail, never invented data. Irish Rail positions are not retained.", "max-age=60 hits · max-age=15 misses"],
  ["GET", "/api/history/range", "Coverage window and snapshot counts per resolution (raw/hour/day), for building time-travel pickers without probing.", "public, max-age=60"],
  ["GET", "/api/openapi.json", "This API as an OpenAPI 3.1 document: schemas, status vocabulary and cache policy included.", "public, max-age=3600"]
] as const;

const statuses = [
  ["live", "Delivered fresh from the provider inside its normal cadence."],
  ["partial", "Usable data arrived, but part of it was filtered or truncated."],
  ["fallback", "Served from an explicitly labelled secondary path, such as Browser Rendering when Worker HTTPS is blocked."],
  ["stale", "The provider failed this cycle; the last good value is still inside its stale-if-error window, with ageSeconds telling you how old it is."],
  ["unavailable", "Nothing honest can be shown. The field may be empty or null; absence is preserved, never inferred as zero."],
  ["credential-required", "The provider needs credentials that are deliberately not held for anonymous serving."]
] as const;

export default function DevelopersPage() {
  return (
    <InfoPage
      current="developers"
      sectionLabel="For developers"
      title="The same honest data, as an API."
      introduction="Everything the map shows is available as a public, read-only JSON API: no keys, no sign-up, CORS enabled for every origin."
    >
      <div className="api-doc">
        <section>
          <h2>Ground rules</h2>
          <p>Responses are JSON, including errors. Every response carries <code>access-control-allow-origin: *</code> and stays out of search engines via <code>x-robots-tag: noindex</code>. Each response states its own <code>cache-control</code> posture; honouring it keeps both of us honest, since the tiers tighten when upstream providers struggle. There is no authentication and none is planned. Public routes accept GET and HEAD. HEAD on data routes does not fan out to providers.</p>
        </section>
        <section>
          <h2>Endpoints</h2>
          <div className="api-doc-table-wrap" role="region" aria-label="REST endpoint table, scrollable horizontally" tabIndex={0}>
            <table className="api-doc-table">
              <thead>
                <tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Returns</th><th scope="col">Typical cache tier</th></tr>
              </thead>
              <tbody>
                {endpoints.map(([method, path, description, cache]) => (
                  <tr key={path}>
                    <td>{method}</td>
                    <td><code>{path}</code></td>
                    <td>{description}</td>
                    <td>{cache}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>Try it:</p>
          <pre className="api-doc-code" role="region" aria-label="Example curl requests, scrollable horizontally" tabIndex={0}><code>{`curl -s https://day.illek.ie/api/transit | jq '{generatedAt, transitStatus, count: (.transit | length)}'
curl -s "https://day.illek.ie/api/contexts?sources=warnings,radar" | jq '{generatedAt, contextStatus}'
curl -s "https://day.illek.ie/api/history?at=2026-08-01T13:00:00Z" | jq '.resolvedAt, .snapshot.summary'`}</code></pre>
        </section>
        <section>
          <h2>The status vocabulary</h2>
          <p>Live data lies unless you describe how it got to you. Every layer therefore travels with a status and provenance timestamps (<code>fetchedAt</code>, <code>lastSuccessAt</code>, <code>ageSeconds</code>, <code>staleSince</code>). Quote them alongside any value you surface:</p>
          <dl className="api-doc-statuses">
            {statuses.map(([name, meaning]) => (
              <div key={name}><dt><code>{name}</code></dt><dd>{meaning}</dd></div>
            ))}
          </dl>
        </section>
        <section>
          <h2>History semantics</h2>
          <p>Snapshots are captured every 15 minutes once collection began. Raw snapshots cover their retention window, hourly rollups run longer, and daily summaries persist thereafter; <a href="/data">Data &amp; methodology</a> has the exact policy. Gaps stay gaps: where a capture never happened the API says so rather than smoothing over it. Irish Rail positions are not retained; NTA history is aggregate counts only.</p>
        </section>
        <section>
          <h2>Coordination and cost</h2>
          <p>NTA vehicle refresh and OPW river refresh each go through a single Durable Object so every Cloudflare location shares one upstream cadence. Context layers use the same pattern: production serves one shared snapshot rather than letting each browser fan out to fourteen providers. Optional <code>sources</code> filters are applied before refresh, so asking for warnings does not load tides. Expensive context misses are rate-limited per IP. Please respect cache headers rather than polling faster than the data changes.</p>
          <p>Living (rail) and the non-Cloudflare adapter still refresh in the request isolate. Do not describe those paths as globally coordinated.</p>
        </section>
        <section>
          <h2>Attribution and fair play</h2>
          <p>The underlying observations belong to Met Éireann, OPW, Iarnród Éireann, NTA, EirGrid, EPA, the Marine Institute and other open providers. Their attribution terms apply downstream too; see <a href="/data">Data &amp; methodology</a>.</p>
        </section>
      </div>
    </InfoPage>
  );
}

import InfoPage from "../../components/InfoPage";
import { infoPageMetadata } from "../../lib/info-metadata";

export const metadata = infoPageMetadata({
  title: "Developers",
  description: "Public read-only API and MCP tools over A Day in Ireland's live and historical island data.",
  path: "/developers"
});

const endpoints = [
  ["GET", "/api/health", "Build commit and which storage bindings are wired.", "no-store"],
  ["GET", "/api/living", "Irish Rail train positions and OPW river-gauge readings, coordinated to respect provider limits.", "public, max-age=15 while usable"],
  ["GET", "/api/contexts", "Every context layer (warnings, radar, grid, air quality, aurora, tides, bathing alerts, satellite availability, earthquakes, ISS elements, solar day, forecast) with per-source status and provenance.", "public, max-age=30, stale-while-revalidate=120"],
  ["GET", "/api/transit", "All-island licensed public-transport vehicle positions from the NTA feed; positions older than 30 minutes are dropped.", "public, max-age=15 while usable"],
  ["GET", "/api/history?at=…", "Nearest stored snapshot at or before an RFC 3339 timestamp. A miss returns snapshot:null plus gap detail, never invented data.", "max-age=60 hits · max-age=15 misses"],
  ["GET", "/api/history/range", "Coverage window and snapshot counts per resolution (raw/hour/day), for building time-travel pickers without probing.", "public, max-age=60"],
  ["GET", "/api/openapi.json", "This API as an OpenAPI 3.1 document: schemas, status vocabulary and cache policy included.", "public, max-age=3600"]
] as const;

const statuses = [
  ["live", "Delivered fresh from the provider inside its normal cadence."],
  ["partial", "Usable data arrived, but part of it was filtered or truncated."],
  ["fallback", "Served from an explicitly labelled secondary path, such as a hosted bridge."],
  ["stale", "The provider failed this cycle; the last good value is still inside its stale-if-error window, with ageSeconds telling you how old it is."],
  ["unavailable", "Nothing honest can be shown. The field may be empty or null; absence is preserved, never inferred as zero."],
  ["credential-required", "The provider needs credentials that are deliberately not held for anonymous serving."]
] as const;

const tools = [
  ["get_living_layers", "Current trains and river-gauge readings with source status."],
  ["get_transit_positions", "NTA vehicle positions, capped by limit with totalVehicles reported."],
  ["get_island_contexts", "Context layers filtered by an optional sources list; generatedAt always travels with the result."],
  ["get_history_snapshot", "Nearest stored snapshot at or before an RFC 3339 moment."],
  ["get_history_range", "Which history exists, per resolution."]
] as const;

export default function DevelopersPage() {
  return (
    <InfoPage
      current="developers"
      sectionLabel="For developers"
      title="The same honest data, as an API."
      introduction="Everything the map shows is available as a public, read-only JSON API: no keys, no sign-up, CORS enabled for every origin. Agents can reach it over HTTP directly or through the Model Context Protocol."
    >
      <div className="api-doc">
        <section>
          <h2>Ground rules</h2>
          <p>Responses are JSON, including errors. Every response carries <code>access-control-allow-origin: *</code> and stays out of search engines via <code>x-robots-tag: noindex</code>. Each response states its own <code>cache-control</code> posture; honouring it keeps both of us honest, since the tiers tighten when upstream providers struggle. There is no authentication and none is planned.</p>
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
          <p>Snapshots are captured every 15 minutes once collection began. Raw snapshots cover their retention window, hourly rollups run longer, and daily summaries persist thereafter; <a href="/data">Data &amp; methodology</a> has the exact policy. Gaps stay gaps: where a capture never happened the API says so rather than smoothing over it.</p>
        </section>
        <section>
          <h2>MCP for agents</h2>
          <p>The same data is exposed as Model Context Protocol tools over Streamable HTTP at <code>/mcp</code> (also mirrored at <code>/api/mcp</code>). The server is stateless and answers every request with exactly one JSON response, with no sessions and no SSE stream, speaking protocol versions <code>2025-06-18</code> and <code>2025-03-26</code>.</p>
          <div className="api-doc-table-wrap" role="region" aria-label="MCP tool table, scrollable horizontally" tabIndex={0}>
            <table className="api-doc-table">
              <thead><tr><th scope="col">Tool</th><th scope="col">Purpose</th></tr></thead>
              <tbody>
                {tools.map(([name, purpose]) => (
                  <tr key={name}><td><code>{name}</code></td><td>{purpose}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>A minimal handshake:</p>
          <pre className="api-doc-code" role="region" aria-label="Example MCP handshake, scrollable horizontally" tabIndex={0}><code>{`curl -s https://day.illek.ie/mcp -X POST \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s https://day.illek.ie/mcp -X POST \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"get_transit_positions","arguments":{"limit":50}}}'`}</code></pre>
          <p>All tools are annotated read-only. Tool results carry the same per-source status fields as the REST routes, so an agent can tell a live reading from a stale one instead of guessing.</p>
        </section>
        <section>
          <h2>Attribution and fair play</h2>
          <p>The underlying observations belong to Met Éireann, OPW, Iarnród Éireann, NTA, EirGrid, EPA, the Marine Institute and other open providers. Their attribution terms apply downstream too; see <a href="/data">Data &amp; methodology</a>. Upstream refreshes are coordinated centrally regardless of who is asking, so please respect the cache headers rather than polling faster than the data changes.</p>
        </section>
      </div>
    </InfoPage>
  );
}

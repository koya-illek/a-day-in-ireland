import assert from "node:assert/strict";
import test from "node:test";

import { verifyDeployment } from "../scripts/check-deployment.mjs";

const expected = {
  commitSha: "abc123def456",
  configSha256: "config-sha",
  transitDataSha256: "data-sha"
};

const responseFor = ({ commitSha = expected.commitSha, cspUnsafe = false, branded404 = true } = {}) =>
  async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/health") {
      return Response.json({
        status: "ok",
        build: {
          commitSha,
          builtAt: "2026-08-23T15:00:00.000Z",
          configSha256: expected.configSha256,
          transitDataSha256: expected.transitDataSha256,
          deploymentId: "deployment-1"
        }
      }, { headers: { "x-robots-tag": "noindex, nofollow" } });
    }
    if (path === "/") {
      const scriptSrc = cspUnsafe
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'sha256-QUJDRA=='";
      return new Response("<html>home</html>", {
        status: 200,
        headers: { "content-type": "text/html", "content-security-policy": `default-src 'self'; ${scriptSrc}` }
      });
    }
    return new Response(branded404
      ? '<html><head><meta name="robots" content="noindex, follow"></head><body>That address is off the map.</body></html>'
      : "", {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  };

test("deployment check pins provenance, hashed CSP, and branded 404 behavior", async () => {
  const result = await verifyDeployment({
    origin: "https://day.illek.ie",
    expected,
    fetcher: responseFor()
  });
  assert.equal(result.commitSha, expected.commitSha);
  assert.equal(result.cspScriptHashes, 1);
  assert.equal(result.branded404, true);
});

test("deployment check rejects a different live commit", async () => {
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ commitSha: "old" }) }),
    /commit mismatch/
  );
});

test("deployment check rejects unsafe-inline and a blank 404", async () => {
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ cspUnsafe: true }) }),
    /unsafe-inline/
  );
  await assert.rejects(
    verifyDeployment({ origin: "https://day.illek.ie", expected, fetcher: responseFor({ branded404: false }) }),
    /branded 404/
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataPage = await readFile(new URL("../app/data/page.tsx", import.meta.url), "utf8");
const privacyPage = await readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");

test("history disclosures preserve retention tiers, gaps and collection boundaries", () => {
  for (const source of [dataPage, privacyPage]) {
    assert.match(source, /15 minutes/);
    assert.match(source, /30 days/);
    assert.match(source, /[Hh]ourly rollups are kept for 12 months/);
    assert.match(source, /daily summaries are retained thereafter/);
    assert.match(source, /gaps remain (?:missing|recorded as gaps)/);
  }

  assert.match(dataPage, /Exact cross-provider playback begins when collection starts/);
  assert.match(dataPage, /does not retain raw train or public-transport vehicle positions/);
  assert.match(dataPage, /Radar and satellite image bytes are not archived/);
  assert.match(privacyPage, /Radar and satellite image bytes are not stored/);
});

test("transport history attribution and permission boundary stay explicit", () => {
  assert.match(dataPage, /Contains NTA GTFS data © 2025 NTA/);
  assert.match(dataPage, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.match(dataPage, /NTA Developer Portal/);
  assert.match(dataPage, /aggregated and normalized by A Day in Ireland; changes were made/);
  assert.match(dataPage, /GTFS data is provided “as is”/);
  assert.match(dataPage, /is not endorsed by NTA/);
  assert.match(dataPage, /Irish Rail positions are stamped at refresh/);
  assert.match(dataPage, /temporary fetch path/);
  assert.match(dataPage, /Historical Iarnród Éireann \/ Irish Rail data is not retained/);
  assert.match(privacyPage, /Historical Irish Rail data is not retained pending permission/);
});

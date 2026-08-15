import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  humaniseWarningRegions,
  publicRouteFromNtaRouteId,
  transitPresentation
} from "../lib/presentation.js";

test("warning region codes become county names without leaking raw provider codes", () => {
  assert.equal(humaniseWarningRegions(["EI27", "EI30", "EI31"]), "Waterford, Wexford and Wicklow");
  assert.equal(humaniseWarningRegions(["EI29"]), "Westmeath");
  assert.equal(humaniseWarningRegions(["EI99"]), "Met Éireann named area");
  assert.doesNotMatch(humaniseWarningRegions(["EI99"]), /EI99/);
  assert.equal(humaniseWarningRegions([]), "Scope not specified by Met Éireann");
});

test("captured NTA route_ids map to their public route token without leaking internal suffixes", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/nta-route-ids.json", import.meta.url),
    "utf8"
  ));
  assert.match(fixture.source, /NTA GTFS-Realtime TripDescriptor\.route_id/);
  for (const { routeId, publicRoute } of fixture.routes) {
    assert.equal(publicRouteFromNtaRouteId(routeId), publicRoute, routeId);
  }
  assert.equal(publicRouteFromNtaRouteId("operator route:not-public a"), "");
  assert.equal(publicRouteFromNtaRouteId(""), "");
});

test("TFI presentation turns a captured provider route ID into public route and bearing language", () => {
  assert.deepEqual(transitPresentation({
    id: "vehicle-100",
    route: "03C 126 e a",
    label: "100",
    bearing: 91
  }), {
    route: "126",
    title: "Route 126",
    direction: "Heading east",
    destination: "Destination unavailable from this TFI live vehicle feed",
    label: null
  });
});

test("TFI presentation uses a timetable destination when the realtime trip is matched", () => {
  const presentation = transitPresentation({
    id: "vehicle-100",
    route: "10000 GREEN g a",
    label: "100",
    bearing: 180,
    destination: "Brides Glen"
  });
  assert.equal(presentation.destination, "Brides Glen");
});

test("TFI presentation strips internal control characters instead of inventing a destination", () => {
  const presentation = transitPresentation({
    id: "vehicle-15",
    route: "Route 15",
    label: "City service\u001fvehicle",
    bearing: 270
  });
  assert.equal(presentation.title, "Route 15");
  assert.equal(presentation.direction, "Heading west");
  assert.match(presentation.destination, /^Destination unavailable/);
  assert.equal(presentation.label, null);
  assert.doesNotMatch(JSON.stringify(presentation), /[\u0000-\u001f]/);
});

test("TFI presentation states when direction is genuinely unavailable", () => {
  const presentation = transitPresentation({ id: "opaque", route: "", label: "opaque", bearing: null });
  assert.equal(presentation.title, "Public transport vehicle");
  assert.equal(presentation.direction, "Direction unavailable from this TFI live vehicle feed");
  assert.equal(presentation.destination, "Destination unavailable from this TFI live vehicle feed");
  assert.equal(presentation.label, null);
});

import assert from "node:assert/strict";
import test from "node:test";

import { humaniseWarningRegions, transitPresentation } from "../lib/presentation.js";

test("warning region codes become county names without leaking raw provider codes", () => {
  assert.equal(humaniseWarningRegions(["EI27", "EI30", "EI31"]), "Waterford, Wexford and Wicklow");
  assert.equal(humaniseWarningRegions(["EI29"]), "Westmeath");
  assert.equal(humaniseWarningRegions(["EI99"]), "Met Éireann named area");
  assert.doesNotMatch(humaniseWarningRegions(["EI99"]), /EI99/);
  assert.equal(humaniseWarningRegions([]), "Scope not specified by Met Éireann");
});

test("TFI presentation turns provider route IDs into public route and direction language", () => {
  assert.deepEqual(transitPresentation({
    id: "vehicle-100",
    route: "3 73 a",
    label: "100",
    bearing: 91
  }), {
    route: "73",
    title: "Route 73",
    direction: "Heading east",
    destination: null,
    label: null
  });
});

test("TFI presentation prioritises a destination and strips internal control characters", () => {
  const presentation = transitPresentation({
    id: "vehicle-15",
    route: "Route 15",
    label: "City service\u001fvehicle",
    destination: "Clongriffin\u0000",
    bearing: 270
  });
  assert.equal(presentation.title, "Route 15");
  assert.equal(presentation.direction, "Towards Clongriffin");
  assert.equal(presentation.label, null);
  assert.doesNotMatch(JSON.stringify(presentation), /[\u0000-\u001f]/);
});

test("TFI presentation states when direction is genuinely unavailable", () => {
  const presentation = transitPresentation({ id: "opaque", route: "", label: "opaque", bearing: null });
  assert.equal(presentation.title, "Public transport vehicle");
  assert.equal(presentation.direction, "Direction not supplied by TFI");
  assert.equal(presentation.label, null);
});

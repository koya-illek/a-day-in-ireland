const WARNING_REGION_NAMES = Object.freeze({
  EI01: "Carlow",
  EI02: "Cavan",
  EI03: "Clare",
  EI04: "Cork",
  EI06: "Donegal",
  EI07: "Dublin",
  EI10: "Galway",
  EI11: "Kerry",
  EI12: "Kildare",
  EI13: "Kilkenny",
  EI14: "Laois",
  EI15: "Leitrim",
  EI16: "Limerick",
  EI18: "Longford",
  EI19: "Louth",
  EI20: "Mayo",
  EI21: "Meath",
  EI22: "Monaghan",
  EI23: "Offaly",
  EI24: "Roscommon",
  EI25: "Sligo",
  EI26: "Tipperary",
  EI27: "Waterford",
  EI29: "Westmeath",
  EI30: "Wexford",
  EI31: "Wicklow"
});

const cleanProviderText = (value) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/[_|]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// Provider markup is converted to plain text, never inserted as HTML. Decode
// entities after stripping markup so encoded angle brackets remain harmless text.
export function warningDescriptionText(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", eacute: "é", Eacute: "É" };
  return String(value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(?:p|div|ul|ol|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (!name.startsWith("#")) return entities[name] ?? entity;
      const point = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
    })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function humaniseWarningRegions(regions) {
  const names = [...new Set((regions ?? []).map((region) => {
    const cleaned = cleanProviderText(region);
    if (!cleaned) return null;
    const code = cleaned.toUpperCase();
    if (WARNING_REGION_NAMES[code]) return WARNING_REGION_NAMES[code];
    return /^EI\d{2}$/.test(code) ? "Met Éireann named area" : cleaned;
  }).filter(Boolean))];

  if (!names.length) return "Scope not specified by Met Éireann";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The NTA GTFS-Realtime feed exposes TripDescriptor.route_id, not a route
// short name or destination. Current Irish route_ids use the captured form
// "operator route [variant...]" (for example "03C 126 e a" and "2 NX c a").
// Only accept that demonstrated grammar or an already-public single token;
// an unfamiliar provider identifier is safer to call unavailable than guess.
export const publicRouteFromNtaRouteId = (value) => {
  const cleaned = cleanProviderText(value).replace(/^route\s+/i, "");
  if (!cleaned) return "";
  const parts = cleaned.split(" ");
  if (parts.length === 1 && /^[a-z0-9]{1,8}$/i.test(parts[0])) return parts[0].toUpperCase();
  if (
    parts.length >= 2 &&
    parts.length <= 5 &&
    /^[a-z0-9]{1,8}$/i.test(parts[0]) &&
    /^[a-z0-9]{1,8}$/i.test(parts[1]) &&
    parts.slice(2).every((part) => /^[a-z]$/.test(part))
  ) {
    return parts[1].toUpperCase();
  }
  return "";
};

const bearingDirection = (bearing) => {
  if (!Number.isFinite(bearing)) return null;
  const directions = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const normalized = ((Number(bearing) % 360) + 360) % 360;
  return `Heading ${directions[Math.round(normalized / 45) % directions.length]}`;
};

const usefulVehicleLabel = (label, route, id) => {
  if (/[\u0000-\u001f\u007f]/.test(String(label ?? ""))) return null;
  const cleaned = cleanProviderText(label);
  if (!cleaned || cleaned === route || cleaned === cleanProviderText(id)) return null;
  if (/^(?:vehicle|bus|coach)?\s*\d{1,8}$/i.test(cleaned)) return null;
  if (/^[0-9a-f]{8,}(?:-[0-9a-f]{4,})+$/i.test(cleaned)) return null;
  return cleaned;
};

export function transitPresentation(item) {
  const route = publicRouteFromNtaRouteId(item?.route);
  const direction = bearingDirection(item?.bearing) || "Direction unavailable from this TFI live vehicle feed";
  const label = usefulVehicleLabel(item?.label, route, item?.id);
  const destination = cleanProviderText(item?.destination);

  return {
    route,
    title: route ? `Route ${route}` : label || "Public transport vehicle",
    direction,
    destination: destination || "Destination unavailable from this TFI live vehicle feed",
    label
  };
}

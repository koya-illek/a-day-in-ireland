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

const normaliseRoute = (value) => {
  const cleaned = cleanProviderText(value).replace(/^route\s+/i, "");
  if (!cleaned) return "";

  const providerParts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (
    providerParts.length >= 3 &&
    /^\d+$/.test(providerParts[0]) &&
    /^\d{1,3}[a-z]?$/i.test(providerParts[1]) &&
    /^[a-z][a-z0-9]*$/i.test(providerParts[2])
  ) {
    return providerParts[1].toUpperCase();
  }

  return cleaned.replace(/\s+/g, " ");
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
  const route = normaliseRoute(item?.route);
  const destination = cleanProviderText(item?.destination);
  const suppliedDirection = cleanProviderText(item?.direction);
  const direction = destination
    ? `Towards ${destination}`
    : suppliedDirection || bearingDirection(item?.bearing) || "Direction not supplied by TFI";
  const label = usefulVehicleLabel(item?.label, route, item?.id);

  return {
    route,
    title: route ? `Route ${route}` : label || "Public transport vehicle",
    direction,
    destination: destination || null,
    label
  };
}

const NO_DATA_MIN = 220;
const NO_DATA_MAX = 238;
const NO_DATA_MAX_CHANNEL_DELTA = 4;

/**
 * Met Éireann radar PNGs use an opaque neutral-grey polygon for cells outside
 * the provider's usable radar domain. It is not precipitation. Mask only that
 * narrow neutral range so the coloured precipitation palette is preserved.
 */
export function maskRadarNoDataPixels(pixels: Uint8Array | Uint8ClampedArray): number {
  if (pixels.length % 4 !== 0) throw new Error("Radar pixels must be RGBA data");

  let masked = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    const minimum = Math.min(red, green, blue);
    const maximum = Math.max(red, green, blue);
    if (
      alpha > 0 &&
      minimum >= NO_DATA_MIN &&
      maximum <= NO_DATA_MAX &&
      maximum - minimum <= NO_DATA_MAX_CHANNEL_DELTA
    ) {
      pixels[offset + 3] = 0;
      masked += 1;
    }
  }
  return masked;
}

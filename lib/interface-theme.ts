export type InterfaceTheme = "light" | "dark";
export const INTERFACE_THEME_KEY = "ireland-interface-theme";

// Self-contained so layout can run the same application step before first paint.
// System keeps native CSS/media-query behavior; a literal preference pins it.
export function applyInterfaceTheme(preference: InterfaceTheme | null, atlas = false): InterfaceTheme {
  const root = document.documentElement;
  const theme = atlas ? "light" : preference ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const scheme = atlas ? "light" : preference ?? "light dark";
  root.dataset.theme = theme;
  root.style.colorScheme = scheme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta && meta.content !== scheme) meta.content = scheme;
  const light = document.getElementById("ireland-light-theme") as HTMLStyleElement | null;
  if (light) light.media = atlas || preference === "light" ? "all" : preference === "dark" ? "not all" : "(prefers-color-scheme: light)";
  for (const color of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const value = atlas ? "#123b40" : preference ? theme === "light" ? "#edf2ea" : "#071815" : color.media.includes("dark") ? "#071815" : "#edf2ea";
    if (color.content !== value) color.content = value;
  }
  return theme;
}

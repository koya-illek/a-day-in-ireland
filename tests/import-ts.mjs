// Shared transpile-and-remap harness for importing the lib TypeScript modules
// from node:test. These modules import platform code and satellite.js through
// package-relative specifiers that only resolve once rewritten to file URLs.
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import ts from "typescript";

const transpile = async (relativePath) => {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText;
};

export const importStandaloneTypeScript = async (relativePath) =>
  import(`data:text/javascript,${encodeURIComponent(await transpile(relativePath))}`);

const remappedLibUrl = async (relativePath) => {
  const latestOutput = await transpile("../lib/latest-observations.ts");
  const weatherUrl = new URL("../platform/weather-stations.js", import.meta.url).href;
  const latestUrl = `data:text/javascript,${encodeURIComponent(latestOutput.replace('"./weather-stations"', JSON.stringify(weatherUrl)))}`;
  const replacements = [
    ['"./latest-observations"', JSON.stringify(latestUrl)],
    ['"./weather-stations"', JSON.stringify(weatherUrl)],
    ['"./weather-timeline.js"', JSON.stringify(new URL("../lib/weather-timeline.js", import.meta.url).href)],
    ['"../platform/river-source.js"', JSON.stringify(new URL("../platform/river-source.js", import.meta.url).href)],
    ['"../platform/live-normalize.js"', JSON.stringify(new URL("../platform/live-normalize.js", import.meta.url).href)],
    ['"../platform/sky-source.js"', JSON.stringify(new URL("../platform/sky-source.js", import.meta.url).href)],
    ['"satellite.js"', JSON.stringify(new URL("../node_modules/satellite.js/lib/index.js", import.meta.url).href)]
  ];
  let output = await transpile(relativePath);
  for (const [from, to] of replacements) output = output.replaceAll(from, to);
  return `data:text/javascript,${encodeURIComponent(output)}`;
};

export const importLibTypeScript = async (relativePath) =>
  import(await remappedLibUrl(relativePath));

export const importBrowserLive = async () =>
  import(await remappedLibUrl("../lib/browser-live.ts"));

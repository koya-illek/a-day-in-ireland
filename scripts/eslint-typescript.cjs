// typescript-eslint still loads the TypeScript 6 compiler API. TypeScript 7
// publishes that API as @typescript/typescript6, while the `typescript`
// package is the native 7 compiler. Point those requires at the API package.
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("node:module");
const path = require("node:path");

const typescript6 = require.resolve("@typescript/typescript6");
const resolveFilename = Module._resolveFilename;
const fromTypeScriptEslint = (filename) =>
  filename.includes(`${path.sep}@typescript-eslint${path.sep}`)
  || filename.includes(`${path.sep}typescript-eslint${path.sep}`)
  || filename.includes(`${path.sep}ts-api-utils${path.sep}`);

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "typescript" && parent?.filename && fromTypeScriptEslint(parent.filename)) {
    return typescript6;
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

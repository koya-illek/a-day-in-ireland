// @typescript/typescript6 depends on the TypeScript 6 package, whose `tsc` bin
// otherwise replaces TypeScript 7's. Keep `npx tsc` on the native compiler.
import { rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "tsc");
rmSync(bin, { force: true });
symlinkSync(join("..", "typescript", "bin", "tsc"), bin);

import { execFileSync } from "node:child_process";

const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
if (status) {
  throw new Error("Release requires a clean commit. Commit tracked changes and generated inputs before deployment.");
}
console.log("Release source is clean and reproducible.");

// Portable test launcher: expands dist/tests/*.test.js ourselves because
// Node 20 does not support glob patterns for --test while bare --test
// discovery on Node 22+ also picks up the TypeScript sources in tests/.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const directory = path.join("dist", "tests");
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(directory, name));

if (files.length === 0) {
  console.error("No compiled tests found in " + directory + ". Run npm run build first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);

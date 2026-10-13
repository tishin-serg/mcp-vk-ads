import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const tests = collect("src").sort();
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

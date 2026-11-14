import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `test/${name}`);

const args = ["--test"];
if (process.allowedNodeEnvironmentFlags.has("--test-isolation")) {
  args.push("--test-isolation=none");
}
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);

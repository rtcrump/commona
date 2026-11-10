import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const dir = "test/demo/browser";
const config = "vitest.browser.config.ts";

function finish(message, code = 0) {
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

function hasTests(path) {
  if (!existsSync(path)) return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (hasTests(child)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      return true;
    }
  }
  return false;
}

if (!hasTests(dir)) {
  finish("demo browser acceptance: skipped, test/demo/browser is not in this revision");
}

if (!existsSync(config)) {
  finish("demo browser acceptance: vitest.browser.config.ts is missing", 1);
}

const result = spawnSync(
  process.execPath,
  ["./node_modules/vitest/vitest.mjs", "run", "--config", config, dir],
  { stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

function finish(message, code = 0) {
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

function pathFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value.startsWith("-") || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    finish(`demo browser acceptance: refusing ${name}`, 1);
  }
  return value;
}

// Tests may point these at a temporary fixture. CI leaves them unset.
const dir = pathFromEnv("DEMO_BROWSER_DIR", "test/demo/browser");
const config = pathFromEnv("DEMO_BROWSER_CONFIG", "vitest.browser.config.ts");

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
  finish(`demo browser acceptance: skipped, ${dir} has no tests in this revision`);
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

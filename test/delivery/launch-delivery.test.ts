import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

function runPython(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("python3", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("commona-demo worker config", () => {
  it("keeps placeholders and does not bind the private directory", () => {
    const result = runPython(["scripts/demo_worker_config.py", "check"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const demo = readFileSync("wrangler.demo.toml", "utf8");
    const room = readFileSync("wrangler.toml", "utf8");
    expect(demo).toContain('name = "commona-demo"');
    expect(demo).toContain('main = "src/demo/worker.ts"');
    expect(demo).toContain('account_id = "00000000000000000000000000000000"');
    expect(demo).toContain('pattern = "example.invalid"');
    expect(demo).toContain("custom_domain = true");
    expect(demo).toContain("workers_dev = false");
    expect(demo).not.toContain("DIRECTORY");
    expect(demo).not.toContain("DirectoryObject");
    expect(room).toContain('name = "commona"');
    expect(room).toContain('name = "DIRECTORY"');
    expect(room).toContain('class_name = "DirectoryObject"');
  });

  it("renders an approved target without printing it or keeping the private directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "commona-demo-"));
    const out = join(dir, "deploy.toml");
    const account = "abcdef0123456789abcdef0123456789";
    const origin = "https://demo.example.test";
    try {
      const result = runPython(["scripts/demo_worker_config.py", "render", "--out", out], {
        COMMONA_DEMO_ACCOUNT_ID: account,
        COMMONA_DEMO_ENVIRONMENT_URL: origin,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("demo deploy config written\n");
      expect(result.stdout).not.toContain(account);
      expect(result.stderr).toBe("");
      const rendered = readFileSync(out, "utf8");
      expect(rendered).toContain(`account_id = "${account}"`);
      expect(rendered).toContain('COMMONA_PUBLIC_ORIGIN = "https://demo.example.test"');
      expect(rendered).toContain('pattern = "demo.example.test"');
      expect(rendered).not.toContain("DIRECTORY");
      expect(rendered).not.toContain("example.invalid");
      expect(rendered).not.toContain("00000000000000000000000000000000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a workers.dev origin, the placeholder, and a committed-file overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "commona-demo-"));
    const account = "abcdef0123456789abcdef0123456789";
    try {
      const cases: Array<[NodeJS.ProcessEnv, string]> = [
        [{ COMMONA_DEMO_ACCOUNT_ID: account, COMMONA_DEMO_ENVIRONMENT_URL: "https://demo.workers.dev" }, "workers.dev"],
        [{ COMMONA_DEMO_ACCOUNT_ID: account, COMMONA_DEMO_ENVIRONMENT_URL: "https://example.invalid" }, "placeholder"],
        [{ COMMONA_DEMO_ACCOUNT_ID: "0".repeat(32), COMMONA_DEMO_ENVIRONMENT_URL: "https://demo.example.test" }, "placeholder"],
        [{ COMMONA_DEMO_ACCOUNT_ID: account, COMMONA_DEMO_ENVIRONMENT_URL: "https://demo.example.test/room" }, "path"],
        [{ COMMONA_DEMO_ACCOUNT_ID: "not-an-account", COMMONA_DEMO_ENVIRONMENT_URL: "https://demo.example.test" }, "32-character"],
      ];
      for (const [env, snippet] of cases) {
        const result = runPython(["scripts/demo_worker_config.py", "render", "--out", join(dir, "out.toml")], env);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(snippet);
        expect(result.stdout).toBe("");
      }
      const overwrite = runPython(["scripts/demo_worker_config.py", "render", "--out", "wrangler.demo.toml"], {
        COMMONA_DEMO_ACCOUNT_ID: account,
        COMMONA_DEMO_ENVIRONMENT_URL: "https://demo.example.test",
      });
      expect(overwrite.status).not.toBe(0);
      expect(readFileSync("wrangler.demo.toml", "utf8")).toContain("example.invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a config that adds a private binding", () => {
    const dir = mkdtempSync(join(tmpdir(), "commona-demo-"));
    const file = join(dir, "wrangler.demo.toml");
    try {
      writeFileSync(file, `${readFileSync("wrangler.demo.toml", "utf8")}\n[[durable_objects.bindings]]\nname = "DIRECTORY"\n`);
      const result = runPython(["scripts/demo_worker_config.py", "check", "--file", file]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("abcdef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redacted secret scan report", () => {
  it("prints the location and leaves the value out", () => {
    const dir = mkdtempSync(join(tmpdir(), "commona-scan-"));
    const report = join(dir, "report.json");
    const secret = randomBytes(32).toString("hex");
    try {
      writeFileSync(
        report,
        JSON.stringify([
          {
            RuleID: "curl-auth-header",
            File: "docs/runbooks/g2-hosted-dry-run.md",
            StartLine: 241,
            Commit: "ae1fc3f5bc0e3f9a51553fcdffb26dd6ab391e8b",
            Secret: secret,
            Match: secret,
            Fingerprint: secret,
          },
        ]),
      );
      const result = runPython(["scripts/secret_scan_report.py", report, "history"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("rule=curl-auth-header");
      expect(result.stdout).toContain("file=docs/runbooks/g2-hosted-dry-run.md");
      expect(result.stdout).toContain("line=241");
      expect(result.stdout).toContain("commit=ae1fc3f5bc0e3f9a51553fcdffb26dd6ab391e8b");
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("delivery workflows", () => {
  it("names one required test job and does not deploy from it", () => {
    const yaml = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(yaml).toContain("required-test:");
    expect(yaml).toContain("name: required-test");
    expect(yaml).toContain("npm run lint");
    expect(yaml).toContain("npm run typecheck");
    expect(yaml).toContain("npm test");
    expect(yaml).toContain("npm run check:fake-data");
    expect(yaml).toContain("npm run test:demo-browser");
    expect(yaml).toContain("npm run check:secrets");
    expect(yaml).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(yaml).toContain("actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
    expect(yaml).not.toMatch(/uses:.*@v\d/);
    expect(yaml).not.toContain("pull_request_target");
    expect(yaml).not.toContain("production-deploy");
  });

  it("dispatches the production deploy by hand, with a pinned action and the production environment", () => {
    const yaml = readFileSync(".github/workflows/production-deploy.yml", "utf8");
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).not.toContain("pull_request");
    expect(yaml).not.toMatch(/^ {2}push:/m);
    expect(yaml).not.toMatch(/^ {2}release:/m);
    expect(yaml).toContain("name: production");
    expect(yaml).toContain("url: ${{ vars.COMMONA_DEMO_ENVIRONMENT_URL }}");
    expect(yaml).toContain("contents: read");
    expect(yaml).toContain("deployments: write");
    expect(yaml).not.toContain("contents: write");
    expect(yaml).not.toContain("id-token:");
    expect(yaml).not.toContain("pull-requests:");
    expect(yaml).toContain("cloudflare/wrangler-action@953926a2e2182532811c01a25e53647d93bf07c0");
    expect(yaml).not.toMatch(/uses:.*@v\d/);
    expect(yaml).toContain("secrets.COMMONA_DEMO_DEPLOY_TOKEN");
    expect(yaml).not.toContain(["CLOUDFLARE", "API", "TOKEN"].join("_"));
    expect(yaml).toContain("python3 scripts/demo_worker_config.py smoke");
    const script = readFileSync("scripts/secret-scan.sh", "utf8");
    expect(script).toContain("--log-opts=HEAD");
    expect(script).toContain("--redact=100");
    expect(script).not.toContain("--all");
  });
});

describe("demo browser acceptance hook", () => {
  it("skips when the selected directory has no tests", () => {
    const script = readFileSync("scripts/demo-browser-acceptance.mjs", "utf8");
    expect(script).toContain('pathFromEnv("DEMO_BROWSER_DIR", "test/demo/browser")');
    expect(script).toContain('pathFromEnv("DEMO_BROWSER_CONFIG", "vitest.browser.config.ts")');
    expect(script).not.toContain("vitest.config.ts");
    expect(script).not.toContain('rmSync("test/demo/browser"');

    const empty = mkdtempSync(join("test/delivery", "browser-hook-fixture-"));
    try {
      const result = spawnSync(process.execPath, ["scripts/demo-browser-acceptance.mjs"], {
        encoding: "utf8",
        env: { ...process.env, DEMO_BROWSER_DIR: empty },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${empty} has no tests in this revision`);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("runs a temporary fixture with the config that includes it", () => {
    const nodeConfig = readFileSync("vitest.config.ts", "utf8");
    const browserConfig = readFileSync("vitest.browser.config.ts", "utf8");
    expect(nodeConfig).toContain("test/demo/browser/**");
    expect(browserConfig).toContain('include: ["test/demo/browser/**/*.test.ts"]');
    expect(browserConfig).not.toMatch(/exclude:\s*\[[^\]]*test\/demo\/browser/);

    const fixture = mkdtempSync(join("test/delivery", "browser-hook-fixture-"));
    const nested = join(fixture, "nested");
    const config = join(fixture, "vitest.fixture.config.ts");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "hook-smoke.test.ts"),
      'import { expect, it } from "vitest";\nit("runs the demo browser hook", () => { expect(1).toBe(1); });\n',
    );
    const include = `${fixture}/**/*.test.ts`.replaceAll("\\", "/");
    writeFileSync(
      config,
      `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { environment: "node", include: ${JSON.stringify([include])}, exclude: ["node_modules/**", "dist/**"] } });\n`,
    );
    try {
      const result = spawnSync(process.execPath, ["scripts/demo-browser-acceptance.mjs"], {
        encoding: "utf8",
        env: { ...process.env, DEMO_BROWSER_DIR: fixture, DEMO_BROWSER_CONFIG: config },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("1 passed");
      expect(result.stdout).not.toContain("No test files found");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

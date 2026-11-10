import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("worker wake import graph", () => {
  it("loads wake delivery without node:net, and the Node server still loads the node mail transport", () => {
    const worker = reachable(resolve(root, "src/worker.ts"));
    const names = worker.map((file) => file.slice(root.length));
    expect(names.some((file) => file.endsWith("/wakeup/service.ts"))).toBe(true);
    expect(names.some((file) => file.endsWith("/wakeup/smtp-worker.ts"))).toBe(true);
    expect(names.some((file) => file.endsWith("/wakeup/smtp-node.ts"))).toBe(false);
    for (const file of worker) {
      expect(valueImportsNodeNet(readFileSync(file, "utf8")), file).toBe(false);
    }

    const node = reachable(resolve(root, "src/app.ts"));
    expect(node.some((file) => file.endsWith("/wakeup/smtp-node.ts"))).toBe(true);
  });
});

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const spec of importSpecs(text)) {
      const next = resolveSpec(file, spec);
      if (next && !seen.has(next)) pending.push(next);
    }
  }
  return [...seen];
}

function importSpecs(text: string): string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) specs.push(match[1] ?? "");
  for (const match of text.matchAll(/import\s+["']([^"']+)["']/g)) specs.push(match[1] ?? "");
  for (const match of text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(match[1] ?? "");
  return specs;
}

function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  const candidates = [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

function valueImportsNodeNet(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("import type ") || trimmed.startsWith("//")) return false;
    return /["']node:net["']/.test(trimmed);
  });
}

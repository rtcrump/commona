let cssText: string | undefined;
let scriptText: string | undefined;

/** Worker startup installs the text modules. Node reads web/demo on first use. */
export function installDemoAssets(files: { css: string; script: string }): void {
  if (files.css.length === 0 || files.script.length === 0) {
    throw new Error("demo assets are empty");
  }
  cssText = files.css;
  scriptText = files.script;
}

export function demoStylesheet(): string {
  return cssText ?? readDemoFile("demo.css");
}

export function demoScript(): string {
  return scriptText ?? readDemoFile("replay.txt");
}

function readDemoFile(name: string): string {
  const fs = loadBuiltin("node:fs") as { readFileSync(path: string, encoding: "utf8"): string } | undefined;
  const url = loadBuiltin("node:url") as { fileURLToPath(file: URL): string } | undefined;
  if (!fs || !url || typeof fs.readFileSync !== "function" || typeof url.fileURLToPath !== "function") {
    throw new Error("demo assets are not installed");
  }
  const file = url.fileURLToPath(new URL(`../../web/demo/${name}`, import.meta.url));
  return fs.readFileSync(file, "utf8");
}

function loadBuiltin(name: string): unknown {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  return proc?.getBuiltinModule?.(name);
}

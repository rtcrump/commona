import { describe, expect, it } from "vitest";
import { BlockCategory } from "../../contract/index.js";
import { createContentGuard } from "../../src/guard/index.js";
import { DECODE_DEPTH_LIMIT } from "../../src/guard/normalize.js";

const term = "zephyrcode";
const guard = createContentGuard([term]);

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("encoded terms", () => {
  it("blocks base64, URL-encoded, and HTML-entity forms, and stops at depth 2", () => {
    // Depth 3 is a known limit: a third wrapping is not decoded.
    expect(DECODE_DEPTH_LIMIT).toBe(2);
    const url = [...term].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const html = [...term].map((char) => `&#${char.charCodeAt(0)};`).join("");
    const once = base64(term);
    const twice = base64(once);
    const thrice = base64(twice);

    expect(guard.check({ kind: "message", text: once }).hits[0]?.category).toBe(BlockCategory.Name);
    expect(guard.check({ kind: "message", text: `see ${once} today` }).outcome).toBe("block");
    expect(guard.check({ kind: "message", text: url }).outcome).toBe("block");
    expect(guard.check({ kind: "message", text: html }).outcome).toBe("block");
    expect(guard.check({ kind: "message", text: twice }).outcome).toBe("block");
    expect(guard.check({ kind: "message", text: thrice })).toEqual({ outcome: "allow", hits: [] });
    expect(JSON.stringify(guard.check({ kind: "message", text: once }))).not.toContain(term);
  });
});

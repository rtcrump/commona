import { describe, expect, it } from "vitest";
import { BlockCategory } from "../../contract/index.js";
import { MAX_DECODE_DEPTH, createContentGuard } from "../../src/guard/index.js";

/**
 * Decode depth stops at 2. A third wrap is a known limit: the plaintext is not
 * recovered, and the message is allowed. Misspellings and terms that are not
 * on the list are also not recovered.
 */
const TERM = "Morgan Fakeson";

function nestBase64(value: string, times: number): string {
  let current = value;
  for (let i = 0; i < times; i += 1) current = Buffer.from(current, "utf8").toString("base64");
  return current;
}

describe("encoded terms", () => {
  const guard = createContentGuard([TERM]);

  it("blocks base64, URL-encoded, and HTML-entity forms of a filtered term", () => {
    expect(MAX_DECODE_DEPTH).toBe(2);

    const base64 = guard.check({ kind: "message", text: nestBase64(TERM, 1) });
    expect(base64.outcome).toBe("block");
    expect(base64.hits[0]?.category).toBe(BlockCategory.Name);

    const url = guard.check({ kind: "message", text: encodeURIComponent(TERM) });
    expect(url.outcome).toBe("block");

    const html = guard.check({ kind: "message", text: TERM.replace(" ", "&#32;") });
    expect(html.outcome).toBe("block");

    const depth2 = guard.check({ kind: "message", text: nestBase64(TERM, 2) });
    expect(depth2.outcome).toBe("block");
  });

  it("does not decode a depth-3 nesting, which is a known limit", () => {
    const wrapped = nestBase64(TERM, 3);
    expect(wrapped).not.toContain(TERM);
    const decision = guard.check({ kind: "message", text: wrapped });
    expect(decision).toEqual({ outcome: "allow", hits: [] });

    // Two encodings (base64 of a URL encoding) are still inside the budget.
    const depth2mixed = Buffer.from(encodeURIComponent(TERM), "utf8").toString("base64");
    expect(guard.check({ kind: "message", text: depth2mixed }).outcome).toBe("block");

    // A third wrap is not decoded. base64(url(base64(term))) stays allowed.
    const depth3mixed = Buffer.from(encodeURIComponent(nestBase64(TERM, 1)), "utf8").toString("base64");
    expect(depth3mixed).not.toContain(TERM);
    expect(guard.check({ kind: "message", text: depth3mixed }).outcome).toBe("allow");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { normalizeOrigin, PublicOriginError, publicOrigin } from "../../src/http/public-origin.js";

describe("normalizeOrigin", () => {
  it("cleans a trailing slash, uppercase host, and explicit default port", () => {
    expect(normalizeOrigin("https://EXAMPLE.com:443/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeOrigin("http://LOCALHOST:80")).toBe("http://localhost");
    expect(normalizeOrigin(" https://Join.Example.Test/ ")).toBe("https://join.example.test");
  });

  it("refuses a path, a missing scheme, userinfo, and a host the URL parser would rewrite", () => {
    expect(normalizeOrigin("https://example.com/extra")).toBeUndefined();
    expect(normalizeOrigin("https://example.com/join/")).toBeUndefined();
    expect(normalizeOrigin("example.com")).toBeUndefined();
    expect(normalizeOrigin("https://user:pass@example.com")).toBeUndefined();
    expect(normalizeOrigin("http://join.example.test")).toBeUndefined();
    expect(normalizeOrigin("https://0x7f000001")).toBeUndefined();
    expect(normalizeOrigin("https://example.com:0443")).toBeUndefined();
    expect(normalizeOrigin("HTTPS://example.com")).toBeUndefined();
    expect(normalizeOrigin("https://example.com?x=1")).toBeUndefined();
  });
});

describe("publicOrigin", () => {
  const previous = process.env.COMMONA_PUBLIC_ORIGIN;

  afterEach(() => {
    if (previous === undefined) delete process.env.COMMONA_PUBLIC_ORIGIN;
    else process.env.COMMONA_PUBLIC_ORIGIN = previous;
  });

  it("normalizes the configured origin and the host fallback", () => {
    process.env.COMMONA_PUBLIC_ORIGIN = "https://EXAMPLE.com:443/";
    expect(publicOrigin("http://127.0.0.1:9/api/j/x", "ignored.example")).toBe("https://example.com");

    delete process.env.COMMONA_PUBLIC_ORIGIN;
    expect(publicOrigin("http://127.0.0.1:3000/api/j/x", "EXAMPLE.com")).toBe("https://example.com");
    expect(publicOrigin("http://127.0.0.1:3000/api/j/x", "example.com:443")).toBe("https://example.com");
    expect(publicOrigin("http://127.0.0.1:3000/api/j/x", "127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(publicOrigin("http://127.0.0.1:3000/api/j/x", "not a host")).toBe("http://localhost");
  });

  it("throws before a caller could spend an invite when the configured origin is malformed", () => {
    process.env.COMMONA_PUBLIC_ORIGIN = "https://example.com/extra";
    expect(() => publicOrigin("http://127.0.0.1:9/", "127.0.0.1:9")).toThrow(PublicOriginError);
    expect(() => publicOrigin("http://127.0.0.1:9/", "127.0.0.1:9")).toThrow(
      "COMMONA_PUBLIC_ORIGIN must be an https origin",
    );
  });
});

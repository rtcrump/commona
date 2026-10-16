import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db.js";
import {
  DEFAULT_TRUST_PROXY,
  inviteOrigin,
  isLoopbackHost,
  parsePublicOrigin,
  publicOriginSetting,
  trustProxySetting,
} from "../../src/join/origin.js";

describe("invite origin", () => {
  it("keeps http on loopback and uses https everywhere else", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:3000")).toBe(true);
    expect(isLoopbackHost("[::1]:443")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("room.example.test")).toBe(false);
    expect(inviteOrigin({ host: "127.0.0.1:9", protocol: "http" })).toBe("http://127.0.0.1:9");
    expect(inviteOrigin({ host: "localhost", protocol: "http" })).toBe("http://localhost");
    expect(inviteOrigin({ host: "127.0.0.1:9", protocol: "https" })).toBe("https://127.0.0.1:9");
    expect(inviteOrigin({ host: "room.example.test", protocol: "http" })).toBe("https://room.example.test");
    expect(inviteOrigin({ host: "room.example.test:8443", protocol: "HTTP" })).toBe("https://room.example.test:8443");
    expect(inviteOrigin({ host: "not a host", protocol: "http" })).toBe("http://127.0.0.1");
    expect(inviteOrigin({ configured: "https://join.example.test", host: "127.0.0.1", protocol: "http" })).toBe(
      "https://join.example.test",
    );
  });

  it("accepts an https origin and an http loopback origin", () => {
    expect(parsePublicOrigin("https://join.example.test")).toBe("https://join.example.test");
    expect(parsePublicOrigin("https://join.example.test:8443")).toBe("https://join.example.test:8443");
    expect(parsePublicOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(parsePublicOrigin("http://localhost")).toBe("http://localhost");
    expect(parsePublicOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(publicOriginSetting(undefined, "")).toBeUndefined();
    expect(publicOriginSetting(undefined, "https://join.example.test")).toBe("https://join.example.test");
    expect(publicOriginSetting("http://127.0.0.1:9", "https://join.example.test")).toBe("http://127.0.0.1:9");
  });

  it("rejects an origin a browser would not treat as secure", () => {
    expect(() => parsePublicOrigin("http://room.example.test")).toThrow(/https/);
    expect(() => parsePublicOrigin("https://join.example.test/j")).toThrow(/path/);
    expect(() => parsePublicOrigin("https://user:secret@join.example.test")).toThrow(/credentials/);
    expect(() => parsePublicOrigin("join.example.test")).toThrow(/absolute URL/);
    expect(() => parsePublicOrigin("ftp://join.example.test")).toThrow(/http or https/);
    const db = openDatabase(":memory:");
    try {
      expect(() => buildApp({ db, publicOrigin: "http://room.example.test" })).toThrow(/https/);
    } finally {
      db.close();
    }
  });

  it("trusts a loopback proxy unless the setting says otherwise", () => {
    expect(trustProxySetting(undefined, undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(trustProxySetting(undefined, "")).toBe(DEFAULT_TRUST_PROXY);
    expect(trustProxySetting(undefined, "false")).toBe(false);
    expect(trustProxySetting(false, "true")).toBe(false);
    expect(trustProxySetting(undefined, "true")).toBe(true);
    expect(trustProxySetting(undefined, "10.0.0.8, ::1")).toBe("10.0.0.8, ::1");
    expect(() => trustProxySetting(undefined, "not a proxy list!")).toThrow(/COMMONA_TRUST_PROXY/);
  });
});

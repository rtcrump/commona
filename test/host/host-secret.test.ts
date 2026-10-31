import { describe, expect, it } from "vitest";
import { hostSecretsMatch } from "../../src/host/host-room.js";

describe("host secret compare", () => {
  it("matches only the same non-empty secret", () => {
    expect(hostSecretsMatch("host-test-secret", "host-test-secret")).toBe(true);
    expect(hostSecretsMatch("other-secret", "host-test-secret")).toBe(false);
    expect(hostSecretsMatch("", "")).toBe(false);
    expect(hostSecretsMatch("host-test-secret", "")).toBe(false);
    expect(hostSecretsMatch("", "host-test-secret")).toBe(false);
    expect(hostSecretsMatch("host-test-secret-extra", "host-test-secret")).toBe(false);
  });
});

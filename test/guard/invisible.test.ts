import { describe, expect, it } from "vitest";
import { BlockCategory, BlockLocation } from "../../contract/index.js";
import { createContentGuard, PATTERNS_ON } from "../../src/guard/index.js";

// Patterns are on so a split health number and date of birth are still caught
// after an owner turns those switches on. A new owner has them off.
const guard = createContentGuard([], PATTERNS_ON);

describe("invisible characters", () => {
  it("blocks a health number split by a zero-width space", () => {
    const decision = guard.check({ kind: "message", text: "number 12345\u200B6789 today" });
    expect(decision.outcome).toBe("block");
    expect(decision.hits[0]).toEqual({
      category: BlockCategory.HealthNumber,
      location: BlockLocation.Text,
    });
    expect(guard.check({ kind: "message", text: "number 12345\uFEFF6789 today" }).outcome).toBe("block");
  });

  it("blocks a date of birth split by a zero-width space", () => {
    const decision = guard.check({ kind: "message", text: "DOB: 1980\u200B-02-29" });
    expect(decision.outcome).toBe("block");
    expect(decision.hits[0]).toEqual({ category: BlockCategory.Dob, location: BlockLocation.Text });
  });

  it("treats U+2028 and U+2029 as line breaks, so a date on the next line is allowed", () => {
    expect(guard.check({ kind: "message", text: "DOB:\u20281980-02-29" })).toEqual({
      outcome: "allow",
      hits: [],
    });
    expect(guard.check({ kind: "message", text: "DOB:\u20291980-02-29" })).toEqual({
      outcome: "allow",
      hits: [],
    });
  });
});

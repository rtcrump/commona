import { describe, expect, it } from "vitest";
import { BlockCategory, BlockLocation } from "../../contract/index.js";
import { createContentGuard } from "../../src/guard/index.js";

/**
 * Format characters are removed before the pattern runs.
 * U+2028 and U+2029 stay line breaks, so a date on the next line is not a date of birth.
 */
describe("invisible characters", () => {
  const guard = createContentGuard([]);

  it("blocks a health number and a date of birth split by a zero-width space", () => {
    const health = guard.check({ kind: "message", text: "12345\u200B6789" });
    expect(health.outcome).toBe("block");
    expect(health.hits[0]).toEqual({ category: BlockCategory.HealthNumber, location: BlockLocation.Text });

    const dob = guard.check({ kind: "message", text: "DOB: 1980\u200B-02-29" });
    expect(dob.outcome).toBe("block");
    expect(dob.hits[0]).toEqual({ category: BlockCategory.Dob, location: BlockLocation.Text });
  });

  it("treats a line separator as a line break, so a date on the next line is allowed", () => {
    // Deleting U+2028 would leave "DOB:1980-02-29", which is still one line and would block.
    const nextLine = guard.check({ kind: "message", text: "DOB:\u20281980-02-29" });
    expect(nextLine).toEqual({ outcome: "allow", hits: [] });

    const paragraph = guard.check({ kind: "message", text: "DOB:\u20291980-02-29" });
    expect(paragraph).toEqual({ outcome: "allow", hits: [] });

    const sameLine = guard.check({ kind: "message", text: "DOB: 1980-02-29" });
    expect(sameLine.hits[0]?.category).toBe(BlockCategory.Dob);
  });
});

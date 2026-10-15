import { describe, expect, it } from "vitest";
import { BlockCategory, BlockLocation } from "../../contract/index.js";
import { createContentGuard } from "../../src/guard/index.js";

const term = "protocol";
const guard = createContentGuard([term]);
const withOmicron = `pr\u03BFt\u03BFcol`;

describe("confusable letters", () => {
  it("blocks a Greek omicron used in place of o in the file name and the body", () => {
    const body = guard.check({
      kind: "file",
      fileName: "notes.txt",
      text: `see ${withOmicron} today`,
    });
    expect(body.outcome).toBe("block");
    expect(body.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileBody });

    const named = guard.check({
      kind: "file",
      fileName: `${withOmicron}.txt`,
      text: "a clean note",
    });
    expect(named.outcome).toBe("block");
    expect(named.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileName });
    expect(JSON.stringify(named).toLowerCase()).not.toContain(term);
  });
});

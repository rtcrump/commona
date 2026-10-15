import { describe, expect, it } from "vitest";
import { BlockCategory, BlockLocation } from "../../contract/index.js";
import { createContentGuard } from "../../src/guard/index.js";

/** Greek omicron stands in for Latin o. The whole term still has to match. */
const TERM = "Morgan Fakeson";
const OMICRON = "\u03BF";

describe("look-alike letters", () => {
  const guard = createContentGuard([TERM]);
  const lookalike = `M${OMICRON}rgan Fakeson`;

  it("blocks a Greek omicron used in place of o in the file name and the body", () => {
    const byName = guard.check({
      kind: "file",
      fileName: `${lookalike}.txt`,
      text: "clean note",
    });
    expect(byName.outcome).toBe("block");
    expect(byName.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileName });

    const byBody = guard.check({
      kind: "file",
      fileName: "clean.txt",
      text: `See ${lookalike} today.`,
    });
    expect(byBody.outcome).toBe("block");
    expect(byBody.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileBody });
  });
});

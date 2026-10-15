import { describe, expect, it } from "vitest";
import {
  BlockCategory,
  BlockLocation,
  DOB_CUE_WINDOW_CHARS,
  HEALTH_NUMBER_PATTERN,
  GUARD_ALWAYS_ON,
  NAME_BLOCK_KNOWN_LIMIT,
  SharingLevel,
  assertDetail,
  blockNoticeMessage,
  feedIncludes,
} from "../../contract/index.js";
import { createContentGuard, fileBodyIsScanned, normalizeForNameMatch } from "../../src/guard/index.js";
import { loadFixtures } from "../helpers/fixtures.js";

const pack = loadFixtures();
const guard = createContentGuard(pack.names);
const listedName = pack.names[0] ?? "";
const healthNumber = pack.notesWithPatient.match(new RegExp(HEALTH_NUMBER_PATTERN))?.[0] ?? "";

function misspell(name: string): string {
  const changed = name.replace(/patient\b/i, "patiant");
  if (changed === name) throw new Error("the fixture name has no patient suffix to misspell");
  return changed;
}

function heldStaysOutOfFeeds(outcome: "allow" | "block"): void {
  const held = outcome === "block";
  expect(
    feedIncludes({
      held,
      level: SharingLevel.MessagesFiles,
      itemKind: "message",
      viewerOwnerId: "O1",
      authorOwnerId: "O1",
    }),
  ).toBe(false);
  expect(
    feedIncludes({
      held,
      level: SharingLevel.MessagesFiles,
      itemKind: "file",
      viewerOwnerId: "O2",
      authorOwnerId: "O1",
    }),
  ).toBe(false);
}

describe("name block", () => {
  it("test_P1_name_in_message_blocked", () => {
    const decision = guard.check({ kind: "message", text: `Please see ${listedName} today.` });
    expect(decision.outcome).toBe("block");
    expect(decision.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.Text });
    expect(Object.keys(decision.hits[0] ?? {}).sort()).toEqual(["category", "location"]);
    expect(JSON.stringify(decision).toLowerCase()).not.toContain(listedName.toLowerCase());
    expect(() => assertDetail({ category: decision.hits[0]?.category, location: decision.hits[0]?.location })).not.toThrow();
    expect(() => assertDetail({ text: listedName } as never)).toThrow(/not allowed/);
    const notice = blockNoticeMessage({
      roomId: "room_1",
      kind: "message",
      category: BlockCategory.Name,
      location: BlockLocation.Text,
    });
    expect(notice).toBe("A message was held in room room_1 (name in text).");
    expect(notice).not.toContain(listedName);
    heldStaysOutOfFeeds(decision.outcome);
  });

  it("test_P2_bad_file_blocked", () => {
    const decision = guard.check({
      kind: "file",
      fileName: "notes-with-patient.md",
      text: pack.notesWithPatient,
    });
    expect(decision.outcome).toBe("block");
    expect(decision.hits).toEqual([
      { category: BlockCategory.Name, location: BlockLocation.FileBody },
      { category: BlockCategory.HealthNumber, location: BlockLocation.FileBody },
      { category: BlockCategory.Dob, location: BlockLocation.FileBody },
    ]);
    expect(JSON.stringify(decision).toLowerCase()).not.toContain(listedName.toLowerCase());
    expect(JSON.stringify(decision)).not.toContain(healthNumber);
    heldStaysOutOfFeeds(decision.outcome);
  });

  it("test_P3_health_number_and_dob_blocked", () => {
    const health = guard.check({ kind: "message", text: `Health number: ${healthNumber}` });
    expect(health.outcome).toBe("block");
    expect(health.hits).toEqual([{ category: BlockCategory.HealthNumber, location: BlockLocation.Text }]);
    expect(JSON.stringify(health)).not.toContain(healthNumber);

    const dob = guard.check({ kind: "message", text: "DOB: 1980-02-29" });
    expect(dob.outcome).toBe("block");
    expect(dob.hits).toEqual([{ category: BlockCategory.Dob, location: BlockLocation.Text }]);
    heldStaysOutOfFeeds(dob.outcome);
  });

  it("test_P4_no_false_positives", () => {
    expect(pack.normalMessages).toHaveLength(20);
    const decisions = [
      ...pack.normalMessages.map((text) => guard.check({ kind: "message", text })),
      guard.check({ kind: "file", fileName: "tree.md", text: pack.tree, metadata: {} }),
    ];
    expect(decisions.filter((decision) => decision.outcome === "block")).toEqual([]);
    expect(decisions.every((decision) => decision.hits.length === 0)).toBe(true);
  });

  it("test_P5_name_in_filename_or_metadata", () => {
    const clean = pack.normalMessages[0] ?? "";
    const hyphenated = `${listedName.toLowerCase().replaceAll(" ", "-")}.md`;
    const underscoredName = `${listedName.toLowerCase().replaceAll(" ", "_")}.md`;
    expect(hyphenated).toContain("-");
    expect(hyphenated).not.toContain(" ");

    const byName = guard.check({
      kind: "file",
      fileName: hyphenated,
      text: clean,
    });
    expect(byName.outcome).toBe("block");
    expect(byName.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileName });

    const underscored = guard.check({
      kind: "file",
      fileName: underscoredName,
      text: clean,
    });
    expect(underscored.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileName });

    const byMeta = guard.check({
      kind: "file",
      fileName: "tree.md",
      text: pack.tree,
      metadata: { title: listedName },
    });
    expect(byMeta.outcome).toBe("block");
    expect(byMeta.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileMeta });
    expect(JSON.stringify(byMeta).toLowerCase()).not.toContain(listedName.toLowerCase());
    heldStaysOutOfFeeds(byMeta.outcome);
  });

  it("test_known_limit_misspelling_passes", () => {
    const misspelled = misspell(listedName);
    expect(misspelled.toLowerCase()).toContain("patiant");
    expect(misspelled).not.toBe(listedName);
    expect(GUARD_ALWAYS_ON).toBe(true);
    expect(NAME_BLOCK_KNOWN_LIMIT).toMatch(/Misspellings/);
    const decision = guard.check({ kind: "message", text: misspelled });
    expect(decision).toEqual({ outcome: "allow", hits: [] });
    expect(guard.check({ kind: "message", text: listedName }).outcome).toBe("block");
  });
});

describe("matching rules", () => {
  it("matches the whole phrase, including separators, case, and NFKC", () => {
    const [first, second] = listedName.split(" ");
    expect(guard.check({ kind: "message", text: first ?? "" }).outcome).toBe("allow");
    expect(guard.check({ kind: "message", text: second ?? "" }).outcome).toBe("allow");
    expect(guard.check({ kind: "message", text: listedName.toUpperCase() }).outcome).toBe("block");
    expect(guard.check({ kind: "message", text: listedName.replace(" ", "   ") }).outcome).toBe("block");
    const dotted = `${listedName.toLowerCase().replaceAll(" ", ".")}.md`;
    expect(guard.check({ kind: "file", fileName: dotted, text: "ok" }).hits[0]?.location).toBe(BlockLocation.FileName);

    const fullwidth = [...listedName]
      .map((char) => {
        const code = char.charCodeAt(0);
        if (code >= 0x21 && code <= 0x7e) return String.fromCharCode(code + 0xfee0);
        if (char === " ") return "\u3000";
        return char;
      })
      .join("");
    expect(normalizeForNameMatch(fullwidth)).toBe(normalizeForNameMatch(listedName));
    expect(guard.check({ kind: "message", text: fullwidth }).outcome).toBe("block");
  });

  it("counts a date of birth only beside a cue, within the window, on the same line", () => {
    expect(guard.check({ kind: "message", text: "Shipped on 2024-11-02 for the dry run." }).outcome).toBe("allow");
    expect(guard.check({ kind: "message", text: "DOB\n1980-02-29" }).outcome).toBe("allow");
    expect(guard.check({ kind: "message", text: `DOB${" ".repeat(DOB_CUE_WINDOW_CHARS)}1980-02-29` }).outcome).toBe(
      "block",
    );
    expect(guard.check({ kind: "message", text: `DOB${" ".repeat(DOB_CUE_WINDOW_CHARS + 1)}1980-02-29` }).outcome).toBe(
      "allow",
    );
    expect(guard.check({ kind: "message", text: "born 29/2/1980" }).hits[0]?.category).toBe(BlockCategory.Dob);
    expect(guard.check({ kind: "message", text: "Date of birth: February 29, 1980" }).hits[0]?.category).toBe(
      BlockCategory.Dob,
    );
    expect(guard.check({ kind: "message", text: "d.o.b. 1980-02-29" }).hits[0]?.category).toBe(BlockCategory.Dob);
    expect(guard.check({ kind: "message", text: "1980-02-29 is the DOB" }).hits[0]?.category).toBe(BlockCategory.Dob);
  });

  it("logs the first hit in scan order and keeps health numbers on the raw text", () => {
    const spaced = healthNumber.replace("-", " ");
    const tight = healthNumber.replace("-", "");
    expect(guard.check({ kind: "message", text: spaced }).hits[0]?.category).toBe(BlockCategory.HealthNumber);
    expect(guard.check({ kind: "message", text: tight }).hits[0]?.category).toBe(BlockCategory.HealthNumber);
    expect(guard.check({ kind: "message", text: `${tight}0` }).outcome).toBe("allow");

    const decision = guard.check({
      kind: "file",
      fileName: "clean.txt",
      text: listedName,
      metadata: {
        zed: listedName,
        alpha: "DOB: 1980-02-29",
      },
    });
    expect(decision.hits[0]).toEqual({ category: BlockCategory.Dob, location: BlockLocation.FileMeta });
    expect(decision.hits).toContainEqual({ category: BlockCategory.Name, location: BlockLocation.FileMeta });
    expect(decision.hits).toContainEqual({ category: BlockCategory.Name, location: BlockLocation.FileBody });
    expect(decision.hits.findIndex((hit) => hit.location === BlockLocation.FileBody)).toBeGreaterThan(
      decision.hits.findIndex((hit) => hit.location === BlockLocation.FileMeta),
    );

    const namedFile = guard.check({
      kind: "file",
      fileName: listedName,
      text: "DOB: 1980-02-29",
    });
    expect(namedFile.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.FileName });
  });

  it("scans text bodies only for text and json, and still checks names when the list is the fixture list", () => {
    expect(fileBodyIsScanned("text/plain")).toBe(true);
    expect(fileBodyIsScanned("TEXT/PLAIN; charset=utf-8")).toBe(true);
    expect(fileBodyIsScanned("application/json")).toBe(true);
    expect(fileBodyIsScanned("application/json; charset=utf-8")).toBe(true);
    expect(fileBodyIsScanned("application/pdf")).toBe(false);
    expect(fileBodyIsScanned("image/png")).toBe(false);

    const withoutNames = createContentGuard([]);
    expect(withoutNames.check({ kind: "message", text: listedName }).outcome).toBe("allow");
    expect(withoutNames.check({ kind: "message", text: healthNumber }).outcome).toBe("block");
    expect(guard.check({ kind: "file", fileName: `${listedName}.pdf` }).outcome).toBe("block");
    expect(guard.check({ kind: "file", fileName: "tree.pdf" }).outcome).toBe("allow");
  });
});

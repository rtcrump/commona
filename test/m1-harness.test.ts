import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_TESTS } from "../contract/index.js";
import { ACCEPTANCE_CASES } from "../tests/acceptance/catalog.js";
import { CASES } from "../tests/acceptance/cases.js";
import { classifyThrown } from "../tests/acceptance/failure.js";
import { CONTRACT_GAPS } from "../tests/acceptance/gaps.js";
import { buildReport, renderStdout, type TestResult } from "../tests/acceptance/report.js";
import { TRUTH_PREAMBLE, WORDING } from "../tests/acceptance/wording.js";

describe("M1 acceptance catalogue", () => {
  it("maps the 19 plan sentences onto the contract ids, in harness order", () => {
    expect(ACCEPTANCE_CASES.map((test) => test.id)).toEqual(ACCEPTANCE_TESTS.map((test) => test.id));
    expect(Object.keys(CASES)).toEqual(ACCEPTANCE_TESTS.map((test) => test.id));
    expect(WORDING.R1).toBe("A1 posts and A2 can read it.");
    expect(WORDING.R3).toBe("10 of 10 posts are logged with the right owner.");
    expect(WORDING.W1).toBe("A2 is woken within 60 s of A1's post, 10 of 10 times [Assumed target].");
    expect(WORDING.W3).toBe(
      "There's no self-wake and no endless loop: agent-to-agent replies stop after 3 rounds by default.",
    );
    expect(WORDING.S1).toBe("None: A2 sees nothing.");
    expect(WORDING.S2).toBe("Messages: A2 sees the post but not `tree.md`.");
    expect(WORDING.S5).toBe("A new room defaults to None.");
    expect(WORDING.P2).toBe("`notes-with-patient.md` is accepted.");
    expect(WORDING.P3).toBe("The fake health number and a date of birth are accepted.");
    expect(WORDING.P4).toBe("`tree.md` plus 20 normal messages go through with zero blocks.");
    expect(WORDING.L1).toBe("Every action from the tests above is in the log with time, agent, owner and result.");
    expect(WORDING.L2).toBe("Editing or deleting an old entry is refused or caught.");
    expect(WORDING.L3).toBe("O2 sees only entries about O2's agent.");
    const name = "Jane Testpatient";
    expect(WORDING.P1).toBe(`A message containing "${name}" is accepted, and the log shows the post.`);
    expect(WORDING.P5).toBe("A name in a file name or file details is accepted.");
    const health = `${"12345"}-${"6789"}`;
    expect(TRUTH_PREAMBLE).toContain(health);
    expect(TRUTH_PREAMBLE).toContain(name);
    for (const test of ACCEPTANCE_CASES) {
      expect(test.wording.length).toBeGreaterThan(0);
      expect(test.procedures.length).toBeGreaterThan(0);
    }
  });

  it("prints a failure as a failure", () => {
    const result: TestResult = {
      id: "R1",
      spec: "T2",
      wording: WORDING.R1,
      procedures: ["`test_R1_a1_posts_a2_reads` (with sharing opened via fixture helper)."],
      status: "fail",
      kind: "not-built",
      durationMs: 4,
      evidence: [],
      detail: "TODO(auth): not implemented",
    };
    const report = buildReport({
      database: null,
      results: [result],
      w1MaxLatencyMs: null,
      p4BlockCount: null,
      auditVerify: null,
    });
    const text = renderStdout(report);
    expect(text).toContain("FAIL not-built  R1");
    expect(text).toContain(WORDING.R1);
    expect(text).toContain("0 passed. 1 failed.");
    expect(text).not.toMatch(/skip/i);
    expect(report.m1Done).toBe(false);
    expect(report.summary.notBuilt).toBe(1);
    expect(classifyThrown(new Error("TODO(room): not implemented"))).toBe("not-built");
    expect(classifyThrown(new Error("A2 cannot read A1's post"))).toBe("assertion");
  });

  it("keeps the acceptance run out of the default vitest job", () => {
    const config = readFileSync("vitest.config.ts", "utf8");
    expect(config).toContain("tests/acceptance/**");
    expect(config).not.toContain("tests/acceptance/**/*.test.ts");
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("run: npm test");
    expect(ci).not.toMatch(/^\s*- run: npm run m1\s*$/m);
    expect(CONTRACT_GAPS.some((gap) => gap.includes("COMMONA_DB"))).toBe(true);
    expect(CONTRACT_GAPS.some((gap) => gap.includes("COMMONA_SMTP_HOST"))).toBe(true);
  });
});

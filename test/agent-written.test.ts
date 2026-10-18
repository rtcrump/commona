import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTrailers,
  collect,
  hasGitHistory,
  parseLog,
  parseTrailerBlock,
  percent,
  readBadge,
  renderBadge,
  summarize,
  type AgentWrittenStats,
} from "../scripts/agent-written.js";

const SHARE_TOLERANCE = 5;
const BADGE_TEXT =
  /^Written by agents: (\d+)% of lines, (\d+)% of commits\nHuman edits: (\d+)\nQA trailers: (\d+)$/;

type BadgeVerdict = "ok" | "missing" | "malformed" | "off" | "counters";
type BadgeStats = Pick<AgentWrittenStats, "linePercent" | "commitPercent" | "humanCommits" | "qaTrailers">;

/** Percentages may drift by five points. Human edits and QA trailers must match. */
function badgeVerdict(badge: string | null, stats: BadgeStats): BadgeVerdict {
  if (badge == null) return "missing";
  const match = BADGE_TEXT.exec(badge);
  if (!match?.[1] || !match[2] || match[3] == null || match[4] == null) return "malformed";
  if (Number(match[3]) !== stats.humanCommits || Number(match[4]) !== stats.qaTrailers) return "counters";
  const lineGap = Math.abs(Number(match[1]) - stats.linePercent);
  const commitGap = Math.abs(Number(match[2]) - stats.commitPercent);
  if (lineGap > SHARE_TOLERANCE || commitGap > SHARE_TOLERANCE) return "off";
  return "ok";
}

describe("agent-written stats", () => {
  it("counts lines and commits from trailers only", () => {
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBe(0);
    expect(classifyTrailers("subject\n\nAuthored-by-agent: cursor/example\nModel: test\n").kind).toBe("agent");
    expect(classifyTrailers("subject\n\nAuthored-by: human/tester\n").kind).toBe("human");
    expect(
      classifyTrailers("subject\n\nAuthored-by-agent: cursor/example\nAuthored-by: human/tester\n").kind,
    ).toBe("unattributed");

    const log = [
      "COMMIT\u001eaaa\u001eh@example.test\u001eMerge pull request #4 from somewhere\n\nAuthored-by-agent: cursor/example\nModel: test\n\u001eEND",
      "1\t0\tignored.md",
      "COMMIT\u001ebbb\u001ea@example.test\u001efeat(data): add a line\n\nAuthored-by-agent: cursor/example\nModel: test\n\u001eEND",
      "3\t0\ta.md",
      "-\t-\tbin.dat",
      "COMMIT\u001eccc\u001eh@example.test\u001efix(docs): human edit\n\nAuthored-by: human/tester\nQA: chatgpt round 1 pass\n\u001eEND",
      "1\t0\tb.md",
      "",
    ].join("\n");
    const stats = summarize(parseLog(log));
    expect(stats.totalCommits).toBe(2);
    expect(stats.agentCommits).toBe(1);
    expect(stats.humanCommits).toBe(1);
    expect(stats.agentAdded).toBe(3);
    expect(stats.added).toBe(4);
    expect(stats.linePercent).toBe(75);
    expect(stats.commitPercent).toBe(50);
    expect(stats.qaTrailers).toBe(1);
    expect(renderBadge(stats)).toBe("Written by agents: 75% of lines, 50% of commits\nHuman edits: 1\nQA trailers: 1");
  });

  it("counts cursor/commona-build as agent-written", () => {
    expect(
      classifyTrailers("ci(ci): check\n\nAuthored-by-agent: cursor/commona-build\nModel: cursor\n").kind,
    ).toBe("agent");
  });

  it("counts grok/grok-build as agent-written", () => {
    expect(
      classifyTrailers("ci(ci): check\n\nAuthored-by-agent: grok/grok-build\nModel: grok-build\n").kind,
    ).toBe("agent");
  });

  it("counts a split trailer block as agent-written", () => {
    const split = classifyTrailers(
      "fix(ci): quote claude review json schema\n\nAuthored-by-agent: cursor/commona-cos\n\nModel: grok-bot\n",
    );
    expect(split.kind).toBe("agent");
    const splitQa = classifyTrailers(
      "ci(ci): check\n\nAuthored-by-agent: cursor/commona-build\nModel: cursor\n\nQA: chatgpt round 1 pass\n",
    );
    expect(splitQa.kind).toBe("agent");
    expect(splitQa.qa).toBe("chatgpt round 1 pass");
    expect(
      classifyTrailers(
        "ci(ci): check\n\nAuthored-by-agent: grok/grok-build\nModel: grok-build\n\nCo-authored-by: Nim Quill <nim@example.test>\n",
      ).kind,
    ).toBe("agent");
    expect(
      classifyTrailers(
        "feat(room): x\n\nAuthored-by-agent: cursor/commona-build\n\nA body paragraph sits between the trailers.\n\nModel: cursor\n",
      ).kind,
    ).toBe("agent");
  });

  it("counts a squash whose trailers all name agents", () => {
    const message = [
      "feat(room): serve the room (#37)",
      "",
      "* feat(room): first slice",
      "",
      "The first slice lands.",
      "",
      "Authored-by-agent: cursor/example",
      "Model: test",
      "",
      "* fix(room): second slice",
      "",
      "The second slice lands.",
      "",
      "Authored-by-agent: cursor/other",
      "Model: test",
      "",
      "---------",
      "",
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "",
    ].join("\n");
    expect(parseTrailerBlock(message)).toEqual([["Co-authored-by", "Cursor Agent <cursoragent@cursor.com>"]]);
    expect(classifyTrailers(message).kind).toBe("agent");

    const mixed = message.replace(
      "Authored-by-agent: cursor/other\nModel: test",
      "Authored-by-agent: cursor/other\nModel: test\n\nAuthored-by: human/tester",
    );
    expect(classifyTrailers(mixed).kind).toBe("unattributed");
  });

  it("counts a squash whose footer credits only the merger", () => {
    const message = [
      "feat(room): serve the room (#37)",
      "",
      "* feat(room): first slice",
      "",
      "The first slice lands.",
      "",
      "Authored-by-agent: cursor/example",
      "Model: test",
      "",
      "Co-authored-by: rtcrump <rtcrump@example.test>",
      "",
      "* fix(room): second slice",
      "",
      "The second slice lands.",
      "",
      "Authored-by-agent: cursor/other",
      "Model: test",
      "",
      "---------",
      "",
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "",
    ].join("\n");
    expect(classifyTrailers(message).kind).toBe("agent");
  });

  it("ignores a Markdown rule inside a squashed commit", () => {
    const message = [
      "feat(room): serve the room (#37)",
      "",
      "* feat(room): first slice",
      "",
      "The first slice lands.",
      "",
      "    ---------",
      "",
      "---------",
      "",
      "That rule is part of the commit body.",
      "",
      "Co-authored-by: rtcrump <rtcrump@example.test>",
      "",
      "Authored-by-agent: cursor/example",
      "Model: test",
      "",
      "---------",
      "",
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "",
    ].join("\n");
    expect(classifyTrailers(message).kind).toBe("agent");
  });

  it("does not count a squash co-authored by a person", () => {
    const message = [
      "feat(room): serve the room (#37)",
      "",
      "* feat(room): first slice",
      "",
      "The first slice lands.",
      "",
      "Authored-by-agent: cursor/example",
      "Model: test",
      "",
      "* fix(room): second slice",
      "",
      "The second slice lands.",
      "",
      "Authored-by-agent: cursor/other",
      "Model: test",
      "",
      "---------",
      "",
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "Co-authored-by: rtcrump <rtcrump@example.test>",
      "",
    ].join("\n");
    expect(classifyTrailers(message).kind).toBe("unattributed");
  });

  it("reads a throwaway repository the same way", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "commona-stats-"));
    try {
      git(cwd, ["init"]);
      writeFileSync(path.join(cwd, "a.txt"), `${"h\n".repeat(10)}`);
      git(cwd, ["add", "a.txt"]);
      git(cwd, ["commit", "-m", "chore(data): human lines\n\nAuthored-by: human/tester"]);
      writeFileSync(path.join(cwd, "b.txt"), `${"a\n".repeat(30)}`);
      git(cwd, ["add", "b.txt"]);
      git(cwd, [
        "commit",
        "-m",
        "feat(data): agent lines\n\nAuthored-by-agent: cursor/example\nModel: test",
      ]);
      const stats = collect(cwd);
      expect(stats.humanCommits).toBe(1);
      expect(stats.agentCommits).toBe(1);
      expect(stats.agentAdded).toBe(30);
      expect(stats.added).toBe(40);
      expect(stats.linePercent).toBe(75);
      expect(stats.commitPercent).toBe(50);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a README badge within five points of the computed share", (context) => {
    if (!hasGitHistory()) {
      context.skip("no git history (for example, a zip download)");
      return;
    }
    const stats = collect();
    expect(badgeVerdict(readBadge(readFileSync("README.md", "utf8")), stats)).toBe("ok");
  });

  it("accepts a share within five points", () => {
    const badge = "Written by agents: 95% of lines, 88% of commits\nHuman edits: 0\nQA trailers: 1";
    expect(badgeVerdict(badge, { linePercent: 100, commitPercent: 93, humanCommits: 0, qaTrailers: 1 })).toBe("ok");
  });

  it("rejects a share more than five points off", () => {
    const badge = "Written by agents: 100% of lines, 93% of commits\nHuman edits: 0\nQA trailers: 0";
    const stats = { linePercent: 100, commitPercent: 93, humanCommits: 0, qaTrailers: 0 };
    expect(badgeVerdict(badge, { ...stats, commitPercent: 87 })).toBe("off");
    expect(badgeVerdict(badge, { ...stats, linePercent: 94 })).toBe("off");
  });

  it("rejects a wrong human edit counter", () => {
    const badge = "Written by agents: 100% of lines, 93% of commits\nHuman edits: 999\nQA trailers: 0";
    expect(badgeVerdict(badge, { linePercent: 100, commitPercent: 93, humanCommits: 0, qaTrailers: 0 })).toBe(
      "counters",
    );
  });

  it("rejects a wrong QA trailer counter", () => {
    const badge = "Written by agents: 95% of lines, 88% of commits\nHuman edits: 0\nQA trailers: 999";
    expect(badgeVerdict(badge, { linePercent: 100, commitPercent: 93, humanCommits: 0, qaTrailers: 0 })).toBe(
      "counters",
    );
  });

  it("rejects a missing or malformed badge", () => {
    const stats = { linePercent: 100, commitPercent: 93, humanCommits: 0, qaTrailers: 0 };
    expect(badgeVerdict(null, stats)).toBe("missing");
    expect(badgeVerdict("Written by agents: soon", stats)).toBe("malformed");
  });

  it("matches the shared trailer-block spec", () => {
    const spec = JSON.parse(readFileSync("scripts/trailer-block-spec.json", "utf8")) as {
      cases: { name: string; message: string; trailers: [string, string][] }[];
    };
    for (const entry of spec.cases) {
      expect(parseTrailerBlock(entry.message), entry.name).toEqual(entry.trailers);
    }
  });

  it("treats a folder with no commits as having no git history", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "commona-stats-empty-"));
    try {
      expect(hasGitHistory(cwd)).toBe(false);
      git(cwd, ["init"]);
      expect(hasGitHistory(cwd)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=Stats Tester", "-c", "user.email=stats@example.test", "-c", "init.defaultBranch=main", "-c", "safe.directory=*", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

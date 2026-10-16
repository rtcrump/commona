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
  percent,
  readBadge,
  renderBadge,
  summarize,
  type AgentWrittenStats,
} from "../scripts/agent-written.js";

const SHARE_TOLERANCE = 5;
const BADGE_TEXT =
  /^Written by agents: (\d+)% of lines, (\d+)% of commits\nHuman edits: \d+\nQA trailers: \d+$/;

type BadgeVerdict = "ok" | "missing" | "malformed" | "off";

/** Pass when each badge share is within five points of the computed share. */
function badgeVerdict(badge: string | null, stats: Pick<AgentWrittenStats, "linePercent" | "commitPercent">): BadgeVerdict {
  if (badge == null) return "missing";
  const match = BADGE_TEXT.exec(badge);
  if (!match?.[1] || !match[2]) return "malformed";
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
    const badge = "Written by agents: 95% of lines, 88% of commits\nHuman edits: 0\nQA trailers: 0";
    expect(badgeVerdict(badge, { linePercent: 100, commitPercent: 93 })).toBe("ok");
  });

  it("rejects a share more than five points off", () => {
    const badge = "Written by agents: 100% of lines, 93% of commits\nHuman edits: 0\nQA trailers: 0";
    expect(badgeVerdict(badge, { linePercent: 100, commitPercent: 87 })).toBe("off");
    expect(badgeVerdict(badge, { linePercent: 94, commitPercent: 93 })).toBe("off");
  });

  it("rejects a missing or malformed badge", () => {
    const stats = { linePercent: 100, commitPercent: 93 };
    expect(badgeVerdict(null, stats)).toBe("missing");
    expect(badgeVerdict("Written by agents: soon", stats)).toBe("malformed");
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

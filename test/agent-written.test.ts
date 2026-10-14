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
} from "../scripts/agent-written.js";

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

  it("matches the committed README badge", (context) => {
    if (!hasGitHistory()) {
      context.skip("no git history (for example, a zip download)");
      return;
    }
    const stats = collect();
    expect(readBadge(readFileSync("README.md", "utf8"))).toBe(renderBadge(stats));
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

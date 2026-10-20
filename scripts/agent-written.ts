import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Written by agents: NN% of lines, NN% of commits.
 * Lines are insertions from `git log --numstat`. Commits are classified only
 * from Authored-by-agent and Authored-by trailers. A blank line between
 * trailer paragraphs still counts as one block, the same way
 * scripts/check_conventions.py does. The counter reads every trailer
 * paragraph in the message, not only the last block. A GitHub squash keeps
 * each Authored-by-agent line above its own message and ends with a
 * Co-authored-by footer after a divider, so the last block has no
 * authorship. The divider is an exact, unindented nine-hyphen line, and only
 * when every line after it is an allowed trailer. Body text after it is not
 * the footer. A commit with at least
 * one Authored-by-agent trailer and no Authored-by trailer is agent-written,
 * unless that footer credits a person. That footer is the merger. A person
 * credited inside a squashed commit is not the merger. A normal agent commit
 * may still credit a person with Co-authored-by. A commit with one or more
 * Authored-by trailers and no Authored-by-agent trailer is human. A commit
 * with neither authorship trailer, or with both, is unattributed. Merge
 * commits are skipped.
 */

const START = "<!-- agent-written-badge:start -->";
const END = "<!-- agent-written-badge:end -->";

export interface CommitStat {
  hash: string;
  subject: string;
  kind: "agent" | "human" | "unattributed";
  added: number;
  qa: string | null;
}

export interface AgentWrittenStats {
  commits: CommitStat[];
  totalCommits: number;
  agentCommits: number;
  humanCommits: number;
  unattributedCommits: number;
  added: number;
  agentAdded: number;
  qaTrailers: number;
  linePercent: number;
  commitPercent: number;
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((100 * part) / whole);
}

export function classifyTrailers(message: string): { kind: CommitStat["kind"]; qa: string | null } {
  const trailers = authorshipTrailers(message);
  const agent = trailers.filter(([key]) => key === "Authored-by-agent").length;
  const human = trailers.filter(([key]) => key === "Authored-by").length;
  const qa = parseTrailerBlock(message).find(([key]) => key === "QA")?.[1] ?? null;
  if (agent >= 1 && human === 0 && !squashCreditsAPerson(message)) return { kind: "agent", qa };
  if (human >= 1 && agent === 0) return { kind: "human", qa };
  return { kind: "unattributed", qa };
}

/** GitHub writes this divider before the squash footer's Co-authored-by lines. */
const SQUASH_DIVIDER = "---------";

const AGENT_COAUTHOR_EMAILS = new Set(["cursoragent@cursor.com", "commona-bot@users.noreply.github.com"]);

/** True when the footer after the squash divider credits a person, such as rtcrump. */
function squashCreditsAPerson(message: string): boolean {
  const footer = squashFooter(message);
  if (footer === null) return false;
  return coauthorValues(footer, false).some((value) => !isAgentCoauthor(value));
}

/**
 * Lines after the last divider that is followed only by allowed trailer lines.
 * An indented line is not the divider. Body text after a nine-hyphen line
 * means that line is not the footer. Null when this message is not a squash.
 */
function squashFooter(message: string): string | null {
  const lines = message.replaceAll("\r\n", "\n").split("\n");
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === SQUASH_DIVIDER && followedOnlyByAllowedTrailers(lines, i)) at = i;
  }
  if (at === -1) return null;
  return lines.slice(at + 1).join("\n");
}

function isAgentCoauthor(value: string): boolean {
  const email = /<([^>]+)>/.exec(value)?.[1]?.trim().toLowerCase() ?? "";
  if (AGENT_COAUTHOR_EMAILS.has(email)) return true;
  const name = value.replace(/<[^>]*>/g, "").trim();
  return name === "Cursor Agent" || /^(cursor|grok)\/[A-Za-z0-9._-]+$/.test(name);
}

function coauthorValues(message: string, skipFirst = true): string[] {
  const found: string[] = [];
  const paras = paragraphs(message);
  for (let i = skipFirst ? 1 : 0; i < paras.length; i += 1) {
    const para = paras[i] ?? [];
    if (!pureAllowed(para)) continue;
    for (const trailer of parseTrailerLines(para)) {
      if (trailer[0] === "Co-authored-by") found.push(trailer[1]);
    }
  }
  return found;
}

/**
 * Authorship lines from every trailer paragraph.
 * Body text and the squash divider are skipped. They do not hide trailers above them.
 */
function authorshipTrailers(message: string): [string, string][] {
  const found: [string, string][] = [];
  const paras = paragraphs(message);
  for (let i = 1; i < paras.length; i += 1) {
    const para = paras[i] ?? [];
    if (!pureAllowed(para)) continue;
    for (const trailer of parseTrailerLines(para)) {
      if (trailer[0] === "Authored-by-agent" || trailer[0] === "Authored-by") found.push(trailer);
    }
  }
  return found;
}

const TRAILER_RE = /^([A-Za-z][A-Za-z-]*): (.+)$/;
const ALLOWED_TRAILERS = new Set([
  "Authored-by-agent",
  "Model",
  "Authored-by",
  "QA",
  "Approved-by",
  "Co-authored-by",
  "Refs",
]);

/** Blank lines may separate the footer. Body text means this rule is not the divider. */
function followedOnlyByAllowedTrailers(lines: readonly string[], at: number): boolean {
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line === "") continue;
    const match = TRAILER_RE.exec(line);
    if (!match?.[1] || !ALLOWED_TRAILERS.has(match[1])) return false;
  }
  return true;
}

function paragraphs(message: string): string[][] {
  const paras: string[][] = [];
  let current: string[] = [];
  for (const line of message.replaceAll("\r\n", "\n").replace(/\n+$/, "").split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paras.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paras.push(current);
  return paras;
}

function parseTrailerLines(block: string[]): [string, string][] {
  const parsed: [string, string][] = [];
  for (const line of block) {
    const match = TRAILER_RE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    parsed.push([match[1], match[2].trim()]);
  }
  return parsed;
}

function pureAllowed(block: string[]): boolean {
  if (block.length === 0) return false;
  return block.every((line) => {
    const match = TRAILER_RE.exec(line);
    return Boolean(match?.[1] && ALLOWED_TRAILERS.has(match[1]));
  });
}

/** Same block as `trailers()` in scripts/check_conventions.py. Cases live in trailer-block-spec.json. */
export function parseTrailerBlock(message: string): [string, string][] {
  const paras = paragraphs(message);
  if (paras.length <= 1) return [];
  const parsed = parseTrailerLines(paras[paras.length - 1] ?? []);
  if (parsed.length === 0) return [];
  const earlier: [string, string][] = [];
  for (let i = paras.length - 2; i >= 1; i -= 1) {
    const para = paras[i] ?? [];
    if (!pureAllowed(para)) break;
    earlier.unshift(...parseTrailerLines(para));
  }
  return [...earlier, ...parsed];
}

export function parseLog(text: string): CommitStat[] {
  const commits: CommitStat[] = [];
  const chunks = text.split("COMMIT\u001e").slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf("\u001eEND");
    if (end === -1) continue;
    const header = chunk.slice(0, end);
    const numstat = chunk.slice(end + "\u001eEND".length);
    const parts = header.split("\u001e");
    const hash = parts[0] ?? "";
    const body = parts.slice(2).join("\u001e");
    const subject = body.split("\n", 1)[0] ?? "";
    if (subject.startsWith("Merge pull request #") || subject.startsWith("Merge branch ")) continue;
    const { kind, qa } = classifyTrailers(body);
    commits.push({ hash, subject, kind, added: addedLines(numstat), qa });
  }
  return commits;
}

function addedLines(numstat: string): number {
  let added = 0;
  for (const line of numstat.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match?.[1] || match[1] === "-" || match[2] === "-") continue;
    added += Number(match[1]);
  }
  return added;
}

export function summarize(commits: readonly CommitStat[]): AgentWrittenStats {
  const agentCommits = commits.filter((commit) => commit.kind === "agent").length;
  const humanCommits = commits.filter((commit) => commit.kind === "human").length;
  const unattributedCommits = commits.filter((commit) => commit.kind === "unattributed").length;
  const added = commits.reduce((sum, commit) => sum + commit.added, 0);
  const agentAdded = commits.filter((commit) => commit.kind === "agent").reduce((sum, commit) => sum + commit.added, 0);
  return {
    commits: [...commits],
    totalCommits: commits.length,
    agentCommits,
    humanCommits,
    unattributedCommits,
    added,
    agentAdded,
    qaTrailers: commits.filter((commit) => commit.qa).length,
    linePercent: percent(agentAdded, added),
    commitPercent: percent(agentCommits, commits.length),
  };
}

export function renderBadge(stats: AgentWrittenStats): string {
  return [
    `Written by agents: ${stats.linePercent}% of lines, ${stats.commitPercent}% of commits`,
    `Human edits: ${stats.humanCommits}`,
    `QA trailers: ${stats.qaTrailers}`,
  ].join("\n");
}

/**
 * The badge lives inside the commit it describes, so that commit's lines
 * change the percentages. Treat the staged diff as one more commit of `kind`
 * and return the stats `stats:check` will see after that commit lands.
 * Zero added lines means there is no pending commit.
 */
export function withPendingCommit(
  stats: AgentWrittenStats,
  added: number,
  kind: CommitStat["kind"],
): AgentWrittenStats {
  if (added <= 0) return stats;
  const agent = kind === "agent";
  const human = kind === "human";
  const agentAdded = stats.agentAdded + (agent ? added : 0);
  const totalAdded = stats.added + added;
  const agentCommits = stats.agentCommits + (agent ? 1 : 0);
  const totalCommits = stats.totalCommits + 1;
  return {
    ...stats,
    totalCommits,
    agentCommits,
    humanCommits: stats.humanCommits + (human ? 1 : 0),
    unattributedCommits: stats.unattributedCommits + (!agent && !human ? 1 : 0),
    added: totalAdded,
    agentAdded,
    linePercent: percent(agentAdded, totalAdded),
    commitPercent: percent(agentCommits, totalCommits),
  };
}

export function readBadge(readme: string): string | null {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return readme.slice(start + START.length, end).replace(/^\n/, "").replace(/\n$/, "");
}

export function writeBadge(readme: string, badge: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("README is missing the agent-written badge markers");
  }
  return `${readme.slice(0, start + START.length)}\n${badge}\n${readme.slice(end)}`;
}

/** False for a zip download or any folder that is not a git checkout with a commit. */
export function hasGitHistory(cwd = process.cwd()): boolean {
  try {
    const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (inside !== "true") return false;
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function collect(cwd = process.cwd()): AgentWrittenStats {
  const text = execFileSync(
    "git",
    ["-C", cwd, "log", "--reverse", "--numstat", "--format=COMMIT%x1e%H%x1e%aE%x1e%B%x1eEND"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return summarize(parseLog(text));
}

function stagedAdditions(cwd: string): number {
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  const staged = execFileSync("git", ["-C", cwd, "diff", "--cached", "--numstat"], { encoding: "utf8" });
  return addedLines(staged);
}

function main(): void {
  const cwd = process.cwd();
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  const includeWorkdir = process.argv.includes("--include-workdir");
  if (write) {
    const readmePath = `${cwd}/README.md`;
    // Repeat until the badge text stops changing the staged insertions.
    // The pending commit counts as agent-written, which is true only when
    // that commit carries Authored-by-agent and Model and no Authored-by.
    for (let attempt = 0; attempt < 6; attempt++) {
      const stats = collect(cwd);
      const extra = includeWorkdir ? stagedAdditions(cwd) : 0;
      const next = renderBadge(withPendingCommit(stats, extra, "agent"));
      const readme = readFileSync(readmePath, "utf8");
      if (readBadge(readme) === next) break;
      writeFileSync(readmePath, writeBadge(readme, next));
      if (includeWorkdir) execFileSync("git", ["-C", cwd, "add", "-A"]);
    }
  }
  const stats = collect(cwd);
  const badge = renderBadge(stats);
  if (check) {
    const actual = readBadge(readFileSync(`${cwd}/README.md`, "utf8"));
    if (actual !== badge) {
      process.stderr.write(`badge drift\nexpected:\n${badge}\nactual:\n${actual ?? "missing"}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`${badge}\n`);
}

const invoked = process.argv[1]?.endsWith("agent-written.ts") || process.argv[1]?.endsWith("agent-written.js");
if (invoked) main();

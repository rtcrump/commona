import type { AcceptanceTestId } from "../../contract/index.js";
import type { FailureKind } from "./failure.js";
import { CONTRACT_GAPS, HARNESS_NOTES } from "./gaps.js";

export interface TestResult {
  id: AcceptanceTestId;
  spec: string;
  wording: string;
  procedures: readonly string[];
  status: "pass" | "fail";
  kind: "pass" | FailureKind;
  durationMs: number;
  evidence: string[];
  detail: string;
}

export interface M1Report {
  command: "npm run m1";
  database: string | null;
  summary: {
    ran: number;
    passed: number;
    failed: number;
    notBuilt: number;
    assertionFailures: number;
  };
  m1Done: boolean;
  w1MaxLatencyMs: number | null;
  p4BlockCount: number | null;
  auditVerify: unknown;
  results: TestResult[];
  contractGaps: readonly string[];
  harnessNotes: readonly string[];
}

export function summarize(results: readonly TestResult[]): M1Report["summary"] {
  const passed = results.filter((result) => result.status === "pass").length;
  const notBuilt = results.filter((result) => result.kind === "not-built").length;
  const assertionFailures = results.filter((result) => result.kind === "assertion").length;
  return {
    ran: results.length,
    passed,
    failed: results.length - passed,
    notBuilt,
    assertionFailures,
  };
}

export function buildReport(args: {
  database: string | null;
  results: TestResult[];
  w1MaxLatencyMs: number | null;
  p4BlockCount: number | null;
  auditVerify: unknown;
}): M1Report {
  const summary = summarize(args.results);
  return {
    command: "npm run m1",
    database: args.database,
    summary,
    m1Done: summary.ran === 19 && summary.failed === 0,
    w1MaxLatencyMs: args.w1MaxLatencyMs,
    p4BlockCount: args.p4BlockCount,
    auditVerify: args.auditVerify,
    results: args.results,
    contractGaps: CONTRACT_GAPS,
    harnessNotes: HARNESS_NOTES,
  };
}

export function renderStdout(report: M1Report): string {
  const lines = [
    "commona m1",
    `${report.summary.ran} ran. ${report.summary.passed} passed. ${report.summary.failed} failed. ${report.summary.notBuilt} failed because a module is not built. ${report.summary.assertionFailures} failed an assertion.`,
    report.m1Done ? "M1 is done when all 19 pass in one clean run. This run passed." : "M1 is done when all 19 pass in one clean run. This run has failures.",
    `W1 max latency: ${report.w1MaxLatencyMs === null ? "n/a" : `${report.w1MaxLatencyMs} ms`}`,
    `P4 block count: ${report.p4BlockCount === null ? "n/a" : String(report.p4BlockCount)}`,
    `audit.verify(): ${report.auditVerify === null || report.auditVerify === undefined ? "n/a" : JSON.stringify(report.auditVerify)}`,
    "",
  ];
  for (const result of report.results) {
    const kind = result.status === "pass" ? "pass" : result.kind === "not-built" ? "FAIL not-built" : "FAIL assertion";
    lines.push(`${kind}  ${result.id}  ${result.durationMs}ms`);
    lines.push(`      ${result.wording}`);
    if (result.evidence.length > 0) lines.push(`      evidence: ${result.evidence.join(", ")}`);
    if (result.detail) {
      for (const line of result.detail.split("\n")) lines.push(`      ${line}`);
    }
  }
  lines.push("", "Contract gaps:");
  for (const gap of report.contractGaps) lines.push(`- ${gap}`);
  lines.push("", "Harness notes:");
  for (const note of report.harnessNotes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

export function renderMarkdown(report: M1Report): string {
  const lines = [
    "# M1 acceptance report",
    "",
    `${report.summary.ran} ran. ${report.summary.passed} passed. ${report.summary.failed} failed. ${report.summary.notBuilt} failed because a module is not built. ${report.summary.assertionFailures} failed an assertion.`,
    "",
    report.m1Done
      ? "M1 is done when all 19 pass in one clean run. This run passed."
      : "M1 is done when all 19 pass in one clean run. This run has failures.",
    "",
    `| W1 max latency | ${report.w1MaxLatencyMs === null ? "n/a" : `${report.w1MaxLatencyMs} ms`} |`,
    `| P4 block count | ${report.p4BlockCount === null ? "n/a" : String(report.p4BlockCount)} |`,
    `| audit.verify() | ${report.auditVerify === null || report.auditVerify === undefined ? "n/a" : JSON.stringify(report.auditVerify)} |`,
    "",
    "| Test | Spec | Result | Kind | Duration | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of report.results) {
    const evidence = result.evidence.length === 0 ? "" : result.evidence.join(", ");
    lines.push(
      `| ${result.id} | ${result.spec} | ${result.status} | ${result.kind} | ${result.durationMs}ms | ${evidence} |`,
    );
  }
  lines.push("");
  for (const result of report.results) {
    lines.push(`## ${result.id}`, "", result.wording, "");
    for (const procedure of result.procedures) lines.push(`- ${procedure}`);
    lines.push("", `Result: ${result.status} (${result.kind}).`, "");
    if (result.detail) lines.push("```", result.detail, "```", "");
  }
  lines.push("## Contract gaps", "");
  for (const gap of report.contractGaps) lines.push(`- ${gap}`);
  lines.push("", "## Harness notes", "");
  for (const note of report.harnessNotes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

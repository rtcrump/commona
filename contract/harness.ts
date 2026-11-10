import type { AuditAction, AuditRecord, AuditResult } from "./audit.js";
import { isIsoTimestamp } from "./clock.js";

/**
 * One action the M1 harness expects to find in the log.
 * L1 passes when the multiset of these keys equals the multiset of log rows,
 * every log timestamp parses, and {@link verifyAuditChain} returns ok.
 * Detail is not part of the key.
 */
export interface ExpectedLogRow {
  action: AuditAction;
  agentId: string;
  ownerId: string;
  result: AuditResult;
  room?: string;
}

export function l1Key(row: {
  action: string;
  agentId: string;
  ownerId: string;
  result: string;
}): string {
  return `${row.action}\0${row.agentId}\0${row.ownerId}\0${row.result}`;
}

export function l1Matches(expected: readonly ExpectedLogRow[], actual: readonly AuditRecord[]): boolean {
  if (expected.length !== actual.length) return false;
  if (actual.some((row) => !isIsoTimestamp(row.ts))) return false;
  const counts = new Map<string, number>();
  for (const row of expected) {
    const key = l1Key(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of actual) {
    const key = l1Key(row);
    const left = counts.get(key) ?? 0;
    if (left === 0) return false;
    counts.set(key, left - 1);
  }
  return true;
}

/** The 19 acceptance tests, in the order `npm run m1` runs them. T0 owns none of them. */
export const ACCEPTANCE_TESTS = [
  { id: "R1", spec: "T2" },
  { id: "R2", spec: "T2" },
  { id: "R3", spec: "T2" },
  { id: "W1", spec: "T5" },
  { id: "W2", spec: "T5" },
  { id: "W3", spec: "T6" },
  { id: "S1", spec: "T3" },
  { id: "S2", spec: "T3" },
  { id: "S3", spec: "T3" },
  { id: "S4", spec: "T3" },
  { id: "S5", spec: "T3" },
  { id: "P1", spec: "T4" },
  { id: "P2", spec: "T4" },
  { id: "P3", spec: "T4" },
  { id: "P4", spec: "T4" },
  { id: "P5", spec: "T4" },
  { id: "L1", spec: "T1" },
  { id: "L2", spec: "T1" },
  { id: "L3", spec: "T1" },
] as const;

export type AcceptanceTestId = (typeof ACCEPTANCE_TESTS)[number]["id"];

import type { AuditRecord, ExpectedLogRow, FixturePack } from "../../contract/index.js";
import type { startMailSink } from "../../test/helpers/mailSink.js";
import type { startWebhookSink } from "../../test/helpers/webhookSink.js";

export type WebhookSink = Awaited<ReturnType<typeof startWebhookSink>>;
export type MailSink = Awaited<ReturnType<typeof startMailSink>>;

export interface HarnessMetrics {
  w1MaxLatencyMs: number | null;
  p4BlockCount: number | null;
  auditVerify: unknown;
}

export interface Ctx {
  baseUrl: string;
  dbPath: string;
  pack: FixturePack;
  expected: ExpectedLogRow[];
  evidence: Record<string, string[]>;
  currentTest: string;
  webhooks: Record<"A1" | "A2" | "AX", WebhookSink>;
  mail: MailSink;
  ownerTokens: Map<string, string>;
  agentTokens: Map<string, string>;
  metrics: HarnessMetrics;
  /** Set when a wake wait already timed out, so later tests do not each wait 60s. */
  wakesUnavailable: boolean;
}

export function expectRows(ctx: Ctx, rows: readonly ExpectedLogRow[]): void {
  ctx.expected.push(...rows);
}

export function noteEvidence(ctx: Ctx, entries: readonly Pick<AuditRecord, "id">[]): void {
  const bucket = ctx.evidence[ctx.currentTest] ?? [];
  for (const entry of entries) {
    if (entry.id) bucket.push(entry.id);
  }
  ctx.evidence[ctx.currentTest] = bucket;
}

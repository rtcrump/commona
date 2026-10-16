import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACCEPTANCE_TESTS } from "../../contract/index.js";
import { openDatabase } from "../../src/db.js";
import { loadFixtures, seedFixtures } from "../../test/helpers/fixtures.js";
import { ACCEPTANCE_CASES } from "./catalog.js";
import type { Ctx } from "./ctx.js";
import { classifyThrown, thrownMessage } from "./failure.js";
import { buildReport, renderMarkdown, renderStdout, type TestResult } from "./report.js";

export async function runAcceptance(): Promise<number> {
  const results: TestResult[] = [];
  let database: string | null = null;
  let w1MaxLatencyMs: number | null = null;
  let p4BlockCount: number | null = null;
  let auditVerify: unknown = null;
  const stoppers: Array<() => Promise<void>> = [];
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "commona-m1-"));
    database = path.join(dir, "m1.sqlite");
    const pack = loadFixtures();
    const db = openDatabase(database);
    seedFixtures(db, pack);
    db.close();

    const { startMailSink } = await import("../../test/helpers/mailSink.js");
    const { startWebhookSink } = await import("../../test/helpers/webhookSink.js");
    const mail = await startMailSink();
    stoppers.push(mail.stop);
    const webhooks = {
      A1: await startWebhookSink({ port: portOf(agentWebhook(pack, "A1")) }),
      A2: await startWebhookSink({ port: portOf(agentWebhook(pack, "A2")) }),
      AX: await startWebhookSink({ port: portOf(agentWebhook(pack, "AX")) }),
    };
    stoppers.push(webhooks.A1.stop, webhooks.A2.stop, webhooks.AX.stop);

    process.env.COMMONA_DB = database;
    process.env.COMMONA_SMTP_HOST = mail.host;
    process.env.COMMONA_SMTP_PORT = String(mail.port);
    // Fixture webhooks are http://127.0.0.1. TLS is required unless this flag is set.
    // The 19 test sentences are unchanged. This is the only adaptation for those URLs.
    process.env.COMMONA_ALLOW_INSECURE_WEBHOOKS = "1";

    const { startTestServer } = await import("../../test/helpers/server.js");
    const server = await startTestServer();
    stoppers.push(server.stop);
    const { CASES } = await import("./cases.js");

    const ctx: Ctx = {
      baseUrl: server.baseUrl,
      dbPath: database,
      pack,
      expected: [],
      evidence: {},
      currentTest: "",
      webhooks,
      mail,
      ownerTokens: new Map(),
      agentTokens: new Map(),
      metrics: { w1MaxLatencyMs: null, p4BlockCount: null, auditVerify: null },
      wakesUnavailable: false,
    };

    for (const listed of ACCEPTANCE_TESTS) {
      const spec = ACCEPTANCE_CASES.find((candidate) => candidate.id === listed.id);
      if (!spec) throw new Error(`missing catalogue entry for ${listed.id}`);
      ctx.currentTest = listed.id;
      ctx.webhooks.A1.setStatus(200);
      ctx.webhooks.A2.setStatus(200);
      ctx.webhooks.AX.setStatus(200);
      ctx.mail.setFailing(false);
      const started = Date.now();
      let result: TestResult = {
        id: listed.id,
        spec: spec.spec,
        wording: spec.wording,
        procedures: spec.procedures,
        status: "pass",
        kind: "pass",
        durationMs: 0,
        evidence: [],
        detail: "",
      };
      try {
        await CASES[listed.id](ctx);
      } catch (error) {
        result = {
          ...result,
          status: "fail",
          kind: classifyThrown(error),
          detail: thrownMessage(error),
        };
      }
      result.durationMs = Date.now() - started;
      result.evidence = [...new Set(ctx.evidence[listed.id] ?? [])];
      results.push(result);
    }
    w1MaxLatencyMs = ctx.metrics.w1MaxLatencyMs;
    p4BlockCount = ctx.metrics.p4BlockCount;
    auditVerify = ctx.metrics.auditVerify;
  } catch (error) {
    const message = thrownMessage(error);
    for (const listed of ACCEPTANCE_TESTS) {
      if (results.some((result) => result.id === listed.id)) continue;
      const spec = ACCEPTANCE_CASES.find((candidate) => candidate.id === listed.id);
      results.push({
        id: listed.id,
        spec: spec?.spec ?? "",
        wording: spec?.wording ?? "",
        procedures: spec?.procedures ?? [],
        status: "fail",
        kind: classifyThrown(error),
        durationMs: 0,
        evidence: [],
        detail: message,
      });
    }
  } finally {
    for (const stop of stoppers.reverse()) {
      try {
        await stop();
      } catch {
        // The report still has to be written if a sink is already closed.
      }
    }
  }

  const report = buildReport({
    database,
    results,
    w1MaxLatencyMs,
    p4BlockCount,
    auditVerify,
  });
  const stdout = renderStdout(report);
  process.stdout.write(stdout);
  writeFileSync("m1-report.md", renderMarkdown(report));
  writeFileSync("m1-report.json", `${JSON.stringify(report, null, 2)}\n`);
  return report.summary.failed === 0 ? 0 : 1;
}

function agentWebhook(pack: ReturnType<typeof loadFixtures>, agentId: string): string {
  const agent = pack.agents.find((candidate) => candidate.id === agentId);
  if (!agent?.wake.webhook) throw new Error(`fixture ${agentId} has no webhook`);
  return agent.wake.webhook;
}

function portOf(webhook: string): number {
  const url = new URL(webhook);
  if (url.hostname !== "127.0.0.1") throw new Error(`fixture webhook left the machine: ${webhook}`);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`fixture webhook has no port: ${webhook}`);
  return port;
}

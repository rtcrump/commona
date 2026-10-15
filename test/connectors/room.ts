import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemClock } from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { buildApp } from "../../src/app.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { createOwnerNotifier } from "../../src/notices/index.js";
import { createSharingDirectory } from "../../src/sharing/index.js";
import { createWakeService } from "../../src/wakeup/index.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";

export interface ConnectorRoom {
  baseUrl: string;
  db: ReturnType<typeof openDatabase>;
  ownerTokens: { O1: string; O2: string };
  stop(): Promise<void>;
}

/** In-process Commona with real wake delivery. Tokens exist only in memory. */
export async function startConnectorRoom(): Promise<ConnectorRoom> {
  const db = openDatabase(":memory:");
  seedFixtures(db, loadFixtures());
  const tokens = createTokenStore(db);
  const audit = createAuditLog(db);
  const notices = createOwnerNotifier(db, systemClock);
  const sharing = createSharingDirectory(db);
  const wake = createWakeService({ db, audit, notices });
  const app = buildApp({
    db,
    tokens,
    audit,
    sharing,
    notices,
    wakeQueue: wake,
    deliverWake: (wakeId) => wake.deliver(wakeId).then(() => undefined),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("room did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    ownerTokens: {
      O1: tokens.issueOwnerToken("O1"),
      O2: tokens.issueOwnerToken("O2"),
    },
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}

export function freshSpool(): string {
  return mkdtempSync(path.join(tmpdir(), "commona-wakes-"));
}

export async function roomSend(
  baseUrl: string,
  method: string,
  urlPath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

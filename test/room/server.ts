import type { ContentGuard, WakeQueue } from "../../contract/index.js";
import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";
import { createTestAudit, createTestSharing, steppingClock, type TestAuditLog } from "./fakes.js";

const allowGuard: ContentGuard = {
  check() {
    return { outcome: "allow", hits: [] };
  },
};

export interface RoomHarness {
  baseUrl: string;
  db: ReturnType<typeof openDatabase>;
  audit: TestAuditLog;
  sharing: ReturnType<typeof createTestSharing>;
  tokens: ReturnType<typeof createTokenStore>;
  wakes: WakeQueue & { calls: Parameters<WakeQueue["enqueue"]>[0][] };
  stop: () => Promise<void>;
}

export async function startRoom(overrides: BuildAppOptions = {}): Promise<RoomHarness> {
  const db = overrides.db ?? openDatabase(":memory:");
  seedFixtures(db, loadFixtures());
  const clock = overrides.clock ?? steppingClock();
  const tokens = overrides.tokens ?? createTokenStore(db);
  const audit = (overrides.audit as TestAuditLog | undefined) ?? createTestAudit(db, clock);
  const sharing = overrides.sharing ?? createTestSharing(db);
  const guard = overrides.guard ?? allowGuard;
  const calls: Parameters<WakeQueue["enqueue"]>[0][] = [];
  const wakes: RoomHarness["wakes"] = {
    calls,
    enqueue(input) {
      calls.push(input);
      return [];
    },
  };
  const wakeQueue = overrides.wakeQueue ?? (wakes as WakeQueue);
  const app = buildApp({ db, clock, tokens, audit, sharing, guard, wakeQueue });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("room server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    audit,
    sharing,
    tokens,
    wakes,
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}

export async function send(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

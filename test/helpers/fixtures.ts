import { readFileSync } from "node:fs";
import path from "node:path";
import { HEALTH_NUMBER_PATTERN, type AgentFixture, type FixturePack, type OwnerFixture } from "../../contract/index.js";
import { openDatabase } from "../../src/db.js";
import { enableBuiltinPatterns, installClarityDemo } from "../../src/guard/filter-store.js";

type Sqlite = ReturnType<typeof openDatabase>;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fixture field ${key} must be a non-empty string`);
  }
  return value;
}

export function loadFixtures(dir = path.resolve("fixtures")): FixturePack {
  const owners = parseOwners(readJson(path.join(dir, "owners.json")));
  const agents = parseAgents(readJson(path.join(dir, "agents.json")));
  const tree = readFileSync(path.join(dir, "tree.md"), "utf8");
  const notesWithPatient = readFileSync(path.join(dir, "notes-with-patient.md"), "utf8");
  const names = readFileSync(path.join(dir, "names.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const normalMessages = parseMessages(readJson(path.join(dir, "normal-messages.json")));
  const pack = { owners, agents, tree, notesWithPatient, names, normalMessages };
  assertPack(pack);
  return pack;
}

function parseOwners(value: unknown): OwnerFixture[] {
  if (!Array.isArray(value)) throw new Error("owners.json must be an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("owner row must be an object");
    const role = requireString(row, "role");
    if (role !== "participant" && role !== "outsider") throw new Error("owner role is invalid");
    return {
      id: requireString(row, "id"),
      email: requireString(row, "email"),
      displayName: requireString(row, "displayName"),
      role,
    };
  });
}

function parseAgents(value: unknown): AgentFixture[] {
  if (!Array.isArray(value)) throw new Error("agents.json must be an array");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("agent row must be an object");
    if (!isRecord(row.wake)) throw new Error("agent wake must be an object");
    if (typeof row.roomMember !== "boolean") throw new Error("agent roomMember must be a boolean");
    const webhook = row.wake.webhook;
    const event = row.wake.event;
    return {
      id: requireString(row, "id"),
      ownerId: requireString(row, "ownerId"),
      displayName: requireString(row, "displayName"),
      roomMember: row.roomMember,
      wake: {
        email: requireString(row.wake, "email"),
        ...(typeof webhook === "string" ? { webhook } : {}),
        ...(isRecord(event) && event.kind === "event" && typeof event.target === "string"
          ? { event: { kind: "event" as const, target: event.target } }
          : {}),
      },
    };
  });
}

function parseMessages(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("normal-messages.json must be an array of strings");
  }
  return value;
}

function assertPack(pack: FixturePack): void {
  const ownerIds = pack.owners.map((owner) => owner.id).join(",");
  if (ownerIds !== "O1,O2,O3") throw new Error("owners must be O1, O2, O3");
  if (pack.owners.some((owner) => !owner.email.endsWith("@example.test"))) {
    throw new Error("owner emails must use the example.test domain");
  }
  const agentIds = pack.agents.map((agent) => `${agent.id}:${agent.ownerId}:${agent.roomMember}`).join(",");
  if (agentIds !== "A1:O1:true,A2:O2:true,AX:O3:false") {
    throw new Error("agents must be A1, A2, and a non-member AX");
  }
  for (const agent of pack.agents) {
    if (!agent.wake.webhook) throw new Error("fixture agents need a webhook");
    const url = new URL(agent.wake.webhook);
    if (url.hostname !== "127.0.0.1") throw new Error("fixture webhooks must stay on 127.0.0.1");
    if (!agent.wake.email.endsWith("@example.test")) throw new Error("agent emails must use example.test");
  }
  if (pack.names.length === 0) throw new Error("names.txt is empty");
  if (/\d/.test(pack.tree)) throw new Error("tree.md must not contain digits");
  if (!pack.notesWithPatient.includes(pack.names[0] ?? "")) {
    throw new Error("notes-with-patient.md must contain the first name-list entry");
  }
  if (!new RegExp(HEALTH_NUMBER_PATTERN).test(pack.notesWithPatient)) {
    throw new Error("notes-with-patient.md must contain an invented health number");
  }
  if (!/DOB|date of birth|born/i.test(pack.notesWithPatient)) {
    throw new Error("notes-with-patient.md must contain a date-of-birth cue");
  }
  if (pack.normalMessages.length !== 20) throw new Error("normal-messages.json must have 20 messages");
  for (const phrase of ["Meet at 10:30.", "Version v2.1 is the one to review.", "Room 12 is free this afternoon."]) {
    if (!pack.normalMessages.includes(phrase)) throw new Error(`missing ordinary message: ${phrase}`);
  }
}

/**
 * Insert owners and agents. Rooms, posts, and tokens are left for later specs.
 * These showroom owners are not the new-owner default. The Clarity preset is
 * turned on so the milestone 1 name checks still block. Health-number and
 * date-of-birth patterns are turned on so P3 still blocks. A new owner
 * outside this setup gets neither.
 */
export function seedFixtures(db: Sqlite, pack: FixturePack): void {
  const owner = db.prepare(
    "INSERT INTO owners (id, email, display_name, role) VALUES (@id, @email, @displayName, @role)",
  );
  const agent = db.prepare(
    `INSERT INTO agents (id, owner_id, display_name, email, webhook_url, event_target)
     VALUES (@id, @ownerId, @displayName, @email, @webhook, @eventTarget)`,
  );
  const insert = db.transaction(() => {
    for (const row of pack.owners) owner.run(row);
    for (const row of pack.agents) {
      agent.run({
        id: row.id,
        ownerId: row.ownerId,
        displayName: row.displayName,
        email: row.wake.email,
        webhook: row.wake.webhook ?? null,
        eventTarget: row.wake.event?.target ?? null,
      });
    }
    for (const row of pack.owners) {
      installClarityDemo(db, row.id);
      enableBuiltinPatterns(db, row.id);
    }
  });
  insert();
}

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOM_ID = /^room_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class RoomDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomDeleteError";
  }
}

/**
 * Ask the running server to delete the room from room:new.
 * Prints `deleted` and nothing else. The credential is not printed.
 * The server returns the audit record. This script checks that record and does not print it.
 */
export async function deleteRoom(serverUrl: string | undefined, credentialPath: string | undefined): Promise<void> {
  const url = requireServerUrl(serverUrl);
  const credential = readCredential(credentialPath);
  let response: Response;
  try {
    response = await fetch(`${url}/rooms/${credential.roomId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential.token}` },
    });
  } catch {
    throw new RoomDeleteError("room:delete failed");
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new RoomDeleteError("room:delete was refused");
  if (!response.ok) throw new RoomDeleteError("room:delete failed");
  if (text.includes(credential.token)) throw new RoomDeleteError("room:delete failed");
  assertAudit(text, credential.roomId);
}

function assertAudit(text: string, roomId: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RoomDeleteError("room:delete failed");
  }
  if (typeof parsed !== "object" || parsed === null) throw new RoomDeleteError("room:delete failed");
  const record = parsed as { deleted?: unknown; audit?: unknown };
  const audit = record.audit;
  if (record.deleted !== true || typeof audit !== "object" || audit === null) {
    throw new RoomDeleteError("room:delete failed");
  }
  const row = audit as { action?: unknown; result?: unknown; room?: unknown; hash?: unknown };
  if (row.action !== "setting_change" || row.result !== "ok" || row.room !== roomId) {
    throw new RoomDeleteError("room:delete failed");
  }
  if (typeof row.hash !== "string" || !/^[0-9a-f]{64}$/.test(row.hash)) {
    throw new RoomDeleteError("room:delete failed");
  }
}

function readCredential(raw: string | undefined): { token: string; roomId: string } {
  const file = raw?.trim() ?? "";
  if (!file) throw new RoomDeleteError("COMMONA_HOST_CREDENTIAL is not set");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new RoomDeleteError("room:delete failed");
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const token = values.get("COMMONA_AGENT_TOKEN") ?? "";
  const roomId = values.get("COMMONA_ROOM_ID") ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(token) || !ROOM_ID.test(roomId)) {
    throw new RoomDeleteError("room:delete failed");
  }
  return { token, roomId };
}

function requireServerUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) throw new RoomDeleteError("COMMONA_URL is not set");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoomDeleteError("room:delete only talks to the room server");
  }
  const host = url.hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const https = url.protocol === "https:";
  const httpLocal = url.protocol === "http:" && local;
  if (!https && !httpLocal) throw new RoomDeleteError("room:delete only talks to the room server");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new RoomDeleteError("room:delete only talks to the room server");
  }
  return value.replace(/\/$/, "");
}

async function main(): Promise<void> {
  try {
    await deleteRoom(process.env.COMMONA_URL, process.env.COMMONA_HOST_CREDENTIAL);
    process.stdout.write("deleted\n");
  } catch (error) {
    const message = error instanceof RoomDeleteError ? error.message : "room:delete failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

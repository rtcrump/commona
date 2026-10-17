import { chmodSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guard } from "../src/guard/index.js";
import { HOST_SECRET_HEADER, hostSecretPath } from "../src/room/host.js";

const LABEL_MAX = 80;
const DEFAULT_INVITE_COUNT = 2;
const MAX_INVITE_COUNT = 20;
const INVITE_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/j\/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_ID = /^room_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIAL_UNWRITABLE = "COMMONA_HOST_CREDENTIAL is not writable";

const SAFE_SERVER_MESSAGES = new Set([
  "COMMONA_PUBLIC_ORIGIN must be an https origin",
  "room title must be a short label",
  "room title is not allowed",
  "host display name must be a short label",
  "host display name is not allowed",
  "invite count must be a whole number from 1 to 20",
  "room:new failed",
]);

class RoomNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomNewError";
  }
}

export interface RoomNewInput {
  serverUrl: string | undefined;
  credentialPath: string | undefined;
  title: string;
  hostName: string;
  inviteCount?: string;
}

interface HostSetup {
  invites: string[];
  credential: string;
  roomId: string;
  agentId: string;
}

/**
 * Ask the running server to create a room and invites.
 * Prints nothing. The caller prints the invite URLs and nothing else.
 * The host credential, room id, and agent id are written to a local file and are not returned.
 */
export async function createRoomInvites(input: RoomNewInput): Promise<string[]> {
  const serverUrl = requireLocalUrl(input.serverUrl);
  const credentialPath = requireCredentialPath(input.credentialPath);
  const title = requireLabel(input.title, "room title must be a short label", "room title is not allowed");
  const hostName = requireLabel(
    input.hostName,
    "host display name must be a short label",
    "host display name is not allowed",
  );
  const inviteCount = requireCount(input.inviteCount);
  reserveCredential(credentialPath);
  let committed = false;
  try {
    const hostSecret = readHostSecret(hostSecretPath());
    let response: Response;
    try {
      response = await fetch(`${serverUrl}/host/room`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HOST_SECRET_HEADER]: hostSecret,
        },
        body: JSON.stringify({ title, hostName, inviteCount }),
      });
    } catch {
      throw new RoomNewError("room:new failed");
    }
    const text = await response.text();
    if (!response.ok) throw new RoomNewError(safeServerMessage(text));
    const parsed = readResult(text, hostSecret);
    writeCredential(credentialPath, credentialBody(parsed));
    committed = true;
    return parsed.invites;
  } catch (error) {
    if (!committed) releaseCredential(credentialPath);
    throw error;
  }
}

function readHostSecret(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    throw new RoomNewError("room:new could not read the host secret");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new RoomNewError("room:new could not read the host secret");
  return text;
}

function reserveCredential(file: string): void {
  // Fail before the server creates a room. An existing file is left untouched.
  // 0o600 is owner-only on Unix. Windows does not apply that mode.
  let directory;
  try {
    directory = statSync(path.dirname(file));
  } catch {
    throw new RoomNewError(CREDENTIAL_UNWRITABLE);
  }
  if (!directory.isDirectory()) throw new RoomNewError(CREDENTIAL_UNWRITABLE);
  try {
    writeFileSync(file, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    throw new RoomNewError(CREDENTIAL_UNWRITABLE);
  }
}

function releaseCredential(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // The reservation is already gone.
  }
}

function writeCredential(file: string, body: string): void {
  // 0o600 is owner-only on Unix. Windows does not apply that mode.
  try {
    writeFileSync(file, body, { encoding: "utf8", mode: 0o600, flag: "w" });
  } catch {
    releaseCredential(file);
    throw new RoomNewError("room:new failed");
  }
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch {
    releaseCredential(file);
    throw new RoomNewError("room:new failed");
  }
}

function credentialBody(parsed: HostSetup): string {
  return `COMMONA_AGENT_TOKEN=${parsed.credential}\nCOMMONA_ROOM_ID=${parsed.roomId}\nCOMMONA_AGENT_ID=${parsed.agentId}\n`;
}

function readResult(text: string, hostSecret: string): HostSetup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RoomNewError("room:new failed");
  }
  if (typeof parsed !== "object" || parsed === null) throw new RoomNewError("room:new failed");
  const record = parsed as { invites?: unknown; credential?: unknown; roomId?: unknown; agentId?: unknown };
  const invites = record.invites;
  const credential = record.credential;
  const roomId = record.roomId;
  const agentId = record.agentId;
  if (
    !Array.isArray(invites) ||
    typeof credential !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(credential) ||
    credential.includes(hostSecret) ||
    typeof roomId !== "string" ||
    !ROOM_ID.test(roomId) ||
    roomId.includes(hostSecret) ||
    roomId.includes(credential) ||
    typeof agentId !== "string" ||
    !AGENT_ID.test(agentId) ||
    agentId.includes(hostSecret) ||
    agentId.includes(credential)
  ) {
    throw new RoomNewError("room:new failed");
  }
  const urls: string[] = [];
  for (const invite of invites) {
    if (
      typeof invite !== "string" ||
      !INVITE_URL.test(invite) ||
      invite.includes(credential) ||
      invite.includes(hostSecret) ||
      invite.includes(roomId) ||
      invite.includes(agentId)
    ) {
      throw new RoomNewError("room:new failed");
    }
    urls.push(invite);
  }
  if (urls.length === 0) throw new RoomNewError("room:new failed");
  return { invites: urls, credential, roomId, agentId };
}

function safeServerMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && SAFE_SERVER_MESSAGES.has(message)) return message;
  } catch {
    return "room:new failed";
  }
  return "room:new failed";
}

function requireLocalUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) throw new RoomNewError("COMMONA_URL is not set");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoomNewError("room:new only talks to a local server");
  }
  const host = url.hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (
    url.protocol !== "http:" ||
    !local ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RoomNewError("room:new only talks to a local server");
  }
  return value.replace(/\/$/, "");
}

function requireCredentialPath(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) throw new RoomNewError("COMMONA_HOST_CREDENTIAL is not set");
  return value;
}

function requireLabel(raw: string, shapeMessage: string, blockedMessage: string): string {
  const label = raw.trim();
  if (!label || label.length > LABEL_MAX || /[\r\n<>]/.test(label)) {
    throw new RoomNewError(shapeMessage);
  }
  if (guard.check({ kind: "message", text: label }).outcome !== "allow") {
    throw new RoomNewError(blockedMessage);
  }
  return label;
}

function requireCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INVITE_COUNT;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new RoomNewError("invite count must be a whole number from 1 to 20");
  }
  const count = Number(raw);
  if (count < 1 || count > MAX_INVITE_COUNT) {
    throw new RoomNewError("invite count must be a whole number from 1 to 20");
  }
  return count;
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3) {
      throw new RoomNewError("room:new needs a room title, a host display name, and an optional invite count");
    }
    const title = args[0] ?? "";
    const hostName = args[1] ?? "";
    const urls = await createRoomInvites({
      serverUrl: process.env.COMMONA_URL,
      credentialPath: process.env.COMMONA_HOST_CREDENTIAL,
      title,
      hostName,
      inviteCount: args[2],
    });
    process.stdout.write(`${urls.join("\n")}\n`);
  } catch (error) {
    const message = error instanceof RoomNewError ? error.message : "room:new failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

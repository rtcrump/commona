import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { guard } from "../src/guard/index.js";

const LABEL_MAX = 80;
const DEFAULT_INVITE_COUNT = 2;
const MAX_INVITE_COUNT = 20;
const INVITE_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/j\/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/**
 * Ask the running server to create a room and invites.
 * Prints nothing. The caller prints the invite URLs and nothing else.
 * The host agent credential is written to a local file and is not returned.
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

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/host/room`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, hostName, inviteCount }),
    });
  } catch {
    throw new RoomNewError("room:new failed");
  }
  const text = await response.text();
  if (!response.ok) throw new RoomNewError(safeServerMessage(text));
  const parsed = readResult(text);
  writeCredential(credentialPath, parsed.credential);
  return parsed.invites;
}

function writeCredential(file: string, credential: string): void {
  // 0o600 is owner-only on Unix. Windows does not apply that mode.
  try {
    writeFileSync(file, credential, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    throw new RoomNewError("room:new failed");
  }
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch {
    unlinkSync(file);
    throw new RoomNewError("room:new failed");
  }
}

function readResult(text: string): { invites: string[]; credential: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RoomNewError("room:new failed");
  }
  if (typeof parsed !== "object" || parsed === null) throw new RoomNewError("room:new failed");
  const invites = (parsed as { invites?: unknown }).invites;
  const credential = (parsed as { credential?: unknown }).credential;
  if (!Array.isArray(invites) || typeof credential !== "string" || !/^[A-Za-z0-9_-]+$/.test(credential)) {
    throw new RoomNewError("room:new failed");
  }
  const urls: string[] = [];
  for (const invite of invites) {
    if (typeof invite !== "string" || !INVITE_URL.test(invite) || invite.includes(credential)) {
      throw new RoomNewError("room:new failed");
    }
    urls.push(invite);
  }
  if (urls.length === 0) throw new RoomNewError("room:new failed");
  return { invites: urls, credential };
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

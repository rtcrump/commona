import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashToken } from "../../contract/index.js";

/**
 * A bound Claude link, kept so the next process can use it.
 * The file stores a hash of the handoff. The credential is sealed with the handoff,
 * so the file never holds the handoff or the raw credential.
 * Callers must not write this file, or the credential, into a log.
 */
const VERSION = 1;

interface SealedLink {
  handoffHash: string;
  roomId: string;
  agentId: string;
  nonce: string;
  boxed: string;
}

interface StoreFile {
  version: number;
  links: SealedLink[];
}

export interface SavedLink {
  credential: string;
  agentId: string;
  roomId: string;
}

export interface LinkStore {
  find(handoff: string, roomId: string): SavedLink | undefined;
  remember(handoff: string, roomId: string, agentId: string, credential: string): void;
  forget(handoff: string, roomId: string): void;
}

export function openLinkStore(filePath: string): LinkStore {
  return {
    find(handoff, roomId) {
      const row = readStore(filePath).links.find(
        (link) => link.handoffHash === hashToken(handoff) && link.roomId === roomId,
      );
      if (!row) return undefined;
      const credential = unseal(handoff, row.nonce, row.boxed);
      if (!credential) return undefined;
      return { credential, agentId: row.agentId, roomId: row.roomId };
    },

    remember(handoff, roomId, agentId, credential) {
      const hash = hashToken(handoff);
      const current = readStore(filePath).links.filter(
        (link) => !(link.handoffHash === hash && link.roomId === roomId),
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sealed = seal(handoff, credential);
        const body = JSON.stringify({
          version: VERSION,
          links: [...current, { handoffHash: hash, roomId, agentId, nonce: sealed.nonce, boxed: sealed.boxed }],
        } satisfies StoreFile);
        if (!body.includes(handoff) && !body.includes(credential)) {
          writeStore(filePath, body);
          return;
        }
      }
      throw new Error("refusing to store a raw secret");
    },

    forget(handoff, roomId) {
      const file = readStore(filePath);
      const hash = hashToken(handoff);
      const links = file.links.filter((link) => !(link.handoffHash === hash && link.roomId === roomId));
      if (links.length === file.links.length) return;
      writeStore(filePath, JSON.stringify({ version: VERSION, links } satisfies StoreFile));
    },
  };
}

function sealKey(handoff: string): Buffer {
  return createHash("sha256").update("commona-bound-link\0", "utf8").update(handoff, "utf8").digest();
}

function seal(handoff: string, credential: string): { nonce: string; boxed: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(handoff), nonce);
  const body = Buffer.concat([cipher.update(credential, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { nonce: nonce.toString("base64url"), boxed: body.toString("base64url") };
}

function unseal(handoff: string, nonceText: string, boxedText: string): string | undefined {
  try {
    const nonce = Buffer.from(nonceText, "base64url");
    const boxed = Buffer.from(boxedText, "base64url");
    if (nonce.length !== 12 || boxed.length < 17) return undefined;
    const tag = boxed.subarray(boxed.length - 16);
    const body = boxed.subarray(0, boxed.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", sealKey(handoff), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function readStore(filePath: string): StoreFile {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { version: VERSION, links: [] };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { version: VERSION, links: [] };
    const version = (parsed as { version?: unknown }).version;
    const links = (parsed as { links?: unknown }).links;
    if (version !== VERSION || !Array.isArray(links)) return { version: VERSION, links: [] };
    const clean: SealedLink[] = [];
    for (const item of links) {
      if (!isSealed(item)) continue;
      clean.push(item);
    }
    return { version: VERSION, links: clean };
  } catch {
    return { version: VERSION, links: [] };
  }
}

function isSealed(value: unknown): value is SealedLink {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<SealedLink>;
  return (
    typeof row.handoffHash === "string" &&
    typeof row.roomId === "string" &&
    typeof row.agentId === "string" &&
    typeof row.nonce === "string" &&
    typeof row.boxed === "string"
  );
}

function writeStore(filePath: string, body: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, filePath);
  chmodSync(filePath, 0o600);
}

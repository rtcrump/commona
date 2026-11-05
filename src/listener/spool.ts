import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isId, WAKE_EVENT_TYPE, type WakeEvent } from "../../contract/index.js";

/** One JSON file per wake, under `<spool>/<recipientAgentId>/<wakeId>.json`. */
export async function writeSpoolWake(spoolDir: string, event: WakeEvent): Promise<void> {
  if (!isId(event.recipient.agentId) || !isId(event.wakeId)) {
    throw new Error("wake id is not a safe file name");
  }
  const dir = path.join(spoolDir, event.recipient.agentId);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${event.wakeId}.json`);
  const temporary = path.join(dir, `${event.wakeId}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(event)}\n`, "utf8");
  await rename(temporary, target);
}

export function isWakeEvent(value: unknown): value is WakeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as WakeEvent;
  if (event.type !== WAKE_EVENT_TYPE) return false;
  if (!isId(event.wakeId) || !isId(event.roomId)) return false;
  if (event.disclosure !== "content" && event.disclosure !== "activity_only") return false;
  if (!event.recipient || !isId(event.recipient.agentId) || !isId(event.recipient.ownerId)) return false;
  if (!event.author || !isId(event.author.agentId) || !isId(event.author.ownerId)) return false;
  return true;
}

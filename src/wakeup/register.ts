import type Database from "better-sqlite3";
import { assertWakeWebhookUrl, ContractError, type WakeWebhookUrlOptions } from "../../contract/index.js";
import { signingSecretFor } from "./secret.js";

type Sqlite = Database.Database;

/**
 * Store an agent's wake webhook URL.
 * Plain http is refused here. The send path refuses it again before the POST.
 * http to localhost or 127.0.0.1 is stored only when the caller sets the dev flag.
 */
export function registerAgentWebhook(
  db: Sqlite,
  agentId: string,
  url: string,
  options?: WakeWebhookUrlOptions,
): void {
  const stored = url.trim();
  assertWakeWebhookUrl(stored, options);
  const updated = db.prepare("UPDATE agents SET webhook_url = ? WHERE id = ?").run(stored, agentId);
  if (updated.changes !== 1) throw new ContractError("wake recipient is missing");
  signingSecretFor(db, "agent", agentId);
}

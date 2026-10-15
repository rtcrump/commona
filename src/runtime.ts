import type Database from "better-sqlite3";
import {
  systemClock,
  type AuditLog,
  type AuthPrincipal,
  type Clock,
  type ContentGuard,
  type OwnerNotifier,
  type SharingDirectory,
  type TokenStore,
} from "../contract/index.js";
import { createAuditLog } from "./audit/log.js";
import { createTokenStore } from "./auth/store.js";
import { openDatabase } from "./db.js";
import { createPrivacyGuard } from "./guard/filter.js";
import { createOwnerNotifier } from "./notices/store.js";
import { createSharingDirectory } from "./sharing/index.js";
import { createWakeService, type WakeService } from "./wakeup/index.js";
import { smtpFromEnv, type SmtpEndpoint } from "./wakeup/smtp.js";

/**
 * Process-wide services for `buildApp()` with no arguments.
 * The harness sets COMMONA_DB and the SMTP variables, then starts that app,
 * then calls `tokens` and `audit` in the same process. They share this database.
 */
export interface Runtime {
  db: Database.Database;
  dbPath: string;
  clock: Clock;
  tokens: TokenStore;
  audit: AuditLog;
  sharing: SharingDirectory;
  guard: ContentGuard;
  notices: OwnerNotifier;
  smtp?: SmtpEndpoint;
  wake: WakeService;
}

let runtime: Runtime | undefined;

export function defaultRuntime(): Runtime {
  if (runtime) return runtime;
  const dbPath = process.env.COMMONA_DB ?? ":memory:";
  const db = openDatabase(dbPath);
  const clock = systemClock;
  const tokens = createTokenStore(db);
  const audit = createAuditLog(db, clock);
  const notices = createOwnerNotifier(db, clock);
  const smtp = smtpFromEnv();
  const wake = createWakeService({
    db,
    clock,
    audit,
    notices,
    ...(smtp ? { smtp } : {}),
  });
  runtime = {
    db,
    dbPath,
    clock,
    tokens,
    audit,
    sharing: createSharingDirectory(db),
    guard: createPrivacyGuard(db),
    notices,
    ...(smtp ? { smtp } : {}),
    wake,
  };
  return runtime;
}

/** Close the shared database. The next defaultRuntime() opens it again. */
export function closeDefaultRuntime(): void {
  if (!runtime) return;
  runtime.db.close();
  runtime = undefined;
}

/** Same object the no-argument server authenticates. */
export const tokens: TokenStore = {
  issueOwnerToken(ownerId: string): string {
    return defaultRuntime().tokens.issueOwnerToken(ownerId);
  },
  issueAgentToken(agentId: string): string {
    return defaultRuntime().tokens.issueAgentToken(agentId);
  },
  authenticate(token: string): AuthPrincipal | null {
    return defaultRuntime().tokens.authenticate(token);
  },
};

/** Same chain the no-argument server appends to. */
export const audit: AuditLog = {
  append(input) {
    return defaultRuntime().audit.append(input);
  },
  verify() {
    return defaultRuntime().audit.verify();
  },
  listForOwner(requesterOwnerId: string, ownerId: string) {
    return defaultRuntime().audit.listForOwner(requesterOwnerId, ownerId);
  },
};

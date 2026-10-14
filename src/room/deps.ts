import type Database from "better-sqlite3";
import type {
  AuditLog,
  Clock,
  ContentGuard,
  SharingDirectory,
  TokenStore,
  WakeQueue,
} from "../../contract/index.js";

export interface RoomDeps {
  db: Database.Database;
  clock: Clock;
  tokens: TokenStore;
  audit: AuditLog;
  sharing: SharingDirectory;
  guard: ContentGuard;
  /**
   * Called after an accepted post or file when the round still sends wakes.
   * Omitted until the wake-up service is attached. Held items are never enqueued.
   */
  wakeQueue?: WakeQueue;
}

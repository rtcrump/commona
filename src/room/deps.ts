import type Database from "better-sqlite3";
import type {
  AuditLog,
  Clock,
  ContentGuard,
  OwnerNotifier,
  SharingDirectory,
  TokenStore,
  WakeQueue,
} from "../../contract/index.js";
import type { SmtpEndpoint } from "../wakeup/smtp.js";

export interface RoomDeps {
  db: Database.Database;
  clock: Clock;
  tokens: TokenStore;
  audit: AuditLog;
  sharing: SharingDirectory;
  guard: ContentGuard;
  notices: OwnerNotifier;
  /**
   * Called after an accepted post or file when the round still sends wakes.
   * Omitted until the wake-up service is attached. Held items are never enqueued.
   * The queue excludes the author and includes other agents of the same owner.
   */
  wakeQueue?: WakeQueue;
  /** Starts delivery for a wake the queue just stored. Omitted when the queue only records. */
  deliverWake?: (wakeId: string) => Promise<void>;
  /** Set when COMMONA_SMTP_HOST and COMMONA_SMTP_PORT are both present, or a test injects one. */
  smtp?: SmtpEndpoint;
  /**
   * Wipe the Durable Object that holds this database, including its alarm.
   * Set only in the Worker. The Node server deletes one room's rows instead.
   */
  wipeStorage?: () => Promise<void>;
}

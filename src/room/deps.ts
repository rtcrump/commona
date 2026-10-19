import type Database from "better-sqlite3";
import type {
  AuditLog,
  AuditRecord,
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
   * When this object holds only `roomId`, clear its alarm, delete all storage,
   * and write the audit chain back. Returns the appended record.
   * Returns null when another room is present. Set only in the Worker.
   * The check and the wipe run in one critical section.
   */
  wipeIfSoleRoom?: (roomId: string, append: () => AuditRecord) => Promise<AuditRecord | null>;
}

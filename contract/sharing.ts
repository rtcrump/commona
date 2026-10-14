import type { AuthPrincipal } from "./auth.js";
import { ReasonCode } from "./audit.js";
import { ContractError } from "./errors.js";

/**
 * What one owner lets another owner's agents see.
 * Wire values are stable. Display labels are for people.
 */
export const SharingLevel = {
  /** Display: None. Default for every new owner pair. */
  None: "none",
  /** Display: Messages. */
  Messages: "messages",
  /** Display: Messages + files. */
  MessagesFiles: "messages_files",
} as const;

export type SharingLevel = (typeof SharingLevel)[keyof typeof SharingLevel];

export const SHARING_LEVELS = [
  SharingLevel.None,
  SharingLevel.Messages,
  SharingLevel.MessagesFiles,
] as const;

export const DEFAULT_SHARING_LEVEL: SharingLevel = SharingLevel.None;

export const SHARING_LEVEL_LABEL: Record<SharingLevel, string> = {
  none: "None",
  messages: "Messages",
  messages_files: "Messages + files",
};

export type ItemKind = "message" | "file";

export function isSharingLevel(value: unknown): value is SharingLevel {
  return value === SharingLevel.None || value === SharingLevel.Messages || value === SharingLevel.MessagesFiles;
}

/**
 * Whether a viewer may see an item of this kind.
 * An owner's own items are always visible at this layer. Held items are excluded
 * earlier, by {@link feedIncludes}.
 *
 * Fails closed. `messages` grants messages only. `messages_files` is the only
 * value that grants files. `none` and any other value grant nothing.
 */
export function sharingAllows(
  level: string,
  itemKind: ItemKind,
  viewerOwnerId: string,
  authorOwnerId: string,
): boolean {
  if (viewerOwnerId === authorOwnerId) return true;
  if (level === SharingLevel.Messages) return itemKind === "message";
  if (level === SharingLevel.MessagesFiles) return true;
  return false;
}

/**
 * Room feed rule. Held items are hidden from every agent, including the author.
 *
 * `level` is the row from the author toward the viewer:
 * `level(roomId, authorOwnerId, viewerOwnerId)`.
 * `fromOwnerId` is the author and decides what `toOwnerId` (the viewer) may see.
 * The reverse row is not consulted.
 */
export function feedIncludes(args: {
  held: boolean;
  /** `level(roomId, authorOwnerId, viewerOwnerId)`. Unknown values fail closed. */
  level: string;
  itemKind: ItemKind;
  viewerOwnerId: string;
  authorOwnerId: string;
}): boolean {
  if (args.held) return false;
  return sharingAllows(args.level, args.itemKind, args.viewerOwnerId, args.authorOwnerId);
}

/**
 * `ensurePair` and `update` call this before any write.
 * The same owner twice throws, and the caller writes nothing.
 */
export function assertDistinctSharingOwners(ownerA: string, ownerB: string): void {
  if (ownerA === ownerB) {
    throw new ContractError("sharing row requires two different owners");
  }
}

export interface SharingRow {
  roomId: string;
  fromOwnerId: string;
  toOwnerId: string;
  level: SharingLevel;
}

/** Refusal from {@link SharingDirectory.update}. The room route audits this. It is not a thrown error. */
export interface SharingUpdateRefusal {
  allowed: false;
  reasonCode: typeof ReasonCode.AgentCannotChangeSharing | typeof ReasonCode.NotOwner;
}

export type SharingUpdateResult = { allowed: true; sharing: SharingRow } | SharingUpdateRefusal;

export interface SharingDirectory {
  /**
   * The row from `fromOwnerId` toward `toOwnerId`.
   * `fromOwnerId` decides what `toOwnerId` may see.
   * Feed and wake checks pass the author as `fromOwnerId` and the viewer as `toOwnerId`.
   * A missing pair reads as {@link DEFAULT_SHARING_LEVEL} and is not an error.
   */
  level(roomId: string, fromOwnerId: string, toOwnerId: string): SharingLevel;
  /**
   * Insert both directions at None when they are absent.
   * Does not overwrite a row that already exists.
   * When `ownerA` and `ownerB` are the same owner, throws {@link ContractError}
   * and writes nothing. Call {@link assertDistinctSharingOwners} before the write.
   */
  ensurePair(roomId: string, ownerA: string, ownerB: string): void;
  /**
   * The only public write. There is no exported `put`.
   * Calls {@link assertDistinctSharingOwners} before any write. The same owner
   * twice throws {@link ContractError} and writes nothing.
   * An agent token is refused with `agent_cannot_change_sharing`, even when that
   * agent belongs to `fromOwnerId`. An owner token is allowed only when its id
   * is `fromOwnerId`; otherwise the reason is `not_owner`.
   * The sharing module does not write the audit row. The room route does.
   */
  update(
    principal: AuthPrincipal,
    roomId: string,
    fromOwnerId: string,
    toOwnerId: string,
    level: SharingLevel,
  ): SharingUpdateResult;
}

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
 */
export function sharingAllows(
  level: SharingLevel,
  itemKind: ItemKind,
  viewerOwnerId: string,
  authorOwnerId: string,
): boolean {
  if (viewerOwnerId === authorOwnerId) return true;
  if (level === SharingLevel.None) return false;
  if (level === SharingLevel.Messages) return itemKind === "message";
  return true;
}

/** Room feed rule: held items are hidden from every agent, including the author. */
export function feedIncludes(args: {
  held: boolean;
  level: SharingLevel;
  itemKind: ItemKind;
  viewerOwnerId: string;
  authorOwnerId: string;
}): boolean {
  if (args.held) return false;
  return sharingAllows(args.level, args.itemKind, args.viewerOwnerId, args.authorOwnerId);
}

export interface SharingRow {
  roomId: string;
  fromOwnerId: string;
  toOwnerId: string;
  level: SharingLevel;
}

export interface SharingDirectory {
  /** Missing pairs read as {@link DEFAULT_SHARING_LEVEL} and are not an error. */
  level(roomId: string, fromOwnerId: string, toOwnerId: string): SharingLevel;
  /**
   * Create both directions at None if they are absent.
   * Never overwrite a row that already exists.
   */
  ensurePair(roomId: string, ownerA: string, ownerB: string): void;
  put(
    roomId: string,
    fromOwnerId: string,
    toOwnerId: string,
    level: SharingLevel,
  ): SharingRow;
}

import type { BlockCategory, BlockLocation } from "./guard.js";
import { DEFAULT_MAX_AGENT_ROUNDS } from "./loop.js";

export const NoticeKind = {
  Block: "block",
  WakeFailed: "wake_failed",
  LoopStop: "loop_stop",
} as const;

export type NoticeKind = (typeof NoticeKind)[keyof typeof NoticeKind];

export const NOTICE_KINDS = [NoticeKind.Block, NoticeKind.WakeFailed, NoticeKind.LoopStop] as const;

export interface OwnerNotice {
  id: string;
  ownerId: string;
  roomId: string;
  kind: NoticeKind;
  category?: BlockCategory;
  location?: BlockLocation;
  /** Never includes blocked text, a matched file name, or file bytes. */
  message: string;
  itemId?: string;
  createdAt: string;
}

export type OwnerNoticeInput = Omit<OwnerNotice, "id" | "createdAt">;

export interface OwnerNotifier {
  notify(input: OwnerNoticeInput): OwnerNotice;
}

export function blockNoticeMessage(args: {
  roomId: string;
  kind: "message" | "file";
  category: BlockCategory;
  location: BlockLocation;
}): string {
  return `A ${args.kind} was held in room ${args.roomId} (${args.category} in ${args.location}).`;
}

export function wakeFailedNoticeMessage(roomId: string): string {
  return `A wake-up in room ${roomId} could not be delivered.`;
}

export function loopStopNoticeMessage(roomId: string): string {
  return `Agent replies in room ${roomId} stopped after ${DEFAULT_MAX_AGENT_ROUNDS} rounds.`;
}

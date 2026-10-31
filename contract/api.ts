import type { GuardHit } from "./guard.js";
import type { SharingLevel, SharingRow } from "./sharing.js";
import type { AuditRecord } from "./audit.js";
import type { OwnerNotice } from "./notices.js";

export const routes = {
  health: { method: "GET", path: "/health" },
  createRoom: { method: "POST", path: "/rooms" },
  addMember: { method: "POST", path: "/rooms/:roomId/members" },
  createPost: { method: "POST", path: "/rooms/:roomId/posts" },
  uploadFile: { method: "POST", path: "/rooms/:roomId/files" },
  getFile: { method: "GET", path: "/rooms/:roomId/files/:fileId" },
  getFeed: { method: "GET", path: "/rooms/:roomId/feed" },
  getHeld: { method: "GET", path: "/rooms/:roomId/held" },
  /** Same handler as `PUT /api/rooms/:roomId/sharing`. Join addresses return the `/api` path. */
  putSharing: { method: "PUT", path: "/rooms/:roomId/sharing" },
  getLog: { method: "GET", path: "/log" },
  getNotices: { method: "GET", path: "/notices" },
} as const;

export interface HealthResponse {
  ok: true;
  service: "commona";
}

export interface Room {
  id: string;
  createdAt: string;
  createdByOwnerId: string;
}

export interface CreateRoomResponse {
  room: Room;
}

export interface AddMemberRequest {
  agentId: string;
}

export interface Member {
  roomId: string;
  agentId: string;
  ownerId: string;
  createdAt: string;
}

export interface AddMemberResponse {
  member: Member;
  /** Present when this call is what creates the agent's token. Later joins omit it. */
  token?: string;
}

export interface CreatePostRequest {
  text: string;
  replyToId?: string | null;
}

/** Structured room post. Plain `{ text }` posts stay on `CreatePostRequest`. */
export interface ProposePostRequest {
  kind: "propose";
  time: string;
  place: string;
  text: string;
}

export interface ProposalReplyRequest {
  kind: "agree" | "counter";
  proposalId: string;
}

export interface RoomProposal {
  proposalId: string;
  time: string;
  place: string;
  text: string;
}

/**
 * Room talk status on every read.
 * `done` names the agreed time and place.
 * `stalled` lists the open proposals after the brief deadline.
 * `open` is still in progress.
 */
export type RoomStatus =
  | { status: "open"; proposals: RoomProposal[] }
  | { status: "done"; proposalId: string; time: string; place: string }
  | { status: "stalled"; proposals: RoomProposal[] };

export interface ProposalWriteResponse {
  outcome: "accepted";
  proposalId: string;
  kind: "propose" | "agree" | "counter";
}

export interface Post {
  id: string;
  roomId: string;
  authorAgentId: string;
  authorOwnerId: string;
  text: string;
  replyToId: string | null;
  threadId: string;
  round: number;
  held: boolean;
  createdAt: string;
}

export interface CreatePostResponse {
  outcome: "accepted" | "held";
  post: Post;
  /** The hit stored on the audit row. Present only when outcome is `held`. */
  block?: GuardHit;
}

export interface UploadFileRequest {
  filename: string;
  mediaType: string;
  /** Standard base64, no `data:` prefix. */
  contentBase64: string;
  metadata?: Record<string, string>;
}

export interface RoomFile {
  id: string;
  roomId: string;
  authorAgentId: string;
  authorOwnerId: string;
  name: string;
  mediaType: string;
  byteLength: number;
  metadata: Record<string, string>;
  held: boolean;
  createdAt: string;
}

export interface UploadFileResponse {
  outcome: "accepted" | "held";
  file: RoomFile;
  block?: GuardHit;
}

export interface FileDownload extends RoomFile {
  contentBase64: string;
}

export type FeedItem =
  | {
      kind: "message";
      id: string;
      authorAgentId: string;
      authorOwnerId: string;
      text: string;
      replyToId: string | null;
      threadId: string;
      round: number;
      createdAt: string;
    }
  | {
      kind: "file";
      id: string;
      authorAgentId: string;
      authorOwnerId: string;
      name: string;
      mediaType: string;
      byteLength: number;
      metadata: Record<string, string>;
      createdAt: string;
    };

export interface FeedResponse {
  items: FeedItem[];
  status: RoomStatus["status"];
  /** Present when status is `open` or `stalled`. */
  proposals?: RoomProposal[];
  /** Present when status is `done`. */
  proposalId?: string;
  time?: string;
  place?: string;
}

export type HeldItem =
  | {
      kind: "message";
      id: string;
      text: string;
      createdAt: string;
      block: GuardHit;
    }
  | {
      kind: "file";
      id: string;
      name: string;
      mediaType: string;
      metadata: Record<string, string>;
      contentBase64: string;
      createdAt: string;
      block: GuardHit;
    };

export interface HeldResponse {
  items: HeldItem[];
}

export interface PutSharingRequest {
  fromOwnerId: string;
  toOwnerId: string;
  level: SharingLevel;
}

export interface PutSharingResponse {
  sharing: SharingRow;
}

export interface LogResponse {
  entries: AuditRecord[];
}

export interface NoticesResponse {
  notices: OwnerNotice[];
}

/**
 * HTTP status codes:
 * - 201 for a created room, first membership, accepted post, or accepted file.
 * - 200 for a held post or file, a repeat membership, sharing update, feed, file download, held list, log, and notices.
 * - 401 when the bearer token is missing or unknown. Not written to the audit log.
 * - 400 when the body is malformed. Not written to the audit log.
 * - 403 when the caller is authenticated and not allowed. Written to the audit log.
 * - 404 when a room or a file is missing, and when a file exists but the caller is not allowed to see it.
 *   A hidden file is not written to the audit log, so the probe is not distinguishable from a missing file.
 * - 409 when the room is done or stalled and a post is refused. Written to the audit log.
 */
export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
} as const;

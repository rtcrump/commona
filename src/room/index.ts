import type {
  AuthPrincipal,
  CreatePostRequest,
  CreatePostResponse,
  FeedResponse,
  UploadFileRequest,
  UploadFileResponse,
} from "../../contract/index.js";
import { todo } from "../todo.js";

/** T2. Posts, uploads, and the feed. Membership lives in `membership.ts`. */
export function createPost(
  _principal: AuthPrincipal,
  _roomId: string,
  _body: CreatePostRequest,
): CreatePostResponse {
  return todo("room");
}

export function uploadFile(
  _principal: AuthPrincipal,
  _roomId: string,
  _body: UploadFileRequest,
): UploadFileResponse {
  return todo("room");
}

export function readFeed(_principal: AuthPrincipal, _roomId: string): FeedResponse {
  return todo("room");
}

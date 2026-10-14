import type { AddMemberResponse, AuthPrincipal, Room } from "../../contract/index.js";
import { todo } from "../todo.js";

/** T2. Critical core: inviting an agent into a room. */
export function createRoom(_principal: AuthPrincipal): Room {
  return todo("room.membership");
}

export function addMember(
  _principal: AuthPrincipal,
  _roomId: string,
  _agentId: string,
): AddMemberResponse {
  return todo("room.membership");
}

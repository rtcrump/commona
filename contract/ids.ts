import { randomUUID } from "node:crypto";
import { ContractError } from "./errors.js";

/** Room value for an audit row that is not about one room, such as a cross-owner log read. */
export const UNSCOPED_ROOM = "*";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isId(value: string): boolean {
  return ID_RE.test(value);
}

export function isRoomRef(value: string): boolean {
  return value === UNSCOPED_ROOM || isId(value);
}

/** Agent id stored on owner-authenticated actions, which have no acting agent. */
export function ownerActorId(ownerId: string): string {
  if (!isId(ownerId)) throw new ContractError("owner id has an invalid shape");
  return `owner:${ownerId}`;
}

export function isOwnerActorId(agentId: string): boolean {
  return agentId.startsWith("owner:") && isId(agentId.slice("owner:".length));
}

export function isAgentId(agentId: string): boolean {
  return isId(agentId) && !agentId.includes(":");
}

export function newId(prefix: string): string {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) {
    throw new ContractError("id prefix must be lowercase letters and digits");
  }
  return `${prefix}_${randomUUID()}`;
}

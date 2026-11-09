import {
  DEFAULT_SHARING_LEVEL,
  type AuthPrincipal,
  type SharingDirectory,
  type SharingLevel,
  type SharingUpdateResult,
} from "../../contract/index.js";
import { todo } from "../todo.js";

export { DEFAULT_SHARING_LEVEL };

/** T3. Critical core: per-owner sharing levels. Default is None. */
export const sharing: SharingDirectory = {
  level(_roomId: string, _fromOwnerId: string, _toOwnerId: string): SharingLevel {
    return todo("sharing");
  },
  ensurePair(_roomId: string, _ownerA: string, _ownerB: string): void {
    todo("sharing");
  },
  update(
    _principal: AuthPrincipal,
    _roomId: string,
    _fromOwnerId: string,
    _toOwnerId: string,
    _level: SharingLevel,
  ): SharingUpdateResult {
    return todo("sharing");
  },
};

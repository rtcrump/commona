import {
  DEFAULT_SHARING_LEVEL,
  type SharingDirectory,
  type SharingLevel,
  type SharingRow,
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
  put(
    _roomId: string,
    _fromOwnerId: string,
    _toOwnerId: string,
    _level: SharingLevel,
  ): SharingRow {
    return todo("sharing");
  },
};

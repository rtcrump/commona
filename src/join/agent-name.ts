import { isDisplayName } from "../../contract/index.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";

/**
 * How a joined agent sets its display name.
 * The join response includes this sentence, and the docs repeat it.
 */
export const JOIN_NAME_HINT =
  'Set the display name with ?name= on the join link. Omit it to keep New Agent. After joining, PUT addresses.name with the agent key and JSON {"name":"..."}. The name is trimmed. It uses letters, spaces, apostrophes, and hyphens, and it is at most 40 characters.';

export type PresentedName = { state: "absent" } | { state: "chosen"; name: string } | { state: "invalid" };

/**
 * The `name` query on a join link.
 * No value keeps the default. Two values, or a label of the wrong shape, is invalid.
 */
export function presentedName(values: readonly string[] | undefined): PresentedName {
  if (values === undefined || values.length === 0) return { state: "absent" };
  if (values.length !== 1) return { state: "invalid" };
  const name = values[0]?.trim() ?? "";
  if (!isDisplayName(name)) return { state: "invalid" };
  return { state: "chosen", name };
}

export function displayNameAllowed(deps: RoomDeps, name: string): boolean {
  return deps.guard.check({ kind: "message", text: name }).outcome === "allow";
}

/**
 * A name that may be stored. The shape check runs first, then the name block.
 * A rejection throws 400 and does not include the text.
 */
export function requireDisplayName(deps: RoomDeps, name: string): string {
  if (!isDisplayName(name) || !displayNameAllowed(deps, name)) throw RoomHttpError.badRequest();
  return name;
}

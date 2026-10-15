import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  AuditAction,
  AuditResult,
  formatTimestamp,
  hashToken,
  ownerActorId,
  SharingLevel,
  type SharingLevel as SharingLevelName,
} from "../../contract/index.js";
import {
  FORM_COOKIE,
  INVITE_COOKIE,
  JOINED_COOKIE,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
} from "../join/cookies.js";
import { isInviteId, redeemInvite } from "../join/service.js";
import type { RoomDeps } from "../room/deps.js";
import { RoomHttpError } from "../room/http.js";
import { describeInvite, errorSentence, type InviteView } from "./invite-view.js";
import { renderConnect, renderDone, renderError, renderSharing, renderWelcome } from "./html.js";

const STALE = "This page is out of date, so open the invite link again.";
const NAME_NOTE = "Enter your first name.";
const NAME_RE = /^[\p{L}][\p{L} '-]{0,39}$/u;
const LOCATION_RE =
  /^\/j\/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/(sharing|done))?$/;

const firstNames = new Map<string, string>();
const joined = new Map<string, string>();

export interface JoinResult {
  status: number;
  html?: string;
  location?: string;
  cookies: string[];
  /** Values that must not appear in the HTML or the redirect URL. */
  secrets: string[];
}

function page(status: number, html: string, cookies: string[] = [], secrets: string[] = []): JoinResult {
  return { status, html, cookies, secrets };
}

function redirect(location: string, cookies: string[], secrets: string[]): JoinResult {
  if (!LOCATION_RE.test(location)) throw new Error("refusing to redirect");
  return { status: 303, location, cookies, secrets };
}

function pathFor(id: string, suffix: "" | "/sharing" | "/done" = ""): string {
  if (!isInviteId(id)) throw new Error("refusing to redirect");
  return `/j/${id}${suffix}`;
}

function issueNonce(maxAge: number): { nonce: string; cookie: string } {
  const nonce = randomBytes(32).toString("base64url");
  return { nonce, cookie: serializeCookie(FORM_COOKIE, nonce, "/j", maxAge) };
}

function cookieMaxAge(deps: RoomDeps, id: string): number {
  const row = deps.db.prepare("SELECT expires_at FROM invites WHERE id = ?").get(id) as
    | { expires_at: string }
    | undefined;
  if (!row) return 60;
  const seconds = Math.floor((Date.parse(row.expires_at) - deps.clock.now().getTime()) / 1000);
  return Math.max(1, seconds);
}

function formFields(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

function csrfOk(cookieHeader: string | string[] | undefined, nonce: string | undefined): boolean {
  const cookie = readCookie(cookieHeader, FORM_COOKIE);
  if (!cookie || !nonce) return false;
  const left = Buffer.from(cookie);
  const right = Buffer.from(nonce);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function errorPage(view: InviteView): JoinResult {
  return page(200, renderError(errorSentence(view)));
}

function stalePage(): JoinResult {
  return page(403, renderError(STALE));
}

function readFirstName(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  if (!NAME_RE.test(name)) return null;
  return name;
}

function seeingFromForm(value: string | undefined): SharingLevelName {
  if (value === "Messages") return SharingLevel.Messages;
  if (value === "Messages and files") return SharingLevel.MessagesFiles;
  return SharingLevel.None;
}

function rememberJoined(inviteId: string): string {
  const token = randomBytes(32).toString("base64url");
  joined.set(token, inviteId);
  return token;
}

function joinedInvite(token: string | null): string | null {
  if (!token) return null;
  return joined.get(token) ?? null;
}

export function openWelcome(deps: RoomDeps, inviteId: string, secret: string | null): JoinResult {
  const view = describeInvite(deps, inviteId);
  if (view.status !== "open") return errorPage(view);
  const maxAge = cookieMaxAge(deps, inviteId);
  const { nonce, cookie } = issueNonce(maxAge);
  const cookies = [cookie];
  const secrets: string[] = [];
  if (secret && /^[A-Za-z0-9_-]+$/.test(secret)) {
    cookies.push(serializeCookie(INVITE_COOKIE, secret, "/j", maxAge));
    secrets.push(secret, hashToken(secret));
  }
  return page(
    200,
    renderWelcome({
      inviter: view.inviter,
      room: view.roomTitle,
      action: pathFor(inviteId, "") + "/continue",
      nonce,
    }),
    cookies,
    secrets,
  );
}

export function submitName(
  deps: RoomDeps,
  inviteId: string,
  body: unknown,
  cookieHeader: string | string[] | undefined,
): JoinResult {
  const view = describeInvite(deps, inviteId);
  if (view.status !== "open") return errorPage(view);
  const fields = formFields(body);
  if (!csrfOk(cookieHeader, fields.nonce)) return stalePage();
  const name = readFirstName(fields.firstName);
  const maxAge = cookieMaxAge(deps, inviteId);
  if (!name) {
    const { nonce, cookie } = issueNonce(maxAge);
    return page(
      400,
      renderWelcome({
        inviter: view.inviter,
        room: view.roomTitle,
        action: `${pathFor(inviteId)}/continue`,
        nonce,
        note: NAME_NOTE,
      }),
      [cookie],
    );
  }
  firstNames.set(inviteId, name);
  return redirect(pathFor(inviteId, "/sharing"), [], []);
}

export function openSharing(deps: RoomDeps, inviteId: string): JoinResult {
  const view = describeInvite(deps, inviteId);
  if (view.status !== "open") return errorPage(view);
  if (!firstNames.has(inviteId)) return redirect(pathFor(inviteId), [], []);
  const { nonce, cookie } = issueNonce(cookieMaxAge(deps, inviteId));
  return page(200, renderSharing({ action: `${pathFor(inviteId)}/finish`, nonce }), [cookie]);
}

function grantSeeing(deps: RoomDeps, roomId: string, ownerId: string, level: SharingLevelName): void {
  if (level === SharingLevel.None) return;
  const others = deps.db
    .prepare("SELECT DISTINCT owner_id FROM memberships WHERE room_id = ? AND owner_id <> ?")
    .all(roomId, ownerId) as { owner_id: string }[];
  const principal = { kind: "owner" as const, ownerId };
  for (const other of others) {
    const result = deps.sharing.update(principal, roomId, ownerId, other.owner_id, level);
    if (!result.allowed) continue;
    deps.audit.append({
      ts: formatTimestamp(deps.clock.now()),
      room: roomId,
      agentId: ownerActorId(ownerId),
      ownerId,
      action: AuditAction.SettingChange,
      result: AuditResult.Ok,
      detail: {
        level: result.sharing.level,
        fromOwnerId: result.sharing.fromOwnerId,
        toOwnerId: result.sharing.toOwnerId,
      },
    });
  }
}

export function submitSharing(
  deps: RoomDeps,
  inviteId: string,
  body: unknown,
  cookieHeader: string | string[] | undefined,
): JoinResult {
  const view = describeInvite(deps, inviteId);
  if (view.status !== "open") return errorPage(view);
  const fields = formFields(body);
  if (!csrfOk(cookieHeader, fields.nonce)) return stalePage();
  const name = firstNames.get(inviteId);
  if (!name) {
    return page(400, renderError(STALE));
  }
  const secret = readCookie(cookieHeader, INVITE_COOKIE);
  let redeemed;
  try {
    redeemed = redeemInvite(deps, inviteId, secret, undefined);
  } catch (error) {
    if (!(error instanceof RoomHttpError)) throw error;
    const again = describeInvite(deps, inviteId);
    if (again.status === "open" || again.status === "unknown") return stalePage();
    return errorPage(again);
  }
  deps.db.prepare("UPDATE owners SET display_name = ? WHERE id = ?").run(name, redeemed.owner.id);
  grantSeeing(deps, redeemed.member.roomId, redeemed.owner.id, seeingFromForm(fields.seeing));
  firstNames.delete(inviteId);
  if (!/^[A-Za-z0-9_-]+$/.test(redeemed.sessionToken)) throw new Error("refusing to send a secret");
  const marker = rememberJoined(inviteId);
  const secrets = [redeemed.sessionToken, hashToken(redeemed.sessionToken), marker, secret ?? ""].filter(
    (value) => value.length > 0,
  );
  return redirect(
    pathFor(inviteId, "/done"),
    [
      serializeCookie(SESSION_COOKIE, redeemed.sessionToken, "/"),
      serializeCookie(JOINED_COOKIE, marker, "/j", 10 * 60),
    ],
    secrets,
  );
}

export function openDone(
  deps: RoomDeps,
  inviteId: string,
  cookieHeader: string | string[] | undefined,
): JoinResult {
  const marker = readCookie(cookieHeader, JOINED_COOKIE);
  if (joinedInvite(marker) === inviteId) {
    return page(200, renderDone(), [], marker ? [marker] : []);
  }
  return errorPage(describeInvite(deps, inviteId));
}

export function openConnect(): JoinResult {
  return page(200, renderConnect());
}

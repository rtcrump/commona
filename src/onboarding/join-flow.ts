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
import { ensureInviteSchema } from "../join/schema.js";
import { isInviteId, redeemInvite } from "../join/service.js";
import type { RoomDeps } from "../room/deps.js";
import { grantHostMessages } from "../room/host-grant.js";
import { RoomHttpError } from "../room/http.js";
import {
  connectLinkState,
  hasArrived,
  issueConnectLink,
  requestCheck,
  waitForCheck,
} from "./connect.js";
import { describeInvite, errorSentence, type InviteView } from "./invite-view.js";
import { renderConnect, renderDone, renderError, renderGuided, renderSharing, renderStatus, renderWelcome } from "./html.js";

const STALE = "This page is out of date, so open the invite link again.";
const NAME_NOTE = "Enter your first name.";
const NAME_RE = /^[\p{L}][\p{L} '-]{0,39}$/u;
const LOCATION_RE =
  /^\/j\/inv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/(sharing|done))?$/;

interface JoinedMark {
  inviteId: string;
  ownerId: string;
}

const joined = new Map<string, JoinedMark>();

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

function pathFor(id: string, suffix: "" | "/sharing" | "/done" | "/connect" | "/connect/link" | "/connect/check" = ""): string {
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

/** The invite secret hash when this browser still holds the one-time invite cookie. */
function matchingInviteHash(
  deps: RoomDeps,
  inviteId: string,
  cookieHeader: string | string[] | undefined,
): string | null {
  const secret = readCookie(cookieHeader, INVITE_COOKIE);
  if (!secret) return null;
  const row = deps.db.prepare("SELECT secret_hash FROM invites WHERE id = ?").get(inviteId) as
    | { secret_hash: string }
    | undefined;
  if (!row) return null;
  const got = Buffer.from(hashToken(secret));
  const expected = Buffer.from(row.secret_hash);
  if (got.length === 0 || got.length !== expected.length) return null;
  return timingSafeEqual(got, expected) ? row.secret_hash : null;
}

function displayNameAllowed(deps: RoomDeps, name: string): boolean {
  return deps.guard.check({ kind: "message", text: name }).outcome === "allow";
}

function savePendingName(deps: RoomDeps, inviteId: string, secretHash: string, name: string): void {
  ensureInviteSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO invite_pending_names (invite_id, secret_hash, first_name)
       VALUES (?, ?, ?)
       ON CONFLICT(invite_id) DO UPDATE SET
         secret_hash = excluded.secret_hash,
         first_name = excluded.first_name`,
    )
    .run(inviteId, secretHash, name);
}

function loadPendingName(deps: RoomDeps, inviteId: string, secretHash: string): string | null {
  ensureInviteSchema(deps.db);
  const row = deps.db
    .prepare("SELECT first_name FROM invite_pending_names WHERE invite_id = ? AND secret_hash = ?")
    .get(inviteId, secretHash) as { first_name: string } | undefined;
  return row?.first_name ?? null;
}

function dropPendingName(deps: RoomDeps, inviteId: string): void {
  ensureInviteSchema(deps.db);
  deps.db.prepare("DELETE FROM invite_pending_names WHERE invite_id = ?").run(inviteId);
}

function welcomeAgain(
  deps: RoomDeps,
  inviteId: string,
  view: InviteView,
  note: string,
): JoinResult {
  const { nonce, cookie } = issueNonce(cookieMaxAge(deps, inviteId));
  return page(
    400,
    renderWelcome({
      inviter: view.inviter,
      room: view.roomTitle,
      action: `${pathFor(inviteId)}/continue`,
      nonce,
      note,
    }),
    [cookie],
  );
}

function seeingFromForm(value: string | undefined): SharingLevelName {
  if (value === "Messages") return SharingLevel.Messages;
  if (value === "Messages and files") return SharingLevel.MessagesFiles;
  return SharingLevel.None;
}

function rememberJoined(inviteId: string, ownerId: string): string {
  const token = randomBytes(32).toString("base64url");
  joined.set(token, { inviteId, ownerId });
  return token;
}

function joinedMark(token: string | null): JoinedMark | null {
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
  const secretHash = matchingInviteHash(deps, inviteId, cookieHeader);
  if (!secretHash) return stalePage();
  const name = readFirstName(fields.firstName);
  if (!name || !displayNameAllowed(deps, name)) return welcomeAgain(deps, inviteId, view, NAME_NOTE);
  savePendingName(deps, inviteId, secretHash, name);
  return redirect(pathFor(inviteId, "/sharing"), [], []);
}

export function openSharing(
  deps: RoomDeps,
  inviteId: string,
  cookieHeader: string | string[] | undefined,
): JoinResult {
  const view = describeInvite(deps, inviteId);
  if (view.status !== "open") return errorPage(view);
  const secretHash = matchingInviteHash(deps, inviteId, cookieHeader);
  if (!secretHash || loadPendingName(deps, inviteId, secretHash) === null) {
    return redirect(pathFor(inviteId), [], []);
  }
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
  const secretHash = matchingInviteHash(deps, inviteId, cookieHeader);
  const name = secretHash ? loadPendingName(deps, inviteId, secretHash) : null;
  if (!secretHash || !name) {
    return page(400, renderError(STALE));
  }
  if (!displayNameAllowed(deps, name)) {
    dropPendingName(deps, inviteId);
    return page(400, renderError(NAME_NOTE));
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
  grantHostMessages(deps, redeemed.member.roomId, redeemed.owner.id);
  dropPendingName(deps, inviteId);
  if (!/^[A-Za-z0-9_-]+$/.test(redeemed.sessionToken)) throw new Error("refusing to send a secret");
  const marker = rememberJoined(inviteId, redeemed.owner.id);
  rememberInviteOwner(deps, inviteId, redeemed.owner.id, redeemed.member.roomId);
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
  if (joinedMark(marker)?.inviteId === inviteId) {
    return page(200, renderDone(pathFor(inviteId, "/connect")), [], marker ? [marker] : []);
  }
  return errorPage(describeInvite(deps, inviteId));
}

export function openConnect(): JoinResult {
  return page(200, renderConnect());
}

type ConnectAuth = { ownerId: string; roomId: string; hidden: string[] };

function rememberInviteOwner(deps: RoomDeps, inviteId: string, ownerId: string, roomId: string): void {
  ensureInviteSchema(deps.db);
  deps.db
    .prepare(
      `INSERT INTO invite_owners (invite_id, owner_id, room_id)
       VALUES (?, ?, ?)
       ON CONFLICT(invite_id) DO NOTHING`,
    )
    .run(inviteId, ownerId, roomId);
}

function authorizeConnect(
  deps: RoomDeps,
  inviteId: string,
  cookieHeader: string | string[] | undefined,
): ConnectAuth | JoinResult {
  if (!isInviteId(inviteId)) return errorPage(describeInvite(deps, inviteId));
  ensureInviteSchema(deps.db);
  const marker = readCookie(cookieHeader, JOINED_COOKIE);
  const mark = joinedMark(marker);
  const session = readCookie(cookieHeader, SESSION_COOKIE);
  const principal = session ? deps.tokens.authenticate(session) : null;
  const saved = deps.db.prepare("SELECT owner_id FROM invite_owners WHERE invite_id = ?").get(inviteId) as
    | { owner_id: string }
    | undefined;
  let ownerId: string | null = null;
  if (mark && mark.inviteId === inviteId) {
    if (!principal || principal.kind !== "owner" || principal.ownerId !== mark.ownerId) return stalePage();
    ownerId = mark.ownerId;
  } else if (saved && principal && principal.kind === "owner" && principal.ownerId === saved.owner_id) {
    ownerId = saved.owner_id;
  } else {
    return errorPage(describeInvite(deps, inviteId));
  }
  const invite = deps.db.prepare("SELECT room_id FROM invites WHERE id = ?").get(inviteId) as
    | { room_id: string }
    | undefined;
  if (!invite) return errorPage(describeInvite(deps, inviteId));
  const member = deps.db
    .prepare("SELECT 1 AS ok FROM memberships WHERE room_id = ? AND owner_id = ?")
    .get(invite.room_id, ownerId) as { ok: number } | undefined;
  if (!member) return stalePage();
  const hidden = [marker ?? "", session ?? ""].filter((value) => value.length > 0);
  return { ownerId, roomId: invite.room_id, hidden };
}

function isAuth(value: ConnectAuth | JoinResult): value is ConnectAuth {
  return "ownerId" in value;
}

function handoffDeps(deps: RoomDeps) {
  return { db: deps.db, clock: deps.clock, tokens: deps.tokens };
}

export function openConnectPage(
  deps: RoomDeps,
  inviteId: string,
  cookieHeader: string | string[] | undefined,
): JoinResult {
  const auth = authorizeConnect(deps, inviteId, cookieHeader);
  if (!isAuth(auth)) return auth;
  const view = describeInvite(deps, inviteId);
  const arrived = hasArrived(handoffDeps(deps), auth.ownerId);
  const link = connectLinkState(handoffDeps(deps), auth.ownerId);
  const { nonce, cookie } = issueNonce(10 * 60);
  const note = link.bound
    ? "<p>Claude can keep using that link. A new link replaces it.</p>"
    : link.label === "Get a new link"
      ? "<p>That link was already used, or it ran out of time.</p>"
      : "";
  return page(
    200,
    renderGuided({
      heading: arrived ? "Your assistant is connected" : "Connect your assistant",
      intro: arrived
        ? "Click Check connection to ask your assistant to check in again."
        : "You'll paste one link into Claude. That is three steps.",
      note,
      inviter: view.inviter,
      copyLabel: link.label,
      copyAction: pathFor(inviteId, "/connect/link"),
      checkAction: pathFor(inviteId, "/connect/check"),
      nonce,
    }),
    [cookie],
    auth.hidden,
  );
}

export type CopyPrepared =
  | { ok: true; secret: string; roomId: string; hidden: string[] }
  | { ok: false; result: JoinResult };

export function prepareCopy(
  deps: RoomDeps,
  inviteId: string,
  body: unknown,
  cookieHeader: string | string[] | undefined,
): CopyPrepared {
  const auth = authorizeConnect(deps, inviteId, cookieHeader);
  if (!isAuth(auth)) return { ok: false, result: auth };
  const fields = formFields(body);
  if (!csrfOk(cookieHeader, fields.nonce)) return { ok: false, result: stalePage() };
  try {
    const issued = issueConnectLink(handoffDeps(deps), auth.ownerId, auth.roomId, inviteId);
    return { ok: true, secret: issued.secret, roomId: auth.roomId, hidden: auth.hidden };
  } catch {
    return { ok: false, result: stalePage() };
  }
}

export async function submitCheck(
  deps: RoomDeps,
  inviteId: string,
  body: unknown,
  cookieHeader: string | string[] | undefined,
): Promise<JoinResult> {
  const auth = authorizeConnect(deps, inviteId, cookieHeader);
  if (!isAuth(auth)) return auth;
  const fields = formFields(body);
  if (!csrfOk(cookieHeader, fields.nonce)) return stalePage();
  let checkId: string;
  try {
    checkId = requestCheck(handoffDeps(deps), auth.ownerId);
  } catch {
    return page(200, renderStatus("Not connected"), [], auth.hidden);
  }
  const answered = await waitForCheck(handoffDeps(deps), checkId);
  return page(200, renderStatus(answered ? "Connected" : "Not connected"), [], auth.hidden);
}

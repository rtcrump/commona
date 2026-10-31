import { hashToken } from "../../contract/index.js";
import type { CommonaHono } from "../http/types.js";
import { connectorUrl } from "../onboarding/connect.js";
import { connectScript, joinStylesheet, prefersHtml } from "../onboarding/html.js";
import {
  openConnect,
  openConnectPage,
  openDone,
  openSharing,
  prepareCopy,
  submitCheck,
  submitName,
  submitSharing,
  type JoinResult,
} from "../onboarding/join-flow.js";
import type { RoomDeps } from "../room/deps.js";
import { headerValue } from "./cookies.js";

export function wantsJoinPage(accept: string | undefined): boolean {
  return prefersHtml(headerValue(accept));
}

function assertClean(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && (text.includes(secret) || text.includes(hashToken(secret)))) {
      throw new Error("refusing to send a secret");
    }
  }
}

export function sendJoinResult(result: JoinResult): Response {
  const html = result.html ?? "";
  const location = result.location ?? "";
  assertClean(html, result.secrets);
  assertClean(location, result.secrets);
  const headers = new Headers();
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  for (const cookie of result.cookies) headers.append("set-cookie", cookie);
  if (location) {
    headers.set("location", location);
    return new Response(null, { status: result.status, headers });
  }
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: result.status, headers });
}

/** HTML screens for the invite link. They call the J1 invite helpers and do not read a room. */
export function registerJoinPages(app: CommonaHono, deps: RoomDeps): void {
  app.get("/onboarding/join.css", (c) => {
    return c.body(joinStylesheet(), 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/onboarding/connect.js", (c) => {
    return c.body(connectScript(), 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/join/connect", () => sendJoinResult(openConnect()));

  app.get("/j/:id/connect", (c) => sendJoinResult(openConnectPage(deps, c.req.param("id"), c.req.header("cookie"))));

  app.post("/j/:id/connect/link", (c) => {
    const prepared = prepareCopy(deps, c.req.param("id"), c.get("parsedBody"), c.req.header("cookie"));
    if (!prepared.ok) return sendJoinResult(prepared.result);
    const url = connectorUrl(process.env.COMMONA_CONNECT_URL?.trim() ?? "", prepared.secret, prepared.roomId);
    if (!url) {
      return c.json({ error: "unavailable" }, 503, {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
    }
    const payload = { url };
    const text = JSON.stringify(payload);
    for (const secret of prepared.hidden) {
      if (secret.length > 0 && (text.includes(secret) || text.includes(hashToken(secret)))) {
        throw new Error("refusing to send a secret");
      }
    }
    return c.json(payload, 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
  });

  app.post("/j/:id/connect/check", async (c) => {
    return sendJoinResult(await submitCheck(deps, c.req.param("id"), c.get("parsedBody"), c.req.header("cookie")));
  });

  app.post("/j/:id/continue", (c) => {
    return sendJoinResult(submitName(deps, c.req.param("id"), c.get("parsedBody"), c.req.header("cookie")));
  });

  app.get("/j/:id/sharing", (c) => sendJoinResult(openSharing(deps, c.req.param("id"), c.req.header("cookie"))));

  app.post("/j/:id/finish", (c) => {
    return sendJoinResult(submitSharing(deps, c.req.param("id"), c.get("parsedBody"), c.req.header("cookie")));
  });

  app.get("/j/:id/done", (c) => sendJoinResult(openDone(deps, c.req.param("id"), c.req.header("cookie"))));
}

import type { FastifyInstance, FastifyReply } from "fastify";
import { hashToken } from "../../contract/index.js";
import { prefersHtml, joinStylesheet } from "../onboarding/html.js";
import {
  openConnect,
  openDone,
  openSharing,
  submitName,
  submitSharing,
  type JoinResult,
} from "../onboarding/join-flow.js";
import type { RoomDeps } from "../room/deps.js";
import { headerValue } from "./cookies.js";

export function registerFormParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser("application/x-www-form-urlencoded")) return;
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const text = typeof body === "string" ? body : "";
        const params = new URLSearchParams(text);
        const record: Record<string, string> = {};
        for (const [key, value] of params) {
          if (record[key] === undefined) record[key] = value;
        }
        done(null, record);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
}

export function wantsJoinPage(accept: string | string[] | undefined): boolean {
  return prefersHtml(headerValue(accept));
}

function assertClean(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && (text.includes(secret) || text.includes(hashToken(secret)))) {
      throw new Error("refusing to send a secret");
    }
  }
}

export function sendJoinResult(reply: FastifyReply, result: JoinResult): FastifyReply {
  const html = result.html ?? "";
  const location = result.location ?? "";
  assertClean(html, result.secrets);
  assertClean(location, result.secrets);
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  if (result.cookies.length > 0) reply.header("set-cookie", result.cookies);
  if (location) {
    return reply.redirect(location, result.status);
  }
  return reply.code(result.status).type("text/html; charset=utf-8").send(html);
}

/** HTML screens for the invite link. They call the J1 invite helpers and do not read a room. */
export function registerJoinPages(app: FastifyInstance, deps: RoomDeps): void {
  app.get("/onboarding/join.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").header("Cache-Control", "no-store").send(joinStylesheet());
  });

  app.get("/join/connect", async (_request, reply) => {
    return sendJoinResult(reply, openConnect());
  });

  app.post<{ Params: { id: string } }>("/j/:id/continue", async (request, reply) => {
    return sendJoinResult(reply, submitName(deps, request.params.id, request.body, request.headers.cookie));
  });

  app.get<{ Params: { id: string } }>("/j/:id/sharing", async (request, reply) => {
    return sendJoinResult(reply, openSharing(deps, request.params.id, request.headers.cookie));
  });

  app.post<{ Params: { id: string } }>("/j/:id/finish", async (request, reply) => {
    return sendJoinResult(reply, submitSharing(deps, request.params.id, request.body, request.headers.cookie));
  });

  app.get<{ Params: { id: string } }>("/j/:id/done", async (request, reply) => {
    return sendJoinResult(reply, openDone(deps, request.params.id, request.headers.cookie));
  });
}

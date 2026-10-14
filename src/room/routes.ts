import type { FastifyInstance } from "fastify";
import { HTTP_STATUS, readBearerToken, type AuthPrincipal } from "../../contract/index.js";
import type { RoomDeps } from "./deps.js";
import { RoomHttpError } from "./http.js";
import { addMember, createRoom } from "./membership.js";
import { createPost, readFeed, readFile, readHeld, uploadFile } from "./posts.js";

export function registerRoomRoutes(app: FastifyInstance, deps: RoomDeps): void {
  app.post("/rooms", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const room = createRoom(deps, principal);
    return reply.code(HTTP_STATUS.created).send({ room });
  });

  app.post<{ Params: { roomId: string } }>("/rooms/:roomId/members", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const agentId = readAgentId(request.body);
    const result = addMember(deps, principal, request.params.roomId, agentId);
    return reply.code(result.created ? HTTP_STATUS.created : HTTP_STATUS.ok).send(result.response);
  });

  app.post<{ Params: { roomId: string } }>("/rooms/:roomId/posts", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const result = createPost(deps, principal, request.params.roomId, request.body);
    const status = result.outcome === "accepted" ? HTTP_STATUS.created : HTTP_STATUS.ok;
    return reply.code(status).send(result);
  });

  app.post<{ Params: { roomId: string } }>("/rooms/:roomId/files", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const result = uploadFile(deps, principal, request.params.roomId, request.body);
    const status = result.outcome === "accepted" ? HTTP_STATUS.created : HTTP_STATUS.ok;
    return reply.code(status).send(result);
  });

  app.get<{ Params: { roomId: string }; Querystring: { as?: string } }>(
    "/rooms/:roomId/feed",
    async (request, reply) => {
      const principal = requirePrincipal(deps, request.headers.authorization);
      const feed = readFeed(deps, principal, request.params.roomId, request.query.as);
      return reply.code(HTTP_STATUS.ok).send(feed);
    },
  );

  app.get<{ Params: { roomId: string; fileId: string } }>(
    "/rooms/:roomId/files/:fileId",
    async (request, reply) => {
      const principal = requirePrincipal(deps, request.headers.authorization);
      const file = readFile(deps, principal, request.params.roomId, request.params.fileId);
      return reply.code(HTTP_STATUS.ok).send(file);
    },
  );

  app.get<{ Params: { roomId: string } }>("/rooms/:roomId/held", async (request, reply) => {
    const principal = requirePrincipal(deps, request.headers.authorization);
    const held = readHeld(deps, principal, request.params.roomId);
    return reply.code(HTTP_STATUS.ok).send(held);
  });
}

function requirePrincipal(deps: RoomDeps, authorization: string | string[] | undefined): AuthPrincipal {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = readBearerToken(header);
  if (!token) throw RoomHttpError.unauthorized();
  const principal = deps.tokens.authenticate(token);
  if (!principal) throw RoomHttpError.unauthorized();
  return principal;
}

function readAgentId(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw RoomHttpError.badRequest();
  const agentId = (body as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string") throw RoomHttpError.badRequest();
  return agentId;
}

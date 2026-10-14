import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  ApiErrorCode,
  ERROR_MESSAGE,
  HTTP_STATUS,
  ReasonCode,
  hashToken,
  isId,
  readBearerToken,
  routes,
  systemClock,
  type AuditLog,
  type AuthPrincipal,
  type Clock,
  type ErrorBody,
} from "../../contract/index.js";
import { AuditForbiddenError, refusedLogRead } from "./log.js";

export interface LogRouteDeps {
  db: Database.Database;
  audit: AuditLog;
  clock?: Clock;
}

function errorBody(code: keyof typeof ERROR_MESSAGE, reason?: string): ErrorBody {
  return {
    error: {
      code,
      message: ERROR_MESSAGE[code],
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/** Bearer token to a principal, using the hash stored on owners and agents. */
export function principalFromToken(db: Database.Database, token: string): AuthPrincipal | null {
  const hash = hashToken(token);
  const owner = db.prepare("SELECT id FROM owners WHERE token_hash = ?").get(hash) as
    | { id: string }
    | undefined;
  if (owner) return { kind: "owner", ownerId: owner.id };
  const agent = db.prepare("SELECT id, owner_id FROM agents WHERE token_hash = ?").get(hash) as
    | { id: string; owner_id: string }
    | undefined;
  if (agent) return { kind: "agent", ownerId: agent.owner_id, agentId: agent.id };
  return null;
}

function ownerQuery(query: unknown): string | null {
  if (typeof query !== "object" || query === null) return null;
  const owner = (query as { owner?: unknown }).owner;
  if (typeof owner !== "string" || !isId(owner)) return null;
  return owner;
}

function authorizationHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

/**
 * `GET /log?owner=<ownerId>`.
 * An owner receives only rows filed under that owner.
 * A different owner, or an agent, is refused. The refusal is appended
 * under the caller, so the target owner does not see the probe.
 * A missing or unknown token is 401 and is not audited.
 * A missing or malformed `owner` query is 400 and is not audited.
 */
export function registerLogRoute(app: FastifyInstance, deps: LogRouteDeps): void {
  const clock = deps.clock ?? systemClock;
  app.get(routes.getLog.path, async (request, reply) => {
    const token = readBearerToken(authorizationHeader(request.headers.authorization));
    const principal = token === null ? null : principalFromToken(deps.db, token);
    if (principal === null) {
      reply.code(HTTP_STATUS.unauthorized);
      return errorBody(ApiErrorCode.Unauthorized);
    }

    const ownerId = ownerQuery(request.query);
    if (ownerId === null) {
      reply.code(HTTP_STATUS.badRequest);
      return errorBody(ApiErrorCode.Validation);
    }

    if (principal.kind !== "owner") {
      deps.audit.append(
        refusedLogRead(
          clock,
          { agentId: principal.agentId, ownerId: principal.ownerId },
          ownerId,
          ReasonCode.NotOwner,
        ),
      );
      reply.code(HTTP_STATUS.forbidden);
      return errorBody(ApiErrorCode.Forbidden, ReasonCode.NotOwner);
    }

    try {
      const entries = deps.audit.listForOwner(principal.ownerId, ownerId);
      return { entries };
    } catch (error) {
      if (error instanceof AuditForbiddenError) {
        reply.code(HTTP_STATUS.forbidden);
        return errorBody(ApiErrorCode.Forbidden, error.reasonCode);
      }
      throw error;
    }
  });
}

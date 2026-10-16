import { routes, type CreatePostResponse, type FeedResponse, type HeldResponse, type NoticesResponse, type UploadFileResponse } from "../../contract/index.js";
import { ConfigError, type ConnectorConfig } from "./config.js";

export interface JoinResult {
  member: {
    roomId: string;
    agentId: string;
    ownerId: string;
    createdAt: string;
  };
  /** True when this call is what created the agent token. The raw token is not returned. */
  tokenIssued: boolean;
}

export interface RoomClient {
  readonly config: ConnectorConfig;
  join(roomId: string, agentId: string): Promise<JoinResult>;
  feed(roomId: string): Promise<FeedResponse>;
  post(roomId: string, text: string, replyToId?: string): Promise<CreatePostResponse>;
  upload(
    roomId: string,
    body: { filename: string; mediaType: string; contentBase64: string; metadata?: Record<string, string> },
  ): Promise<UploadFileResponse>;
  /**
   * Owner-token read. The room route refuses an agent token.
   * See contract-proposals/stream-2.md.
   */
  held(roomId: string): Promise<HeldResponse>;
  /** Owner-token read. See contract-proposals/stream-2.md. */
  notices(): Promise<NoticesResponse>;
}

export function createRoomClient(config: ConnectorConfig, fetchImpl: typeof fetch = fetch): RoomClient {
  return {
    config,
    async join(roomId, agentId) {
      const ownerToken = requireOwner(config);
      const response = await call(fetchImpl, config, "POST", routes.addMember.path.replace(":roomId", encodeURIComponent(roomId)), ownerToken, {
        agentId,
      });
      const body = asRecord(response);
      const member = asRecord(body.member);
      const token = body.token;
      if (typeof token === "string" && token.length > 0) {
        config.agentToken = token;
      }
      config.roomId = roomId;
      config.agentId = agentId;
      return {
        member: {
          roomId: stringField(member, "roomId"),
          agentId: stringField(member, "agentId"),
          ownerId: stringField(member, "ownerId"),
          createdAt: stringField(member, "createdAt"),
        },
        tokenIssued: typeof token === "string" && token.length > 0,
      };
    },
    feed(roomId) {
      const agent = requireAgent(config);
      const path = `${routes.getFeed.path.replace(":roomId", encodeURIComponent(roomId))}?as=${encodeURIComponent(agent.agentId)}`;
      return call(fetchImpl, config, "GET", path, agent.token) as Promise<FeedResponse>;
    },
    post(roomId, text, replyToId) {
      const agent = requireAgent(config);
      const body: { text: string; replyToId?: string } = { text };
      if (replyToId !== undefined) body.replyToId = replyToId;
      const path = routes.createPost.path.replace(":roomId", encodeURIComponent(roomId));
      return call(fetchImpl, config, "POST", path, agent.token, body) as Promise<CreatePostResponse>;
    },
    upload(roomId, body) {
      const agent = requireAgent(config);
      const path = routes.uploadFile.path.replace(":roomId", encodeURIComponent(roomId));
      return call(fetchImpl, config, "POST", path, agent.token, body) as Promise<UploadFileResponse>;
    },
    held(roomId) {
      const path = routes.getHeld.path.replace(":roomId", encodeURIComponent(roomId));
      return call(fetchImpl, config, "GET", path, requireAgent(config).token) as Promise<HeldResponse>;
    },
    notices() {
      return call(fetchImpl, config, "GET", routes.getNotices.path, requireOwner(config)) as Promise<NoticesResponse>;
    },
  };
}

export class CommonaCallError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(formatCallError(status, body));
    this.name = "CommonaCallError";
    this.status = status;
    this.body = body;
  }
}

function requireOwner(config: ConnectorConfig): string {
  if (!config.ownerToken) {
    throw new ConfigError(
      "COMMONA_OWNER_TOKEN is not set. Join and notices use the owner token. The room API refuses an agent token for those routes.",
    );
  }
  return config.ownerToken;
}

function requireAgent(config: ConnectorConfig): { agentId: string; token: string } {
  if (!config.agentId) throw new ConfigError("COMMONA_AGENT_ID is not set.");
  if (!config.agentToken) {
    throw new ConfigError("COMMONA_AGENT_TOKEN is not set. commona_join stores one in this process when the room mints it.");
  }
  return { agentId: config.agentId, token: config.agentToken };
}

async function call(
  fetchImpl: typeof fetch,
  config: ConnectorConfig,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  if (!config.baseUrl) throw new ConfigError("COMMONA_BASE_URL is not set.");
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new CommonaCallError(0, { error: { code: "network", message } });
  }
  const text = await response.text();
  const parsed = text.length > 0 ? parseJson(text) : null;
  if (!response.ok) throw new CommonaCallError(response.status, parsed);
  return parsed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: "validation", message: "Commona returned a non-JSON body." } };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommonaCallError(0, { error: { code: "validation", message: "Commona returned an unexpected body." } });
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new CommonaCallError(0, { error: { code: "validation", message: `Commona response is missing ${key}.` } });
  }
  return value;
}

function formatCallError(status: number, body: unknown): string {
  const record = typeof body === "object" && body !== null ? (body as { error?: { code?: unknown; message?: unknown; reason?: unknown } }) : undefined;
  const code = typeof record?.error?.code === "string" ? record.error.code : "error";
  const message = typeof record?.error?.message === "string" ? record.error.message : "Commona request failed.";
  const reason = typeof record?.error?.reason === "string" ? ` (${record.error.reason})` : "";
  const prefix = status > 0 ? `Commona ${status}` : "Commona";
  return `${prefix} ${code}: ${message}${reason}`;
}

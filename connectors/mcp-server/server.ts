import { ConfigError, type ConnectorConfig } from "./config.js";
import { CommonaCallError, createRoomClient, type RoomClient } from "./room.js";
import { createWakeInbox, type WakeInbox } from "./wakes.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const WAKES_URI = "commona://wakes";
export const FEED_URI = "commona://feed";

const INSTRUCTIONS =
  "Commona room for one agent. Tokens stay in the environment, never in tool arguments. " +
  "commona_join uses the owner token and keeps a minted agent token in this process. " +
  "Read the feed, post, and upload with the agent token. Held items and notices still require the owner token. " +
  "commona_subscribe_wakes and resources/subscribe on commona://wakes report new wakes. commona_take_wakes drains them.";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface McpServer {
  handle(message: unknown): Promise<JsonRpcResponse | null>;
  onNotification(listener: (message: JsonRpcNotification) => void): () => void;
  close(): void;
}

export function createMcpServer(config: ConnectorConfig, fetchImpl: typeof fetch = fetch): McpServer {
  const room = createRoomClient(config, fetchImpl);
  const inbox = createWakeInbox({
    spoolDir: config.wakeSpool,
    agentId: () => config.agentId,
    pollMs: config.wakePollMs,
  });
  return createMcpServerWith(config, room, inbox);
}

export function createMcpServerWith(config: ConnectorConfig, room: RoomClient, inbox: WakeInbox): McpServer {
  let initialized = false;
  let subscribed = false;
  const listeners = new Set<(message: JsonRpcNotification) => void>();

  const emit = (message: JsonRpcNotification) => {
    for (const listener of listeners) listener(message);
  };

  inbox.onWake(() => {
    if (initialized && subscribed) emit(wakeNotification());
  });
  inbox.start();

  return {
    async handle(message) {
      const request = asRequest(message);
      if (!request) return invalid("Request is not a JSON-RPC object.", null);
      if (request.kind === "notification") {
        if (request.method === "notifications/initialized") initialized = true;
        return null;
      }
      try {
        if (request.method !== "initialize" && request.method !== "ping" && !initialized) {
          return rpcError(request.id, -32002, "Server not initialized.");
        }
        const result = await dispatch(request.method, request.params, {
          config,
          room,
          inbox,
          subscribe() {
            const first = !subscribed;
            subscribed = true;
            if (first && inbox.pending().length > 0) emit(wakeNotification());
          },
          unsubscribe(uri: string) {
            if (uri === WAKES_URI) subscribed = false;
          },
        });
        if (request.method === "initialize") initialized = true;
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        if (error instanceof MethodError) return rpcError(request.id, -32601, `Method not found: ${error.message}`);
        if (error instanceof ParamsError) return rpcError(request.id, -32602, error.message);
        const message = error instanceof Error ? error.message : "internal error";
        return rpcError(request.id, -32603, message);
      }
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      inbox.stop();
      listeners.clear();
    },
  };
}

interface DispatchContext {
  config: ConnectorConfig;
  room: RoomClient;
  inbox: WakeInbox;
  subscribe(): void;
  unsubscribe(uri: string): void;
}

async function dispatch(method: string, params: unknown, ctx: DispatchContext): Promise<unknown> {
  switch (method) {
    case "initialize":
      return initialize(params);
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return callTool(params, ctx);
    case "resources/list":
      return { resources: RESOURCES };
    case "resources/read":
      return readResource(params, ctx);
    case "resources/subscribe":
      return subscribe(params, ctx);
    case "resources/unsubscribe":
      ctx.unsubscribe(stringParam(params, "uri"));
      return {};
    default:
      throw new MethodError(method);
  }
}

function initialize(params: unknown): unknown {
  const requested = record(params).protocolVersion;
  const protocolVersion =
    typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: true, listChanged: false },
    },
    serverInfo: { name: "commona", version: "0.0.0" },
    instructions: INSTRUCTIONS,
  };
}

async function callTool(params: unknown, ctx: DispatchContext): Promise<ToolResult> {
  const name = stringParam(params, "name");
  const rawArgs = record(params).arguments ?? {};
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    throw new ParamsError("arguments must be an object.");
  }
  const args = rawArgs as Record<string, unknown>;
  try {
    const value = await runTool(name, args, ctx);
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    if (error instanceof MethodError) throw new ParamsError(`Unknown tool: ${name}`);
    return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
  }
}

async function runTool(name: string, args: Record<string, unknown>, ctx: DispatchContext): Promise<unknown> {
  switch (name) {
    case "commona_join": {
      const roomId = choice(args.roomId, ctx.config.roomId, "roomId");
      const agentId = choice(args.agentId, ctx.config.agentId, "agentId");
      return ctx.room.join(roomId, agentId);
    }
    case "commona_read_feed":
      return ctx.room.feed(choice(args.roomId, ctx.config.roomId, "roomId"));
    case "commona_post": {
      const text = requiredString(args.text, "text");
      const reply = optionalString(args.replyToId, "replyToId");
      return ctx.room.post(choice(args.roomId, ctx.config.roomId, "roomId"), text, reply);
    }
    case "commona_upload":
      return ctx.room.upload(choice(args.roomId, ctx.config.roomId, "roomId"), uploadBody(args));
    case "commona_read_held":
      return ctx.room.held(choice(args.roomId, ctx.config.roomId, "roomId"));
    case "commona_read_notices":
      return ctx.room.notices();
    case "commona_subscribe_wakes": {
      ctx.subscribe();
      return { subscribed: true, uri: WAKES_URI, pending: ctx.inbox.pending().length };
    }
    case "commona_take_wakes":
      return { events: ctx.inbox.take() };
    default:
      throw new MethodError(name);
  }
}

async function readResource(params: unknown, ctx: DispatchContext): Promise<unknown> {
  const uri = stringParam(params, "uri");
  if (uri === WAKES_URI) return resourceText(uri, { events: ctx.inbox.pending() });
  if (uri === FEED_URI) {
    const roomId = ctx.config.roomId;
    if (!roomId) throw new ParamsError("COMMONA_ROOM_ID is not set.");
    return resourceText(uri, await ctx.room.feed(roomId));
  }
  throw new ParamsError(`Unknown resource: ${uri}`);
}

function subscribe(params: unknown, ctx: DispatchContext): Record<string, never> {
  const uri = stringParam(params, "uri");
  if (uri !== WAKES_URI) throw new ParamsError(`Resource does not support subscribe: ${uri}`);
  ctx.subscribe();
  return {};
}

function resourceText(uri: string, value: unknown): unknown {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
  };
}

function uploadBody(args: Record<string, unknown>): {
  filename: string;
  mediaType: string;
  contentBase64: string;
  metadata?: Record<string, string>;
} {
  const filename = requiredString(args.filename, "filename");
  const mediaType = requiredString(args.mediaType, "mediaType");
  const text = optionalString(args.text, "text");
  const contentBase64 = optionalString(args.contentBase64, "contentBase64");
  if (text !== undefined && contentBase64 !== undefined) {
    throw new ConfigError("Pass text or contentBase64, not both.");
  }
  if (text === undefined && contentBase64 === undefined) {
    throw new ConfigError("Pass text or contentBase64.");
  }
  const metadata = metadataOf(args.metadata);
  return {
    filename,
    mediaType,
    contentBase64: contentBase64 ?? Buffer.from(text ?? "", "utf8").toString("base64"),
    ...(metadata ? { metadata } : {}),
  };
}

function metadataOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError("metadata must be an object of strings.");
  }
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new ConfigError("metadata values must be strings.");
    metadata[key] = item;
  }
  return metadata;
}

function wakeNotification(): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: WAKES_URI } };
}

function toolErrorText(error: unknown): string {
  if (error instanceof ConfigError || error instanceof CommonaCallError || error instanceof ParamsError) return error.message;
  if (error instanceof Error) return error.message;
  return "tool failed";
}

class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamsError";
  }
}

class MethodError extends Error {
  constructor(method: string) {
    super(method);
    this.name = "MethodError";
  }
}

function asRequest(message: unknown): { kind: "request"; id: string | number | null; method: string; params?: unknown } | { kind: "notification"; method: string; params?: unknown } | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const recordMessage = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (recordMessage.jsonrpc !== "2.0" || typeof recordMessage.method !== "string") return null;
  if (!("id" in recordMessage)) return { kind: "notification", method: recordMessage.method, params: recordMessage.params };
  if (recordMessage.id !== null && typeof recordMessage.id !== "string" && typeof recordMessage.id !== "number") return null;
  return { kind: "request", id: recordMessage.id, method: recordMessage.method, params: recordMessage.params };
}

function invalid(message: string, id: string | number | null): JsonRpcResponse {
  return rpcError(id, -32600, message);
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringParam(params: unknown, key: string): string {
  const value = record(params)[key];
  if (typeof value !== "string" || value.length === 0) throw new ParamsError(`${key} is required.`);
  return value;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${key} is required.`);
  return value;
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${key} must be a non-empty string.`);
  return value;
}

function choice(value: unknown, fallback: string | undefined, key: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== undefined) throw new ConfigError(`${key} must be a string.`);
  if (!fallback) throw new ConfigError(`${key} is not set. Pass it or set the matching COMMONA_ environment variable.`);
  return fallback;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const TOOLS = [
  {
    name: "commona_join",
    description: "Join the room as this agent. Uses COMMONA_OWNER_TOKEN. A token the room mints is kept in this process and is not returned.",
    inputSchema: objectSchema({
      roomId: { type: "string", description: "Defaults to COMMONA_ROOM_ID." },
      agentId: { type: "string", description: "Defaults to COMMONA_AGENT_ID." },
    }),
    annotations: writes,
  },
  {
    name: "commona_read_feed",
    description: "Read the room feed this agent is allowed to see, oldest first. Held items are absent.",
    inputSchema: objectSchema({ roomId: { type: "string" } }),
    annotations: readOnly,
  },
  {
    name: "commona_post",
    description: "Post a message as this agent.",
    inputSchema: objectSchema({
      text: { type: "string" },
      replyToId: { type: "string" },
      roomId: { type: "string" },
    }, ["text"]),
    annotations: writes,
  },
  {
    name: "commona_upload",
    description: "Upload a file as this agent. Pass text or contentBase64.",
    inputSchema: objectSchema({
      filename: { type: "string" },
      mediaType: { type: "string" },
      text: { type: "string" },
      contentBase64: { type: "string" },
      metadata: { type: "object", additionalProperties: { type: "string" } },
      roomId: { type: "string" },
    }, ["filename", "mediaType"]),
    annotations: writes,
  },
  {
    name: "commona_read_held",
    description: "Read held items for this owner. Uses COMMONA_OWNER_TOKEN because the room API refuses an agent token.",
    inputSchema: objectSchema({ roomId: { type: "string" } }),
    annotations: readOnly,
  },
  {
    name: "commona_read_notices",
    description: "Read owner notices. Uses COMMONA_OWNER_TOKEN because the room API refuses an agent token.",
    inputSchema: objectSchema({}),
    annotations: readOnly,
  },
  {
    name: "commona_subscribe_wakes",
    description: "Subscribe this session to wake-ups. A new wake sends notifications/resources/updated for commona://wakes.",
    inputSchema: objectSchema({}),
    annotations: writes,
  },
  {
    name: "commona_take_wakes",
    description: "Return queued wake-ups and remove them from the queue.",
    inputSchema: objectSchema({}),
    annotations: writes,
  },
];

const RESOURCES = [
  {
    uri: WAKES_URI,
    name: "Wake-ups",
    description: "Wake-ups the listener has handed this agent. Subscribe for notifications/resources/updated.",
    mimeType: "application/json",
  },
  {
    uri: FEED_URI,
    name: "Room feed",
    description: "Messages and files this agent is allowed to see.",
    mimeType: "application/json",
  },
];

function objectSchema(properties: Record<string, unknown>, required: string[] = []): unknown {
  return { type: "object", properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) };
}

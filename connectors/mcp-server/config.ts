/**
 * Process configuration for one agent.
 * Tokens are read from the environment. Nothing in this module writes them to disk.
 */

export interface ConnectorConfig {
  baseUrl: string;
  roomId?: string;
  agentId?: string;
  agentToken?: string;
  ownerToken?: string;
  /** Directory of per-agent wake files written by the wake listener. */
  wakeSpool?: string;
  wakePollMs: number;
}

const DEFAULT_POLL_MS = 250;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  return {
    baseUrl: stripSlash(optional(env.COMMONA_BASE_URL) ?? ""),
    roomId: optional(env.COMMONA_ROOM_ID),
    agentId: optional(env.COMMONA_AGENT_ID),
    agentToken: optional(env.COMMONA_AGENT_TOKEN),
    ownerToken: optional(env.COMMONA_OWNER_TOKEN),
    wakeSpool: optional(env.COMMONA_WAKE_SPOOL),
    wakePollMs: parsePoll(env.COMMONA_WAKE_POLL_MS),
  };
}

export function requireBaseUrl(config: ConnectorConfig): string {
  if (!config.baseUrl) {
    throw new ConfigError("COMMONA_BASE_URL is not set.");
  }
  return config.baseUrl;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parsePoll(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_POLL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
  return Math.min(60_000, Math.max(20, Math.floor(parsed)));
}

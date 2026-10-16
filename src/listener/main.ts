import { combineHandoffs, commandHandoff, spoolHandoff } from "./handoff.js";
import { startWakeListener } from "./server.js";
import { isDirectRun } from "./run.js";

/**
 * Receive Commona wake webhooks and hand them to the local agent.
 * COMMONA_WAKE_SPOOL is the directory the MCP server polls.
 * COMMONA_WAKE_COMMAND is an executable (no shell) that reads one wake JSON on stdin.
 * COMMONA_WAKE_COMMAND_ARGS is a JSON array of arguments.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const spool = optional(env.COMMONA_WAKE_SPOOL);
  const command = optional(env.COMMONA_WAKE_COMMAND);
  if (!spool && !command) {
    throw new Error("Set COMMONA_WAKE_SPOOL, COMMONA_WAKE_COMMAND, or both.");
  }
  const args = command ? parseArgs(env.COMMONA_WAKE_COMMAND_ARGS) : [];
  const handoff = combineHandoffs(spool ? spoolHandoff(spool) : undefined, command ? commandHandoff(command, args) : undefined);
  const listener = await startWakeListener({
    handoff,
    host: optional(env.COMMONA_WAKE_LISTEN_HOST) ?? "127.0.0.1",
    port: parsePort(env.COMMONA_WAKE_LISTEN_PORT),
  });
  process.stderr.write(`commona wake listener ${listener.url}/wake\n`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      void listener.close().then(() => resolve(), () => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("COMMONA_WAKE_LISTEN_PORT is invalid.");
  return port;
}

function parseArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("COMMONA_WAKE_COMMAND_ARGS must be a JSON array of strings.");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("COMMONA_WAKE_COMMAND_ARGS must be a JSON array of strings.");
  }
  return parsed;
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "wake listener failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

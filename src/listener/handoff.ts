import { spawn } from "node:child_process";
import { isId, type WakeEvent } from "../../contract/index.js";
import { writeSpoolWake } from "./spool.js";

export interface WakeHandoff {
  deliver(event: WakeEvent): Promise<void>;
}

/** Append the wake where the MCP server for that recipient agent polls. */
export function spoolHandoff(spoolDir: string): WakeHandoff {
  return {
    deliver(event) {
      if (!isId(event.recipient.agentId) || !isId(event.wakeId)) {
        return Promise.reject(new Error("wake recipient is not a safe spool name"));
      }
      return writeSpoolWake(spoolDir, event);
    },
  };
}

/**
 * Run a local program with the wake JSON on stdin.
 * No shell. The program should exit quickly; Commona's webhook wait is 5 seconds.
 */
export function commandHandoff(command: string, args: readonly string[] = [], timeoutMs = 4_000): WakeHandoff {
  return {
    deliver(event) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          child.kill();
          finish(new Error(`wake command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(0, 500);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(`wake command exited ${code}: ${stderr}`));
        });
        child.stdin.end(JSON.stringify(event));
      });
    },
  };
}

/**
 * Spool first, then the command.
 * A command failure after a successful spool write is logged and still succeeds,
 * because the MCP inbox already has the wake. A command-only handoff must exit 0.
 */
export function combineHandoffs(spool: WakeHandoff | undefined, command: WakeHandoff | undefined, log: (message: string) => void = console.error): WakeHandoff {
  return {
    async deliver(event) {
      if (spool) await spool.deliver(event);
      if (!command) return;
      try {
        await command.deliver(event);
      } catch (error) {
        if (!spool) throw error;
        const message = error instanceof Error ? error.message : "wake command failed";
        log(`wake command failed after the spool write: ${message}`);
      }
    },
  };
}

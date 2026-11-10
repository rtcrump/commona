import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { isId, type WakeEvent } from "../../contract/index.js";
import { isWakeEvent } from "../../src/listener/spool.js";

export interface WakeInbox {
  start(): void;
  stop(): void;
  pending(): WakeEvent[];
  take(): WakeEvent[];
  /** Used by tests. The listener path is the spool directory. */
  push(event: WakeEvent): void;
  onWake(listener: (event: WakeEvent) => void): () => void;
}

export function createWakeInbox(options: {
  spoolDir?: string;
  agentId: () => string | undefined;
  pollMs: number;
}): WakeInbox {
  const pending: WakeEvent[] = [];
  const seen = new Set<string>();
  const listeners = new Set<(event: WakeEvent) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  function push(event: WakeEvent): void {
    if (seen.has(event.wakeId)) return;
    seen.add(event.wakeId);
    pending.push(event);
    for (const listener of listeners) listener(event);
  }

  async function poll(): Promise<void> {
    if (polling || !options.spoolDir) return;
    const agentId = options.agentId();
    if (!agentId || !isId(agentId)) return;
    polling = true;
    try {
      const dir = path.join(options.spoolDir, agentId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
        const file = path.join(dir, name);
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          if (isEnoent(error)) continue;
          throw error;
        }
        const event = parseStoredWake(text);
        if (!event || event.recipient.agentId !== agentId) continue;
        push(event);
      }
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      void poll();
      timer = setInterval(() => {
        void poll();
      }, options.pollMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    pending() {
      return pending.map(cloneEvent);
    },
    take() {
      const events = pending.splice(0, pending.length).map(cloneEvent);
      if (options.spoolDir) {
        const agentId = options.agentId();
        if (agentId && isId(agentId)) void ackFiles(options.spoolDir, agentId, events);
      }
      return events;
    },
    push,
    onWake(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function ackFiles(spoolDir: string, agentId: string, events: WakeEvent[]): Promise<void> {
  const dir = path.join(spoolDir, agentId);
  const acked = path.join(dir, "acked");
  await mkdir(acked, { recursive: true });
  for (const event of events) {
    if (!isId(event.wakeId)) continue;
    try {
      await rename(path.join(dir, `${event.wakeId}.json`), path.join(acked, `${event.wakeId}.json`));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

function parseStoredWake(text: string): WakeEvent | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isWakeEvent(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function cloneEvent(event: WakeEvent): WakeEvent {
  return JSON.parse(JSON.stringify(event)) as WakeEvent;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcNotification, JsonRpcResponse } from "../../connectors/mcp-server/server.js";

export interface ToolOutcome {
  isError: boolean;
  text: string;
  json: unknown;
}

export class McpStdioClient {
  readonly notifications: JsonRpcNotification[] = [];
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly stderrChunks: string[] = [];
  private buffer = "";
  private nextId = 1;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(env: Record<string, string>) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("COMMONA_")) delete childEnv[key];
    }
    this.child = spawn(process.execPath, ["--import", "tsx", "connectors/mcp-server/stdio.ts"], {
      cwd: process.cwd(),
      env: { ...childEnv, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  stderr(): string {
    return this.stderrChunks.join("");
  }

  async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "commona-test", version: "0" },
    })) as { protocolVersion?: string };
    if (result.protocolVersion !== "2025-06-18") {
      throw new Error(`unexpected protocol ${result.protocolVersion ?? ""}`);
    }
    await this.notify("notifications/initialized");
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
    return { isError: result.isError === true, text, json: parseMaybe(text) };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return;
    }
    if (!("id" in message)) {
      this.notifications.push(message);
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
}

function parseMaybe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

declare module "cloudflare:workers" {
  export interface DurableObjectState {
    storage: unknown;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    waitUntil(promise: Promise<unknown>): void;
  }

  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

declare module "cloudflare:sockets" {
  export function connect(address: { hostname: string; port: number }): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    close(): Promise<void>;
  };
}

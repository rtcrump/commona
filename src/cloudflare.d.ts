declare module "cloudflare:workers" {
  export interface DurableObjectState {
    storage: unknown;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

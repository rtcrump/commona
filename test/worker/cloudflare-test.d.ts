declare module "cloudflare:test" {
  export const SELF: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  export const env: {
    DIRECTORY: {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(request: Request): Promise<Response> };
    };
    COMMONA_HOST_SECRET: string;
  };
  export function runInDurableObject<T>(
    stub: { fetch(request: Request): Promise<Response> },
    callback: (instance: import("../../src/objects/directory.js").DirectoryObject) => T | Promise<T>,
  ): Promise<T>;
}

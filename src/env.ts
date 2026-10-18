/** Bindings the Worker sees. The host secret is a secret binding, not a var in wrangler.toml. */
export interface CommonaEnv {
  DIRECTORY: DirectoryNamespace;
  COMMONA_HOST_SECRET?: string;
  COMMONA_PUBLIC_ORIGIN?: string;
  COMMONA_CONNECT_URL?: string;
}

export interface DirectoryNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DirectoryStub;
}

export interface DirectoryStub {
  fetch(request: Request): Promise<Response>;
}

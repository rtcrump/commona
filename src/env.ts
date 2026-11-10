/** Bindings the Worker sees. The host secret is a secret binding, not a var in wrangler.toml. */
export interface CommonaEnv {
  DIRECTORY: DirectoryNamespace;
  COMMONA_HOST_SECRET?: string;
  COMMONA_PUBLIC_ORIGIN?: string;
  COMMONA_CONNECT_URL?: string;
  /** Both must be set or wake email is not sent. The Worker opens SMTP with a TCP socket, not `node:net`. */
  COMMONA_SMTP_HOST?: string;
  COMMONA_SMTP_PORT?: string;
  /** Exact `1` allows http webhooks for localhost and 127.0.0.1. Off when unset. */
  COMMONA_ALLOW_INSECURE_WEBHOOKS?: string;
}

export interface DirectoryNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DirectoryStub;
}

export interface DirectoryStub {
  fetch(request: Request): Promise<Response>;
}

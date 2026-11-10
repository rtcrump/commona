export type FailureKind = "not-built" | "assertion";

export class AcceptanceFailure extends Error {
  readonly kind: FailureKind;

  constructor(message: string, kind: FailureKind) {
    super(message);
    this.name = "AcceptanceFailure";
    this.kind = kind;
  }
}

export function fail(message: string): never {
  throw new AcceptanceFailure(message, "assertion");
}

export function notBuilt(message: string): never {
  throw new AcceptanceFailure(message, "not-built");
}

export function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function classifyThrown(error: unknown): FailureKind {
  if (error instanceof AcceptanceFailure) return error.kind;
  const message = thrownMessage(error);
  if (/TODO\(/.test(message) || /not implemented/i.test(message)) return "not-built";
  return "assertion";
}

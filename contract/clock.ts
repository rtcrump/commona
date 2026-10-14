export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Audit timestamps and wake `occurredAt` use this form. */
export function formatTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  return date.toISOString();
}

export function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Wake delivery log.
 * Callers pass the signing secret into {@link safeWakeLog} so a line that contains it is dropped.
 * The dropped line does not repeat the secret.
 */
export interface WakeLog {
  info(message: string): void;
  error(message: string): void;
}

export const silentWakeLog: WakeLog = {
  info() {},
  error() {},
};

export function safeWakeLog(
  log: WakeLog,
  secret: string | undefined,
  level: "info" | "error",
  message: string,
): void {
  if (secret && secret.length > 0 && message.includes(secret)) {
    log.error("wake log dropped a line that contained the signing secret");
    return;
  }
  log[level](message);
}

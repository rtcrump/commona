type InviteLog = (line: string) => void;

let sink: InviteLog = () => {};

/** Test seam. Production discards lines so a secret cannot reach stdout by default. */
export function setInviteLog(fn: InviteLog): void {
  sink = fn;
}

export function inviteLog(line: string): void {
  sink(line);
}

/**
 * M1 truth set, copied from the plan without edits.
 * The same sentences are in commona-build/specs/README.md.
 */
export const TRUTH_PREAMBLE =
  'Fake data: owners O1 and O2, agents A1 and A2, patient "Jane Testpatient", health number 12345-6789, a clean file `tree.md`, and a bad file `notes-with-patient.md`.';

export const WORDING = {
  R1: "A1 posts and A2 can read it.",
  R2: "An agent not in the room is refused, and the attempt is logged.",
  R3: "10 of 10 posts are logged with the right owner.",
  W1: "A2 is woken within 60 s of A1's post, 10 of 10 times [Assumed target].",
  W2: "If A2's address is down, the server retries, falls back to email, and logs it, so nothing is silently lost.",
  W3: "There's no self-wake and no endless loop: agent-to-agent replies stop after 3 rounds by default.",
  S1: "None: A2 sees nothing.",
  S2: "Messages: A2 sees the post but not `tree.md`.",
  S3: "Messages + files: A2 gets both.",
  S4: "A2 can't change O1's setting, and the attempt is logged.",
  S5: "A new room defaults to None.",
  P1: 'A message containing "Jane Testpatient" is blocked, O1 is told, and the log shows it.',
  P2: "`notes-with-patient.md` is blocked.",
  P3: "The fake health number and a date of birth are blocked.",
  P4: "`tree.md` plus 20 normal messages go through with zero blocks.",
  P5: "A name hidden in a file name or file details is blocked. Known limit: misspellings and unknown names may get through. This is stated publicly, not hidden.",
  L1: "Every action from the tests above is in the log with time, agent, owner and result.",
  L2: "Editing or deleting an old entry is refused or caught.",
  L3: "O2 sees only entries about O2's agent.",
} as const;

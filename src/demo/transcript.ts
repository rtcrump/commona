/**
 * Scripted public story. Every person, assistant, and sentence is fictional.
 * The room core test replays the same sentences through ordinary posts and
 * per-owner sharing approvals. This module does not open a room.
 */

export const DEMO_LABEL = "Scripted demo, fake data, no account needed";

export const DEMO_LIMITATION =
  "This is a scripted replay with fictional people. No model is answering, and this is not a live conversation.";

export const DEMO_TASK = "Find one time and place for a short walk.";

export const DEMO_MESSAGES = {
  larkOffer:
    "Shall we find one time for a short walk? Saturday at 10:00, the east park gate, would be lovely.",
  reedOffer: "Saturday at 10:00 at the east park gate suits us. I will bring a thermos.",
  agreement: "Then we are set. Saturday at 10:00, east park gate.",
  reportToNia:
    "Agreed with Sol's assistant Reed: Saturday at 10:00, east park gate. Nothing is still open.",
  reportToSol:
    "Agreed with Nia's assistant Lark: Saturday at 10:00, east park gate. Nothing is still open.",
} as const;

export type DemoMessageId = keyof typeof DEMO_MESSAGES;

export type DemoPerson = "nia" | "sol";

export interface StoryStep {
  id: string;
  atMs: number;
  heading: string;
  paragraphs: readonly string[];
  tone: "scene" | "note" | "approval" | "agreement" | "report";
  owner: DemoPerson | "both";
}

/** Replay finishes on the last step. Kept under twenty seconds. */
export const STORY_STEPS: readonly StoryStep[] = [
  {
    id: "welcome",
    atMs: 0,
    heading: "Two people, two assistants",
    paragraphs: [
      "Nia brings Lark. Sol brings Reed. They want to plan one short walk.",
      "Sharing is closed. Each person can see only their own assistant.",
    ],
    tone: "scene",
    owner: "both",
  },
  {
    id: "lark-offer",
    atMs: 1_500,
    heading: "Lark writes to Nia",
    paragraphs: [DEMO_MESSAGES.larkOffer, "Sol cannot see Lark's note yet."],
    tone: "note",
    owner: "nia",
  },
  {
    id: "nia-approval",
    atMs: 3_000,
    heading: "Nia approves sharing messages with Sol.",
    paragraphs: [
      "Nia allows messages with Sol. Sol can now read Lark's note.",
      "Nia still cannot read Sol's side. Reed has not been shared yet.",
    ],
    tone: "approval",
    owner: "nia",
  },
  {
    id: "reed-offer",
    atMs: 4_500,
    heading: "Reed writes to Sol",
    paragraphs: [DEMO_MESSAGES.reedOffer, "Nia cannot see Reed's note yet."],
    tone: "note",
    owner: "sol",
  },
  {
    id: "sol-approval",
    atMs: 6_500,
    heading: "Sol approves sharing messages with Nia.",
    paragraphs: [
      "Sol allows messages with Nia. Both notes are shared.",
      "Each assistant can now read the other person's offer.",
    ],
    tone: "approval",
    owner: "sol",
  },
  {
    id: "agreement",
    atMs: 8_000,
    heading: "The walk is agreed.",
    paragraphs: [DEMO_MESSAGES.agreement, "One task is finished: one time, one place."],
    tone: "agreement",
    owner: "both",
  },
  {
    id: "report-nia",
    atMs: 10_000,
    heading: "Lark reports to Nia",
    paragraphs: [DEMO_MESSAGES.reportToNia],
    tone: "report",
    owner: "nia",
  },
  {
    id: "report-sol",
    atMs: 12_000,
    heading: "Reed reports to Sol",
    paragraphs: [DEMO_MESSAGES.reportToSol],
    tone: "report",
    owner: "sol",
  },
];

export const STORY_DURATION_MS = STORY_STEPS[STORY_STEPS.length - 1]?.atMs ?? 0;

export interface VisibilityCheckpoint {
  posted: readonly DemoMessageId[];
  approvals: readonly DemoPerson[];
  niaSees: readonly DemoMessageId[];
  solSees: readonly DemoMessageId[];
}

/**
 * What each owner can read after each core step.
 * Sharing is directional: a person sees the other side only after that
 * other person approves messages.
 */
export const VISIBILITY_CHECKPOINTS: readonly VisibilityCheckpoint[] = [
  {
    posted: ["larkOffer"],
    approvals: [],
    niaSees: ["larkOffer"],
    solSees: [],
  },
  {
    posted: ["larkOffer"],
    approvals: ["nia"],
    niaSees: ["larkOffer"],
    solSees: ["larkOffer"],
  },
  {
    posted: ["larkOffer", "reedOffer"],
    approvals: ["nia"],
    niaSees: ["larkOffer"],
    solSees: ["larkOffer", "reedOffer"],
  },
  {
    posted: ["larkOffer", "reedOffer"],
    approvals: ["nia", "sol"],
    niaSees: ["larkOffer", "reedOffer"],
    solSees: ["larkOffer", "reedOffer"],
  },
  {
    posted: ["larkOffer", "reedOffer", "agreement", "reportToNia", "reportToSol"],
    approvals: ["nia", "sol"],
    niaSees: ["larkOffer", "reedOffer", "agreement", "reportToNia", "reportToSol"],
    solSees: ["larkOffer", "reedOffer", "agreement", "reportToNia", "reportToSol"],
  },
];

export function storySentences(): string[] {
  const sentences = [DEMO_LABEL, DEMO_LIMITATION, DEMO_TASK];
  for (const step of STORY_STEPS) {
    sentences.push(step.heading);
    sentences.push(...step.paragraphs);
  }
  return sentences;
}

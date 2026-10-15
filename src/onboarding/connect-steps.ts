/** The person's actions, in order. Claude menu clicks stay inside the paste step. */
export interface ConnectStep {
  text: string;
  /** True when nobody has clicked this on a real Claude account. */
  unverified: boolean;
}

export const CONNECT_OWNER_ACTIONS: readonly ConnectStep[] = [
  { text: "Click Copy my link.", unverified: false },
  {
    text: "On claude.ai or in Claude Desktop, open Customize, then Connectors, then + Add, then Add custom connector, and paste the link.",
    unverified: true,
  },
  {
    text: "Turn it on in the chat with +, then Connectors, come back to this page, and click Check connection.",
    unverified: true,
  },
];

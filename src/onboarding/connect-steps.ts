/** The person's actions, in order. Claude menu clicks stay inside the paste step. */
export interface ConnectStep {
  text: string;
  /** True when nobody has clicked this on a real Claude account. */
  unverified: boolean;
}

export const CONNECT_OWNER_ACTIONS: readonly ConnectStep[] = [
  { text: "Click Copy my link.", unverified: false },
  {
    text: "In Claude, open Settings, then Connectors, then Add custom connector, and paste the link.",
    unverified: true,
  },
  {
    text: "Click Connect, come back to this page, and click Check connection.",
    unverified: true,
  },
];

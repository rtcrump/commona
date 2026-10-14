import type { WakeAddress } from "./wake.js";

export interface OwnerFixture {
  id: string;
  email: string;
  displayName: string;
  role: "participant" | "outsider";
}

export interface AgentFixture {
  id: string;
  ownerId: string;
  displayName: string;
  roomMember: boolean;
  wake: WakeAddress;
}

export interface FixturePack {
  owners: OwnerFixture[];
  agents: AgentFixture[];
  /** Clean question tree. */
  tree: string;
  /** Invented note that the name block must hold. */
  notesWithPatient: string;
  /** Name list. The first non-empty line is the primary invented patient name. */
  names: string[];
  /** Exactly 20 ordinary messages. */
  normalMessages: string[];
}

import type { AuthPrincipal, TokenStore } from "../../contract/index.js";
import { todo } from "../todo.js";

/** T2. Critical core: bearer tokens for owners and agents. */
export const tokens: TokenStore = {
  issueOwnerToken(_ownerId: string): string {
    return todo("auth");
  },
  issueAgentToken(_agentId: string): string {
    return todo("auth");
  },
  authenticate(_token: string): AuthPrincipal | null {
    return todo("auth");
  },
};

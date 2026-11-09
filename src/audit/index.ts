import type { AuditAppendInput, AuditLog, AuditRecord, AuditVerifyResult } from "../../contract/index.js";
import { todo } from "../todo.js";

/** T1. Critical core: append-only audit log. */
export const audit: AuditLog = {
  append(_input: AuditAppendInput): AuditRecord {
    return todo("audit");
  },
  verify(): AuditVerifyResult {
    return todo("audit");
  },
  listForOwner(_requesterOwnerId: string, _ownerId: string): AuditRecord[] {
    return todo("audit");
  },
};

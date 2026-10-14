import {
  AuditAction,
  AuditResult,
  ownerActorId,
  type AgentFixture,
  type ExpectedLogRow,
} from "../../contract/index.js";
import type { Ctx } from "./ctx.js";
import { fail } from "./failure.js";

export function fixtureAgent(ctx: Ctx, agentId: string): AgentFixture {
  const found = ctx.pack.agents.find((agent) => agent.id === agentId);
  if (!found) fail(`fixture has no agent ${agentId}`);
  return found;
}

export function ownerEmail(ctx: Ctx, ownerId: string): string {
  const found = ctx.pack.owners.find((owner) => owner.id === ownerId);
  if (!found) fail(`fixture has no owner ${ownerId}`);
  return found.email;
}

export function joined(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Join,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function posted(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Post,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function uploaded(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Upload,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function readRow(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Read,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function woke(ctx: Ctx, recipientAgentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Wake,
    agentId: recipientAgentId,
    ownerId: fixtureAgent(ctx, recipientAgentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function wakeRetry(ctx: Ctx, recipientAgentId: string): ExpectedLogRow {
  return {
    action: AuditAction.WakeRetry,
    agentId: recipientAgentId,
    ownerId: fixtureAgent(ctx, recipientAgentId).ownerId,
    result: AuditResult.Retried,
  };
}

export function wakeFallback(ctx: Ctx, recipientAgentId: string): ExpectedLogRow {
  return {
    action: AuditAction.WakeFallbackEmail,
    agentId: recipientAgentId,
    ownerId: fixtureAgent(ctx, recipientAgentId).ownerId,
    result: AuditResult.FellBack,
  };
}

export function wakeFailed(ctx: Ctx, recipientAgentId: string): ExpectedLogRow {
  return {
    action: AuditAction.WakeFailed,
    agentId: recipientAgentId,
    ownerId: fixtureAgent(ctx, recipientAgentId).ownerId,
    result: AuditResult.Failed,
  };
}

export function blocked(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.Block,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Blocked,
  };
}

export function settingChanged(ownerId: string): ExpectedLogRow {
  return {
    action: AuditAction.SettingChange,
    agentId: ownerActorId(ownerId),
    ownerId,
    result: AuditResult.Ok,
  };
}

export function settingRefused(agentId: string, ownerId: string): ExpectedLogRow {
  return {
    action: AuditAction.SettingChangeRefused,
    agentId,
    ownerId,
    result: AuditResult.Refused,
  };
}

export function joinRefused(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.JoinRefused,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Refused,
  };
}

export function loopStopped(ctx: Ctx, agentId: string): ExpectedLogRow {
  return {
    action: AuditAction.LoopStop,
    agentId,
    ownerId: fixtureAgent(ctx, agentId).ownerId,
    result: AuditResult.Ok,
  };
}

export function ordinary(ctx: Ctx, index = 0): string {
  const text = ctx.pack.normalMessages[index];
  if (!text) fail(`normal message ${index} is missing`);
  return text;
}

/** Three failed attempts are retried. The fourth attempt falls through to email. */
export function retriedAttempts(ctx: Ctx, recipientAgentId: string): ExpectedLogRow[] {
  return [wakeRetry(ctx, recipientAgentId), wakeRetry(ctx, recipientAgentId), wakeRetry(ctx, recipientAgentId)];
}

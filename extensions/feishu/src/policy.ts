import type { AllowlistMatch, ChannelGroupContext, GroupPolicy, GroupToolPolicyConfig } from "clawdbot/plugin-sdk";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveMentionGatingWithBypass,
  resolveNestedAllowlistDecision,
} from "clawdbot/plugin-sdk";

import type { FeishuChatConfig } from "./types.js";

function normalizeFeishuAllowEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(feishu|lark):/i, "")
    .replace(/^(user|open|chat):/i, "");
}

export function normalizeFeishuAllowlist(values: Array<string | number> | undefined): string[] {
  return (values ?? []).map((value) => normalizeFeishuAllowEntry(String(value))).filter(Boolean);
}

export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number> | undefined;
  senderId: string;
  senderUserId?: string | null;
  senderName?: string | null;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = normalizeFeishuAllowlist(params.allowFrom);
  if (allowFrom.length === 0) return { allowed: false };
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const candidates = [
    params.senderId,
    params.senderUserId ?? "",
  ]
    .map((value) => normalizeFeishuAllowEntry(String(value)))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (allowFrom.includes(candidate)) {
      return { allowed: true, matchKey: candidate, matchSource: "id" };
    }
  }

  const senderName = params.senderName ? normalizeFeishuAllowEntry(params.senderName) : "";
  if (senderName && allowFrom.includes(senderName)) {
    return { allowed: true, matchKey: senderName, matchSource: "name" };
  }

  return { allowed: false };
}

export type FeishuChatMatch = {
  chatConfig?: FeishuChatConfig;
  wildcardConfig?: FeishuChatConfig;
  chatKey?: string;
  matchSource?: "direct" | "parent" | "wildcard";
  allowed: boolean;
  allowlistConfigured: boolean;
};

export function resolveFeishuChatMatch(params: {
  chats?: Record<string, FeishuChatConfig>;
  chatId: string;
  chatName?: string | null;
}): FeishuChatMatch {
  const chats = params.chats ?? {};
  const allowlistConfigured = Object.keys(chats).length > 0;
  const chatName = params.chatName?.trim() || undefined;
  const candidates = buildChannelKeyCandidates(
    params.chatId,
    chatName,
    chatName ? normalizeChannelSlug(chatName) : undefined,
  );
  const match = resolveChannelEntryMatchWithFallback({
    entries: chats,
    keys: candidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });

  const chatConfig = match.entry;
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(chatConfig),
    innerConfigured: false,
    innerMatched: false,
  });

  return {
    chatConfig,
    wildcardConfig: match.wildcardEntry,
    chatKey: match.matchKey ?? match.key,
    matchSource: match.matchSource,
    allowed,
    allowlistConfigured,
  };
}

export function resolveFeishuGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg as {
    channels?: { feishu?: { chats?: Record<string, FeishuChatConfig> } };
  };
  const chatId = params.groupId?.trim();
  if (!chatId) return undefined;
  const chatName = params.groupChannel?.trim() || undefined;
  const match = resolveFeishuChatMatch({
    chats: cfg.channels?.feishu?.chats,
    chatId,
    chatName,
  });
  return match.chatConfig?.tools ?? match.wildcardConfig?.tools;
}

export function resolveFeishuRequireMention(params: {
  chatConfig?: FeishuChatConfig;
  wildcardConfig?: FeishuChatConfig;
}): boolean {
  if (typeof params.chatConfig?.requireMention === "boolean") {
    return params.chatConfig.requireMention;
  }
  if (typeof params.wildcardConfig?.requireMention === "boolean") {
    return params.wildcardConfig.requireMention;
  }
  return true;
}

export function resolveFeishuGroupAllow(params: {
  groupPolicy: GroupPolicy;
  outerAllowFrom: Array<string | number> | undefined;
  innerAllowFrom: Array<string | number> | undefined;
  senderId: string;
  senderUserId?: string | null;
  senderName?: string | null;
}): { allowed: boolean; outerMatch: AllowlistMatch; innerMatch: AllowlistMatch } {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, outerMatch: { allowed: false }, innerMatch: { allowed: false } };
  }
  if (params.groupPolicy === "open") {
    return { allowed: true, outerMatch: { allowed: true }, innerMatch: { allowed: true } };
  }

  const outerAllow = normalizeFeishuAllowlist(params.outerAllowFrom);
  const innerAllow = normalizeFeishuAllowlist(params.innerAllowFrom);
  if (outerAllow.length === 0 && innerAllow.length === 0) {
    return { allowed: false, outerMatch: { allowed: false }, innerMatch: { allowed: false } };
  }

  const outerMatch = resolveFeishuAllowlistMatch({
    allowFrom: params.outerAllowFrom,
    senderId: params.senderId,
    senderUserId: params.senderUserId,
    senderName: params.senderName,
  });
  const innerMatch = resolveFeishuAllowlistMatch({
    allowFrom: params.innerAllowFrom,
    senderId: params.senderId,
    senderUserId: params.senderUserId,
    senderName: params.senderName,
  });
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
    outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
    innerConfigured: innerAllow.length > 0,
    innerMatched: innerMatch.allowed,
  });

  return { allowed, outerMatch, innerMatch };
}

export function resolveFeishuMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; shouldBypassMention: boolean } {
  const result = resolveMentionGatingWithBypass({
    isGroup: params.isGroup,
    requireMention: params.requireMention,
    canDetectMention: true,
    wasMentioned: params.wasMentioned,
    allowTextCommands: params.allowTextCommands,
    hasControlCommand: params.hasControlCommand,
    commandAuthorized: params.commandAuthorized,
  });
  return { shouldSkip: result.shouldSkip, shouldBypassMention: result.shouldBypassMention };
}

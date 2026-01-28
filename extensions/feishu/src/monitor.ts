import {
  createReplyPrefixContext,
  logInboundDrop,
  normalizeAccountId,
  resolveControlCommandGate,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  normalizeFeishuAllowlist,
  resolveFeishuAllowlistMatch,
  resolveFeishuChatMatch,
  resolveFeishuGroupAllow,
  resolveFeishuMentionGate,
  resolveFeishuRequireMention,
} from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { addReactionFeishu, deleteReactionFeishu, sendTextFeishu } from "./send.js";
import type {
  FeishuMessage,
  FeishuMessageEventPayload,
  FeishuSender,
  FeishuTarget,
  ResolvedFeishuAccount,
} from "./types.js";

import * as lark from "@larksuiteoapi/node-sdk";

const CHANNEL_ID = "feishu" as const;
const FALLBACK_TEXT_LIMIT = 4000;
const AUTO_BINDING_CACHE = new Set<string>();
const AUTO_BINDING_IN_FLIGHT = new Set<string>();

const DEFAULT_AGENT_ID = "main";
const DEFAULT_WS_IDLE_TIMEOUT_SECONDS = 20 * 60;
const WS_RECONNECT_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

type FeishuCoreRuntime = ReturnType<typeof getFeishuRuntime>;

type FeishuRuntimeEnv = Pick<RuntimeEnv, "log" | "error">;

type FeishuMonitorOptions = {
  account: ResolvedFeishuAccount;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: {
    running?: boolean;
    connected?: boolean;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string | null;
    lastConnectedAt?: number;
    lastDisconnectAt?: number;
  }) => void;
};

type FeishuMessageContent = {
  text: string;
};

type FeishuWsClient = {
  start?: (opts: { eventDispatcher: unknown }) => Promise<unknown> | unknown;
  stop?: () => Promise<unknown> | unknown;
  close?: () => Promise<unknown> | unknown;
};

type FeishuEventDispatcher = {
  register?: (handlers: Record<string, (payload: unknown) => unknown>) => void;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function computeBackoff(policy: typeof WS_RECONNECT_POLICY, attempt: number): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  try {
    await delay(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) {
      throw new Error("aborted");
    }
    throw err;
  }
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 1e11) return parsed * 1000;
  return parsed;
}

function parseMessageContent(message: FeishuMessage): FeishuMessageContent | null {
  const raw = message.content?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = readRecord(parsed);
    const text = record?.text;
    if (typeof text === "string" && text.trim()) {
      return { text: text.trim() };
    }
  } catch {
    // fall through to raw content
  }
  return { text: raw };
}

function unwrapFeishuEvent(payload: FeishuMessageEventPayload): {
  event: Record<string, unknown>;
  message: FeishuMessage | null;
  sender: FeishuSender | null;
} {
  // Long-connection SDK sometimes gives { event: {...} }, sometimes flattens.
  const evt = (payload as { event?: Record<string, unknown> }).event ?? (payload as Record<string, unknown>);
  const message =
    (evt?.message as FeishuMessage | undefined) ??
    ((evt?.msg as Record<string, unknown> | undefined) as FeishuMessage | undefined) ??
    null;
  const sender = (evt?.sender as FeishuSender | undefined) ?? null;
  return { event: evt ?? {}, message, sender };
}

function resolveSenderIds(payload: FeishuMessageEventPayload): {
  senderId: string;
  senderOpenId?: string;
  senderUserId?: string;
} | null {
  const { sender } = unwrapFeishuEvent(payload);
  const senderIdObj =
    sender?.sender_id ||
    // Some payloads flatten sender_id
    ((sender as unknown as { open_id?: string; user_id?: string }) ?? null);
  const openId = senderIdObj?.open_id?.trim();
  const userId = senderIdObj?.user_id?.trim();
  const senderId = openId || userId;
  if (!senderId) return null;
  return {
    senderId,
    senderOpenId: openId || undefined,
    senderUserId: userId || undefined,
  };
}

function resolveTenantKey(params: {
  payload: FeishuMessageEventPayload;
  sender: FeishuSender | null;
  event: Record<string, unknown>;
}): string | undefined {
  const headerKey = params.payload.header?.tenant_key?.trim();
  if (headerKey) return headerKey;
  const senderKey = params.sender?.tenant_key?.trim();
  if (senderKey) return senderKey;
  const eventKey = (params.event.tenant_key as string | undefined)?.trim();
  return eventKey || undefined;
}

function wasMentionedByFeishu(message: FeishuMessage, botOpenId?: string): boolean {
  const mentions = message.mentions ?? [];
  if (mentions.length === 0) return false;
  if (!botOpenId) return true;
  const target = botOpenId.trim();
  if (!target) return true;
  return mentions.some((mention) => mention.id?.open_id?.trim() === target);
}

function resolveUserPath(input: string, homedir: () => string = os.homedir): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);
  return path.join(os.homedir(), ".clawdbot");
}

function resolveDefaultAgentWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.CLAWDBOT_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(os.homedir(), `clawd-${profile}`);
  }
  return path.join(os.homedir(), "clawd");
}

function normalizeAgentId(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function resolveDefaultAgentId(cfg: ClawdbotConfig): string {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  if (list.length === 0) return DEFAULT_AGENT_ID;
  const defaults = list.filter((agent) => agent?.default);
  const chosen = (defaults[0] ?? list[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID) || DEFAULT_AGENT_ID;
}

function resolveAgentWorkspaceDir(cfg: ClawdbotConfig, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  const entry = agents.find(
    (agent) => normalizeAgentId(agent?.id) === normalizedAgentId,
  );
  const configuredWorkspace = entry?.workspace?.trim();
  if (configuredWorkspace) return resolveUserPath(configuredWorkspace);

  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultsWorkspace = cfg.agents?.defaults?.workspace?.trim();
  if (normalizedAgentId === defaultAgentId) {
    if (defaultsWorkspace) return resolveUserPath(defaultsWorkspace);
    return resolveDefaultAgentWorkspaceDir();
  }
  return path.join(os.homedir(), `clawd-${normalizedAgentId}`);
}

function resolveAgentDir(agentId: string): string {
  return path.join(resolveStateDir(), "agents", normalizeAgentId(agentId), "agent");
}

function resolveAgentSessionsDir(agentId: string): string {
  return path.join(resolveStateDir(), "agents", normalizeAgentId(agentId), "sessions");
}

function resolveWsIdleTimeoutSeconds(account: ResolvedFeishuAccount): number {
  const configured = account.config.wsIdleTimeoutSeconds;
  if (typeof configured === "number" && configured >= 0) return configured;
  return DEFAULT_WS_IDLE_TIMEOUT_SECONDS;
}

function resolveWsWatchdogIntervalSeconds(
  account: ResolvedFeishuAccount,
  idleSeconds: number,
): number {
  const configured = account.config.wsWatchdogIntervalSeconds;
  if (typeof configured === "number" && configured > 0) return configured;
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return 0;
  return Math.max(15, Math.min(60, Math.floor(idleSeconds / 3)));
}

function buildSenderBindingKey(accountId: string, senderId: string): string {
  const normalizedAccountId = normalizeAccountId(accountId);
  return `${normalizedAccountId}:${senderId.trim()}`;
}

async function persistFeishuSenderBinding(params: {
  core: FeishuCoreRuntime;
  accountId: string;
  senderId: string;
  agentId: string;
  runtime: FeishuRuntimeEnv;
}): Promise<void> {
  const senderId = params.senderId.trim();
  if (!senderId) return;
  const key = buildSenderBindingKey(params.accountId, senderId);
  if (AUTO_BINDING_CACHE.has(key) || AUTO_BINDING_IN_FLIGHT.has(key)) return;
  AUTO_BINDING_IN_FLIGHT.add(key);

  try {
    const currentConfig = params.core.config.loadConfig();
    const bindings = Array.isArray(currentConfig.bindings) ? [...currentConfig.bindings] : [];
    const normalizedAccountId = normalizeAccountId(params.accountId);
    const existing = bindings.find((binding) => {
      if (!binding || typeof binding !== "object") return false;
      const match = (binding as { match?: Record<string, unknown> }).match;
      if (!match || typeof match !== "object") return false;
      const channel = String(match.channel ?? "").trim().toLowerCase();
      if (channel !== CHANNEL_ID) return false;
      const matchAccountId = normalizeAccountId(match.accountId as string | undefined);
      if (matchAccountId !== normalizedAccountId) return false;
      const matchSenderId =
        typeof match.senderId === "string" ? match.senderId.trim() : "";
      return matchSenderId === senderId;
    });

    if (existing) {
      const existingAgent = String(existing.agentId ?? "").trim().toLowerCase();
      const desiredAgent = params.agentId.trim().toLowerCase();
      if (existingAgent && existingAgent !== desiredAgent) {
        params.runtime.log?.(
          `feishu: sender binding exists for ${senderId} (agent=${existingAgent}); skipping auto-bind`,
        );
      }
      AUTO_BINDING_CACHE.add(key);
      return;
    }

    const agentId = params.agentId.trim();
    if (!agentId) return;

    const agents = currentConfig.agents ?? {};
    const list = Array.isArray(agents.list) ? [...agents.list] : [];
    const normalizedAgentId = normalizeAgentId(agentId);
    const entryIndex = list.findIndex(
      (entry) => normalizeAgentId(entry?.id) === normalizedAgentId,
    );
    const existingEntry = entryIndex >= 0 ? list[entryIndex] : undefined;

    const workspaceDir =
      existingEntry?.workspace?.trim() || resolveAgentWorkspaceDir(currentConfig, agentId);
    const agentDir = existingEntry?.agentDir?.trim() || resolveAgentDir(agentId);
    const sessionsDir = resolveAgentSessionsDir(agentId);

    try {
      await fs.mkdir(resolveUserPath(workspaceDir), { recursive: true });
      await fs.mkdir(resolveUserPath(agentDir), { recursive: true });
      await fs.mkdir(resolveUserPath(sessionsDir), { recursive: true });
    } catch (err) {
      params.runtime.error?.(
        `feishu: failed creating agent dirs for ${agentId}: ${String(err)}`,
      );
      return;
    }

    if (entryIndex >= 0) {
      list[entryIndex] = {
        ...existingEntry,
        workspace: existingEntry?.workspace ?? workspaceDir,
        agentDir: existingEntry?.agentDir ?? agentDir,
      };
    } else {
      list.push({
        id: agentId,
        workspace: workspaceDir,
        agentDir: agentDir,
      });
    }

    bindings.push({
      agentId,
      match: {
        channel: CHANNEL_ID,
        accountId: normalizedAccountId,
        senderId,
      },
    });

    const nextConfig: ClawdbotConfig = {
      ...currentConfig,
      bindings,
      agents: { ...agents, list },
    };
    await params.core.config.writeConfigFile(nextConfig);
    AUTO_BINDING_CACHE.add(key);
    params.runtime.log?.(`feishu: saved sender binding ${senderId} -> agent ${agentId}`);
  } catch (err) {
    params.runtime.error?.(
      `feishu: failed to persist sender binding for ${senderId}: ${String(err)}`,
    );
  } finally {
    AUTO_BINDING_IN_FLIGHT.delete(key);
  }
}

async function deliverFeishuReply(params: {
  core: FeishuCoreRuntime;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  payload: ReplyPayload;
  runtime: FeishuRuntimeEnv;
  onBeforeSend?: () => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number; lastError?: string | null }) => void;
}): Promise<void> {
  const { core, cfg, account, chatId, payload, runtime, statusSink, onBeforeSend } = params;
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, account.accountId, {
    fallbackLimit: account.config.textChunkLimit ?? FALLBACK_TEXT_LIMIT,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, CHANNEL_ID, account.accountId);

  const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const attachmentBlock = mediaUrls.length > 0
    ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  const text = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);
  const combined = attachmentBlock
    ? text.trim()
      ? `${text.trim()}\n\n${attachmentBlock}`
      : attachmentBlock
    : text;

  const chunks = core.channel.text.chunkMarkdownTextWithMode(combined, textLimit, chunkMode);
  const sendList = chunks.length > 0 ? chunks : [combined];
  const target: FeishuTarget = { receiveIdType: "chat_id", id: chatId };

  await onBeforeSend?.();

  for (const chunk of sendList) {
    const body = chunk.trim();
    if (!body) continue;
    try {
      await sendTextFeishu({
        account,
        target,
        text: body,
        statusSink: (patch) => statusSink?.({ lastOutboundAt: patch.lastOutboundAt }),
      });
      statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusSink?.({ lastError: message });
      runtime.error?.(`feishu: failed to deliver reply to ${chatId}: ${message}`);
      throw err;
    }
  }

  core.channel.activity.record({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    direction: "outbound",
    at: Date.now(),
  });
}

async function handleFeishuMessage(params: {
  payload: FeishuMessageEventPayload;
  account: ResolvedFeishuAccount;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  core: FeishuCoreRuntime;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string | null;
  }) => void;
}): Promise<void> {
  const { payload, account, config, runtime, core, statusSink } = params;

  const { event, message, sender } = unwrapFeishuEvent(payload);
  if (!message) return;

  const senderType =
    (event?.sender as { sender_type?: string } | undefined)?.sender_type?.trim().toLowerCase();
  if (senderType === "app") return;

  const senderIds = resolveSenderIds(payload);
  if (!senderIds) return;
  if (account.botOpenId && senderIds.senderOpenId === account.botOpenId) return;

  const tenantKey = resolveTenantKey({ payload, sender, event });
  const senderRouteId = senderIds.senderOpenId ?? senderIds.senderId;
  const routeBySenderId = account.config.routeBySenderId === true;

  const chatId = message.chat_id?.trim() ?? (message as unknown as { chatId?: string })?.chatId;
  if (!chatId) return;

  const content = parseMessageContent(message);
  if (!content?.text) return;
  const rawBody = content.text.trim();
  if (!rawBody) return;

  const timestamp =
    parseTimestamp(message.create_time) ?? parseTimestamp(payload.header?.create_time) ?? Date.now();

  statusSink?.({ lastInboundAt: timestamp, lastError: null });
  core.channel.activity.record({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    direction: "inbound",
    at: timestamp,
  });

  const chatType = message.chat_type?.trim().toLowerCase() ?? (message as unknown as { chatType?: string })?.chatType?.toLowerCase();
  const isGroup = chatType !== "p2p";

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const configAllowFrom = normalizeFeishuAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeFeishuAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore(CHANNEL_ID)
    .catch(() => []);
  const storeAllowList = normalizeFeishuAllowlist(storeAllowFrom);

  const chatMatch = resolveFeishuChatMatch({
    chats: account.config.chats,
    chatId,
  });
  const chatConfig = chatMatch.chatConfig;
  if (isGroup && !chatMatch.allowed) {
    runtime.log?.(`feishu: drop chat ${chatId} (not allowlisted)`);
    return;
  }
  if (chatConfig?.enabled === false) {
    runtime.log?.(`feishu: drop chat ${chatId} (disabled)`);
    return;
  }

  const chatAllowFrom = normalizeFeishuAllowlist(chatConfig?.allowFrom);
  const baseGroupAllowFrom =
    configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowList].filter(Boolean);
  const effectiveGroupAllowFrom = [...baseGroupAllowFrom, ...storeAllowList].filter(Boolean);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveFeishuAllowlistMatch({
    allowFrom: isGroup
      ? [...effectiveGroupAllowFrom, ...chatAllowFrom]
      : effectiveAllowFrom,
    senderId: senderIds.senderId,
    senderUserId: senderIds.senderUserId,
    senderName: senderIds.senderId,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (messageLine) => runtime.log?.(messageLine),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderIds.senderId,
    });
    return;
  }

  if (isGroup) {
    const groupAllow = resolveFeishuGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: chatAllowFrom,
      senderId: senderIds.senderId,
      senderUserId: senderIds.senderUserId,
      senderName: senderIds.senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`feishu: drop group sender ${senderIds.senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`feishu: drop DM sender=${senderIds.senderId} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveFeishuAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId: senderIds.senderId,
        senderUserId: senderIds.senderUserId,
        senderName: senderIds.senderId,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderIds.senderId,
            meta: {
              name: senderIds.senderId,
              userId: senderIds.senderUserId,
            },
          });
          if (created) {
            try {
              await sendTextFeishu({
                account,
                target: { receiveIdType: "chat_id", id: chatId },
                text: core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your Feishu user id: ${senderIds.senderId}`,
                  code,
                }),
                statusSink: (patch) => statusSink?.({ lastOutboundAt: patch.lastOutboundAt }),
              });
            } catch (err) {
              runtime.error?.(
                `feishu: pairing reply failed for ${senderIds.senderId}: ${String(err)}`,
              );
            }
          }
        }
        runtime.log?.(`feishu: drop DM sender ${senderIds.senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config);
  const wasMentionedByPatterns = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const wasMentioned = isGroup
    ? wasMentionedByPatterns || wasMentionedByFeishu(message, account.botOpenId)
    : false;
  const shouldRequireMention = isGroup
    ? resolveFeishuRequireMention({
        chatConfig,
        wildcardConfig: chatMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveFeishuMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`feishu: drop chat ${chatId} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    senderId: senderRouteId,
    teamId: tenantKey,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? chatId : senderIds.senderId,
    },
    ...(routeBySenderId && senderRouteId
      ? { fallbackAgentId: senderRouteId, allowUnknownAgentId: true }
      : {}),
  });

  if (routeBySenderId && senderRouteId && route.matchedBy === "fallback") {
    void persistFeishuSenderBinding({
      core,
      accountId: account.accountId,
      senderId: senderRouteId,
      agentId: route.agentId,
      runtime,
    });
  }

  const fromLabel = isGroup ? `chat:${chatId}` : `user:${senderIds.senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: fromLabel,
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = chatConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `feishu:chat:${chatId}` : `feishu:${senderIds.senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderIds.senderId,
    SenderId: senderIds.senderId,
    GroupSubject: isGroup ? chatId : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.message_id,
    Timestamp: timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `feishu:${chatId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`feishu: failed updating session meta: ${String(err)}`);
    },
  });

  const prefixContext = createReplyPrefixContext({ cfg: config, agentId: route.agentId });
  const replyStatusReaction = account.config.replyStatusReaction?.trim();
  const replyStatusText = replyStatusReaction ? undefined : account.config.replyStatusText?.trim();
  const inboundMessageId = message.message_id?.trim();
  let replyStatusReactionId: string | null = null;
  let replyStatusReactionPromise: Promise<string | null> | null = null;
  let replyStatusCleared = false;

  const ensureReplyStatusReaction = async (): Promise<string | null> => {
    if (!replyStatusReaction || !inboundMessageId) return null;
    if (replyStatusReactionId) return replyStatusReactionId;
    if (!replyStatusReactionPromise) {
      replyStatusReactionPromise = (async () => {
        try {
          const { reactionId } = await addReactionFeishu({
            account,
            messageId: inboundMessageId,
            emojiType: replyStatusReaction,
          });
          replyStatusReactionId = reactionId ?? null;
          return replyStatusReactionId;
        } catch (err) {
          runtime.error?.(`feishu: reply reaction failed for ${chatId}: ${String(err)}`);
          return null;
        }
      })();
    }
    return replyStatusReactionPromise;
  };

  const clearReplyStatusReactionOnce = async () => {
    if (replyStatusCleared) return;
    replyStatusCleared = true;
    const reactionId =
      replyStatusReactionId ??
      (replyStatusReactionPromise ? await replyStatusReactionPromise.catch(() => null) : null);
    if (!reactionId || !inboundMessageId) return;
    try {
      await deleteReactionFeishu({ account, messageId: inboundMessageId, reactionId });
    } catch (err) {
      runtime.error?.(`feishu: reply reaction cleanup failed for ${chatId}: ${String(err)}`);
    }
  };

  let replyStatusTextSent = false;
  const ensureReplyStatusText = async () => {
    if (!replyStatusText || replyStatusTextSent) return;
    replyStatusTextSent = true;
    try {
      await sendTextFeishu({
        account,
        target: { receiveIdType: "chat_id", id: chatId },
        text: replyStatusText,
        statusSink: (patch) => statusSink?.({ lastOutboundAt: patch.lastOutboundAt }),
      });
    } catch (err) {
      runtime.error?.(`feishu: reply status failed for ${chatId}: ${String(err)}`);
    }
  };

  const onReplyStart = replyStatusReaction
    ? () => ensureReplyStatusReaction()
    : replyStatusText
      ? () => ensureReplyStatusText()
      : undefined;
  const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(config, route.agentId),
    deliver: async (payload: ReplyPayload) => {
      await deliverFeishuReply({
        core,
        cfg: config,
        account,
        chatId,
        payload,
        runtime,
        onBeforeSend: replyStatusReaction ? clearReplyStatusReactionOnce : undefined,
        statusSink,
      });
    },
    onError: (err, info) => {
      runtime.error?.(`feishu ${info.kind} reply failed: ${String(err)}`);
      if (replyStatusReaction) {
        void clearReplyStatusReactionOnce();
      }
    },
    onReplyStart,
  });

  if (replyStatusReaction) {
    void ensureReplyStatusReaction();
  } else if (replyStatusText) {
    void ensureReplyStatusText();
  }

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: config,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: chatConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected: prefixContext.onModelSelected,
    },
  });
  if (replyStatusReaction) {
    await clearReplyStatusReactionOnce();
  }
  markDispatchIdle();
}

function createEventDispatcher(params: {
  account: ResolvedFeishuAccount;
}): FeishuEventDispatcher {
  const DispatcherCtor = (lark as unknown as { EventDispatcher: new (opts?: Record<string, unknown>) => FeishuEventDispatcher })
    .EventDispatcher;
  const options: Record<string, unknown> = {};
  if (params.account.verificationToken) {
    options.verificationToken = params.account.verificationToken;
  }
  if (params.account.encryptKey) {
    options.encryptKey = params.account.encryptKey;
  }
  return new DispatcherCtor(options);
}

function createWsClient(account: ResolvedFeishuAccount): FeishuWsClient {
  const WsCtor = (lark as unknown as { WSClient: new (opts: Record<string, unknown>) => FeishuWsClient })
    .WSClient;
  return new WsCtor({ appId: account.appId, appSecret: account.appSecret });
}

export async function monitorFeishuProvider(options: FeishuMonitorOptions): Promise<{ stop: () => void }> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getFeishuRuntime();

  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  let stopped = false;
  let wsClient: FeishuWsClient | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let lastInboundAt = Date.now();
  let reconnectAttempts = 0;
  let restartInFlight: Promise<void> | null = null;
  let restartQueued = false;

  const stop = (reason: string = "shutdown") => {
    if (stopped) return;
    stopped = true;
    statusSink?.({ connected: false, running: false, lastDisconnectAt: Date.now() });
    runtime.log?.(`feishu: ws stopping (${reason})`);
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    const client = wsClient;
    wsClient = null;
    try {
      if (client?.stop) {
        void client.stop();
      } else if (client?.close) {
        void client.close();
      }
    } catch (err) {
      runtime.error?.(`feishu: stop failed: ${String(err)}`);
    }
  };

  const onAbort = () => stop("abort");
  abortSignal.addEventListener("abort", onAbort, { once: true });

  const dispatcher = createEventDispatcher({ account });
  const register = dispatcher.register;
  if (typeof register !== "function") {
    throw new Error("Feishu SDK dispatcher missing register()");
  }

  const idleTimeoutSeconds = resolveWsIdleTimeoutSeconds(account);
  const watchdogIntervalSeconds = resolveWsWatchdogIntervalSeconds(account, idleTimeoutSeconds);

  const startWsClient = async (label: string): Promise<boolean> => {
    runtime.log?.(`feishu: ws connect start (${label})`);
    wsClient = createWsClient(account);
    const start = wsClient.start;
    if (typeof start !== "function") {
      throw new Error("Feishu SDK WSClient missing start()");
    }

    statusSink?.({ connected: true, lastConnectedAt: Date.now(), lastError: null });
    const startPromise = Promise.resolve(start.call(wsClient, { eventDispatcher: dispatcher }));
    startPromise.catch((err) => {
      statusSink?.({ lastError: String(err) });
      runtime.error?.(`feishu: WSClient.start failed (${label}): ${String(err)}`);
    });

    const startOutcome = await Promise.race([
      startPromise.then(() => ({ ok: true as const })).catch((err) => ({
        ok: false as const,
        err,
      })),
      new Promise<{ ok: true; timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ ok: true, timedOut: true }), 5000),
      ),
    ]);
    if (!startOutcome.ok) {
      statusSink?.({ connected: false, lastError: String(startOutcome.err) });
      runtime.error?.(`feishu: ws connect failed (${label}): ${String(startOutcome.err)}`);
      return false;
    }
    if ("timedOut" in startOutcome) {
      runtime.log?.(`feishu: ws connect pending (${label})`);
    } else {
      runtime.log?.(`feishu: ws connected (${label})`);
    }
    return true;
  };

  const requestRestart = (reason: string) => {
    if (stopped || abortSignal.aborted) return;
    if (restartInFlight) {
      restartQueued = true;
      return;
    }
    restartInFlight = (async () => {
      reconnectAttempts += 1;
      const delayMs = computeBackoff(WS_RECONNECT_POLICY, reconnectAttempts);
      runtime.error?.(
        `feishu: ws restarting (reason=${reason} attempt=${reconnectAttempts} delayMs=${delayMs})`,
      );
      statusSink?.({
        connected: false,
        lastDisconnectAt: Date.now(),
        lastError: `ws-restart: ${reason}`,
      });

      const client = wsClient;
      wsClient = null;
      try {
        if (client?.stop) {
          await client.stop();
        } else if (client?.close) {
          await client.close();
        }
        runtime.log?.(`feishu: ws disconnected for restart (reason=${reason})`);
      } catch (err) {
        runtime.error?.(`feishu: stop failed: ${String(err)}`);
      }

      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (err) {
        if (abortSignal.aborted) return;
        throw err;
      }

      if (stopped || abortSignal.aborted) return;

      const started = await startWsClient(`restart:${reason}`);
      if (started) {
        reconnectAttempts = 0;
        lastInboundAt = Date.now();
        return;
      }

      restartQueued = true;
    })()
      .catch((err) => {
        if (!abortSignal.aborted) {
          runtime.error?.(`feishu: restart failed: ${String(err)}`);
        }
      })
      .finally(() => {
        restartInFlight = null;
        if (restartQueued) {
          restartQueued = false;
          requestRestart("retry");
        }
      });
  };

  const ensureWatchdog = () => {
    if (watchdogTimer) return;
    if (idleTimeoutSeconds <= 0 || watchdogIntervalSeconds <= 0) return;
    watchdogTimer = setInterval(() => {
      if (stopped || abortSignal.aborted) return;
      const idleMs = Date.now() - lastInboundAt;
      if (idleMs < idleTimeoutSeconds * 1000) return;
      runtime.error?.(
        `feishu: ws idle ${Math.round(idleMs / 1000)}s; restarting connection`,
      );
      requestRestart("idle-timeout");
    }, watchdogIntervalSeconds * 1000);
    watchdogTimer.unref?.();
  };

  register.call(dispatcher, {
    "im.message.receive_v1": (payload: unknown) => {
      if (stopped || abortSignal.aborted) return;
      const event = payload as FeishuMessageEventPayload;
      lastInboundAt = Date.now();
      statusSink?.({ lastInboundAt });
      runtime.log?.(
        `feishu: inbound event chat=${event.event?.message?.chat_id ?? "<unknown>"} ` +
          `sender=${event.event?.sender?.sender_id?.open_id ?? event.event?.sender?.sender_id?.user_id ?? "<unknown>"} ` +
          `type=${event.event?.message?.message_type ?? "<unknown>"}`,
      );
      runtime.log?.(`feishu: raw payload ${JSON.stringify(payload)}`);
      void handleFeishuMessage({
        payload: event,
        account,
        config,
        runtime,
        core,
        statusSink,
      }).catch((err) => {
        statusSink?.({ lastError: String(err) });
        runtime.error?.(`feishu: inbound handler failed: ${String(err)}`);
      });
    },
  });

  statusSink?.({ running: true, lastError: null });
  const started = await startWsClient("startup");
  if (!started) {
    throw new Error("Feishu WSClient.start failed");
  }
  ensureWatchdog();

  await new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

  stop();
  abortSignal.removeEventListener("abort", onAbort);
  return { stop };
}

import {
  createReplyPrefixContext,
  logInboundDrop,
  resolveControlCommandGate,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";

import {
  normalizeFeishuAllowlist,
  resolveFeishuAllowlistMatch,
  resolveFeishuChatMatch,
  resolveFeishuGroupAllow,
  resolveFeishuMentionGate,
  resolveFeishuRequireMention,
} from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendTextFeishu } from "./send.js";
import type {
  FeishuMessage,
  FeishuMessageEventPayload,
  FeishuTarget,
  ResolvedFeishuAccount,
} from "./types.js";

import * as lark from "@larksuiteoapi/node-sdk";

const CHANNEL_ID = "feishu" as const;
const FALLBACK_TEXT_LIMIT = 4000;

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

function wasMentionedByFeishu(message: FeishuMessage, botOpenId?: string): boolean {
  const mentions = message.mentions ?? [];
  if (mentions.length === 0) return false;
  if (!botOpenId) return true;
  const target = botOpenId.trim();
  if (!target) return true;
  return mentions.some((mention) => mention.id?.open_id?.trim() === target);
}

async function deliverFeishuReply(params: {
  core: FeishuCoreRuntime;
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  chatId: string;
  payload: ReplyPayload;
  runtime: FeishuRuntimeEnv;
  statusSink?: (patch: { lastOutboundAt?: number; lastError?: string | null }) => void;
}): Promise<void> {
  const { core, cfg, account, chatId, payload, runtime, statusSink } = params;
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
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? chatId : senderIds.senderId,
    },
  });

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
        statusSink,
      });
    },
    onError: (err, info) => {
      runtime.error?.(`feishu ${info.kind} reply failed: ${String(err)}`);
    },
  });

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

  const stop = () => {
    if (stopped) return;
    stopped = true;
    statusSink?.({ connected: false, running: false, lastDisconnectAt: Date.now() });
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

  const onAbort = () => stop();
  abortSignal.addEventListener("abort", onAbort, { once: true });

  const dispatcher = createEventDispatcher({ account });
  const register = dispatcher.register;
  if (typeof register !== "function") {
    throw new Error("Feishu SDK dispatcher missing register()");
  }

  register.call(dispatcher, {
    "im.message.receive_v1": (payload: unknown) => {
      if (stopped || abortSignal.aborted) return;
      const event = payload as FeishuMessageEventPayload;
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

  wsClient = createWsClient(account);
  const start = wsClient.start;
  if (typeof start !== "function") {
    throw new Error("Feishu SDK WSClient missing start()");
  }

  statusSink?.({ running: true, connected: true, lastConnectedAt: Date.now(), lastError: null });
  const startPromise = Promise.resolve(start.call(wsClient, { eventDispatcher: dispatcher }));
  startPromise.catch((err) => {
    statusSink?.({ lastError: String(err) });
    runtime.error?.(`feishu: WSClient.start failed: ${String(err)}`);
    stop();
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
    statusSink?.({ lastError: String(startOutcome.err) });
    throw startOutcome.err;
  }

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

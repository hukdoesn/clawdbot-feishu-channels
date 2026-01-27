import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ClawdbotConfig,
  OutboundDeliveryResult,
  ReplyPayload,
} from "clawdbot/plugin-sdk";
import { missingTargetError } from "clawdbot/plugin-sdk";

import { resolveFeishuAccount } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";
import { parseFeishuTarget, sendTextFeishu } from "./send.js";
import type { ResolvedFeishuAccount } from "./types.js";

const FALLBACK_TEXT_LIMIT = 4000;

function ensureTarget(to: string | undefined, allowFrom: string[] | undefined): string {
  const trimmed = to?.trim();
  if (trimmed) return trimmed;
  const fallback = (allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && entry !== "*")
    .find(Boolean);
  if (fallback) return fallback;
  throw missingTargetError(
    "Feishu",
    "chat:<chat_id> or user:<open_id> (or channels.feishu.allowFrom[0])",
  );
}

function normalizeMediaList(payload: Pick<ReplyPayload, "mediaUrls" | "mediaUrl">): string[] {
  if (payload.mediaUrls && payload.mediaUrls.length > 0) return payload.mediaUrls;
  if (payload.mediaUrl) return [payload.mediaUrl];
  return [];
}

function combineTextAndMedia(text: string, mediaUrls: string[]): string {
  const cleanText = text.trim();
  if (mediaUrls.length === 0) return cleanText;
  const attachments = mediaUrls.map((url) => `Attachment: ${url}`).join("\n");
  if (!cleanText) return attachments;
  return `${cleanText}\n\n${attachments}`;
}

async function sendChunkedText(params: {
  cfg: ClawdbotConfig;
  channel: string;
  account: ResolvedFeishuAccount;
  targetRaw: string;
  text: string;
  signal?: AbortSignal;
}): Promise<{ messageId: string; targetId: string }> {
  const core = getFeishuRuntime();
  const account = params.account;
  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  const target = parseFeishuTarget(params.targetRaw);
  if (!target) {
    throw new Error("Feishu target is empty");
  }

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: params.channel,
    accountId: account.accountId,
  });
  const textLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    params.channel,
    account.accountId,
    {
      fallbackLimit: account.config.textChunkLimit ?? FALLBACK_TEXT_LIMIT,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, params.channel, account.accountId);

  const converted = core.channel.text.convertMarkdownTables(params.text, tableMode);
  const chunks = core.channel.text.chunkMarkdownTextWithMode(converted, textLimit, chunkMode);
  const sendList = chunks.length > 0 ? chunks : [converted];

  let lastMessageId = `feishu-${Date.now()}`;
  for (const chunk of sendList) {
    const body = chunk.trim();
    if (!body) continue;
    const sent = await sendTextFeishu({
      account,
      target,
      text: body,
      signal: params.signal,
    });
    lastMessageId = sent.messageId;
  }

  return { messageId: lastMessageId, targetId: target.id };
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: FALLBACK_TEXT_LIMIT,
  resolveTarget: ({ to, allowFrom }) => {
    const resolved = ensureTarget(to, allowFrom);
    return { ok: true, to: resolved };
  },
  sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    if (ctx.signal?.aborted) {
      throw new Error("Feishu outbound aborted");
    }
    const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    const targetRaw = ensureTarget(ctx.to, account.config.allowFrom);
    const { messageId, targetId } = await sendChunkedText({
      cfg: ctx.cfg,
      channel: "feishu",
      account,
      targetRaw,
      text: ctx.text,
      signal: ctx.signal,
    });
    return {
      channel: "feishu",
      messageId,
      chatId: targetId,
      timestamp: Date.now(),
      to: targetId,
    };
  },
  sendMedia: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
    if (ctx.signal?.aborted) {
      throw new Error("Feishu outbound aborted");
    }
    const mediaUrl = ctx.mediaUrl?.trim();
    const combined = combineTextAndMedia(ctx.text ?? "", mediaUrl ? [mediaUrl] : []);
    return feishuOutbound.sendText!({ ...ctx, text: combined });
  },
  sendPayload: async (ctx: ChannelOutboundPayloadContext): Promise<OutboundDeliveryResult> => {
    if (ctx.signal?.aborted) {
      throw new Error("Feishu outbound aborted");
    }
    const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
    const targetRaw = ensureTarget(ctx.to, account.config.allowFrom);
    const mediaUrls = normalizeMediaList(ctx.payload);
    const combined = combineTextAndMedia(ctx.payload.text ?? "", mediaUrls);
    const { messageId, targetId } = await sendChunkedText({
      cfg: ctx.cfg,
      channel: "feishu",
      account,
      targetRaw,
      text: combined,
      signal: ctx.signal,
    });
    return {
      channel: "feishu",
      messageId,
      chatId: targetId,
      timestamp: Date.now(),
      to: targetId,
    };
  },
};

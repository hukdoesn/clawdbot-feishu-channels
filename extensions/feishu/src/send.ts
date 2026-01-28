import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { resolveFeishuAccount } from "./accounts.js";
import type { FeishuTarget, ResolvedFeishuAccount } from "./types.js";

import * as lark from "@larksuiteoapi/node-sdk";

type FeishuClient = {
  im?: {
    message?: {
      create?: (params: {
        params: { receive_id_type: "chat_id" | "open_id" };
        data: { receive_id: string; msg_type: string; content: string };
      }) => Promise<unknown>;
      delete?: (params: { path: { message_id: string } }) => Promise<unknown>;
    };
    messageReaction?: {
      create?: (params: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: string } };
      }) => Promise<unknown>;
      delete?: (params: { path: { message_id: string; reaction_id: string } }) => Promise<unknown>;
    };
  };
};

const clientCache = new Map<string, { key: string; client: FeishuClient }>();

function buildClientKey(account: ResolvedFeishuAccount): string {
  return `${account.appId}|${account.appSecret}`;
}

function createClient(account: ResolvedFeishuAccount): FeishuClient {
  const appType = (lark as unknown as { AppType?: { SelfBuild?: unknown } }).AppType?.SelfBuild;
  const client = new (lark as unknown as { Client: new (opts: Record<string, unknown>) => FeishuClient }).Client({
    appId: account.appId,
    appSecret: account.appSecret,
    ...(appType ? { appType } : {}),
  });
  return client;
}

export function getFeishuClient(account: ResolvedFeishuAccount): FeishuClient {
  const cacheKey = buildClientKey(account);
  const cached = clientCache.get(account.accountId);
  if (cached && cached.key === cacheKey) {
    return cached.client;
  }
  const client = createClient(account);
  clientCache.set(account.accountId, { key: cacheKey, client });
  return client;
}

export function clearFeishuClient(accountId?: string): void {
  if (!accountId) {
    clientCache.clear();
    return;
  }
  clientCache.delete(accountId);
}

export function parseFeishuTarget(raw: string): FeishuTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let value = trimmed;
  value = value.replace(/^(feishu|lark):/i, "").trim();

  const lower = value.toLowerCase();
  if (lower.startsWith("user:")) {
    const id = value.slice("user:".length).trim();
    return id ? { receiveIdType: "open_id", id } : null;
  }
  if (lower.startsWith("open:")) {
    const id = value.slice("open:".length).trim();
    return id ? { receiveIdType: "open_id", id } : null;
  }
  if (lower.startsWith("chat:")) {
    const id = value.slice("chat:".length).trim();
    return id ? { receiveIdType: "chat_id", id } : null;
  }

  if (/^ou_/i.test(value)) {
    return { receiveIdType: "open_id", id: value };
  }
  if (/^oc_/i.test(value)) {
    return { receiveIdType: "chat_id", id: value };
  }

  return { receiveIdType: "chat_id", id: value };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractMessageId(response: unknown): string | null {
  const record = readRecord(response);
  const data = readRecord(record?.data);
  const messageIdDirect = data?.message_id;
  if (typeof messageIdDirect === "string" && messageIdDirect.trim()) {
    return messageIdDirect.trim();
  }
  const message = readRecord(data?.message);
  const messageIdNested = message?.message_id;
  if (typeof messageIdNested === "string" && messageIdNested.trim()) {
    return messageIdNested.trim();
  }
  return null;
}

function extractReactionId(response: unknown): string | null {
  const record = readRecord(response);
  const data = readRecord(record?.data);
  const reactionId = data?.reaction_id;
  if (typeof reactionId === "string" && reactionId.trim()) {
    return reactionId.trim();
  }
  return null;
}

export async function sendTextFeishu(params: {
  account: ResolvedFeishuAccount;
  target: FeishuTarget;
  text: string;
  signal?: AbortSignal;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<{ messageId: string }> {
  const { account, target, text, signal, statusSink } = params;

  if (signal?.aborted) {
    throw new Error("Feishu send aborted");
  }

  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  const body = text.trim();
  if (!body) {
    throw new Error("Feishu send requires non-empty text.");
  }

  const client = getFeishuClient(account);
  const create = client.im?.message?.create;
  if (typeof create !== "function") {
    throw new Error("Feishu SDK client missing im.message.create");
  }

  const response = await create({
    params: { receive_id_type: target.receiveIdType },
    data: {
      receive_id: target.id,
      msg_type: "text",
      content: JSON.stringify({ text: body }),
    },
  });

  statusSink?.({ lastOutboundAt: Date.now() });

  const messageId = extractMessageId(response) ?? `feishu-${Date.now()}`;
  return { messageId };
}

export async function addReactionFeishu(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  emojiType: string;
  signal?: AbortSignal;
}): Promise<{ reactionId: string | null }> {
  const { account, messageId, emojiType, signal } = params;
  const id = messageId.trim();
  const emoji = emojiType.trim();
  if (!id || !emoji) return { reactionId: null };

  if (signal?.aborted) {
    throw new Error("Feishu reaction create aborted");
  }

  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  const client = getFeishuClient(account);
  const create = client.im?.messageReaction?.create;
  if (typeof create !== "function") {
    throw new Error("Feishu SDK client missing im.messageReaction.create");
  }

  const response = await create({
    path: { message_id: id },
    data: { reaction_type: { emoji_type: emoji } },
  });

  return { reactionId: extractReactionId(response) };
}

export async function deleteReactionFeishu(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  reactionId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { account, messageId, reactionId, signal } = params;
  const id = messageId.trim();
  const reaction = reactionId.trim();
  if (!id || !reaction) return;

  if (signal?.aborted) {
    throw new Error("Feishu reaction delete aborted");
  }

  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  const client = getFeishuClient(account);
  const del = client.im?.messageReaction?.delete;
  if (typeof del !== "function") {
    throw new Error("Feishu SDK client missing im.messageReaction.delete");
  }

  await del({ path: { message_id: id, reaction_id: reaction } });
}

export async function deleteMessageFeishu(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { account, messageId, signal } = params;
  const id = messageId.trim();
  if (!id) return;

  if (signal?.aborted) {
    throw new Error("Feishu delete aborted");
  }

  if (!account.configured) {
    throw new Error(
      `Feishu account \"${account.accountId}\" is not configured (appId/appSecret missing).`,
    );
  }

  const client = getFeishuClient(account);
  const del = client.im?.message?.delete;
  if (typeof del !== "function") {
    throw new Error("Feishu SDK client missing im.message.delete");
  }

  await del({ path: { message_id: id } });
}

export function resolveFeishuSendContext(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  to: string;
}): { account: ResolvedFeishuAccount; target: FeishuTarget } {
  const account = resolveFeishuAccount({ cfg: params.cfg, accountId: params.accountId });
  const target = parseFeishuTarget(params.to);
  if (!target) {
    throw new Error("Feishu target is empty");
  }
  return { account, target };
}

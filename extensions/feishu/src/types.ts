import type {
  BlockStreamingCoalesceConfig,
  ChunkMode,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "clawdbot/plugin-sdk";

export type FeishuSenderId = {
  open_id?: string;
  user_id?: string;
  union_id?: string;
};

export type FeishuMention = {
  id?: FeishuSenderId;
  name?: string;
  key?: string;
};

export type FeishuMessage = {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  update_time?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
};

export type FeishuSender = {
  sender_id?: FeishuSenderId;
  sender_type?: string;
  tenant_key?: string;
};

export type FeishuEventHeader = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  tenant_key?: string;
  app_id?: string;
};

export type FeishuMessageEventPayload = {
  schema?: string;
  header?: FeishuEventHeader;
  event?: {
    sender?: FeishuSender;
    message?: FeishuMessage;
  };
};

export type FeishuChatConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: string[];
  systemPrompt?: string;
};

export type FeishuAccountConfig = {
  name?: string;
  enabled?: boolean;
  markdown?: MarkdownConfig;
  appId?: string;
  appIdFile?: string;
  appSecret?: string;
  appSecretFile?: string;
  verificationToken?: string;
  encryptKey?: string;
  botOpenId?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: GroupPolicy;
  /** Route inbound messages to per-sender agents using open_id (fallback: user_id). */
  routeBySenderId?: boolean;
  /** Add a reaction to the inbound message while generating a reply (emoji_type). */
  replyStatusReaction?: string;
  /** Send a one-time status message (e.g. "请稍等...") when a reply starts. */
  replyStatusText?: string;
  chats?: Record<string, FeishuChatConfig>;
  defaultAccount?: string;
  historyLimit?: number;
  dmHistoryLimit?: number;
  textChunkLimit?: number;
  chunkMode?: ChunkMode;
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
};

export type FeishuConfig = FeishuAccountConfig & {
  accounts?: Record<string, FeishuAccountConfig>;
  defaultAccount?: string;
};

export type FeishuCredentialSource = "env" | "file" | "config" | "none";

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  botOpenId?: string;
  appIdSource: FeishuCredentialSource;
  appSecretSource: FeishuCredentialSource;
  config: FeishuAccountConfig;
};

export type FeishuTarget = {
  receiveIdType: "chat_id" | "open_id";
  id: string;
};

import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  requireOpenAllowFrom,
} from "clawdbot/plugin-sdk";
import { z } from "zod";

export const FeishuChatSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const FeishuAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    appId: z.string().optional(),
    appIdFile: z.string().optional(),
    appSecret: z.string().optional(),
    appSecretFile: z.string().optional(),
    verificationToken: z.string().optional(),
    encryptKey: z.string().optional(),
    botOpenId: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    routeBySenderId: z.boolean().optional(),
    replyStatusReaction: z.string().optional(),
    replyStatusText: z.string().optional(),
    chats: z.record(z.string(), FeishuChatSchema.optional()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
  })
  .strict();

export const FeishuAccountSchema = FeishuAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.feishu.dmPolicy="open" requires channels.feishu.allowFrom to include "*"',
  });
});

export const FeishuConfigSchema = FeishuAccountSchemaBase.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), FeishuAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.feishu.dmPolicy="open" requires channels.feishu.allowFrom to include "*"',
  });
});

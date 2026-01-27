import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
} from "clawdbot/plugin-sdk";

import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  type ResolvedFeishuAccount,
} from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { monitorFeishuProvider } from "./monitor.js";
import { feishuOutbound } from "./outbound.js";
import {
  normalizeFeishuAllowlist,
  resolveFeishuChatMatch,
  resolveFeishuGroupToolPolicy,
  resolveFeishuRequireMention,
} from "./policy.js";
import { sendTextFeishu } from "./send.js";
import type { FeishuConfig } from "./types.js";

const meta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu (Lark long connection)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "Feishu (Lark) bot via server-side SDK long connection.",
  aliases: ["lark"],
  order: 78,
  quickstartAllowFrom: true,
} as const;

function normalizeFeishuMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(feishu|lark):/i, "");
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta,
  pairing: {
    idLabel: "feishuOpenId",
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|lark):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveFeishuAccount({ cfg });
      await sendTextFeishu({
        account,
        target: { receiveIdType: "open_id", id },
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    threads: false,
    polls: false,
    reactions: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: ["channels.feishu"] },
  configSchema: buildChannelConfigSchema(FeishuConfigSchema),
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) =>
      resolveFeishuAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg as ClawdbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "feishu",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "feishu",
        accountId,
        clearBaseFields: [
          "name",
          "appId",
          "appIdFile",
          "appSecret",
          "appSecretFile",
          "verificationToken",
          "encryptKey",
          "botOpenId",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      appIdSource: account.appIdSource,
      appSecretSource: account.appSecretSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveFeishuAccount({ cfg: cfg as ClawdbotConfig, accountId }).config.allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry) => entry && entry !== "*")
        .map((entry) => entry.replace(/^(feishu|lark):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const config = (cfg as ClawdbotConfig).channels?.feishu as
        | { accounts?: Record<string, unknown> }
        | undefined;
      const useAccountPath = Boolean(config?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.feishu.accounts.${resolvedAccountId}.`
        : "channels.feishu.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("feishu"),
        normalizeEntry: (raw) => raw.replace(/^(feishu|lark):/i, ""),
      };
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, groupId, groupChannel }) => {
      const chatId = groupId?.trim();
      if (!chatId) return true;
      const config = (cfg as ClawdbotConfig).channels?.feishu as FeishuConfig | undefined;
      const match = resolveFeishuChatMatch({
        chats: config?.chats,
        chatId,
        chatName: groupChannel,
      });
      return resolveFeishuRequireMention({
        chatConfig: match.chatConfig,
        wildcardConfig: match.wildcardConfig,
      });
    },
    resolveToolPolicy: resolveFeishuGroupToolPolicy,
  },
  outbound: feishuOutbound,
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToId,
      hasRepliedRef,
    }),
  },
  messaging: {
    normalizeTarget: normalizeFeishuMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        return (
          /^oc_/i.test(trimmed) ||
          /^ou_/i.test(trimmed) ||
          /^(chat|user|open):/i.test(trimmed)
        );
      },
      hint: "chat:<chatId> or user:<openId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveFeishuAccount({ cfg: cfg as ClawdbotConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const peers = Array.from(
        new Set(
          normalizeFeishuAllowlist(account.config.allowFrom).filter((entry) => entry !== "*"),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveFeishuAccount({ cfg: cfg as ClawdbotConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const groups = Object.keys(account.config.chats ?? {})
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return groups;
    },
  },
  setup: {
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "feishu",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "FEISHU_APP_ID/FEISHU_APP_SECRET can only be used for the default account.";
      }
      const typedInput = input as {
        appId?: string;
        token?: string;
      };
      const appId = typedInput.appId ?? typedInput.token;
      if (!input.useEnv && !appId) {
        return "Feishu requires --token <appId> (or --use-env). Set appSecret via env or config.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        useEnv?: boolean;
        appId?: string;
        appIdFile?: string;
        appSecret?: string;
        appSecretFile?: string;
        token?: string;
        tokenFile?: string;
      };
      const appId = typedInput.appId ?? typedInput.token;
      const appIdFile = typedInput.appIdFile;
      const appSecret = typedInput.appSecret;
      // Map the generic --token-file flag to appSecretFile for this channel.
      const appSecretFile = typedInput.appSecretFile ?? typedInput.tokenFile;

      const named = applyAccountNameToChannelSection({
        cfg: cfg as ClawdbotConfig,
        channelKey: "feishu",
        accountId,
        name: input.name,
      });
      const existing = (named.channels?.feishu ?? {}) as FeishuConfig;
      const nextChannel =
        accountId === DEFAULT_ACCOUNT_ID
          ? {
              ...existing,
              enabled: true,
              ...(typedInput.useEnv
                ? {}
                : {
                    ...(appId ? { appId } : {}),
                    ...(appIdFile ? { appIdFile } : {}),
                    ...(appSecret ? { appSecret } : {}),
                    ...(appSecretFile ? { appSecretFile } : {}),
                  }),
            }
          : {
              ...existing,
              accounts: {
                ...(existing.accounts ?? {}),
                [accountId]: {
                  ...(existing.accounts?.[accountId] ?? {}),
                  enabled: true,
                  ...(typedInput.useEnv
                    ? {}
                    : {
                        ...(appId ? { appId } : {}),
                        ...(appIdFile ? { appIdFile } : {}),
                        ...(appSecret ? { appSecret } : {}),
                        ...(appSecretFile ? { appSecretFile } : {}),
                      }),
                  ...(input.name ? { name: input.name } : {}),
                },
              },
            };

      return {
        ...named,
        channels: {
          ...named.channels,
          feishu: nextChannel,
        },
      } as ClawdbotConfig;
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      appIdSource: snapshot.appIdSource ?? "none",
      appSecretSource: snapshot.appSecretSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      appIdSource: account.appIdSource,
      appSecretSource: account.appSecretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        configured: account.configured,
        appIdSource: account.appIdSource,
        appSecretSource: account.appSecretSource,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      ctx.log?.info(`[${account.accountId}] starting Feishu long connection provider`);
      return monitorFeishuProvider({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};

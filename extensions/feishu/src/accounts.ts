import { readFileSync } from "node:fs";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

import type {
  FeishuAccountConfig,
  FeishuConfig,
  FeishuCredentialSource,
  ResolvedFeishuAccount,
} from "./types.js";

const ENV_KEYS = {
  appId: "FEISHU_APP_ID",
  appSecret: "FEISHU_APP_SECRET",
  verificationToken: "FEISHU_VERIFICATION_TOKEN",
  encryptKey: "FEISHU_ENCRYPT_KEY",
  botOpenId: "FEISHU_BOT_OPEN_ID",
} as const;

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.feishu as FeishuConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) continue;
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  const feishu = cfg.channels?.feishu as FeishuConfig | undefined;
  const preferred = feishu?.defaultAccount?.trim();
  if (preferred) return normalizeAccountId(preferred);
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.feishu as FeishuConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as FeishuAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as FeishuAccountConfig | undefined) : undefined;
}

function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuAccountConfig {
  const raw = (cfg.channels?.feishu ?? {}) as FeishuConfig;
  const { accounts: _ignoredAccounts, defaultAccount: _ignoredDefault, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveEnvValue(key: keyof typeof ENV_KEYS): string | undefined {
  const envKey = ENV_KEYS[key];
  const value = process.env[envKey]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readSecretFile(pathValue: string | undefined): string | undefined {
  const filePath = pathValue?.trim();
  if (!filePath) return undefined;
  try {
    const value = readFileSync(filePath, "utf-8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function resolveCredential(
  accountId: string,
  configValue: string | undefined,
  configFile: string | undefined,
  envKey: keyof typeof ENV_KEYS,
): { value: string; source: FeishuCredentialSource } {
  const configTrimmed = configValue?.trim() ?? "";
  const envValue = accountId === DEFAULT_ACCOUNT_ID ? resolveEnvValue(envKey) : undefined;
  const fileValue = readSecretFile(configFile);
  if (envValue) return { value: envValue, source: "env" };
  if (fileValue) return { value: fileValue, source: "file" };
  if (configTrimmed) return { value: configTrimmed, source: "config" };
  return { value: "", source: "none" };
}

export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.feishu as FeishuConfig | undefined)?.enabled !== false;

  const resolve = (accountId: string): ResolvedFeishuAccount => {
    const merged = mergeFeishuAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const appIdResolution = resolveCredential(accountId, merged.appId, merged.appIdFile, "appId");
    const appSecretResolution = resolveCredential(
      accountId,
      merged.appSecret,
      merged.appSecretFile,
      "appSecret",
    );

    const verificationToken =
      (accountId === DEFAULT_ACCOUNT_ID ? resolveEnvValue("verificationToken") : undefined) ??
      merged.verificationToken?.trim() ??
      undefined;
    const encryptKey =
      (accountId === DEFAULT_ACCOUNT_ID ? resolveEnvValue("encryptKey") : undefined) ??
      merged.encryptKey?.trim() ??
      undefined;
    const botOpenId =
      (accountId === DEFAULT_ACCOUNT_ID ? resolveEnvValue("botOpenId") : undefined) ??
      merged.botOpenId?.trim() ??
      undefined;

    const configured = Boolean(appIdResolution.value && appSecretResolution.value);

    return {
      accountId,
      enabled,
      configured,
      name: merged.name?.trim() || undefined,
      appId: appIdResolution.value,
      appSecret: appSecretResolution.value,
      verificationToken,
      encryptKey,
      botOpenId,
      appIdSource: appIdResolution.source,
      appSecretSource: appSecretResolution.source,
      config: merged,
    };
  };

  const primary = resolve(normalizedAccountId);
  if (hasExplicitAccountId) return primary;
  if (primary.configured) return primary;

  const fallbackId = resolveDefaultFeishuAccountId(params.cfg);
  if (fallbackId === primary.accountId) return primary;
  const fallback = resolve(fallbackId);
  return fallback.configured ? fallback : primary;
}

export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

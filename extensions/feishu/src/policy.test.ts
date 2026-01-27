import { describe, expect, it } from "vitest";

import {
  normalizeFeishuAllowlist,
  resolveFeishuAllowlistMatch,
  resolveFeishuChatMatch,
  resolveFeishuGroupAllow,
  resolveFeishuRequireMention,
} from "./policy.js";

describe("feishu policy helpers", () => {
  it("normalizes allowlist entries", () => {
    expect(normalizeFeishuAllowlist(["Feishu:User:OU_ABC", " lark:oc_123 "])).toEqual([
      "ou_abc",
      "oc_123",
    ]);
  });

  it("matches allowlist by id, user id, and wildcard", () => {
    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["ou_abc"],
        senderId: "ou_abc",
      }).allowed,
    ).toBe(true);

    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["ou_abc"],
        senderId: "ou_other",
        senderUserId: "ou_abc",
      }).allowed,
    ).toBe(true);

    expect(
      resolveFeishuAllowlistMatch({
        allowFrom: ["*"],
        senderId: "ou_any",
      }).allowed,
    ).toBe(true);
  });

  it("resolves chat allowlist matches", () => {
    const chats = {
      oc_allowed: { requireMention: false },
      "*": { requireMention: true },
    };

    const direct = resolveFeishuChatMatch({ chats, chatId: "oc_allowed" });
    expect(direct.allowed).toBe(true);
    expect(resolveFeishuRequireMention(direct)).toBe(false);

    const wildcard = resolveFeishuChatMatch({ chats, chatId: "oc_other" });
    expect(wildcard.allowed).toBe(true);
    expect(resolveFeishuRequireMention(wildcard)).toBe(true);

    const denied = resolveFeishuChatMatch({ chats: { oc_allowed: {} }, chatId: "oc_other" });
    expect(denied.allowed).toBe(false);
  });

  it("applies nested group allowlists", () => {
    const allowed = resolveFeishuGroupAllow({
      groupPolicy: "allowlist",
      outerAllowFrom: ["ou_abc"],
      innerAllowFrom: ["ou_abc"],
      senderId: "ou_abc",
    });
    expect(allowed.allowed).toBe(true);

    const blocked = resolveFeishuGroupAllow({
      groupPolicy: "allowlist",
      outerAllowFrom: ["ou_abc"],
      innerAllowFrom: ["ou_abc"],
      senderId: "ou_other",
    });
    expect(blocked.allowed).toBe(false);
  });
});

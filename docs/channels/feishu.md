---
title: Feishu
description: 使用飞书服务端 SDK 的长连接模式把 Clawdbot 接入飞书（无需公网回调）
---

状态：官方扩展，走飞书服务端 SDK **长连接**，不需要公网 HTTP/HTTPS 回调。

## 安装

本仓库已自带 `extensions/feishu`，在源码环境执行：

```bash
clawdbot plugins install ./extensions/feishu
```

## 长连接模式概览

通过飞书官方 SDK 建立 WebSocket 长连接接收事件，无需暴露公网地址。

步骤概览：

1. 创建“企业自建”飞书应用，开启机器人能力。  
2. 权限（租户级）至少勾选：`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`；需发图片再加 `im:resource:upload`。  
3. 事件与回调 → 订阅方式选“使用长连接接收事件/回调”，事件订阅添加 `im.message.receive_v1`，保存并发布。  
4. 在 Clawdbot 填写凭证并启动网关。

## 配置

环境变量（推荐）：

```bash
export FEISHU_APP_ID="cli_your_app_id"
export FEISHU_APP_SECRET="your_app_secret"
export FEISHU_VERIFICATION_TOKEN="your_verification_token"
export FEISHU_ENCRYPT_KEY="your_encrypt_key"
# 提升 @ 识别准确度（可选）
export FEISHU_BOT_OPEN_ID="ou_your_bot_open_id"
```

或写入配置：

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_your_app_id"
    appSecretFile: "/path/to/feishu-app-secret.txt"
    verificationToken: "your_verification_token"
    encryptKey: "your_encrypt_key"
    botOpenId: "ou_your_bot_open_id"

    # 访问控制
    dmPolicy: "open"          # 默认 pairing，建议改为 open 直通
    allowFrom: ["*"]          # 私聊白名单，* 表示全员
    groupPolicy: "allowlist"
    groupAllowFrom: ["*"]     # 群聊白名单

    # 群聊单独配置（chat_id 形如 oc_xxx）
    chats:
      "oc_allowed_chat_id":
        requireMention: false  # 默认 true，设为 false 可无需 @
        enabled: true
        allowFrom: ["*"]
        skills:
          - "default"
        systemPrompt: "You are the Feishu chat assistant for this room."
```

说明：

- `appSecretFile` 运行时读取，避免明文写在配置里。  
- `--token-file` 在 `clawdbot channels add feishu` 中会映射到 `appSecretFile`。  

## 目标写法

- 群聊：`chat:oc_chat_id`  
- 私聊：`user:ou_open_id`  

`feishu:` / `lark:` 前缀可选，例如 `feishu:chat:oc_xxx`。

## 提及策略

群聊默认要求 @（`requireMention=true`），可按需改为 false。设置 `botOpenId` 可提升原生 @ 识别准确度。

## 多账号

```yaml
channels:
  feishu:
    defaultAccount: "work"
    accounts:
      work:
        appId: "cli_work_app_id"
        appSecretFile: "/path/to/work-secret.txt"
      lab:
        appId: "cli_lab_app_id"
        appSecretFile: "/path/to/lab-secret.txt"
```

## 故障排查

- `clawdbot channels status --probe` 查看运行/连接状态。  
- 已连接但无消息：在飞书后台重新保存“长连接 + im.message.receive_v1”订阅，并确认权限已开。  
- 群聊不触发：检查是否仍要求 @，或 `botOpenId` 是否填写。  
- 端口冲突：默认 18789，可改 `gateway.port` 后重启。  

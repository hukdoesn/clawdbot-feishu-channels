# Clawdbot × 飞书Channel

本仓库聚焦：在国内环境用飞书应用长连接接入 Clawdbot，让团队可以直接在飞书对话和控制 Clawdbot，而不依赖 WhatsApp、Telegram 等境外渠道；同样适用于纯内网部署。

## 前置条件
- Node.js ≥ 22.12（已用 nvm 安装的 22.12.0 可以直接用）
- pnpm ≥ 8（仓库脚本用 pnpm）
- 已在飞书开发者后台创建 **企业自建应用** 并开启机器人能力

## 获取飞书必要信息
在飞书开放平台：
1) 「凭证与基础信息」抄下 **App ID / App Secret**  
2) 「事件安全」取 **Verification Token / Encrypt Key**  
3) 在「API 调试台」调用 `GET /bot/v3/info`，返回的 `bot.open_id` 作为 **Bot Open ID**  
4) 权限（租户级）至少勾选：`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:message.p2p_msg:readonly`；如需发图片再加 `im:resource:upload`
5) 「事件与回调」→ 订阅方式选 **使用长连接接收事件/回调**，事件订阅添加 **接收消息 `im.message.receive_v1`**，保存并发布到整个企业

## 本地安装与构建
```bash
git clone https://github.com/hukdoesn/clawdbot-feishu-channels.git
cd clawdbot-feishu-channels

pnpm install
pnpm ui:build   # 构建控制台前端
```

## 配置飞书长连接
推荐用环境变量（启动前导出）：
```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export FEISHU_VERIFICATION_TOKEN="xxx"
export FEISHU_ENCRYPT_KEY="xxx"
export FEISHU_BOT_OPEN_ID="ou_xxx"   # 建议填，提升 @ 识别
```

或直接写入配置（~/.clawdbot/clawdbot.json）：
```bash
pnpm clawdbot config set channels.feishu.enabled true
pnpm clawdbot config set channels.feishu.appId cli_xxx
pnpm clawdbot config set channels.feishu.appSecret xxx
pnpm clawdbot config set channels.feishu.verificationToken xxx
pnpm clawdbot config set channels.feishu.encryptKey xxx
pnpm clawdbot config set channels.feishu.botOpenId ou_xxx

# 放开全员/全群，私聊直通
pnpm clawdbot config set channels.feishu.allowFrom '["*"]'
pnpm clawdbot config set channels.feishu.groupAllowFrom '["*"]'
pnpm clawdbot config set channels.feishu.dmPolicy open
pnpm clawdbot config set channels.feishu.chats."*".requireMention false   # 群聊无需 @
```

## 启动后端网关
```bash
pnpm clawdbot gateway run --force
# 默认端口 18789，如被占用可加 --port <自定义>
```
终端应看到：
```
[feishu] [default] starting Feishu long connection provider
[info]: [ '[ws]', 'ws client ready' ]
```

## 启动前端控制台（可选，开发调试）
```bash
pnpm ui:dev   # Vite 前端，默认 http://localhost:5173
# 或直接使用上一步构建的 dist 由网关提供：http://127.0.0.1:18789/
```

## 通用向导（configure）
非交互配置也可以用向导一步步填：
```bash
pnpm clawdbot configure
```
按提示选择模型（Kimi/Moonshot）、飞书渠道、鉴权信息。向导会写入 `~/.clawdbot/clawdbot.json`，完成后重启网关生效。

## 重启网关
- 开发模式（前台）：`pnpm clawdbot gateway run --force`
- 端口占用时：`pnpm clawdbot gateway run --force --port 19001`
- 如需确认只有一个进程：`lsof -iTCP:18789 -sTCP:LISTEN` 查看占用；必要时结束旧进程后再启动。

## 验证
1) 查看渠道状态：
```bash
pnpm clawdbot channels status --probe --json --no-color | jq '.channels.feishu'
```
`running:true`、`connected:true` 即长连接正常。  
2) 在飞书私聊机器人或群里发消息（无需 @），应收到回复。  
若无响应：  
- 在飞书后台重新保存“长连接 + im.message.receive_v1”订阅（确保网关进程在跑）  
- 检查权限是否勾全  
- 查看日志 `/tmp/feishu-debug.log` 或终端里 `feishu: inbound event ...` 是否出现

## 目标写法（手动发送时）
- 群聊：`chat:oc_chat_id`  
- 私聊：`user:ou_open_id`  
`feishu:` / `lark:` 前缀可选，如 `feishu:chat:oc_xxx`。

## 常见问题
- **已连接但没消息**：通常是飞书后台订阅未保存成功，或代理/DNS 阻塞到 `open.feishu.cn`。  
- **群里不触发**：检查 `requireMention` 是否仍为 true，或 `botOpenId` 是否填写。  
- **端口占用**：用 `pnpm clawdbot gateway run --force --port 19001` 改端口。

## 效果图

![飞书对话示例 ](image.png)

---
飞书长连接无需公网回调，按本文完成配置并保持网关运行，即可在企业内直接用飞书与 Clawdbot 对话。若遇到问题，先看 `channels status --probe` 与终端的 Feishu 调试日志。 

# 飞书话题群双向适配设计

**Date**: 2026-05-08
**Status**: Draft -> 待用户审批
**Depends on**: 2026-04-30-telegram-direct-topics-design.md

## 1. 背景与目标

quadtodo 当前已经支持 Telegram supergroup + Forum Topic：每个 task 一个独立 topic，AI 输出和用户回复都按 `message_thread_id` 路由。用户希望飞书也能提供接近一致的手机端体验。

飞书 OpenAPI 调研结果：

- 群支持 `group_message_type: "thread"`，即话题消息模式。
- 发送群消息使用 `POST /open-apis/im/v1/messages?receive_id_type=chat_id`。
- 回复消息支持 `POST /open-apis/im/v1/messages/{message_id}/reply`，请求体可带 `reply_in_thread: true`。
- 消息响应可能返回 `message_id`、`thread_id`、`message_app_link`。
- 事件订阅可监听 `im.message.receive_v1`。

核心目标：

1. 飞书目标群必须是话题群，避免普通群降级导致体验偏离 Telegram。
2. 每个 task 在飞书话题群中对应一个话题：用任务主消息作为话题根消息。
3. AI Stop / SessionEnd 输出回复到对应飞书话题。
4. 用户在飞书话题内回复时，quadtodo 将内容写回对应 PTY stdin。
5. 支持从飞书群主流发起新任务，走现有 wizard 创建 todo + AI session。
6. Telegram 现有行为不回归。

非目标：

- 不模拟飞书 UI 层面的关闭/锁定话题；飞书 OpenAPI 未发现 Telegram `closeForumTopic` 等价能力。
- 不在第一版支持飞书交互卡片按钮；wizard 先用纯文本数字选择。
- 不自动把已有飞书群改成话题群；可检测并提示，由用户决定是否手动改造或后续单独实现设置入口。

## 2. 用户体验

### 2.1 从飞书群发起任务

用户在飞书话题群主流发：

```text
帮我做 修复配置保存问题
```

quadtodo 事件订阅收到 `im.message.receive_v1`，交给现有 wizard。wizard 询问工作目录、象限、模板。完成后：

1. 创建 todo。
2. 启动 AI session。
3. 在同一个飞书话题群发送任务主消息：

```text
#t123 修复配置保存问题
AI 已启动，后续输出会回复在这个话题里。
```

4. 保存这条主消息返回的 `message_id` / `thread_id` / `message_app_link` 到 session route。
5. 在发起任务的主流回复用户：

```text
todo #t123 已建，后续请到话题「#t123 修复配置保存问题」查看进度。
```

### 2.2 AI 输出

Claude Code Stop hook 触发后，quadtodo 将最新 assistant turn 回复到该任务主消息：

```text
POST /open-apis/im/v1/messages/{rootMessageId}/reply
{
  "msg_type": "text",
  "content": "{\"text\":\"...AI 输出...\"}",
  "reply_in_thread": true
}
```

### 2.3 用户继续对话

用户在任务话题里回复：

```text
继续，顺便补测试
```

事件订阅收到消息，按 `thread_id` 或 `root_id/parent_id` 找到对应 session，写入 PTY：

```text
继续，顺便补测试\r
```

quadtodo 不需要额外 ack；下一轮 AI 输出仍回复到同一飞书话题。

### 2.4 任务结束

SessionEnd hook 在同一飞书话题回复：

```text
任务已结束
```

如果用户之后继续在这个飞书话题回复，quadtodo 不写入 PTY，回复：

```text
这个任务已结束，请在群里重新发起任务。
```

## 3. 架构

新增飞书通知通道，但尽量复用 Telegram 已经验证的 route / wizard / hook 流程。

```text
飞书话题群
  主流消息 -> lark event subscriber -> wizard.handleInbound({ channel: 'lark', chatId, threadId: null, messageId, text })
  话题回复 -> lark event subscriber -> wizard.handleInbound({ channel: 'lark', chatId, threadId, rootMessageId, messageId, text })

quadtodo
  src/lark-bot.js
    - sendMessage(chatId, text)
    - replyInThread(rootMessageId, text)
    - subscribeEvents() / stop()
    - normalize inbound event

  src/openclaw-wizard.js
    - route key 加 channel，避免 telegram/lark/weixin ID 碰撞
    - finalizeWizard 支持 lark 主消息建话题
    - stdin proxy 可用 lark thread route 查 session

  src/openclaw-bridge.js
    - sessionRoute 支持 channel: 'lark'
    - postText 对 lark 走 larkBot.replyInThread

  src/openclaw-hook.js
    - 沿用 postText，SessionEnd 对 lark 只发结束消息，不 close topic
```

## 4. 数据模型与路由

### 4.1 Session route

扩展现有 `openclaw.registerSessionRoute(sessionId, route)`。Telegram 继续使用原字段，Lark 增加字段：

```js
{
  channel: 'lark',
  targetUserId: 'oc_xxx',
  threadId: 'omt_xxx',
  rootMessageId: 'om_xxx',
  topicName: '#t123 修复配置保存问题',
  messageAppLink: 'https://.../client/thread/open?...'
}
```

字段语义：

- `targetUserId`：沿用旧命名，Lark 下实际是 `chat_id`。
- `threadId`：飞书话题 ID，优先用于入站路由。
- `rootMessageId`：任务主消息 ID，出站 reply API 使用。
- `topicName`：展示用标题。
- `messageAppLink`：可选，给用户跳转到话题。

### 4.2 Route key

现有 `makeRouteKey(chatId, threadId)` 需要升级为包含 channel：

```js
function makeRouteKey(channel, chatId, threadId) {
  return `${channel || 'openclaw'}:${chatId}:${threadId || 'general'}`
}
```

兼容策略：

- Telegram 入站传 `channel: 'telegram'`。
- Lark 入站传 `channel: 'lark'`。
- OpenClaw 微信旧路径不传 channel，默认 `openclaw`。

### 4.3 入站路由查找

新增或扩展 `openclaw.findSessionByRoute({ channel, targetUserId, threadId, rootMessageId })`：

- Lark 优先按 `channel === 'lark' && targetUserId === chatId && threadId === incomingThreadId` 查。
- 如果事件只有 `root_id` / `parent_id`，再按 `rootMessageId` 查。
- Telegram 继续按 `targetUserId + threadId` 查。

## 5. 飞书 Bot 模块

新增 `src/lark-bot.js`，职责限定为飞书 API 与事件适配，不承载 wizard 业务逻辑。

### 5.1 API 表面

```js
export function createLarkBot({ getConfig, wizard, logger, spawnFn }) {
  return {
    start(),
    stop(),
    describe(),
    sendMessage({ chatId, text, msgType }),
    replyInThread({ rootMessageId, text, msgType }),
    handleEvent(event),
  }
}
```

### 5.2 出站发送

第一版使用 `lark-cli`，而不是直接手写 token 获取逻辑：

- `sendMessage` 调用：
  ```bash
  lark-cli im +messages-send --chat-id <oc_xxx> --text <text> --as bot
  ```
- `replyInThread` 调用：
  ```bash
  lark-cli im +messages-reply --message-id <om_xxx> --text <text> --reply-in-thread --as bot
  ```

原因：

- 现有环境已有 `lark-cli`。
- `lark-cli` 负责 tenant access token、scope 错误提示、内容 JSON 包装。
- 先避免把飞书鉴权逻辑引入 quadtodo。

### 5.3 事件订阅

`start()` 启动子进程：

```bash
lark-cli event +subscribe --event-types im.message.receive_v1 --compact --as bot
```

处理规则：

1. stdout 按 NDJSON 逐行解析。
2. 忽略解析失败行，记录 warn。
3. 忽略 bot 自己发送的消息，避免自回环。
4. 只接受配置中的 `lark.chatId`。
5. 提取文本、`chat_id`、`message_id`、`thread_id`、`root_id`、`parent_id`。
6. 调用 `wizard.handleInbound({ channel: 'lark', chatId, threadId, rootMessageId, messageId, text })`。
7. 如果 wizard 返回 `reply`，按上下文回复：
   - 有 `rootMessageId`：`replyInThread(rootMessageId, reply)`。
   - 无 `rootMessageId`：`sendMessage(chatId, reply)`。

断线策略：

- 子进程退出后，如果 `lark.enabled` 仍为 true，5 秒后重启。
- `stop()` 终止子进程并阻止重启。
- 重复事件第一版用 `message_id` 做内存去重，保留最近 500 条。

## 6. 配置

新增默认配置段：

```json
{
  "lark": {
    "enabled": false,
    "chatId": "",
    "requireThreadGroup": true,
    "eventSubscribeEnabled": true,
    "notificationCooldownMs": 600000
  }
}
```

字段说明：

- `enabled`：启用飞书适配。
- `chatId`：目标飞书群 ID，格式 `oc_xxx`。
- `requireThreadGroup`：第一版固定建议 true；如果检测到不是话题群，bot 不启动并给日志提示。
- `eventSubscribeEnabled`：是否启动双向事件订阅。
- `notificationCooldownMs`：后续如需要对 idle notification 单独节流；第一版沿用 hook 默认策略即可。

## 7. 与现有 Telegram 的差异

| 能力 | Telegram | 飞书 |
|---|---|---|
| 创建任务隔离区 | `createForumTopic` | 发送任务主消息形成话题 |
| 路由 ID | `message_thread_id` | `thread_id` + `rootMessageId` |
| AI 输出 | `sendMessage` 带 thread id | `messages/{rootMessageId}/reply` + `reply_in_thread` |
| 用户入站 | getUpdates | event +subscribe |
| 结束后关闭 | `closeForumTopic` | 无等价 API，只发结束消息并在本地拒绝写入 |
| 改名 | `editForumTopic` | 无等价 API，主消息内容不改 |

## 8. 错误处理

- 飞书未启用：不启动 lark bot，不影响 Telegram。
- `chatId` 缺失：启动时 warn，`describe()` 返回 misconfigured。
- `lark-cli` 不存在：启动时 warn，飞书功能不可用，不影响主服务。
- 权限不足：保留 `lark-cli` stderr，日志中提示需要检查 bot scope 和是否入群。
- 发送失败：hook 返回飞书失败原因，但不影响 Telegram 路径。
- 入站找不到 session：如果是话题回复，回复“没有找到对应运行中的任务”；如果是主流消息且不是新任务触发词，走 wizard 现有 fallback。
- SessionEnd 后继续回复：回复“这个任务已结束，请在群里重新发起任务”。

## 9. 测试策略

单元测试优先，不依赖真实飞书：

1. `test/lark-bot.test.js`
   - `sendMessage` 生成正确 `lark-cli im +messages-send` 参数。
   - `replyInThread` 生成正确 `lark-cli im +messages-reply --reply-in-thread` 参数。
   - `handleEvent` 能从消息事件提取 chat/thread/root/text 并调用 wizard。
   - bot 自消息被忽略。
   - 重复 `message_id` 被去重。

2. `test/openclaw-bridge.test.js`
   - `registerSessionRoute` 保留 lark 的 `rootMessageId/threadId/messageAppLink`。
   - `postText` 对 `channel: 'lark'` 调用 `larkBot.replyInThread`。
   - lark route 缺 `rootMessageId` 时拒绝发送，不落到 OpenClaw CLI。

3. `test/openclaw-wizard.test.js`
   - Lark 主流消息可启动 wizard。
   - Lark finalizeWizard 会发任务主消息并注册 route。
   - Lark 话题回复能通过 route 写入对应 PTY。
   - 已结束 session 不写 PTY。

4. 回归测试：
   - Telegram 现有测试继续通过。
   - `npm test` 全量通过。

## 10. 验收标准

1. 飞书话题群主流发起任务后，能创建 todo、启动 AI session、发送任务主消息。
2. AI Stop 输出进入该任务飞书话题，不出现在其他任务话题。
3. 用户在该飞书话题内回复，内容写入对应 PTY stdin。
4. 多任务并行时，多个飞书话题互不串线。
5. SessionEnd 在同一飞书话题内发结束消息。
6. 已结束话题继续回复不会写入已结束 PTY。
7. 飞书事件订阅断开后会重启，重复事件不会重复写入。
8. 飞书配置错误、权限不足或 CLI 不存在时，Telegram 和本地任务不受影响。
9. 现有 Telegram Topic 双向流程测试保持通过。

# quadtodo 直连 Telegram + 每任务一个 Topic

**Date**: 2026-04-30
**Status**: Draft → 待用户审批
**Depends on**: 2026-04-29-openclaw-quadtodo-bridge-design.md, 2026-04-29-claude-hooks-proactive-push-design.md

## 1. 背景与目标

当前 quadtodo + Telegram 单聊天体验：
- 所有 task 都在一个 chat 里，靠 `[#tNN]` ticket 切换 → 心智负担
- 入站消息走 OpenClaw skill：用户消息 → Telegram → OpenClaw 长轮询 → DeepSeek V4 Flash 模型判断要不要触发 skill → exec quadtodo CLI → wizard
  - 每一步引入 5-10s 延迟
  - 模型偶尔判错（之前观察过"已转给 ai" 的失败链路）
  - **OpenClaw 不暴露 Telegram `message_thread_id` 给 skill** —— Topic 路由没法做

### 目标
1. **每开一个 task 自动建一个 Telegram Topic**（论坛主题），物理隔离对话
2. **绕过 OpenClaw 的 inbound 模型层**：quadtodo 直接 getUpdates 长轮询 Telegram，自己路由
3. 所有 task 在一个 supergroup 里集中管理，但每个 task 有独立 topic
4. 任务结束自动 close topic（保留可查看，禁止新消息）

### 用户决策（已记录）
- Q1: Topic 名 = `#tNN 标题`（短码 + 标题）
- Q2: 任务结束 → `closeForumTopic` 关闭（Telegram 没有"归档分组"概念，close 是最接近的）
- Q3: 智能模式 — General topic 里只在触发词命中时才进 wizard
- Q4: quadtodo 直连 Telegram bot（不经 OpenClaw）
- 选 A：禁用 OpenClaw 的 telegram channel，quadtodo 独占 bot
- **Hook 推送内容来源**：从 Claude Code 的 jsonl 日志读，不从 PTY 输出读（避开 spinner/ANSI 噪声）
- **长度处理**（B）：≤ 4000 字 inline 直发；> 4000 字 inline 顶部 800 字 + 完整 `.md` 文件附件
- **SessionEnd**：额外推整段 transcript（所有 turn）的 `.md` 文件附件

---

## 2. 架构

```
┌─ Telegram supergroup ─────────────────────────────┐
│                                                    │
│  General topic（默认）            ← 控制中心        │
│  • 用户："帮我做 X"                                │
│  • bot：多轮向导（目录/象限/模板）                  │
│  • bot："✅ todo #42 已建 → 去 topic «#tNN ...»"   │
│  • 用户："列表" / "状态"                            │
│                                                    │
│  Topic: #t42 修复 login bug      ← 任务 1 独立     │
│  • bot 创建：欢迎消息 + AI 启动信息                 │
│  • bot 推：Stop hook（AI 一轮回话）                 │
│  • 用户回 → 写 PTY stdin                            │
│  • bot 推：SessionEnd → 自动 close topic            │
│                                                    │
│  Topic: #tab8 重构 X             ← 任务 2 独立     │
│                                                    │
└────────────────────────────────────────────────────┘
       ↑↓ HTTPS Bot API
┌─ quadtodo (127.0.0.1:5677) ────────────────────────┐
│  + src/telegram-bot.js（新建）                      │
│      - getUpdates 长轮询 → 派发到 wizard            │
│      - createForumTopic / closeForumTopic           │
│      - sendMessage（带 message_thread_id）          │
│  + src/openclaw-wizard.js（改）                     │
│      - 路由 key 改 (chatId, threadId)               │
│  + src/openclaw-bridge.js（改）                     │
│      - sendViaTelegramAPI 接受 threadId             │
│  + src/openclaw-hook.js（改）                       │
│      - 拿 sessionRoute.threadId 推到正确 topic      │
│  + DB（不改）                                        │
│      - sessionRoutes 内存表已经能存 threadId         │
└────────────────────────────────────────────────────┘
```

---

## 3. 关键时序

### 启动新任务

```
用户 (General topic): "帮我做 写个 demo"
    │ telegram getUpdates
    ↓
quadtodo telegram-bot
    │ wizard.handleInbound({chatId, threadId=null/general, text})
    ↓
wizard 在 General 跑多轮（选目录/象限/模板）
    │ 每条 reply：sendMessage(chatId, threadId=general, text)
    ↓
finalizeWizard → 创建 todo
    │
    ├─ 调 createForumTopic({chatId, name: "#t42 修复 login bug"})
    │     → 拿 message_thread_id
    │
    ├─ start_ai_session（已有）
    │     → 拿 sessionId
    │     → openclaw.registerSessionRoute(sessionId, {targetUserId: chatId, threadId})
    │
    ├─ sendMessage(chatId, new threadId): "🤖 任务「X」AI 已启动 (Claude Code)"
    │
    └─ sendMessage(chatId, general): "✅ todo #42 已建 → 去 topic «#t42 ...» 看进度"
```

### 任务运行

```
AI Stop hook fire
    → quadtodo /api/openclaw/hook
    → openclaw-bridge.postText(sessionId, message)
    → resolve 这个 session 的 route → {targetUserId, threadId}
    → sendViaTelegramAPI(token, chatId=targetUserId, threadId, text=message)
    → Telegram 推到那个 topic ✓

用户在 task topic 里回 "c"
    → telegram getUpdates 拿到（带 message_thread_id）
    → wizard.handleInbound({chatId, threadId=task topic id, text="c"})
    → wizard 看 (chatId, threadId) 没 active wizard / pending ask_user
    → fallback 走 stdin proxy
    → 怎么找 PTY session？
    → 反向查 sessionRoutes：找 (targetUserId=chatId, threadId=current threadId) 的 sessionId
    → pty.write(sessionId, "c\r")
    → 静默成功（reply: ''）
```

### 任务结束

```
PTY 退出 → SessionEnd hook fire
    → openclaw-hook.handle({event: 'session-end', sessionId, ...})
    → 推 "✅ 任务完成" 到 topic
    → openclaw.clearLastPushForSession(sessionId)
    → 新增：调 telegram-bot.closeForumTopic(chatId, threadId)
    → 新增：调 telegram-bot.editForumTopic({name: "✅ #t42 ...", ...})
    → 新增：openclaw.clearSessionRoute(sessionId)
```

---

## 4. 路由 key 设计

### 当前
- `wizards: Map<peer, state>` 其中 peer = chatId（单一字符串）
- `sessionRoutes: Map<sessionId, {targetUserId, ...}>`
- `lastPushByPeer: Map<peer, {sessionId, sentAt}>`

### 改造后
- `wizards: Map<routeKey, state>`，`routeKey = '${chatId}:${threadId||"general"}'`
- `sessionRoutes: Map<sessionId, {targetUserId, threadId, ...}>` —— 加 threadId
- `lastPushByPeer: Map<routeKey, {sessionId, sentAt}>` —— peer 同步换成 routeKey

每条入站 / 出站消息都有 (chatId, threadId) 二元组。General topic 用特殊 sentinel `'general'` 或 `null`。

### 重要约束
**General topic 里启动的 wizard，state 也存在 General 路由 key 下**。
任务创建后，新 topic 的 routeKey 是新的 (chatId, newThreadId)；
此时 General topic 的 wizard state 自动结束（finalizeWizard 删除）。

---

## 5. Telegram Bot 模块（src/telegram-bot.js）

### API 表面

```js
createTelegramBot({
  getConfig,            // () => 当前 quadtodo 配置（拿 token）
  wizard,               // { handleInbound({chatId, threadId, text, fromUserId}) → {reply, ...} }
  logger,
  // 测试用注入：
  fetchFn,              // (url, opts) → Promise（默认 undici fetch + ProxyAgent）
}) → {
  start(),              // 启动 getUpdates 长轮询
  stop(),               // 停止长轮询
  sendMessage({chatId, threadId, text, parseMode='Markdown'}),       // 出站
  sendDocument({chatId, threadId, filePath, caption?}),              // 发文件附件（transcript .md）
  createForumTopic({chatId, name, iconColor?}),                       // 建 topic
  closeForumTopic({chatId, threadId}),                                // 锁 topic
  editForumTopic({chatId, threadId, name?, iconCustomEmojiId?}),      // 改 topic
  describe(),           // 状态快照（offset / errors / etc）
}
```

### 长轮询循环

```js
async function pollLoop() {
  let offset = 0
  while (running) {
    try {
      const updates = await call('getUpdates', {
        offset,
        timeout: 30,        // 长轮询 30s
        allowed_updates: ['message'],
      })
      for (const u of updates) {
        offset = u.update_id + 1
        await dispatch(u)   // 不阻塞下一条 — 但顺序处理（避免乱序）
      }
    } catch (e) {
      logger.warn('[telegram-bot] poll error:', e.message)
      await sleep(5000)   // 出错时退避
    }
  }
}
```

### 入站 dispatch

```js
async function dispatch(update) {
  const msg = update.message
  if (!msg || !msg.text) return  // 暂只处理文本
  const chatId = String(msg.chat.id)
  const threadId = msg.message_thread_id || null  // null 表示 General
  const fromUserId = String(msg.from.id)
  const text = msg.text

  // 安全：只处理白名单 chat
  if (!isAuthorizedChat(chatId)) {
    logger.warn(`[telegram-bot] ignored message from unauthorized chat ${chatId}`)
    return
  }

  const result = await wizard.handleInbound({ chatId, threadId, text, fromUserId })
  if (result?.reply) {
    await sendMessage({ chatId, threadId, text: result.reply })
  }
}
```

### 安全：白名单
- `config.telegram.allowedChatIds: ['-1001234567890']`（你的 supergroup ID）
- 启动时校验，运行时 dispatch 拒掉不在白名单的 chat
- 未配置时默认拒所有（不允许任意人 DM 你的 bot）

---

## 6. wizard 改造点

`src/openclaw-wizard.js`：

```diff
- function startWizard(peer, text) { ... wizards.set(peer, w) }
+ function makeRouteKey(chatId, threadId) { return `${chatId}:${threadId || 'general'}` }
+ function startWizard(chatId, threadId, text) {
+   const key = makeRouteKey(chatId, threadId)
+   wizards.set(key, w)
+ }

- async function handleInbound({ peer, text } = {}) { ... }
+ async function handleInbound({ chatId, threadId, text, fromUserId } = {}) {
+   const routeKey = makeRouteKey(chatId, threadId)
+   ...
+ }
```

**finalizeWizard 改造**（任务创建时建 topic）：

```js
async function finalizeWizard(w) {
  // 1. 创建 todo（已有）
  const todo = db.createTodo({...})

  // 2. **新增**：创建 Telegram Topic
  let newThreadId = null
  if (telegramBot && w.chatId) {
    try {
      const shortCode = String(todo.id).slice(-3)
      const topicName = `#t${shortCode} ${w.title}`.slice(0, 128)  // Telegram 限制
      const topic = await telegramBot.createForumTopic({
        chatId: w.chatId,
        name: topicName,
      })
      newThreadId = topic.message_thread_id
    } catch (e) {
      logger.warn(`[wizard] createForumTopic failed: ${e.message}; will fall back to General`)
    }
  }

  // 3. 启动 PTY，session route 带 threadId
  const sessionId = `ai-${Date.now()}-${...}`
  openclaw.registerSessionRoute(sessionId, {
    targetUserId: w.chatId,
    threadId: newThreadId,    // ← 新增
    channel: 'telegram',
  })
  aiTerminal.spawnSession({...})

  // 4. **新增**：往新 topic 推欢迎消息
  if (newThreadId) {
    telegramBot.sendMessage({
      chatId: w.chatId,
      threadId: newThreadId,
      text: `🤖 任务「${w.title}」 AI 已启动 (Claude Code)\n\nAI 一轮结束/卡住时会推到这里。直接回复任意文本会写进 PTY stdin。`,
    }).catch(() => {})
  }

  // 5. General 推 ack（已有，文案改一下）
  return {
    reply: newThreadId
      ? `✅ todo #${shortCode} 已建 → 去 topic «#t${shortCode} ${w.title}» 看进度`
      : `✅ todo #${shortCode} 已建（无 topic — bot 没建 topic 权限）`,
    action: 'wizard_done',
    todoId: todo.id,
    threadId: newThreadId,
  }
}
```

---

## 7. openclaw-bridge 改造

`sendViaTelegramAPI` 接受 threadId：

```diff
- async function sendViaTelegramAPI({ token, chatId, text }) {
-   ...body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
+ async function sendViaTelegramAPI({ token, chatId, threadId, text }) {
+   const body = { chat_id: chatId, text, parse_mode: 'Markdown' }
+   if (threadId) body.message_thread_id = threadId
+   ...JSON.stringify(body)
}
```

`postText` 拿 sessionRoute.threadId 传下去（已经存在 sessionRoutes 里的 threadId 字段）。

---

## 8. openclaw-hook 改造

### 8.1 内容来源大换血：从 Claude Code jsonl 读，不从 PTY 读

**问题**：PTY `recentOutput` 全是 spinner/ANSI/状态行（`Frolicking… running stop hook · 47s · ↓683 tokens`），过滤永远清不干净。

**解法**：每次 hook fire，从 Claude Code 自己的 jsonl 日志读结构化消息：
- 路径：`~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl`
- 复用现有 `pty.findClaudeSession(nativeId)` → 拿 filePath
- 每行一个 JSON 对象：`{"type":"user"\|"assistant", "message":{"role":..., "content":[{"type":"text"\|"tool_use"\|"tool_result", ...}]}, ...}`

```js
// src/claude-transcript.js（新模块）
function readLatestAssistantTurn(jsonlPath) {
  // 反向读文件，找到最后一条 type=assistant
  // 提取 message.content：
  //   - type:'text' → 直接取 text
  //   - type:'tool_use' → 摘要 "🔧 调用 Bash: <command前 80 字>"
  //   - type:'tool_result' → 略（user 消息不算这一轮的）
  // 返回 { text, isLong, raw }
}

function buildFullTranscript(jsonlPath) {
  // 全文件 → 渲染成 markdown
  // 用户消息：> ...
  // 助手消息：## ...
  // 工具调用：```\n<tool>: <input>\n```
  // 返回 markdown 字符串
}
```

### 8.2 hook handler 改造

```js
async function handle({ event, sessionId, todoId, todoTitle, hookPayload }) {
  // ... cooldown / pending suppression（不变）...

  // 新：从 Claude jsonl 读内容
  const session = aiTerminal?.sessions?.get(sessionId)
  const nativeId = session?.nativeSessionId
  let inlineText = ''
  let attachmentPath = null

  if (nativeId && pty?.findClaudeSession) {
    const loc = pty.findClaudeSession(nativeId)
    if (loc?.filePath) {
      const turn = await readLatestAssistantTurn(loc.filePath)
      if (turn.text.length <= 4000) {
        inlineText = turn.text                                        // 短：全 inline
      } else {
        inlineText = turn.text.slice(0, 800) + '\n\n…（完整内容见附件）' // 长：800 头 + 文件
        attachmentPath = await writeTranscriptFile(loc.filePath, sessionId, 'turn')
      }

      // SessionEnd 额外发完整 session transcript
      if (evt === 'session-end') {
        attachmentPath = await writeTranscriptFile(loc.filePath, sessionId, 'full')
      }
    }
  }

  // 拼消息（buildMessage 仍然加 [#tNN] 头部 + 标题）
  const message = buildMessage({ event, todoId, todoTitle, snippet: inlineText })

  // 新：postText 接受可选 attachment
  await openclaw.postText({ sessionId, message, attachment: attachmentPath })

  // SessionEnd 时 close topic
  if (evt === 'session-end') {
    const route = openclaw.resolveRoute(sessionId)
    if (route?.threadId && telegramBot) {
      telegramBot.closeForumTopic({ chatId: route.targetUserId, threadId: route.threadId }).catch(() => {})
      const newName = `✅ ${route.topicName || (todoTitle ? '#tNN ' + todoTitle : 'task')}`
      telegramBot.editForumTopic({ chatId: route.targetUserId, threadId: route.threadId, name: newName }).catch(() => {})
    }
    openclaw.clearLastPushForSession(sessionId)
    openclaw.clearSessionRoute(sessionId)
  }
}
```

### 8.3 transcript 文件管理

- 临时文件路径：`~/.quadtodo/tmp/transcript-<sessionId>-<timestamp>-{turn|full}.md`
- 上传 Telegram 后保留 24 小时（方便 debug）
- 异步清理：每次启动 quadtodo 时扫一次，删 24h+ 的

### 8.4 sessionRoute 加字段

为了拿"当前 topic name"做 `✅` 前缀，sessionRoute 多存一个 `topicName`：

```js
openclaw.registerSessionRoute(sessionId, {
  targetUserId: chatId,
  threadId: newThreadId,
  topicName: `#t${shortCode} ${title}`,   // ← 新增
  channel: 'telegram',
})
```

---

## 9. 配置

`~/.quadtodo/config.json` 新增段：

```json
{
  "telegram": {
    "enabled": false,
    "supergroupId": "",
    "longPollTimeoutSec": 30,
    "useTopics": true,
    "createTopicOnTaskStart": true,
    "closeTopicOnSessionEnd": true,
    "topicNameTemplate": "#t{shortCode} {title}",
    "topicNameDoneTemplate": "✅ {originalName}",
    "allowedChatIds": [],     // 安全白名单；空 = 拒所有
    "allowedFromUserIds": []  // （可选）只允许特定用户的消息触发；空 = 不限
  }
}
```

token 仍从 `~/.openclaw/openclaw.json` 读（已有逻辑）。

---

## 10. 用户 setup 步骤

一次性：
1. **建 supergroup**：在 Telegram 里 → New Group → 加任意一个人 → 升级成 Supergroup（自动 / 设置）
2. **启用 Topics**：Group settings → Topics → ON
3. **加 bot**：把 `@lzhtestBot` 加进去，给 admin 权限，勾选 `Manage topics` + `Send messages`
4. **拿 supergroup ID**：用户在 General 里随便发一条，bot 长轮询 getUpdates 拿到 chat.id（负数，形如 `-1001234567890`）。第一次 bot 跑起来后会在日志输出 chat.id，让用户拿
5. **配 quadtodo**：
   ```bash
   quadtodo config set telegram.enabled true
   quadtodo config set telegram.supergroupId <chat_id>
   quadtodo config set telegram.allowedChatIds.0 <chat_id>
   ```
6. **禁用 OpenClaw 的 telegram channel**（避免 getUpdates 抢消息）：
   ```bash
   openclaw config set channels.telegram.enabled false
   openclaw gateway --force
   ```
7. **重启 quadtodo**

---

## 11. 与既有 OpenClaw 路径共存

OpenClaw 仍处理 weixin / imessage / 其他 channel 的入站。
- `openclaw-wizard.handleInbound` 通过 OpenClaw skill exec CLI 入站时，传的是 `--from <peer>` —— 我们让它继续工作（`peer` → `chatId`，`threadId=null`）
- 出站：weixin 走 openclaw CLI fallback；telegram 走 fast-path（已有）

Telegram 的 inbound 完全 quadtodo 直接处理，OpenClaw 不参与。

---

## 12. 风险 & 兜底

| 风险 | 缓解 |
|---|---|
| Telegram bot token 暴露 | 白名单 chatIds 限制，恶意人即使知道 bot 也无法触发 |
| createForumTopic 失败（权限不足） | 静默降级到 General topic，wizard 仍能完成 |
| 长轮询断流（网络抖动） | 5s 退避重试，offset 持久化（重启不丢消息） |
| 同一个 bot 被两端长轮询（OpenClaw + quadtodo） | step 6 setup 强制禁用 OpenClaw telegram |
| Topics 上限（一个 supergroup 上限 1024 个 topics）| 任务结束 close 不删除，1024 个 active 任务级别才会撞 |
| 用户回复非文本（语音/图片） | v1 暂不处理，回 fallback "暂只支持文本"；future 加图片识别 |
| getUpdates offset 持久化 | 写到 `~/.quadtodo/telegram-offset.json`；重启从那继续 |

---

## 13. 验收标准

**P0**：
1. quadtodo 启动 → telegram-bot 长轮询起来 → log 里 "Telegram bot listening, supergroup=-100xxx"
2. 在 General 发 "帮我做：写个 demo" → 1-2s 收到 "📁 选个工作目录..."
3. 选目录/象限/模板完成 → 创建 todo → 收到："✅ todo 已建 → 去 topic «#t42 ...»"
4. 切到 #t42 topic → 看到欢迎消息
5. AI 在 PTY 跑完一轮 → Stop hook → **#t42 topic** 收到推送（不是 General），**内容是 Claude Code jsonl 里的最后一条 assistant 消息全文**（不是 PTY spinner 噪声）
6. 长 turn（> 4000 字）→ 收到 inline 顶部 800 字 + `.md` 文件附件
7. 在 #t42 回 "c" → 写进 PTY → AI 又一轮 → 又推到 #t42
8. 在另一个 task topic 回话 → 路由到那个 task 的 PTY，互不打扰
9. PTY 退出 → SessionEnd hook → topic close + 标题加 ✅ 前缀 + 整段 transcript .md 文件附件

**P1**：
9. quadtodo 重启后 offset 不丢，未读消息能消费
10. doctor 加 telegram 检查（token 可读、bot getMe 通、supergroup 可达）
11. 安全：从未授权的 chatId 发的消息不进 wizard（log 拒掉）

**P2**：
12. 用 Telegram inline keyboard 给 ask_user 出按钮（替代纯文本数字）
13. 长消息自动拆条（Telegram 单条 4096 字符上限）
14. 图片消息支持（推送 / inbound）

---

## 14. 实施分阶段

| Stage | 范围 | 验证 |
|---|---|---|
| **T1: telegram-bot 模块** | getUpdates 长轮询 + sendMessage + sendDocument + createForumTopic + closeForumTopic + editForumTopic + 单测 | 单测覆盖 mock fetch 各 API |
| **T2: claude-transcript 模块** | readLatestAssistantTurn / buildFullTranscript（解析 ~/.claude/projects 的 jsonl）+ 单测 fixture | 单测：给一个真实 jsonl 样本，extract last turn 文本符合预期 |
| **T3: wizard 改造** | routeKey 改 (chatId, threadId) + finalizeWizard 建 topic + sessionRoute 加 topicName | 测试覆盖 General + topic 双场景 |
| **T4: bridge / hook 改造** | sendViaTelegramAPI 加 threadId + postText 加 attachment 参数 + hook 改用 transcript 源 + close topic on SessionEnd | 集成测试 |
| **T5: server.js 串起来** | 启动 telegram-bot + 注入到 wizard / hook | quadtodo 启动 log 看到 bot listening |
| **T6: 配置 + setup 文档** | config 段 + doctor 检查 + setup 步骤写到 docs/ | doctor 全 ✓ |
| **T7: 端到端验证** | P0 8 条全过 + 长输出附件验证 | 手动在 Telegram 跑一遍 |

---

## 15. 关键设计决策记录

| 决策 | 选 | 理由 |
|---|---|---|
| inbound 走哪 | quadtodo 直连 Telegram getUpdates | 绕过 OpenClaw 的 LLM 判断层；获得 thread_id；秒级响应 |
| outbound 走哪 | quadtodo 直连 sendMessage | 已实现 fast-path；1-3s vs CLI 30s |
| 一任务一 topic？ | 是 | 用户明确诉求 |
| Topic 命名 | `#tNN 标题` | 用户选 A |
| 任务结束 topic | closeForumTopic + ✅ 前缀 | Telegram 没"归档分组"；这是最接近"归档"的 |
| OpenClaw telegram channel | 禁用 | 避免双方抢长轮询 |
| weixin / imessage | 继续走 OpenClaw | 不破坏现有流 |
| 路由 key | `${chatId}:${threadId\|\|'general'}` | 简单字符串，Map 友好 |
| Hook 内容来源 | Claude Code jsonl（不是 PTY recentOutput）| 完全干净，无 spinner/ANSI 噪声 |
| 长内容处理 | ≤4000 inline；>4000 inline 头部 + .md 附件 | 体验 + 完整性都顾 |
| Codex 支持？ | v1 不支持 | Codex jsonl 格式不同；v1 只覆盖 Claude Code |

# Claude Code busy 期间用户输入处理 — 设计

> **实施状态**：已于 2026-05-10 完成，见 `docs/superpowers/plans/2026-05-10-busy-session-input-handling.md`，dispatcher 单元测试 28/28，全量回归 1085/1085。

## 背景

当用户通过 Lark thread / Telegram peer-bound 路径继续给一个仍在干活的 Claude
Code session 发消息时，`src/openclaw-wizard.js:1261` 的 stdin proxy 分支会
直接 `pty.write(sid, payload)` 然后 80ms 后再写 `\r`——bot 这一层**完全没有
busy 检测**，行为黑盒地依赖 Claude Code TUI 的输入框语义：

- 现代 Claude Code TUI 中 busy 时的输入会显示 "▼ message queued"，回车把它
  排进下一轮——但用户在群里**完全感知不到**正在排队
- 如果 Claude 此刻正等 permission prompt（hooks / ask 之类），新消息可能
  被吃成对那个 prompt 的回答，造成误触
- 用户没法明确表达三种意图："补充上下文"、"算了听新的"、"完全停下"——只能
  发消息盲投

服务端其实已经有 busy/idle 信号——`openclaw-hook.js:631` 在 Claude 的
`Stop` 事件触发 `loadingTracker.markIdle()` + `aiTerminal.markSessionAwaitingReply(sid, true)`，
而 `openclaw-wizard.js:1254` 在 stdin 写入时调 `markRunning()`。也就是
per-session 的 awaiting-reply 状态在 `src/routes/ai-terminal.js` 的
session map 里随时可读，只是当前 wizard 不去查它。

## 目标

把"消息送到 busy session"这一动作从"裸 stdin write"升级为带语义的三档投递：

- **排队**（默认）：busy 时进队列，idle 时合并 flush
- **软中断**（`!` 前缀）：busy 时发 Esc 中断当前 turn → 投递新消息；丢弃旧队列
- **硬取消**（`!!` 前缀 / `/stop`）：busy 时发 Ctrl+C，不投递任何文本

并把上述行为统一收口到一个**中央调度器** `session-input-dispatcher.js`，作为所有
"往 session 投递用户输入"路径的唯一入口。

## 非目标

- 不改 PTY 内核（`src/pty.js` 不动）
- 不改 Claude Code TUI 自身（我们只是它的客户端，不去解析它的屏幕状态）
- 不改 web `ai-terminal` 路由的实时投屏路径（仅在它的"用户输入注入"调用点
  统一接入 dispatcher，作为后续工作；本期只接 wizard 两个分支）
- 不识别"Claude 正在等 permission prompt"中态——盲发 Esc，观察后再加
- 不做转义（`!` 是 reserved prefix；用户想字面发 `!` 暂不支持）

## 方案：中央调度器 `session-input-dispatcher`

### 模块边界

新文件 `src/session-input-dispatcher.js`，导出工厂函数：

```js
export function createSessionInputDispatcher({
  pty,            // src/pty.js 实例（write / has）
  aiTerminal,     // src/routes/ai-terminal.js (新增 isSessionAwaitingReply getter)
  larkBot,        // 用于 reaction 回显（可选）
  telegramBot,    // 用于 reaction + reply 回显（可选）
  reactionTracker,// src/telegram-reaction-tracker.js 已存在
  logger,
}) {
  return {
    send,         // 主入口，wizard 调用
    onSessionIdle,// hook 钩子：Stop / session-end 时 flush
    onSessionEnd, // 清队列 + 通知未投递消息
    describe,     // /list 看队列状态
  }
}
```

### `send(input)` 协议

```js
dispatcher.send({
  sessionId,
  text,              // 原始 trimmed
  imagePaths = [],   // wizard 已经解析过的本地图片路径
  channel,           // 'lark' | 'telegram'，用于回显选路
  echoTarget,        // { chatId, threadId | rootMessageId, messageId } 用于贴 reaction / reply
})
=> Promise<{
  action: 'sent' | 'queued' | 'soft_interrupted' | 'hard_cancelled' | 'noop_idle',
  queueSize?: number,
  reason?: string,
}>
```

### 决策流程

```
parse trigger
├─ text 以 "!!" 开头 或 text === "/stop"        → mode = 'hard_cancel'
├─ text 以 "!"（且非 "!!"）开头                  → mode = 'soft_interrupt'
└─ 其他                                          → mode = 'queue_or_send'

ask aiTerminal.isSessionAwaitingReply(sid)?
├─ true（idle，等用户输入）
│   ├─ hard_cancel  → 不写 PTY，回 'noop_idle'
│   ├─ soft_interrupt → 等同普通投递（去掉 ! 前缀直接写）
│   └─ queue_or_send  → 直接 pty.write(sid, payload + '\r')
│
└─ false（busy）
    ├─ hard_cancel  → pty.write(sid, '\x03')，丢弃 queue，echo "⏹ 已中断"
    ├─ soft_interrupt → pty.write(sid, '\x1b')；丢弃 queue；
    │                    入队 "stripped text"；250ms 后 flush（合并）
    └─ queue_or_send  → 推入 per-sid FIFO 队列；echo（首条文字 + reaction）
```

### Flush 触发

dispatcher 不主动轮询。两个事件触发 flush：

1. **`Stop` hook**：`openclaw-hook.js:631` 已经 `markIdle`；改成在 markIdle
   完成后**立即**调用 `dispatcher.onSessionIdle(sessionId)`。dispatcher 检查
   该 sid 队列非空 → 把队列内所有 text 用 `\n` 拼成一条 → `pty.write` →
   写 `\r` → 清空队列 → 触发 `onFlush` 回调（按下文「状态回显」节，flush
   时仅清 reaction，**不发文字**——避免群里刷屏）。
2. **soft_interrupt 后的 250ms timer**：等 Esc 让 Claude TUI 回到 prompt
   再投递新文本。（这个延迟是经验值，可调）

### Busy 状态来源

唯一信号源：`src/routes/ai-terminal.js` 的 session map 里
`session.awaitingReply`（true = idle，false = busy）。新增公开 getter：

```js
// src/routes/ai-terminal.js
export function isSessionAwaitingReply(sessionId) {
  const s = sessions.get(sessionId)
  return s ? !!s.awaitingReply : false  // 不存在视为 busy（保守）
}
```

注意"不存在 = busy"的保守语义：让 dispatcher 在 session 还没注册时优先排队
而不是裸投递，避免抢跑。

### 队列数据结构

```js
// per-sid Map<sessionId, QueueState>
QueueState = {
  items: Array<{ text, imagePaths, source, enqueuedAt }>,
  echoState: { firstReplyMessageId | null },  // 第 1 条回显的消息 id，便于后续编辑/清理
  staleTimer: NodeJS.Timeout | null,          // 5 分钟未 flush 自动 fail
}
```

- 上限 20 条；满了 → 拒绝新消息，echo "📥 队列已满 (20)，请等当前任务结束或 /stop"
- staleTimer：每次入队重置，5 分钟未触发 flush → 调用回调 echo "⚠️ 队列超时，session 似乎卡住，请 /stop 重启"，**不**自动丢弃（保留给用户决策）

### 状态回显（reaction-first）

复用既有路径，dispatcher 不直接调 Lark / Telegram API，而是通过两个回调：

```js
{
  onQueueFirstEnqueue: ({ sessionId, channel, echoTarget }) => Promise<{ messageId? }>
  onQueueAdditionalEnqueue: ({ sessionId, channel, echoTarget }) => Promise<void>
  onFlush: ({ sessionId, channel, count }) => Promise<void>
  onHardCancel: ({ sessionId, channel }) => Promise<void>
  onStale: ({ sessionId, channel }) => Promise<void>
}
```

具体实现（在 wizard / bot 注入端拼装）：

- **第 1 条排队**：贴 reaction（lark `pendingReactions` map / telegram
  reaction tracker）+ 发一条文本 reply "🔄 当前任务进行中，已排队，会在结束后投递"
- **第 2..N 条排队**：仅贴 reaction，不发文字
- **flush**：清掉之前贴的 reaction（既有 `clearReactionsForSession` 路径），不发额外文字
- **hard_cancel**：清 reaction + 发 "⏹ 已中断当前任务"
- **stale**：发警告文本，reaction 保留

### 集成点（最小侵入）

| 文件 | 改动 |
|------|------|
| `src/session-input-dispatcher.js` | 新建（~250 行 + 测试） |
| `src/routes/ai-terminal.js` | 加 `isSessionAwaitingReply` 公开 getter（~10 行） |
| `src/openclaw-wizard.js` | 1244-1281 / 1556 附近两个 stdin proxy 分支：把 `pty.write + '\r'` 改成 `dispatcher.send(...)`，根据返回 action 决定 reply 文本 |
| `src/openclaw-hook.js` | 631 `markIdle` 后追加 `dispatcher.onSessionIdle(sessionId)`；session-end 路径追加 `dispatcher.onSessionEnd(sessionId)` |
| `src/server.js` | wire up：实例化 dispatcher，注入到 wizard / hook |
| `src/orchestrator.js` | session-end 时也通过 dispatcher 通知未投递消息（`onSessionEnd`） |

### `/list` / `/pending` 集成

dispatcher.describe() 返回每个 sid 的 `{ queueSize, oldestEnqueuedAt }`，
注入到 quadtodo slash command 现有 `/list` 输出（`openclaw-wizard.js:1339`
附近的 quadtodoSlash 分支）。

## `/stop` 的重新定义

现有 `/stop`（`src/openclaw-wizard.js:2148-2200` 附近 `cmdStop`）做的是**杀整个
PTY 进程**（`pty.stop(sid)`）+ 更新 `todo.aiSessions` 状态——既是用户日常用
的"中断"又是 admin 的杀 session 工具。本设计把这两层职责拆开：

| 触发位置 | 新语义 | 实现 |
|----------|--------|------|
| Lark thread reply / Telegram task topic 内（已绑定 sid 的上下文）`/stop` 或 `!!` | dispatcher hard_cancel：Ctrl+C 当前 turn，**保留 session** | dispatcher.send(mode='hard_cancel') |
| Telegram supergroup General / 任何**未绑定** sid 的上下文 `/stop` / `/stop <短码>` / `/stop all` | 保留旧的杀 session 行为（admin 兜底） | 保留 `cmdStop` 不动 |

判定规则：进入 `/stop` 处理时先看当前 routeKey 是否 resolve 出绑定的
sessionId（`larkBoundThreadSid` / telegram peer-bound `lastPushedSession`）：

- 有 sid → 走 dispatcher hard_cancel；不再调 `pty.stop`
- 无 sid → 走旧 `cmdStop`（列表 / 短码 / all）

这样：
- 日常在 topic 里 `/stop` = "中断当前 turn 但保留 session"（更符合直觉）
- 真正想杀 session 还可以从 General 用 `/stop <短码>` 或 `/stop all`
- `!!` 等价于 in-topic `/stop`（hard_cancel）

## 边界与决策（已与用户确认）

1. `!` 前缀的字面冲突：reserved prefix，不做转义。用户想发 `!important` 字面
   只能改写说法（`important: ...`）。
2. permission prompt 中态识别：本期不做。Esc 即便被吞成"拒绝授权"，下一步
   投递也只是变成新一轮发问，副作用可控；线上观察后再决定是否加。
3. 队列上限 20、超时 5 分钟。
4. `!` 软中断时旧队列丢弃（语义：算了听新的）。
5. 同一 session 短时间多次 `!`：第 2 个 `!` 期间（前一个 Esc 的 250ms 窗口
   内）降级为入队，避免连发 Esc 噪声。
6. 状态回显：reaction-first，第 1 条排队带文字，后续 silent。

## 错误处理

| 场景 | 处理 |
|------|------|
| `pty.has(sid)` 为 false | dispatcher.send 返回 `{ action: 'sent', reason: 'session_ended' }`，由 wizard 既有路径回 "这个任务已结束，请重新发起任务"，不进队列 |
| `pty.write` 抛异常 | 捕获 + warn log + echo "⚠️ 投递失败：{msg}"，队列不清空（让 stale timer 接管） |
| dispatcher 未注入（启动顺序问题） | wizard 检查 `dispatcher == null` → fallback 到老的裸 `pty.write` 路径，warn log（兜底兼容期保留） |
| 同一 sid 并发 send | dispatcher 内部串行化（per-sid mutex / promise chain），保证队列入队顺序与 PTY 写入顺序一致 |

## 测试策略

**单元测试**（dispatcher 本身，不依赖真 PTY）：

- 文件：`test/session-input-dispatcher.test.js`
- mock pty (`{ write: jest.fn(), has: () => true }`) + mock aiTerminal getter
- 覆盖：
  - busy + 普通消息 → 队列长度 +1，回调 onQueueFirstEnqueue
  - busy + 连续 5 条普通 → 第 1 条触发 first-enqueue，2..5 触发 additional
  - idle + 普通 → 直接 pty.write 触发
  - busy + `!xxx` → pty.write `\x1b`，250ms 后写 `xxx\r`，旧队列被丢弃
  - busy + `!!` / `/stop` → pty.write `\x03`，无文本投递，旧队列丢弃
  - idle + `!!` → 不写 PTY，返回 noop_idle
  - onSessionIdle 触发：队列内 3 条用 `\n` 合并 + `\r` 单次写入
  - 队列上限 20 → 第 21 条被拒，回 queue_full
  - stale 5 分钟 → onStale 回调被调用，队列保留
  - onSessionEnd → 队列清空，未投递消息通过回调暴露

**集成测试**（lark / telegram bot 端到端）：

- 文件：`test/lark-bot-busy-input.test.js`、`test/telegram-bot-busy-input.test.js`
- 用既有 stub bot 框架 + mock aiTerminal busy 状态
- 验证 wizard 两个分支的 reply 文本与既定状态机匹配

**回归**：

- 现有 `test/lark-bot.test.js`、`test/telegram-bot.test.js` 必须不变红
- `test/openclaw-wizard.test.js`（如果有）路径覆盖到 stdin proxy 改动

## 验收标准

- [ ] busy 时普通消息 → 入队 + reaction + 第 1 条带文字 reply
- [ ] idle 时普通消息 → 直发，无 reaction、无 reply
- [ ] busy 时 `!xxx` → Esc 写入 → 250ms 后写 xxx + `\r`，旧队列丢弃
- [ ] busy 时 `!!` / in-topic `/stop` → Ctrl+C 写入，不投递文本，回 "⏹ 已中断"
- [ ] General 里 `/stop <短码>` / `/stop all` 仍走旧的 `cmdStop`（杀整个 session），行为不变
- [ ] Stop hook 触发后队列合并并投递（onSessionIdle 同步调用），reaction 清除
- [ ] 队列满 20 → 第 21 条被拒，echo 提示
- [ ] 5 分钟未 flush → echo 警告，队列保留
- [ ] session-end → 队列清空，echo "session 已结束，未投递 N 条消息"
- [ ] `/list` 输出包含 per-session 队列长度
- [ ] dispatcher 单元测试覆盖率 ≥ 80%
- [ ] 既有 lark/telegram bot 集成测试不回归

## 实施顺序建议（留给 writing-plans 细化）

1. `aiTerminal.isSessionAwaitingReply` getter（最小，可独立提交）
2. `session-input-dispatcher` 模块 + 完整单元测试（可独立提交，未接入）
3. `server.js` wire up + `openclaw-hook.js` 接 onSessionIdle / onSessionEnd
4. `openclaw-wizard.js` 两个 stdin proxy 分支替换为 dispatcher.send
5. lark / telegram 集成测试 + 回归
6. `/list` 输出补队列字段

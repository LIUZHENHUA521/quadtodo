# 禁用 Telegram Notification 事件推送 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram 端不再收到 ⚠️ idle Notification 推送，多轮对话每轮的 Stop 回复正常推。

**Architecture:** 在 `src/openclaw-hook.js` 的 `handle()` 函数早期对 `evt === 'notification'` 短路，由新 helper `notificationSuppressed()` 决定是否抑制；默认值在 `src/config.js` 的 `DEFAULT_TELEGRAM_CONFIG` 加上 `suppressNotificationEvents: true`。Hook 安装器 / buildMessage / cooldown 路径全部不动，开关关掉时旧逻辑可完整回退。

**Tech Stack:** Node.js (ESM), vitest, Express。

**Spec:** `docs/superpowers/specs/2026-05-01-disable-telegram-notification-event-design.md`

---

## File Structure

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/openclaw-hook.js` | 修改 | 加 `notificationSuppressed()` 和 `handle()` 早期 return |
| `src/config.js` | 修改 | `DEFAULT_TELEGRAM_CONFIG` 加 `suppressNotificationEvents: true` |
| `test/openclaw-hook.test.js` | 修改 | 改 2 条 cooldown 测试 + 新增 1 条默认 suppressed 测试 |

---

## Task 1: 加 config 默认值

**Files:**
- Modify: `src/config.js:67-80` (`DEFAULT_TELEGRAM_CONFIG`)

只是加一个默认字段，不改行为（handler 还没读它）。让 config 先就位，后续 task 才能直接用 `cfg.telegram.suppressNotificationEvents`。

- [ ] **Step 1: 修改 `src/config.js`**

在 `DEFAULT_TELEGRAM_CONFIG` 里、`notificationCooldownMs` 那行下面加一行：

```js
const DEFAULT_TELEGRAM_CONFIG = {
	enabled: false,
	supergroupId: "",
	longPollTimeoutSec: 30,
	useTopics: true,
	createTopicOnTaskStart: true,
	closeTopicOnSessionEnd: true,
	topicNameTemplate: "#t{shortCode} {title}",
	topicNameDoneTemplate: "✅ {originalName}",
	allowedChatIds: [],     // 空 = 拒所有，强制白名单
	allowedFromUserIds: [],
	notificationCooldownMs: 600_000,    // 同 session 内 ⚠️ idle 提醒最小间隔（默认 10 分钟，0 = 关闭去重）
	suppressNotificationEvents: true,   // 默认丢弃 Claude Code 的 idle Notification（无信息量；设 false 可恢复旧 cooldown 行为）
	autoCreateTopic: true,              // 非 wizard 起的 PTY session 自动镜像到 Telegram topic
};
```

- [ ] **Step 2: 跑现有测试确认没回归**

Run: `pnpm test -- test/openclaw-hook.test.js test/config.test.js`
Expected: 全部通过（这一步只加默认值，不改任何运行时分支）

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "$(cat <<'EOF'
feat(config): 加 telegram.suppressNotificationEvents 默认开关

为后续 handler 早期短路 idle Notification 准备 config 字段，默认 true。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: TDD — handler 早期短路 idle Notification

**Files:**
- Modify: `src/openclaw-hook.js:215-292`（在 `handle()` 第 1b 段之前插入新短路；并新增 `notificationSuppressed()` helper）
- Modify: `test/openclaw-hook.test.js:236-252`（更新 2 条 cooldown 相关测试 + 新增 1 条默认 suppressed 测试）

### 2.1 写新测试（默认 suppressed）

- [ ] **Step 1: 在 `test/openclaw-hook.test.js` 的 handler describe 块里，紧跟现有 cooldown 测试后追加新测试**

定位：找到这行 `it('SessionEnd ignores cooldown (final state)'`（约 line 254）**之前**插入这条新测试：

```js
  it('Notification: suppressed by default (no config) — 早期短路，不调 bridge', async () => {
    // 默认无 getConfig → suppressNotificationEvents 视为 true
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_suppressed')
    // 关键：早期短路，没浪费 IO，bridge 完全没被调用
    expect(bridge.postText).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: 跑测试，确认新用例失败**

Run: `pnpm test -- test/openclaw-hook.test.js -t 'suppressed by default'`
Expected: FAIL — 当前实现下 reason 会是 `'sent'` 或 cooldown 路径，不是 `'notification_suppressed'`

### 2.2 实现 handler 早期短路

- [ ] **Step 3: 在 `src/openclaw-hook.js` 加 `notificationSuppressed()` helper**

定位：找到 `notificationCooldownMs()` 函数（约 line 240-248）。在它**正下方**追加：

```js
  // 默认丢弃 Claude Code 的 idle Notification —— quadtodo bypass 模式下纯噪声。
  // 用户可在 config 里 telegram.suppressNotificationEvents = false 恢复旧 cooldown 行为。
  function notificationSuppressed() {
    try {
      const cfg = getConfig?.() || {}
      const raw = cfg.telegram?.suppressNotificationEvents
      if (raw === false) return false   // 显式 false → 不抑制
      return true                        // 默认 true / undefined → 抑制
    } catch { return true }
  }
```

- [ ] **Step 4: 在 `handle()` 里加早期 return**

定位：找到 `handle()` 里的 1b 段（约 line 286-292）`if (evt === 'notification') { ... cooldown check ... }`。在这个 if 块**之前**插入新短路：

```js
    // 1b-pre) 默认抑制 idle Notification（noise）—— 早于 cooldown / jsonl / postText
    if (evt === 'notification' && notificationSuppressed()) {
      return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
    }

    // 1b) Notification cooldown（idle 提醒太频繁的关键修复）
    //     ... 保留原有 cooldown 逻辑（仅当 suppressNotificationEvents=false 时才走到）
    if (evt === 'notification') {
```

注意：原来的 1b cooldown 块**保留不动**——它现在只在 `suppressNotificationEvents=false` 时才会被走到。

- [ ] **Step 5: 跑新测试，确认通过**

Run: `pnpm test -- test/openclaw-hook.test.js -t 'suppressed by default'`
Expected: PASS

### 2.3 修复被新行为打破的旧测试

- [ ] **Step 6: 跑全部 hook 测试，看哪些失败**

Run: `pnpm test -- test/openclaw-hook.test.js`
Expected: 2 条失败：
- `'Notification: 2nd within cooldown is skipped (default 10min)'` — 第一条就被 suppress 了，永远走不到 cooldown
- `'Notification: cooldownMs=0 in config disables dedup (back to fire-on-every-event)'` — 默认 suppress 把它拦了

- [ ] **Step 7: 改第 1 条失败测试**

定位：`test/openclaw-hook.test.js` 约 line 236-242：

```js
  it('Notification: 2nd within cooldown is skipped (default 10min)', async () => {
    // 没传 getConfig → 用 default 600s cooldown
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_cooldown')
  })
```

替换成：

```js
  it('Notification: with suppressNotificationEvents=false, 2nd within cooldown is skipped', async () => {
    // 关掉默认 suppress 才能走到 cooldown 路径
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { suppressNotificationEvents: false } }),
    })
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_cooldown')
  })
```

- [ ] **Step 8: 改第 2 条失败测试**

定位：`test/openclaw-hook.test.js` 约 line 244-252：

```js
  it('Notification: cooldownMs=0 in config disables dedup (back to fire-on-every-event)', async () => {
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { notificationCooldownMs: 0 } }),
    })
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })
```

替换成（增加 `suppressNotificationEvents: false`）：

```js
  it('Notification: with suppressNotificationEvents=false + cooldownMs=0, every event fires', async () => {
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { suppressNotificationEvents: false, notificationCooldownMs: 0 } }),
    })
    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })
```

- [ ] **Step 9: 跑全部 hook 测试**

Run: `pnpm test -- test/openclaw-hook.test.js`
Expected: 全部通过（包含新 suppressed 测试 + 2 条改后的 cooldown 测试）

- [ ] **Step 10: 跑全量测试套件**

Run: `pnpm test`
Expected: 全部通过

- [ ] **Step 11: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.test.js
git commit -m "$(cat <<'EOF'
feat(openclaw-hook): 默认抑制 Claude Code idle Notification 推送

quadtodo 用 permissionMode=bypass 启 Claude Code，Notification 几乎只剩
60s idle 心跳——内容是"AI 还在思考"或"Claude is waiting for input"，
用户已经从 Stop 拿到完整答复，⚠️ 这条纯属噪声。

- handle() 早期短路 evt==='notification'，不浪费 jsonl/PTY/bridge IO
- 通过 telegram.suppressNotificationEvents=false 可恢复旧 cooldown 行为
- 旧 notificationCooldownMs 路径保留，仅在开关关掉时生效
- buildMessage / hook installer 都不动

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 真机 smoke 验证

**Files:**
- 无（纯运行时验证）

代码已落地，但 Telegram 推送有外部依赖（`postText` 真发到 Telegram bot）。这里走一次最小路径，眼见为实。

- [ ] **Step 1: 重启 quadtodo 让新 config 生效**

Run（在另一个 terminal，不要影响当前会话）：
```bash
# 停掉跑着的 quadtodo（如果有），重新跑
ps aux | grep -E '[q]uadtodo|node.*server.js' | head
# 找到 PID 后 kill，再启动
pnpm start  # 或用户惯用的启动命令
```

如果用户当前 quadtodo 是 `~/.quadtodo/` 全局命令跑的，提醒用户重启。

- [ ] **Step 2: 在 Telegram 触发一个新任务，让 AI 思考 >60s**

操作（人工在手机或 Telegram client）：
1. 在已绑定的 supergroup 里给 bot 发一条新任务，例如 "帮我数一下 src/ 下有多少个 .js 文件"
2. AI 进入工作 → ~60s 内给出答复 → 触发 `Stop`
3. 等待 1 分钟 → Claude Code 会触发 idle `Notification`

预期：
- ✅ 收到一条 stop 回复（AI 答案）
- ❌ **不再收到** ⚠️ "AI 还在思考 / spinner 中" 这条

- [ ] **Step 3: 查 hook.log 确认 notification 被 suppress**

Run:
```bash
tail -20 ~/.quadtodo/claude-hooks/hook.log | grep notification
```

Expected: 看到 `"event":"notification","status":"sent","action":"skipped","reason":"notification_suppressed"` 这种记录（hook 触发但 quadtodo 这边短路）。

> **Note**: 当前 `notify.js` 在 `status: 'sent'` 字段里记的是 fetch 调用结果，response body 里是 handler 的返回。如果 log 里 `action` 字段不是 `skipped`，看一下 quadtodo server 的 stdout——`reason: 'notification_suppressed'` 必须出现在 server 端。

- [ ] **Step 4: 验证 SessionEnd 仍正常**

操作：
1. 手动结束这个 todo session（Telegram `/done` 或 web UI 完成 todo）
2. 触发 `SessionEnd`

Expected: 收到 `✅ AI session 已结束 ...` 收尾消息，topic name 改成 `✅ {原 name}`。

- [ ] **Step 5: 报告结果**

如果 step 2 / 3 / 4 任一不符合预期：
- 列出实际看到的消息
- 贴 `~/.quadtodo/claude-hooks/hook.log` 末尾 20 行
- 贴 quadtodo server 在那段时间的 stdout

如果都通过：
- 直接告知用户验证通过，spec 关单

---

## 自查（writing-plans self-review）

**Spec coverage:**
- ✅ "默认丢弃 idle Notification" → Task 2.2
- ✅ "config 开关 suppressNotificationEvents=true" → Task 1
- ✅ "handler 早期短路（不浪费 IO）" → Task 2.2 step 4 + 测试 step 1 的 `expect(bridge.postText).not.toHaveBeenCalled()`
- ✅ "测试调整 2 条 + 新增 1 条" → Task 2.1 / 2.3
- ✅ "buildMessage 不动 / hook installer 不动" → 文件清单未列入
- ✅ "SessionEnd / Stop 不受影响" → Task 3 step 2/4 验证

**Placeholder scan:** 无 TBD/TODO；每个 step 都有具体代码或命令。

**Type consistency:**
- `notificationSuppressed()` 签名：无入参，返回 boolean —— Task 2.2 step 3 定义，step 4 调用一致
- `reason` 字符串：`notification_suppressed` 在 step 4 / step 1 / step 5 / step 11 commit message 一致
- config 字段名：`suppressNotificationEvents` 在 Task 1 / 2.1 / 2.3 都一致

无需修复。

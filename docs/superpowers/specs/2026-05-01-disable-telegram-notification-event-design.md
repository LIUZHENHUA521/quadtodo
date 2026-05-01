# 默认禁用 Telegram Notification 事件推送

**日期**: 2026-05-01
**状态**: Draft
**作者**: lzh + Claude

## 背景

quadtodo 通过 Claude Code hooks 把 PTY 内 AI 的状态事件推到 Telegram。当前注册了 3 个 hook 事件：`Stop`、`Notification`、`SessionEnd`。

实测（`~/.quadtodo/claude-hooks/hook.log`）：每次 AI 答完一轮 `Stop` 事件后大约 60 秒，Claude Code 会再触发一次 `Notification` 事件（idle 心跳）。当前 `src/openclaw-hook.js` 把 `Notification` 渲染成：

```
⚠️ AI 还在思考 / spinner 中，最近没新内容
```

或 `⚠️ {hookPayload.message}`（通常是 "Claude is waiting for your input" 这类无信息量提示）。

用户在 Telegram topic 里收到的是：
1. 一条带 ⚠️ 的"超时未回复"提示
2. 紧接着一条正常的 AI stop 回复

第一条没有任何附加信息，纯噪声。

代码中已有 `telegram.notificationCooldownMs`（默认 10 分钟去重），但用户每隔 10+ 分钟还是会漏出一条。

quadtodo 启动 Claude Code 时使用 `permissionMode: 'bypass'`（`src/openclaw-wizard.js:399`），因此 `Notification` 事件**几乎不会**承载 permission ask 这类有用信号——剩下的就只是 idle 心跳。

## 目标

- Telegram 端不再收到 ⚠️ 这种 idle Notification 推送
- 多轮对话依然每轮收到 `Stop` 回复
- `SessionEnd` 的 ✅ 收尾消息不受影响
- 保留一个 config 开关，让用户日后能开回来（万一 Claude Code 行为变化）

## 非目标

- 不改 hook 安装器（保留 `Notification` 在 `~/.claude/settings.json` 的注册）。这样：
  - 已经安装过 hook 的旧用户不需要重新装
  - 服务端单点决定丢/不丢，避免分裂状态
- 不引入"内容感知"的 Notification 过滤（方案 C 已被排除——Claude Code 的提示文案不稳定，正则易漏；当前 bypass 模式根本不会触发 permission Notification）
- 不改前端 Settings UI（命令行 / 直接编辑 config 文件即可关掉这个开关；UI 集成可日后单独做）

## 设计

### 改动 1：handler 早期短路 `notification`

`src/openclaw-hook.js` 的 `handle()` 函数，在所有现有逻辑之前加一段：

```js
// 默认禁用 idle Notification 推送 —— 它在 quadtodo (bypass 模式) 下只剩噪声。
// 用户可在 config 里把 telegram.suppressNotificationEvents 设为 false 恢复旧行为。
if (evt === 'notification' && notificationSuppressed()) {
  return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
}
```

新增 helper：

```js
function notificationSuppressed() {
  try {
    const cfg = getConfig?.() || {}
    const raw = cfg.telegram?.suppressNotificationEvents
    if (raw === false) return false   // 显式 false → 不抑制
    return true                        // 默认 true / undefined → 抑制
  } catch { return true }
}
```

抑制逻辑放在**所有后续处理之前**（包括 cooldown 判断、jsonl 读取、消息构造、推送）——不浪费 IO。

### 改动 2：config 默认值

`src/config.js` 的 `DEFAULT_TELEGRAM_CONFIG` 新增：

```js
suppressNotificationEvents: true,   // 默认丢弃 Claude Code 的 idle Notification（无信息量）
```

`notificationCooldownMs` 保持原状——它只在 `suppressNotificationEvents=false` 时才再次起作用。

### 改动 3：测试调整

`test/openclaw-hook.test.js` 现有两条测试涉及 notification cooldown 路径：

1. `'Notification: 2nd within cooldown is skipped (default 10min)'`
   - **现状**：默认 config 下 2nd 次 notification 走 cooldown 跳过
   - **改后**：默认 config 下**第一次** notification 就被 `notification_suppressed` 跳过，cooldown 路径不会被走到
   - 改成断言 `r.reason === 'notification_suppressed'`，不再依赖 cooldown 行为

2. `'Notification: cooldownMs=0 in config disables dedup (back to fire-on-every-event)'`
   - **现状**：`notificationCooldownMs=0` 表示关闭去重，每条都推
   - **改后**：必须先 `suppressNotificationEvents=false` 才能走到 cooldown 路径——把 config fixture 改成 `{ suppressNotificationEvents: false, notificationCooldownMs: 0 }`

新增一条测试：

3. `'Notification: suppressed by default (no config)'`
   - 不传 `getConfig` 或传空 config → handle 一次 notification → `action: 'skipped'`、`reason: 'notification_suppressed'`
   - 断言 bridge 的 `postText` 没被调用（确认是早期短路，没浪费 IO）

### 改动 4：buildMessage 不动

`buildMessage` 里 `case 'notification'` 分支保留——不删（万一开关关掉走回 cooldown 路径还能用）。

## 数据流

```
Claude Code Notification hook fires
          │
          ▼
notify.js → POST /api/openclaw/hook
          │
          ▼
hookHandler.handle({ event: 'notification', sessionId, ... })
          │
          ▼
   [新增]  notificationSuppressed()? ──yes──▶ return { skipped: 'notification_suppressed' }
          │ no
          ▼
   [现有]  notification cooldown 检查 → buildMessage → openclaw.postText
```

## 风险与缓解

1. **风险**: 未来 Claude Code 把 permission ask 也走 Notification（quadtodo 用了 bypass 不会触发，但如果用户改了 permissionMode）
   - **缓解**: 留 config 开关 `suppressNotificationEvents: false` 一行可恢复
2. **风险**: 用户手动改了 `notificationCooldownMs` 期待去重行为，结果发现连第一条都没了
   - **缓解**: 在 `config.js` 注释里说明两者关系；`MIGRATION` 段落（如果有）写清楚

## 验收标准

- [ ] 启动一个 todo，AI 思考 >60s 后答复 → Telegram 只收到 1 条 `Stop` 回复，**不再有 ⚠️**
- [ ] 多轮对话：每轮的 `Stop` 回复正常推
- [ ] `SessionEnd` 的 `✅ AI session 已结束` 正常推
- [ ] `notification_cooldown` 测试改成 `notification_suppressed`
- [ ] 新增 `suppressNotificationEvents=false` 时回退到 cooldown 行为的测试
- [ ] 新增"默认无 config 时第一条就 suppress"的测试
- [ ] `pnpm test` 全绿
- [ ] `~/.claude/settings.json` 里的 hook 注册不变（installer 不改）

## 影响文件清单

- `src/openclaw-hook.js` — 加 `notificationSuppressed()` 和早期 return
- `src/config.js` — `DEFAULT_TELEGRAM_CONFIG.suppressNotificationEvents = true`
- `test/openclaw-hook.test.js` — 改 2 条 + 新增 1 条 = 3 条测试

# Telegram 配置 web 化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 quadtodo 的 telegram 配置（14 个字段含 2 个新提取的常量）从「只能在终端 `quadtodo config set`」改成「web SettingsDrawer 完整可配」，并支持 token 遮罩、自动抓 supergroup ID、热重启长轮询。

**Architecture:** 后端把 `~/.quadtodo/config.json` 的 telegram 段补全 + 抽出 `startTelegramStack/stopTelegramStack` 让 PUT /api/config 能在不重启进程的情况下重建 telegramBot；新增 2 个常量 `pollRetryDelayMs / minRenameIntervalMs` 进 config schema；新增独立 router `/api/config/telegram/test`（getMe）+ `/probe-chat-id`（SSE 实时推命中表，复用主长轮询的 dispatch hook）。前端 SettingsDrawer 加 Telegram 折叠区铺 14 字段，token `Input.Password` + 来源 Tag + 测试按钮，supergroupId 旁边「抓 ID」按钮弹 SSE 表格。

**Tech Stack:** Node 18+ ESM, Express 4, vitest, React 18 + Antd 5 + Vite, Server-Sent Events (`text/event-stream`)。

**设计稿:** `docs/superpowers/specs/2026-05-02-telegram-config-web-design.md`

---

## 文件结构

**新增**：
- `src/telegram-config-service.js` —— Probe 状态机 + token 遮罩工具，单文件可独立测试
- `src/routes/telegram-config.js` —— Express router 挂 `/api/config/telegram/test` + `/probe-chat-id` SSE
- `test/telegram-config-service.test.js` —— probe 状态机 + mask 工具测试
- `test/telegram-config.route.test.js` —— HTTP 路由集成测试
- `web/src/TelegramProbeModal.tsx` —— probe SSE 弹窗组件

**修改**：
- `src/config.js` —— `DEFAULT_TELEGRAM_CONFIG` 加 2 个新字段；`normalizeConfig.telegram` 处理它们
- `src/telegram-bot.js` —— `pollRetryDelayMs` 改读 config；`readBotToken` 改返回 `{token, source}`；新增 `setProbeListener(fn)` 让 probe 复用 dispatch
- `src/telegram-loading-status.js` —— `MIN_RENAME_INTERVAL_MS` 改读 config
- `src/server.js` —— 抽 `startTelegramStack/stopTelegramStack/restartTelegramStack`；用 `telegramBotHolder = { current: null }` 替换裸引用；GET /api/config 改 mask token；PUT /api/config 比对 telegram 段触发 restart；mount 新 router
- `web/src/api.ts` —— `AppConfig.telegram` 类型补齐；新增 `testTelegram / probeChatId / streamProbeChatId`
- `web/src/SettingsDrawer.tsx` —— 加 Telegram Collapse 折叠区 5 个分区铺字段 + Token 测试按钮 + supergroupId 抓 ID 按钮挂 modal

---

## Task 1：config.js 加 2 个新常量字段

**Files:**
- Modify: `src/config.js:67-81`
- Test: `test/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 文件末尾追加：

```js
describe('telegram defaults: pollRetryDelayMs / minRenameIntervalMs', () => {
  it('normalizes legacy config without these fields by injecting defaults', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-'))
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { enabled: true } }))
    const cfg = loadConfig({ rootDir: tmp })
    expect(cfg.telegram.pollRetryDelayMs).toBe(5000)
    expect(cfg.telegram.minRenameIntervalMs).toBe(30000)
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

如果 `test/config.test.js` 没有 `mkdtempSync / tmpdir / join / writeFileSync / rmSync` 的 import，加进去。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/config.test.js -t "pollRetryDelayMs"
```
预期：FAIL（`undefined`）。

- [ ] **Step 3: 实现**

`src/config.js:67-81` 的 `DEFAULT_TELEGRAM_CONFIG` 加 2 个字段：

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
	allowedChatIds: [],
	allowedFromUserIds: [],
	notificationCooldownMs: 600_000,
	suppressNotificationEvents: true,
	autoCreateTopic: true,
	pollRetryDelayMs: 5000,
	minRenameIntervalMs: 30_000,
};
```

`normalizeConfig` 内 `telegram: { ...DEFAULT_TELEGRAM_CONFIG, ...(cfg.telegram || {}), ... }` 已经会兜底，不用改。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/config.test.js -t "pollRetryDelayMs"
```
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): telegram 加 pollRetryDelayMs / minRenameIntervalMs 默认值"
```

---

## Task 2：telegram-bot.js 用 config 里的 pollRetryDelayMs

**Files:**
- Modify: `src/telegram-bot.js:28, 392`
- Test: `test/telegram-bot.test.js`

- [ ] **Step 1: 写失败测试**

`test/telegram-bot.test.js` 追加：

```js
describe('pollRetryDelayMs reads from config', () => {
  it('uses config.telegram.pollRetryDelayMs as backoff base', async () => {
    const calls = []
    const fetchFn = async (url, opts) => {
      calls.push(url)
      throw new Error('fake_network_error')
    }
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['1'], pollRetryDelayMs: 123 } }),
      wizard: makeWizard(async () => ({})),
      fetchFn,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    // 暴露 backoffBase 供测试断言
    expect(bot.__getPollRetryDelayMs()).toBe(123)
  })

  it('falls back to 5000 when not configured', async () => {
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: ['1'] } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    expect(bot.__getPollRetryDelayMs()).toBe(5000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-bot.test.js -t "pollRetryDelayMs"
```
预期：FAIL（`__getPollRetryDelayMs is not a function`）。

- [ ] **Step 3: 实现**

`src/telegram-bot.js:28` 那一行 `const POLL_RETRY_DELAY_MS = 5_000` 保留作为 fallback。

`src/telegram-bot.js:392` 那一行：

```js
const backoff = Math.min(60_000, POLL_RETRY_DELAY_MS * consecutiveErrors)
```

改为：

```js
const baseDelayMs = getTgConfig().pollRetryDelayMs || POLL_RETRY_DELAY_MS
const backoff = Math.min(60_000, baseDelayMs * consecutiveErrors)
```

在 `src/telegram-bot.js:443` 的 return 块里加一个测试用 getter：

```js
return {
    start,
    stop,
    sendMessage,
    // ... 其他已有方法 ...
    pollOnce,
    isAuthorizedChat,
    describe,
    __getPollRetryDelayMs: () => getTgConfig().pollRetryDelayMs || POLL_RETRY_DELAY_MS,
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-bot.test.js
```
预期：所有 telegram-bot 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-bot.js test/telegram-bot.test.js
git commit -m "refactor(telegram-bot): pollRetryDelayMs 从 config 读取，硬编码作为 fallback"
```

---

## Task 3：telegram-loading-status.js 用 config 里的 minRenameIntervalMs

**Files:**
- Modify: `src/telegram-loading-status.js:28, 66`

- [ ] **Step 1: 读现状**

```bash
sed -n '20,80p' src/telegram-loading-status.js
```
找出 `MIN_RENAME_INTERVAL_MS` 在哪里被引用、`getConfig` 是否已注入。

- [ ] **Step 2: 实现**

`src/telegram-loading-status.js:28` 保留 `const MIN_RENAME_INTERVAL_MS = 30_000` 作为 fallback。

找到 `createLoadingTracker({ telegramBot, openclaw, logger })` 这一行，加一个新依赖 `getConfig`：

```js
export function createLoadingTracker({ telegramBot, openclaw, logger = console, getConfig = null }) {
```

把 `:66` 那行：

```js
return (now() - last) >= MIN_RENAME_INTERVAL_MS
```

改为：

```js
const cfg = getConfig?.()?.telegram || {}
const minInterval = cfg.minRenameIntervalMs || MIN_RENAME_INTERVAL_MS
return (now() - last) >= minInterval
```

- [ ] **Step 3: 改 server.js 注入**

`src/server.js:856` 的 `createLoadingTracker({ telegramBot, openclaw: openclawBridge, logger: console })` 改为：

```js
loadingTracker = createLoadingTracker({
    telegramBot,
    openclaw: openclawBridge,
    logger: console,
    getConfig: () => loadConfig({ rootDir: configRootDir }),
})
```

- [ ] **Step 4: 验证全量测试不退**

```bash
npx vitest run
```
预期：所有现有测试 PASS（loading-status 没有专门的 test 文件，但其他 telegram 测试不应该被打破）。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-loading-status.js src/server.js
git commit -m "refactor(telegram-loading-status): minRenameIntervalMs 从 config 读取"
```

---

## Task 4：telegram-config-service.js 创建 + token mask 工具

**Files:**
- Create: `src/telegram-config-service.js`
- Test: `test/telegram-config-service.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/telegram-config-service.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { maskBotToken } from '../src/telegram-config-service.js'

describe('maskBotToken', () => {
  it('returns null for null/empty', () => {
    expect(maskBotToken(null)).toBeNull()
    expect(maskBotToken('')).toBeNull()
    expect(maskBotToken(undefined)).toBeNull()
  })

  it('masks token keeping last 4 chars', () => {
    expect(maskBotToken('7846123456:AAH9xK_abcdefg1234')).toBe('tg_***1234')
  })

  it('handles short token gracefully', () => {
    expect(maskBotToken('abc')).toBe('tg_***abc')
  })
})

describe('isMaskedToken', () => {
  it('detects mask format', async () => {
    const { isMaskedToken } = await import('../src/telegram-config-service.js')
    expect(isMaskedToken('tg_***1234')).toBe(true)
    expect(isMaskedToken('tg_***ab')).toBe(true)
    expect(isMaskedToken('7846123456:AAH9xK_abc')).toBe(false)
    expect(isMaskedToken('')).toBe(false)
    expect(isMaskedToken(null)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-config-service.test.js
```
预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现**

新建 `src/telegram-config-service.js`：

```js
/**
 * Telegram 配置辅助：
 *  - maskBotToken / isMaskedToken：UI 上 token 的遮罩与回显检测
 *  - createProbeRegistry：probe-chat-id 的状态机（窗口期内收 chat 记录）
 *
 * 跟 telegram-bot.js 解耦，所有 IO（fetch、sleep）由 caller 注入。
 */

const MASK_PREFIX = 'tg_***'

/**
 * 把真实 token 转成展示串：tg_***末四位。null/空返回 null。
 */
export function maskBotToken(token) {
  if (!token || typeof token !== 'string') return null
  const tail = token.length >= 4 ? token.slice(-4) : token
  return MASK_PREFIX + tail
}

/**
 * 判断字符串是不是 mask 格式（用户在 UI 没改 token 时回传的就是 mask）。
 */
export function isMaskedToken(value) {
  if (!value || typeof value !== 'string') return false
  return value.startsWith(MASK_PREFIX)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-config-service.test.js
```
预期：3 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-config-service.js test/telegram-config-service.test.js
git commit -m "feat(telegram): mask/isMasked token 工具"
```

---

## Task 5：telegram-config-service.js 加 probe registry

**Files:**
- Modify: `src/telegram-config-service.js`
- Test: `test/telegram-config-service.test.js`

- [ ] **Step 1: 写失败测试**

`test/telegram-config-service.test.js` 追加：

```js
import { createProbeRegistry } from '../src/telegram-config-service.js'

describe('createProbeRegistry', () => {
  it('rejects start when probe already active', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    expect(reg.startProbe(60).ok).toBe(true)
    expect(reg.startProbe(60).ok).toBe(false)
    expect(reg.startProbe(60).reason).toBe('already_active')
  })

  it('clamps duration to [10, 120] seconds', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    const r1 = reg.startProbe(5)
    expect(r1.durationSec).toBe(10)
    reg.stopProbe()
    const r2 = reg.startProbe(999)
    expect(r2.durationSec).toBe(120)
  })

  it('isActive returns false after expiresAt', () => {
    let t = 0
    const reg = createProbeRegistry({ now: () => t })
    reg.startProbe(60)
    t = 30_000
    expect(reg.isActive()).toBe(true)
    t = 60_001
    expect(reg.isActive()).toBe(false)
  })

  it('record buffers hits while active and notifies subscribers', () => {
    let t = 0
    const reg = createProbeRegistry({ now: () => t })
    const seen = []
    reg.startProbe(60)
    const unsub = reg.subscribe((hit) => seen.push(hit))
    reg.record({ chatId: '-100123', chatTitle: 'g1', chatType: 'supergroup', fromUserId: '99', textPreview: 'hi' })
    expect(seen).toHaveLength(1)
    expect(seen[0].chatId).toBe('-100123')
    expect(reg.snapshot().hits).toHaveLength(1)
    unsub()
    reg.record({ chatId: '-100456', chatTitle: 'g2', chatType: 'supergroup', fromUserId: '99', textPreview: 'hi' })
    expect(seen).toHaveLength(1)             // unsub 后不再收
    expect(reg.snapshot().hits).toHaveLength(2)  // 但 buffer 仍记
  })

  it('record dropped when probe inactive', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    reg.record({ chatId: '-100123' })
    expect(reg.snapshot().hits).toHaveLength(0)
  })

  it('stopProbe clears state', () => {
    const reg = createProbeRegistry({ now: () => 0 })
    reg.startProbe(60)
    reg.record({ chatId: '-100123', chatTitle: 'g', chatType: 'supergroup' })
    reg.stopProbe()
    expect(reg.isActive()).toBe(false)
    expect(reg.snapshot().hits).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-config-service.test.js -t "createProbeRegistry"
```
预期：FAIL（找不到 createProbeRegistry）。

- [ ] **Step 3: 实现**

`src/telegram-config-service.js` 末尾追加：

```js
/**
 * Probe 状态机：startProbe(durationSec) 后，record(hit) 会写到 buffer 并通知订阅者。
 * 同一时刻只能有一个活跃 probe（second startProbe 会失败）。
 *
 * 时间通过 now() 注入，便于测试。
 *
 * 返回：{ startProbe, stopProbe, record, subscribe, isActive, snapshot }
 */
export function createProbeRegistry({ now = () => Date.now() } = {}) {
  let expiresAt = 0
  let hits = []
  const subscribers = new Set()

  function isActive() {
    return now() < expiresAt
  }

  function startProbe(durationSec) {
    if (isActive()) return { ok: false, reason: 'already_active' }
    const clamped = Math.min(120, Math.max(10, Number(durationSec) || 60))
    expiresAt = now() + clamped * 1000
    hits = []
    return { ok: true, durationSec: clamped, expiresAt }
  }

  function stopProbe() {
    expiresAt = 0
    hits = []
    // 通知订阅者结束（payload null 表示 closed）
    for (const fn of subscribers) {
      try { fn(null) } catch {}
    }
  }

  function record(hit) {
    if (!isActive()) return false
    const entry = { ...hit, at: now() }
    hits.push(entry)
    for (const fn of subscribers) {
      try { fn(entry) } catch {}
    }
    return true
  }

  function subscribe(fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  function snapshot() {
    return {
      active: isActive(),
      expiresAt,
      hits: [...hits],
    }
  }

  return { startProbe, stopProbe, record, subscribe, isActive, snapshot }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-config-service.test.js
```
预期：所有 service 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-config-service.js test/telegram-config-service.test.js
git commit -m "feat(telegram): probe-chat-id 状态机"
```

---

## Task 6：telegram-bot.js 改 readBotToken 返回 source

**Files:**
- Modify: `src/telegram-bot.js:446-461`
- Test: `test/telegram-bot.test.js`

- [ ] **Step 1: 写失败测试**

`test/telegram-bot.test.js` 追加（注意要 import `readBotTokenWithSource`）：

```js
import { readBotTokenWithSource } from '../src/telegram-bot.js'

describe('readBotTokenWithSource', () => {
  it('returns quadtodo source when config has botToken', () => {
    const r = readBotTokenWithSource(() => ({ telegram: { botToken: 'XXX' } }))
    expect(r).toEqual({ token: 'XXX', source: 'quadtodo' })
  })

  it('returns missing when no source available', () => {
    // 注：openclaw fallback 路径下面的测试覆盖；这里强制把 home 指向不存在路径
    const r = readBotTokenWithSource(() => ({ telegram: {} }), { fallbackPath: '/nonexistent/openclaw.json' })
    expect(r).toEqual({ token: null, source: 'missing' })
  })

  it('returns openclaw source when fallback file has token', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-fb-'))
    const path = join(tmp, 'openclaw.json')
    writeFileSync(path, JSON.stringify({ channels: { telegram: { botToken: 'YYY' } } }))
    const r = readBotTokenWithSource(() => ({ telegram: {} }), { fallbackPath: path })
    expect(r).toEqual({ token: 'YYY', source: 'openclaw' })
    rmSync(tmp, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-bot.test.js -t "readBotTokenWithSource"
```
预期：FAIL（找不到 export）。

- [ ] **Step 3: 实现**

`src/telegram-bot.js:450` 把现有 `readBotToken` 替换为：

```js
/**
 * 读 bot token，并返回来源标记。
 *  - source: "quadtodo" | "openclaw" | "missing"
 *  - fallbackPath 测试用：默认 ~/.openclaw/openclaw.json
 */
export function readBotTokenWithSource(getConfig, { fallbackPath = join(homedir(), '.openclaw', 'openclaw.json') } = {}) {
  const tg = getConfig?.()?.telegram || {}
  if (tg.botToken && typeof tg.botToken === 'string') {
    return { token: tg.botToken, source: 'quadtodo' }
  }
  try {
    if (!existsSync(fallbackPath)) return { token: null, source: 'missing' }
    const cfg = JSON.parse(readFileSync(fallbackPath, 'utf8'))
    const tok = cfg?.channels?.telegram?.botToken || null
    return tok ? { token: tok, source: 'openclaw' } : { token: null, source: 'missing' }
  } catch {
    return { token: null, source: 'missing' }
  }
}

/** 兼容旧调用方：只返回 token 字符串。新代码请用 readBotTokenWithSource。 */
export function readBotToken(getConfig) {
  return readBotTokenWithSource(getConfig).token
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-bot.test.js
```
预期：所有测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-bot.js test/telegram-bot.test.js
git commit -m "refactor(telegram-bot): readBotTokenWithSource 返回来源标记"
```

---

## Task 7：telegram-bot.js 暴露 setProbeListener（让 dispatch 多挂一个 listener）

**Files:**
- Modify: `src/telegram-bot.js`（dispatch + return 块）
- Test: `test/telegram-bot.test.js`

- [ ] **Step 1: 写失败测试**

`test/telegram-bot.test.js` 追加：

```js
describe('setProbeListener exposes dispatch hits', () => {
  it('listener gets every dispatched message regardless of allowedChatIds', async () => {
    const seen = []
    const fetchSeq = makeFetchSeq([
      { ok: true, body: { ok: true, result: [
        { update_id: 1, message: { message_id: 10, chat: { id: -100999, title: 'foreign', type: 'supergroup' }, from: { id: 7, username: 'alice' }, text: 'hello' } },
      ] } },
    ])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: [] /* 空 = 全 drop */ } }),
      wizard: makeWizard(async () => ({})),
      fetchFn: fetchSeq,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    bot.setProbeListener((info) => seen.push(info))
    await bot.pollOnce()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ chatId: '-100999', chatTitle: 'foreign', chatType: 'supergroup', fromUserId: '7', textPreview: 'hello' })
  })

  it('listener does not affect allowedChatIds drop behavior', async () => {
    const dispatched = []
    const fetchSeq = makeFetchSeq([
      { ok: true, body: { ok: true, result: [
        { update_id: 1, message: { message_id: 10, chat: { id: -100999, type: 'supergroup' }, from: { id: 7 }, text: 'ping' } },
      ] } },
    ])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'TKN', allowedChatIds: [] /* drop */ } }),
      wizard: makeWizard(async (msg) => { dispatched.push(msg); return {} }),
      fetchFn: fetchSeq,
      offsetFile,
      logger: { warn() {}, info() {} },
    })
    bot.setProbeListener(() => {})
    await bot.pollOnce()
    // wizard 不应被调用（消息没在 allowedChatIds 里）
    expect(dispatched).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-bot.test.js -t "setProbeListener"
```
预期：FAIL（`setProbeListener is not a function`）。

- [ ] **Step 3: 实现**

`src/telegram-bot.js` `createTelegramBot` 内部、`function dispatch(update)` **之前**加：

```js
let probeListener = null
function setProbeListener(fn) {
    probeListener = (typeof fn === 'function') ? fn : null
}
```

`function dispatch(update)` 在 `if (!msg) return` 下面、`if (!isAuthorizedChat(...))` **之前**插入：

```js
// Probe listener：在白名单检查之前 fork 一份给订阅者（拿 chatId 用）
if (probeListener) {
    try {
        probeListener({
            chatId: String(msg.chat.id),
            chatTitle: msg.chat.title || msg.chat.username || null,
            chatType: msg.chat.type || null,
            fromUserId: msg.from ? String(msg.from.id) : null,
            fromUsername: msg.from?.username || null,
            textPreview: typeof msg.text === 'string' ? msg.text.slice(0, 80) : null,
            at: Date.now(),
        })
    } catch (e) {
        logger.warn?.(`[telegram-bot] probeListener threw: ${e.message}`)
    }
}
```

return 块加 `setProbeListener,`：

```js
return {
    start, stop, sendMessage, sendDocument, editMessageText, setMessageReaction,
    createForumTopic, closeForumTopic, reopenForumTopic, editForumTopic,
    setMyCommands, deleteMyCommands, getMe,
    setProbeListener,
    pollOnce, isAuthorizedChat, describe,
    __getPollRetryDelayMs: () => getTgConfig().pollRetryDelayMs || POLL_RETRY_DELAY_MS,
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-bot.test.js
```
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/telegram-bot.js test/telegram-bot.test.js
git commit -m "feat(telegram-bot): setProbeListener 暴露 dispatch hits 给 probe"
```

---

## Task 8：HTTP route /api/config/telegram/test

**Files:**
- Create: `src/routes/telegram-config.js`
- Test: `test/telegram-config.route.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/telegram-config.route.test.js`：

```js
import { describe, it, expect } from 'vitest'
import express from 'express'
import { createTelegramConfigRouter } from '../src/routes/telegram-config.js'

function makeApp({ getConfig, getTelegramBot, probeRegistry }) {
  const app = express()
  app.use(express.json())
  app.use('/api/config/telegram', createTelegramConfigRouter({ getConfig, getTelegramBot, probeRegistry }))
  return app
}

async function postJson(app, path, body) {
  const { default: request } = await import('supertest')
  return request(app).post(path).send(body || {})
}

describe('POST /api/config/telegram/test', () => {
  it('returns ok=false when no token', async () => {
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => null,
      probeRegistry: null,
    })
    const r = await postJson(app, '/api/config/telegram/test')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: false, errorReason: 'token_missing' })
  })

  it('calls getMe via getTelegramBot when bot exists', async () => {
    const fakeBot = { getMe: async () => ({ id: 12345, username: 'lzhTodoBot', first_name: 'lzh todo' }) }
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'XXX' } }),
      getTelegramBot: () => fakeBot,
      probeRegistry: null,
    })
    const r = await postJson(app, '/api/config/telegram/test')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, botId: 12345, botUsername: 'lzhTodoBot' })
  })

  it('returns errorReason when getMe throws', async () => {
    const fakeBot = { getMe: async () => { throw new Error('401 Unauthorized') } }
    const app = makeApp({
      getConfig: () => ({ telegram: { botToken: 'BAD' } }),
      getTelegramBot: () => fakeBot,
      probeRegistry: null,
    })
    const r = await postJson(app, '/api/config/telegram/test')
    expect(r.body).toMatchObject({ ok: false, errorReason: '401 Unauthorized' })
  })
})
```

确保 `supertest` 在 devDependencies 中：

```bash
node -e "console.log(require('./package.json').devDependencies?.supertest || 'MISSING')"
```

如果 MISSING，加：

```bash
npm i -D supertest
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-config.route.test.js
```
预期：FAIL（找不到模块）。

- [ ] **Step 3: 实现**

新建 `src/routes/telegram-config.js`：

```js
/**
 * /api/config/telegram/* 路由：
 *   POST /test           —— getMe 连通性测试
 *   POST /probe-chat-id  —— 启动一个 probe 窗口
 *   GET  /probe-chat-id/stream —— SSE 实时推命中
 *
 * 依赖：
 *   - getConfig: () => 当前配置
 *   - getTelegramBot: () => 当前 telegramBot 实例（可能 null，比如 enabled=false）
 *   - probeRegistry: createProbeRegistry() 返回的对象
 */
import { Router } from 'express'
import { readBotTokenWithSource } from '../telegram-bot.js'

export function createTelegramConfigRouter({ getConfig, getTelegramBot, probeRegistry }) {
  if (typeof getConfig !== 'function') throw new Error('getConfig required')
  if (typeof getTelegramBot !== 'function') throw new Error('getTelegramBot required')

  const router = Router()

  // POST /test —— getMe 探测
  router.post('/test', async (_req, res) => {
    const { token, source } = readBotTokenWithSource(getConfig)
    if (!token) {
      return res.json({ ok: false, errorReason: 'token_missing', source })
    }
    const bot = getTelegramBot()
    if (!bot || typeof bot.getMe !== 'function') {
      return res.json({ ok: false, errorReason: 'bot_not_running', source })
    }
    try {
      const me = await bot.getMe()
      res.json({
        ok: true,
        botId: me.id,
        botUsername: me.username || null,
        botFirstName: me.first_name || null,
        source,
      })
    } catch (e) {
      res.json({ ok: false, errorReason: e.message || 'unknown', source })
    }
  })

  return router
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-config.route.test.js
```
预期：3 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/routes/telegram-config.js test/telegram-config.route.test.js
git commit -m "feat(telegram): /api/config/telegram/test 连通性探测"
```

---

## Task 9：HTTP route probe-chat-id（start + SSE stream）

**Files:**
- Modify: `src/routes/telegram-config.js`
- Test: `test/telegram-config.route.test.js`

- [ ] **Step 1: 写失败测试**

`test/telegram-config.route.test.js` 追加：

```js
import { createProbeRegistry } from '../src/telegram-config-service.js'

describe('POST /api/config/telegram/probe-chat-id', () => {
  it('starts probe and returns durationSec + expiresAt', async () => {
    const probeListeners = []
    const fakeBot = { setProbeListener: (fn) => probeListeners.push(fn) }
    const reg = createProbeRegistry({ now: () => 1000 })
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => fakeBot,
      probeRegistry: reg,
    })
    const r = await postJson(app, '/api/config/telegram/probe-chat-id', { durationSec: 60 })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, durationSec: 60 })
    expect(reg.isActive()).toBe(true)
    // 应该已经把 listener 挂到 bot 上
    expect(probeListeners).toHaveLength(1)
  })

  it('returns conflict when probe already active', async () => {
    const reg = createProbeRegistry({ now: () => 1000 })
    reg.startProbe(60)
    const app = makeApp({
      getConfig: () => ({ telegram: {} }),
      getTelegramBot: () => ({ setProbeListener: () => {} }),
      probeRegistry: reg,
    })
    const r = await postJson(app, '/api/config/telegram/probe-chat-id', { durationSec: 60 })
    expect(r.body).toMatchObject({ ok: false, reason: 'already_active' })
  })

  it('returns ok=false when bot not running', async () => {
    const reg = createProbeRegistry({ now: () => 1000 })
    const app = makeApp({
      getConfig: () => ({ telegram: { enabled: false } }),
      getTelegramBot: () => null,
      probeRegistry: reg,
    })
    const r = await postJson(app, '/api/config/telegram/probe-chat-id', { durationSec: 60 })
    expect(r.body).toMatchObject({ ok: false, reason: 'bot_not_running' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/telegram-config.route.test.js -t "probe-chat-id"
```
预期：FAIL（404）。

- [ ] **Step 3: 实现**

在 `src/routes/telegram-config.js` 末尾、`return router` 之前加：

```js
  // POST /probe-chat-id —— 启动 probe 窗口
  router.post('/probe-chat-id', (req, res) => {
    if (!probeRegistry) {
      return res.status(500).json({ ok: false, reason: 'no_registry' })
    }
    const bot = getTelegramBot()
    if (!bot || typeof bot.setProbeListener !== 'function') {
      return res.json({ ok: false, reason: 'bot_not_running' })
    }
    const r = probeRegistry.startProbe(Number(req.body?.durationSec) || 60)
    if (!r.ok) {
      return res.json({ ok: false, reason: r.reason })
    }
    bot.setProbeListener((hit) => probeRegistry.record(hit))
    res.json({ ok: true, durationSec: r.durationSec, expiresAt: r.expiresAt })
  })

  // GET /probe-chat-id/stream —— SSE 推命中
  router.get('/probe-chat-id/stream', (req, res) => {
    if (!probeRegistry) {
      return res.status(500).json({ ok: false, reason: 'no_registry' })
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // 立即把 snapshot 推一遍（让重连客户端看到已有 hits）
    for (const hit of probeRegistry.snapshot().hits) {
      res.write(`data: ${JSON.stringify(hit)}\n\n`)
    }

    const unsub = probeRegistry.subscribe((hit) => {
      if (hit === null) {
        // probe 结束
        res.write(`event: done\ndata: {}\n\n`)
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify(hit)}\n\n`)
    })

    // 每 25 秒发个 ping 防止反向代理掐
    const pingInterval = setInterval(() => {
      try { res.write(`: ping\n\n`) } catch {}
    }, 25_000)

    req.on('close', () => {
      clearInterval(pingInterval)
      unsub()
    })
  })

  // POST /probe-chat-id/stop —— 主动停
  router.post('/probe-chat-id/stop', (_req, res) => {
    const bot = getTelegramBot()
    if (bot && typeof bot.setProbeListener === 'function') bot.setProbeListener(null)
    if (probeRegistry) probeRegistry.stopProbe()
    res.json({ ok: true })
  })
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/telegram-config.route.test.js
```
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/routes/telegram-config.js test/telegram-config.route.test.js
git commit -m "feat(telegram): /api/config/telegram/probe-chat-id + SSE stream"
```

---

## Task 10：server.js 抽出 telegram stack 启动函数

**Files:**
- Modify: `src/server.js:837-907`
- Test: 手测（端到端，无单元测试）

- [ ] **Step 1: 阅读现状**

```bash
sed -n '830,910p' src/server.js
```

确认范围：从 `// Telegram bot：直连 Telegram getUpdates 长轮询；` 到 `openclawBridge.setTelegramBot(telegramBot)` 这一段。

- [ ] **Step 2: 实现 holder 模式 + 抽函数**

把 `src/server.js:837-907` 整段（telegramBot 创建 + loadingTracker + openclawHookHandler 的 telegramBot 注入）改为：

```js
	// ─── Telegram stack（可热重启）─────────────────────────────────
	// holder 模式：所有依赖方持有 holder.current 而非裸引用，重启时只换 .current
	const telegramBotHolder = { current: null }
	const loadingTrackerHolder = { current: null }

	let openclawWizard           // 后面赋值；start/stop 函数闭包引用 lazy ref
	const openclawWizardLazyRef = {
		handleInbound: () => Promise.resolve({ reply: 'wizard not ready' }),
		handleTopicEvent: () => Promise.resolve({ ok: false, reason: 'wizard not ready' }),
	};

	function startTelegramStack() {
		const cfg = loadConfig({ rootDir: configRootDir })
		const tg = cfg.telegram || {}
		if (!tg.enabled) {
			console.log('[telegram] disabled, skipping bot start')
			return
		}
		const bot = createTelegramBot({
			getConfig: () => loadConfig({ rootDir: configRootDir }),
			wizard: {
				handleInbound: (...args) => openclawWizardLazyRef.handleInbound(...args),
				handleTopicEvent: (...args) => openclawWizardLazyRef.handleTopicEvent(...args),
			},
			logger: { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a) },
		})
		telegramBotHolder.current = bot
		loadingTrackerHolder.current = createLoadingTracker({
			telegramBot: bot,
			openclaw: openclawBridge,
			logger: console,
			getConfig: () => loadConfig({ rootDir: configRootDir }),
		})
		// PTY 事件挂到 tracker（注意：避免重复挂！第一次挂时记录 listener 引用）
		// 但 PTY 是单例长期对象，不能 off / on 反复 —— 解法：listener 函数永远走 holder
		openclawBridge.setTelegramBot(bot)
		bot.start()
		console.log(`[telegram] bot started; supergroup=${tg.supergroupId || '(unset)'} allowedChatIds=${(tg.allowedChatIds||[]).join(',')||'(empty—reject all)'}`)
	}

	async function stopTelegramStack() {
		const bot = telegramBotHolder.current
		if (!bot) return
		try { await bot.stop?.() } catch (e) { console.warn(`[telegram] stop failed: ${e.message}`) }
		telegramBotHolder.current = null
		loadingTrackerHolder.current = null
		openclawBridge.setTelegramBot(null)
		console.log('[telegram] bot stopped')
	}

	async function restartTelegramStack() {
		await stopTelegramStack()
		startTelegramStack()
	}

	// PTY 事件：永远走 holder.current，所以重启 bot 后还能跑
	pty.on('native-session', ({ sessionId }) => {
		loadingTrackerHolder.current?.start({ sessionId })
			.catch((e) => console.warn(`[loading-status] start failed: ${e.message}`))
	})
	pty.on('done', ({ sessionId, exitCode, stopped }) => {
		const finalStatus = stopped ? 'stopped' : (exitCode === 0 ? 'done' : 'failed')
		loadingTrackerHolder.current?.stop({ sessionId, finalStatus })
			.catch((e) => console.warn(`[loading-status] stop failed: ${e.message}`))
	})

	// hook 处理器：通过 holder 拿 telegramBot
	const openclawHookHandler = createOpenClawHookHandler({
		db,
		openclaw: openclawBridge,
		aiTerminal: ait,
		pty,
		telegramBot: telegramBotHolder,           // ← 改：传 holder 进去
		loadingTracker: loadingTrackerHolder,     // ← 改：传 holder 进去
		getConfig: () => loadConfig({ rootDir: configRootDir }),
	});
	app.use("/api/openclaw/hook", createOpenClawHookRouter({ hookHandler: openclawHookHandler }));

	// wizard：同样
	openclawWizard = createOpenClawWizard({
		db,
		aiTerminal: ait,
		openclaw: openclawBridge,
		pending: pendingCoord,
		pty,
		telegramBot: telegramBotHolder,           // ← holder
		loadingTracker: loadingTrackerHolder,     // ← holder
		getConfig: () => loadConfig({ rootDir: configRootDir }),
	});
	openclawWizardLazyRef.handleInbound = (...args) => openclawWizard.handleInbound(...args);
	openclawWizardLazyRef.handleTopicEvent = (...args) => openclawWizard.handleTopicEvent(...args);
	app.use("/api/openclaw/inbound", createOpenClawInboundRouter({ wizard: openclawWizard }));

	// 首次启动 telegram stack
	startTelegramStack()
```

⚠️ **重要**：传入 hook / wizard 的不再是 telegramBot 实例，而是 `telegramBotHolder` 对象。这个 task **不**改动 hook / wizard 内部 —— 它们目前就直接用 `telegramBot.sendMessage(...)`。所以 **下一个 Task 11** 必须紧跟着把 hook / wizard 内部的 `telegramBot` 调用全改成 `telegramBot.current` —— 否则会跑不起来。

为了不让中间状态破坏，在这一步**保持**原来的实现作为兼容：在 `createOpenClawHookHandler` / `createOpenClawWizard` 入参那里把 holder unwrap：

新建一个 helper `unwrapHolder`，加在文件顶部 import 之后（或 inline）：

```js
function unwrapHolder(holderOrInstance) {
	if (!holderOrInstance) return null
	// 是 holder
	if (holderOrInstance && typeof holderOrInstance === 'object' && 'current' in holderOrInstance) {
		return new Proxy({}, {
			get(_t, prop) {
				const inst = holderOrInstance.current
				if (!inst) return prop === 'sendMessage' || prop === 'sendDocument' || prop === 'editMessageText' || prop === 'createForumTopic' || prop === 'closeForumTopic' || prop === 'editForumTopic' || prop === 'setMessageReaction'
					? async () => { throw new Error('telegram_bot_not_running') }
					: undefined
				return inst[prop]
			},
		})
	}
	return holderOrInstance
}
```

改：

```js
	telegramBot: unwrapHolder(telegramBotHolder),
	loadingTracker: unwrapHolder(loadingTrackerHolder),
```

这样 hook / wizard 不需要改 —— 它们看到的是一个 Proxy，每次读属性都从 holder 拿最新实例。

- [ ] **Step 3: 跑现有测试，确保没退化**

```bash
npx vitest run
```
预期：全部 PASS。

启动 server 手测：

```bash
node src/cli.js stop || true
node src/cli.js start &
sleep 3
curl -s http://127.0.0.1:5677/api/config | jq '.config.telegram.enabled'
node src/cli.js stop
```

预期：返回当前 enabled 状态，不报错。

- [ ] **Step 4: 提交**

```bash
git add src/server.js
git commit -m "refactor(server): telegram stack 抽函数 + holder 模式（为热重启铺路）"
```

---

## Task 11：server.js GET /api/config 加 token mask + source

**Files:**
- Modify: `src/server.js:418-432`

- [ ] **Step 1: 写失败测试**

新建 `test/server.config-mask.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('GET /api/config token mask', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-')) })
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('masks token + adds source field', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: true, botToken: '7846123456:AAH9xK_abcdefg1234' },
    }))
    process.env.QUADTODO_ROOT_DIR = tmp
    const { createApp } = await import('../src/server.js')
    const { default: request } = await import('supertest')
    const { app } = await createApp({ rootDir: tmp })
    const r = await request(app).get('/api/config')
    expect(r.body.config.telegram.botToken).toBeUndefined()
    expect(r.body.config.telegram.botTokenMasked).toBe('tg_***1234')
    expect(r.body.config.telegram.botTokenSource).toBe('quadtodo')
  })
})
```

⚠️ **如果 server.js 不导出 `createApp`**：先看一下 server.js 怎么暴露 app，可能要稍调测试代码或加一个 `export createApp`。先跑下面这个看清楚：

```bash
grep "export" src/server.js | head -5
```

如果导出的是 `export async function createServer({...})` 之类，按实际名字调。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/server.config-mask.test.js
```
预期：FAIL（`botToken` 仍在或 `botTokenMasked` undefined）。

- [ ] **Step 3: 实现**

`src/server.js:418` `app.get('/api/config', ...)` 改为：

```js
	app.get("/api/config", (_req, res) => {
		try {
			const cfg = loadConfig({ rootDir: configRootDir });
			const { token, source } = readBotTokenWithSource(() => cfg);
			const { botToken, ...telegramSafe } = cfg.telegram || {}
			res.json({
				ok: true,
				config: {
					...cfg,
					tools: resolveToolsConfig(cfg.tools),
					telegram: {
						...telegramSafe,
						botTokenMasked: maskBotToken(token),
						botTokenSource: source,
					},
				},
				toolDiagnostics: inspectToolsConfig(cfg.tools),
			});
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message });
		}
	});
```

文件顶部 import 区加：

```js
import { readBotTokenWithSource } from "./telegram-bot.js";
import { maskBotToken, isMaskedToken } from "./telegram-config-service.js";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/server.config-mask.test.js
```
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server.js test/server.config-mask.test.js
git commit -m "feat(server): GET /api/config 把 botToken 替换为 mask + source"
```

---

## Task 12：server.js PUT /api/config 处理 token mask + 触发热重启

**Files:**
- Modify: `src/server.js:434-480`

- [ ] **Step 1: 写失败测试**

`test/server.config-mask.test.js` 追加：

```js
describe('PUT /api/config token mask', () => {
  let tmp
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-')) })
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch {} })

  it('does not overwrite token when receiving mask string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({
      telegram: { enabled: true, botToken: 'REAL_TOKEN_12345678' },
    }))
    process.env.QUADTODO_ROOT_DIR = tmp
    const { createApp } = await import('../src/server.js')
    const { default: request } = await import('supertest')
    const { app } = await createApp({ rootDir: tmp })
    await request(app).put('/api/config').send({
      telegram: { enabled: true, botTokenMasked: 'tg_***5678', botToken: 'tg_***5678' },
    })
    const fs = await import('node:fs')
    const onDisk = JSON.parse(fs.readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken).toBe('REAL_TOKEN_12345678')
  })

  it('overwrites token when receiving real string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { botToken: 'OLD' } }))
    process.env.QUADTODO_ROOT_DIR = tmp
    const { createApp } = await import('../src/server.js')
    const { default: request } = await import('supertest')
    const { app } = await createApp({ rootDir: tmp })
    await request(app).put('/api/config').send({
      telegram: { botToken: 'NEW_TOKEN_12345' },
    })
    const fs = await import('node:fs')
    const onDisk = JSON.parse(fs.readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken).toBe('NEW_TOKEN_12345')
  })

  it('clears token when receiving empty string', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { botToken: 'OLD' } }))
    process.env.QUADTODO_ROOT_DIR = tmp
    const { createApp } = await import('../src/server.js')
    const { default: request } = await import('supertest')
    const { app } = await createApp({ rootDir: tmp })
    await request(app).put('/api/config').send({ telegram: { botToken: '' } })
    const fs = await import('node:fs')
    const onDisk = JSON.parse(fs.readFileSync(join(tmp, 'config.json'), 'utf8'))
    expect(onDisk.telegram.botToken).toBeFalsy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/server.config-mask.test.js -t "PUT /api/config token mask"
```
预期：FAIL（mask 被写回当真实 token）。

- [ ] **Step 3: 实现**

`src/server.js:434` 的 `app.put('/api/config', ...)` 改成：

```js
	app.put("/api/config", async (req, res) => {
		try {
			const current = loadConfig({ rootDir: configRootDir });
			const nextToolsPatch = req.body?.tools || {};
			const pricingPatch = req.body?.pricing;
			const telegramPatch = { ...(req.body?.telegram || {}) }
			// 1. token mask 处理
			if ('botToken' in telegramPatch) {
				const tok = telegramPatch.botToken
				if (isMaskedToken(tok)) {
					// 用户没改，删掉这个字段（保留磁盘原值）
					delete telegramPatch.botToken
				} else if (tok === '') {
					// 显式清空
					telegramPatch.botToken = null
				}
				// 其他字符串 → 透传作为新值
			}
			// 2. botTokenMasked / botTokenSource 是 GET 出来的，不能写回
			delete telegramPatch.botTokenMasked
			delete telegramPatch.botTokenSource

			// 3. 检测 telegram 段是否变化
			const telegramChanged = JSON.stringify({ ...current.telegram, ...telegramPatch }) !== JSON.stringify(current.telegram)

			const next = {
				...current,
				...req.body,
				telegram: { ...current.telegram, ...telegramPatch },
				tools: {
					...current.tools,
					claude: mergeToolConfig(current.tools?.claude, nextToolsPatch.claude),
					codex: mergeToolConfig(current.tools?.codex, nextToolsPatch.codex),
				},
				pricing: pricingPatch
					? {
						cnyRate: pricingPatch.cnyRate ?? current.pricing.cnyRate,
						default: pricingPatch.default ?? current.pricing.default,
						models: pricingPatch.models ?? current.pricing.models,
					}
					: current.pricing,
			};
			saveConfig(next, { rootDir: configRootDir });

			runtimeConfig.defaultCwd = next.defaultCwd || runtimeConfig.defaultCwd;
			runtimeConfig.defaultTool = next.defaultTool || runtimeConfig.defaultTool;
			runtimeConfig.tools = resolveToolsConfig(next.tools);
			runtimeConfig.webhook = next.webhook || runtimeConfig.webhook;
			pty.tools = runtimeConfig.tools;

			// 4. 触发热重启
			let telegramRestart = { applied: false }
			if (telegramChanged) {
				try {
					await restartTelegramStack()
					telegramRestart = { applied: true }
				} catch (e) {
					telegramRestart = { applied: false, error: e.message }
				}
			}

			// 5. 返回时仍走 mask 逻辑
			const { token, source } = readBotTokenWithSource(() => next);
			const { botToken: _drop, ...telegramSafe } = next.telegram || {}
			res.json({
				ok: true,
				config: {
					...next,
					tools: runtimeConfig.tools,
					telegram: {
						...telegramSafe,
						botTokenMasked: maskBotToken(token),
						botTokenSource: source,
					},
				},
				toolDiagnostics: inspectToolsConfig(next.tools),
				runtimeApplied: {
					defaultCwd: runtimeConfig.defaultCwd,
					defaultTool: runtimeConfig.defaultTool,
				},
				telegramRestart,
			});
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message });
		}
	});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run test/server.config-mask.test.js
```
预期：3 个新测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server.js
git commit -m "feat(server): PUT /api/config 处理 token mask + telegram 变更触发热重启"
```

---

## Task 13：server.js mount /api/config/telegram router

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 实现**

文件顶部 import 加：

```js
import { createTelegramConfigRouter } from "./routes/telegram-config.js";
import { createProbeRegistry } from "./telegram-config-service.js";
```

在 telegram stack 的 holder 声明附近加：

```js
const probeRegistry = createProbeRegistry()
```

在 `app.use('/api/openclaw/inbound', ...)` 那一行**之后**加：

```js
	app.use("/api/config/telegram", createTelegramConfigRouter({
		getConfig: () => loadConfig({ rootDir: configRootDir }),
		getTelegramBot: () => telegramBotHolder.current,
		probeRegistry,
	}))
```

- [ ] **Step 2: 手测路由**

```bash
node src/cli.js stop || true
node src/cli.js start &
sleep 3
curl -s -X POST http://127.0.0.1:5677/api/config/telegram/test
node src/cli.js stop
```

预期：返回 `{"ok":false,"errorReason":"token_missing","source":"missing"}` 之类（如果你机器上没配 telegram）或 `{"ok":true,"botUsername":"..."}`（如果已配）。

- [ ] **Step 3: 提交**

```bash
git add src/server.js
git commit -m "feat(server): mount /api/config/telegram 路由"
```

---

## Task 14：web/src/api.ts 类型 + 新增函数

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: 改 AppConfig.telegram 类型**

`web/src/api.ts:116-123` 替换为：

```ts
  telegram?: {
    enabled?: boolean
    supergroupId?: string
    longPollTimeoutSec?: number
    useTopics?: boolean
    createTopicOnTaskStart?: boolean
    closeTopicOnSessionEnd?: boolean
    topicNameTemplate?: string
    topicNameDoneTemplate?: string
    allowedChatIds?: string[]
    allowedFromUserIds?: string[]
    notificationCooldownMs?: number
    suppressNotificationEvents?: boolean
    autoCreateTopic?: boolean
    pollRetryDelayMs?: number
    minRenameIntervalMs?: number
    botToken?: string                        // PUT 时用，GET 时为 undefined
    botTokenMasked?: string | null            // GET 时返回
    botTokenSource?: 'quadtodo' | 'openclaw' | 'missing'  // GET 时返回
  }
```

- [ ] **Step 2: 新增 API 函数**

`web/src/api.ts` 末尾追加：

```ts
export interface TelegramTestResult {
  ok: boolean
  botId?: number
  botUsername?: string | null
  botFirstName?: string | null
  source: 'quadtodo' | 'openclaw' | 'missing'
  errorReason?: string
}

export async function testTelegram(): Promise<TelegramTestResult> {
  const body = await jsonFetch<{ ok: boolean } & TelegramTestResult>('/api/config/telegram/test', { method: 'POST' })
  return body as TelegramTestResult
}

export interface ProbeStartResult {
  ok: boolean
  durationSec?: number
  expiresAt?: number
  reason?: string
}

export async function startProbeChatId(durationSec = 60): Promise<ProbeStartResult> {
  const body = await jsonFetch<{ ok: boolean } & ProbeStartResult>('/api/config/telegram/probe-chat-id', {
    method: 'POST',
    body: JSON.stringify({ durationSec }),
  })
  return body as ProbeStartResult
}

export async function stopProbeChatId(): Promise<void> {
  await jsonFetch('/api/config/telegram/probe-chat-id/stop', { method: 'POST' })
}

export interface ProbeHit {
  chatId: string
  chatTitle?: string | null
  chatType?: string | null
  fromUserId?: string | null
  fromUsername?: string | null
  textPreview?: string | null
  at: number
}

/**
 * 订阅 probe SSE。返回 close 函数。
 * onHit 收到每个命中条目；onDone 收到「probe 结束」事件。
 */
export function subscribeProbeChatId(callbacks: {
  onHit: (hit: ProbeHit) => void
  onDone?: () => void
  onError?: (err: Event) => void
}): () => void {
  const url = BASE + '/api/config/telegram/probe-chat-id/stream'
  const es = new EventSource(url)
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      callbacks.onHit(data)
    } catch {}
  }
  es.addEventListener('done', () => {
    callbacks.onDone?.()
    es.close()
  })
  es.onerror = (e) => callbacks.onError?.(e)
  return () => es.close()
}
```

注：jsonFetch 因为 .ok 检查会对 `{ ok: false, ... }` 抛错。`testTelegram` 和 `startProbeChatId` 业务上 `ok: false` 是合法回包（不是 HTTP 错误），需要 bypass jsonFetch 的检查。修正：

把这两个函数改为直接 fetch：

```ts
export async function testTelegram(): Promise<TelegramTestResult> {
  const r = await fetch(BASE + '/api/config/telegram/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  return await r.json() as TelegramTestResult
}

export async function startProbeChatId(durationSec = 60): Promise<ProbeStartResult> {
  const r = await fetch(BASE + '/api/config/telegram/probe-chat-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationSec }),
  })
  return await r.json() as ProbeStartResult
}

export async function stopProbeChatId(): Promise<void> {
  await fetch(BASE + '/api/config/telegram/probe-chat-id/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 3: 跑前端类型检查**

```bash
cd web && npm run typecheck 2>&1 | head -30 || npx tsc --noEmit 2>&1 | head -30
```

如果报错，修到通过。

- [ ] **Step 4: 提交**

```bash
git add web/src/api.ts
git commit -m "feat(web/api): telegram 配置类型 + testTelegram/probeChatId"
```

---

## Task 15：web TelegramProbeModal.tsx

**Files:**
- Create: `web/src/TelegramProbeModal.tsx`

- [ ] **Step 1: 实现**

新建 `web/src/TelegramProbeModal.tsx`：

```tsx
import { useEffect, useState, useRef } from 'react'
import { Modal, Table, Tag, message, Empty, Typography } from 'antd'
import { startProbeChatId, stopProbeChatId, subscribeProbeChatId, type ProbeHit } from './api'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onPick: (hit: ProbeHit) => void
}

export function TelegramProbeModal({ open, onClose, onPick }: Props) {
  const [hits, setHits] = useState<ProbeHit[]>([])
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const closerRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setHits([])
    setError(null)
    setExpiresAt(null)
      ; (async () => {
        const r = await startProbeChatId(60)
        if (cancelled) return
        if (!r.ok) {
          setError(r.reason || 'unknown')
          return
        }
        setExpiresAt(r.expiresAt || null)
        const close = subscribeProbeChatId({
          onHit: (hit) => setHits((prev) => [...prev, hit]),
          onDone: () => setExpiresAt(null),
          onError: () => { /* SSE 重连由浏览器处理 */ },
        })
        closerRef.current = close
      })()
    return () => {
      cancelled = true
      closerRef.current?.()
      stopProbeChatId().catch(() => { })
    }
  }, [open])

  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0)
      return
    }
    const t = setInterval(() => {
      const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) clearInterval(t)
    }, 500)
    return () => clearInterval(t)
  }, [expiresAt])

  const dedupedHits = Array.from(new Map(hits.map((h) => [h.chatId, h])).values())

  return (
    <Modal
      title="抓 supergroup ID"
      open={open}
      onCancel={onClose}
      footer={null}
      width={680}
    >
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">
          请到目标 Telegram 群里发条任意消息（@bot 或随便发都行）。
          收到的所有 chat 都会列在下面，点选你要的那一行 → 自动填回 supergroupId。
        </Text>
      </div>

      {error ? (
        <div style={{ color: '#cf1322' }}>启动失败：{error}</div>
      ) : (
        <>
          <div style={{ marginBottom: 8 }}>
            {expiresAt ? (
              <Tag color="processing">监听中… 还有 {secondsLeft}s</Tag>
            ) : (
              <Tag color="default">已结束</Tag>
            )}
            <Text type="secondary" style={{ marginLeft: 8 }}>已收到 {dedupedHits.length} 个 chat</Text>
          </div>

          <Table
            size="small"
            rowKey="chatId"
            dataSource={dedupedHits}
            pagination={false}
            scroll={{ y: 320 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没收到消息，到群里 @bot 发一条试试" /> }}
            columns={[
              { title: 'chatId', dataIndex: 'chatId', width: 160 },
              { title: '类型', dataIndex: 'chatType', width: 90 },
              { title: '群名/用户', dataIndex: 'chatTitle', width: 140, render: (v: string | null) => v || '—' },
              { title: '发送人', dataIndex: 'fromUsername', width: 120, render: (v: string | null, row: ProbeHit) => v ? `@${v}` : (row.fromUserId || '—') },
              { title: '消息预览', dataIndex: 'textPreview', render: (v: string | null) => v || '—' },
            ]}
            onRow={(record) => ({
              onClick: () => {
                onPick(record)
                message.success(`已选择 ${record.chatId}`)
                onClose()
              },
              style: { cursor: 'pointer' },
            })}
          />
        </>
      )}
    </Modal>
  )
}
```

- [ ] **Step 2: 类型检查**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

修到通过。

- [ ] **Step 3: 提交**

```bash
git add web/src/TelegramProbeModal.tsx
git commit -m "feat(web): TelegramProbeModal SSE 抓 chat 表"
```

---

## Task 16：SettingsDrawer 加 Telegram 折叠区

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 1: import 区**

`web/src/SettingsDrawer.tsx` 顶部：

```tsx
import { TelegramProbeModal } from './TelegramProbeModal'
import { testTelegram } from './api'
```

确保已 import `Collapse`、`Tag`、`Select`：

```tsx
import { ... Collapse, Tag, Select, ... } from 'antd'
```

- [ ] **Step 2: state**

`SettingsDrawer` 函数体内（在 `setSaving` 之类附近）加：

```tsx
const [probeOpen, setProbeOpen] = useState(false)
const [tokenSource, setTokenSource] = useState<'quadtodo' | 'openclaw' | 'missing'>('missing')
const [tokenMasked, setTokenMasked] = useState<string>('')
const [testing, setTesting] = useState(false)
const [testResult, setTestResult] = useState<string | null>(null)
```

- [ ] **Step 3: 改 useEffect 初始化 form**

`web/src/SettingsDrawer.tsx:104-138` 的 `useEffect(() => { ... getConfig() ... })` 块内的 `form.setFieldsValue({...})` 加上所有新字段：

```tsx
form.setFieldsValue({
  // ... 已有字段 ...
  telegramEnabled: result.config.telegram?.enabled ?? false,
  telegramBotToken: result.config.telegram?.botTokenMasked || '',
  telegramSupergroupId: result.config.telegram?.supergroupId || '',
  telegramAllowedChatIds: (result.config.telegram?.allowedChatIds || []).join('\n'),
  telegramAllowedFromUserIds: (result.config.telegram?.allowedFromUserIds || []).join('\n'),
  telegramUseTopics: result.config.telegram?.useTopics !== false,
  telegramCreateTopicOnTaskStart: result.config.telegram?.createTopicOnTaskStart !== false,
  telegramCloseTopicOnSessionEnd: result.config.telegram?.closeTopicOnSessionEnd !== false,
  telegramTopicNameTemplate: result.config.telegram?.topicNameTemplate || '#t{shortCode} {title}',
  telegramTopicNameDoneTemplate: result.config.telegram?.topicNameDoneTemplate || '✅ {originalName}',
  telegramAutoCreateTopic: result.config.telegram?.autoCreateTopic !== false,
  telegramNotificationCooldownMs: result.config.telegram?.notificationCooldownMs ?? 600000,
  telegramSuppressNotificationEvents: result.config.telegram?.suppressNotificationEvents !== false,
  telegramLongPollTimeoutSec: result.config.telegram?.longPollTimeoutSec ?? 30,
  telegramPollRetryDelayMs: result.config.telegram?.pollRetryDelayMs ?? 5000,
  telegramMinRenameIntervalMs: result.config.telegram?.minRenameIntervalMs ?? 30000,
})
setTokenSource((result.config.telegram?.botTokenSource as any) || 'missing')
setTokenMasked(result.config.telegram?.botTokenMasked || '')
```

- [ ] **Step 4: 改 handleSave 包含 telegram 段**

`handleSave` 内构造 payload 时把所有 telegram 字段加进去（替换原先的 `telegram: { ...config?.telegram, notificationCooldownMs, autoCreateTopic }`）：

```tsx
telegram: {
  enabled: Boolean(values.telegramEnabled),
  botToken: values.telegramBotToken || '',     // 后端 isMaskedToken 检测会跳过
  supergroupId: values.telegramSupergroupId || '',
  allowedChatIds: String(values.telegramAllowedChatIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
  allowedFromUserIds: String(values.telegramAllowedFromUserIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
  useTopics: values.telegramUseTopics !== false,
  createTopicOnTaskStart: values.telegramCreateTopicOnTaskStart !== false,
  closeTopicOnSessionEnd: values.telegramCloseTopicOnSessionEnd !== false,
  topicNameTemplate: values.telegramTopicNameTemplate || '#t{shortCode} {title}',
  topicNameDoneTemplate: values.telegramTopicNameDoneTemplate || '✅ {originalName}',
  autoCreateTopic: values.telegramAutoCreateTopic !== false,
  notificationCooldownMs: Number(values.telegramNotificationCooldownMs) || 0,
  suppressNotificationEvents: values.telegramSuppressNotificationEvents !== false,
  longPollTimeoutSec: Number(values.telegramLongPollTimeoutSec) || 30,
  pollRetryDelayMs: Number(values.telegramPollRetryDelayMs) || 5000,
  minRenameIntervalMs: Number(values.telegramMinRenameIntervalMs) || 30000,
},
```

- [ ] **Step 5: 加 Telegram Collapse 区到 JSX**

在 SettingsDrawer 的渲染区找到 webhook 段之后插入。注意 form name 全部是 `telegram*` 前缀。完整片段：

```tsx
<Collapse
  defaultActiveKey={['basic', 'topic', 'notify', 'security']}
  items={[
    {
      key: 'basic',
      label: 'Telegram · 基础',
      children: (
        <>
          <Form.Item name="telegramEnabled" label="启用 Telegram" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item label="Bot Token" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="telegramBotToken" noStyle>
                <Input.Password placeholder="paste token here，留空 = 用兜底来源" autoComplete="new-password" />
              </Form.Item>
              <Button
                loading={testing}
                onClick={async () => {
                  setTesting(true)
                  try {
                    const r = await testTelegram()
                    if (r.ok) {
                      setTestResult(`✓ ${r.botUsername ? '@' + r.botUsername : `id=${r.botId}`}（来源：${r.source}）`)
                      message.success('Telegram 连通')
                    } else {
                      setTestResult(`✗ ${r.errorReason || 'unknown'}`)
                      message.error(r.errorReason || '测试失败')
                    }
                  } catch (e: any) {
                    setTestResult(`✗ ${e.message}`)
                  } finally {
                    setTesting(false)
                  }
                }}
              >测试</Button>
            </Space.Compact>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Tag color={tokenSource === 'quadtodo' ? 'default' : tokenSource === 'openclaw' ? 'orange' : 'error'}>
                {tokenSource === 'quadtodo' && '来自 quadtodo 配置'}
                {tokenSource === 'openclaw' && '来自 ~/.openclaw/openclaw.json（兜底）'}
                {tokenSource === 'missing' && '未配置'}
              </Tag>
              {testResult && <span style={{ marginLeft: 8 }}>{testResult}</span>}
            </div>
          </Form.Item>

          <Form.Item label="Supergroup ID">
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="telegramSupergroupId" noStyle>
                <Input placeholder="-1001234567890" />
              </Form.Item>
              <Button onClick={() => setProbeOpen(true)}>抓 ID</Button>
            </Space.Compact>
          </Form.Item>

          <Form.Item
            name="telegramAllowedChatIds"
            label="白名单 chatIds"
            extra="一行一个 chat_id；空 = 拒绝所有（强制白名单）"
          >
            <Input.TextArea rows={3} placeholder="-1001234567890" />
          </Form.Item>
        </>
      ),
    },
    {
      key: 'topic',
      label: 'Telegram · Topic 行为',
      children: (
        <>
          <Form.Item name="telegramUseTopics" label="启用 Topics" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="telegramCreateTopicOnTaskStart" label="任务启动时建 Topic" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="telegramCloseTopicOnSessionEnd" label="Session 结束关 Topic" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="telegramAutoCreateTopic" label="非 wizard 起的 PTY 自动镜像" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="telegramTopicNameTemplate" label="Topic 名模板" extra="占位符：{shortCode} {title}">
            <Input />
          </Form.Item>
          <Form.Item name="telegramTopicNameDoneTemplate" label="完成模板" extra="占位符：{originalName}">
            <Input />
          </Form.Item>
        </>
      ),
    },
    {
      key: 'notify',
      label: 'Telegram · 通知行为',
      children: (
        <>
          <Form.Item name="telegramNotificationCooldownMs" label="同 session idle 提醒最小间隔 (ms)">
            <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="telegramSuppressNotificationEvents" label="丢弃 idle Notification 事件" valuePropName="checked">
            <Switch />
          </Form.Item>
        </>
      ),
    },
    {
      key: 'security',
      label: 'Telegram · 安全',
      children: (
        <Form.Item
          name="telegramAllowedFromUserIds"
          label="白名单 fromUserIds"
          extra="一行一个 user_id；空 = 不限"
        >
          <Input.TextArea rows={3} />
        </Form.Item>
      ),
    },
    {
      key: 'advanced',
      label: 'Telegram · 高级（不动也行）',
      children: (
        <>
          <Form.Item name="telegramLongPollTimeoutSec" label="长轮询超时 (秒)">
            <InputNumber min={5} max={120} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="telegramPollRetryDelayMs" label="拉取失败退避起点 (ms)">
            <InputNumber min={500} step={500} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="telegramMinRenameIntervalMs" label="Topic 重命名最小间隔 (ms)">
            <InputNumber min={1000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
        </>
      ),
    },
  ]}
/>

<TelegramProbeModal
  open={probeOpen}
  onClose={() => setProbeOpen(false)}
  onPick={(hit) => {
    form.setFieldValue('telegramSupergroupId', hit.chatId)
    // 同步把它加到 allowedChatIds 顶部（如果还没在里面）
    const cur = String(form.getFieldValue('telegramAllowedChatIds') || '')
    if (!cur.split('\n').includes(hit.chatId)) {
      form.setFieldValue('telegramAllowedChatIds', hit.chatId + (cur ? '\n' + cur : ''))
    }
  }}
/>
```

- [ ] **Step 6: 类型检查 + dev 起来手测**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
node src/cli.js stop || true
node src/cli.js start &
sleep 3
# 浏览器打开 http://127.0.0.1:5677/ → 设置抽屉 → 找到 Telegram 折叠区
```

手测项：
- 14 个字段都能渲染
- token 输入显示 mask 值，旁边 Tag 显示来源
- 点「测试」按钮反馈连通结果
- 点「抓 ID」按钮弹 modal，群里发条消息能列出来
- 点选某行后回 supergroupId 填回去
- 保存后再开 → 字段值持久化

```bash
node src/cli.js stop
```

- [ ] **Step 7: 提交**

```bash
git add web/src/SettingsDrawer.tsx
git commit -m "feat(web/settings): 加 Telegram 折叠区铺 14 字段"
```

---

## Task 17：补充 README & TELEGRAM 文档

**Files:**
- Modify: `docs/TELEGRAM.md`

- [ ] **Step 1: 改 setup 步骤**

把 `docs/TELEGRAM.md` 的「## 一次性 setup（约 5 分钟）」段替换为：

```markdown
## 一次性 setup（web 上完成）

> 老的 CLI 步骤见文档末尾「附：CLI setup（高级用户）」。

### 1. 在 Telegram 建一个 supergroup

- 新建 Group → 升级为 Supergroup → 启用 Topics → 把 bot 拉进群 → 给 admin + Manage Topics 权限。

### 2. 拿 bot token

跟 [@BotFather](https://t.me/BotFather) 发 `/newbot` 申请一个新 bot，记下 token。

### 3. 启动 quadtodo + 打开设置抽屉

```bash
quadtodo start
# 浏览器自动打开 → 右上角齿轮图标 → 拉到 Telegram 折叠区
```

### 4. 填 token

在 Telegram · 基础 区填入 bot token → 点「测试」→ 看到 `✓ @yourbot` 即连通。

### 5. 抓 supergroup ID

点「抓 ID」按钮 → 到群里随便发条消息 → 在弹出表格里点选你的群那一行 → 自动填回 supergroupId 和 allowedChatIds。

### 6. 保存

点保存后会看到「已保存，telegram 已重启」—— 此时长轮询已切到新 token / 新群，无需重启 quadtodo 进程。
```

- [ ] **Step 2: 提交**

```bash
git add docs/TELEGRAM.md
git commit -m "docs(telegram): setup 改为 web 流程"
```

---

## Task 18：端到端验收

**Files:**
- 无文件改动，只跑验收

- [ ] **Step 1: 全量测试**

```bash
npx vitest run
```
预期：全部 PASS。

- [ ] **Step 2: 全新装验收**

```bash
# 备份现有 config
mv ~/.quadtodo/config.json ~/.quadtodo/config.json.bak 2>/dev/null || true

node src/cli.js stop || true
node src/cli.js start &
sleep 3

# 浏览器进 SettingsDrawer，按 docs/TELEGRAM.md 流程从头跑一遍
# 必须满足：
#   - 不开终端（除了启动 quadtodo）
#   - 不读老版 CLI setup
#   - token / supergroupId / allowedChatIds 全在 web 上配完
#   - 保存后到群里发消息，bot 正常响应

# 测完恢复
node src/cli.js stop
mv ~/.quadtodo/config.json.bak ~/.quadtodo/config.json 2>/dev/null || true
```

- [ ] **Step 3: 热重启验证**

```bash
node src/cli.js start &
sleep 3

# Web SettingsDrawer 把 telegram.enabled 切到 false → 保存
# log 应有 [telegram] bot stopped
# 切回 true → log 应有 [telegram] bot started
# 期间不重启 quadtodo 进程

node src/cli.js stop
```

- [ ] **Step 4: Token 永不泄漏验证**

```bash
node src/cli.js start &
sleep 3
curl -s http://127.0.0.1:5677/api/config | python3 -c "
import json, sys
cfg = json.load(sys.stdin)['config']
tok = cfg.get('telegram', {}).get('botToken')
masked = cfg.get('telegram', {}).get('botTokenMasked')
print('botToken in response:', tok)
print('botTokenMasked:', masked)
assert tok is None or tok == '', f'TOKEN LEAKED: {tok}'
print('OK - no token leak')
"
node src/cli.js stop
```

- [ ] **Step 5: 提交（如有遗漏修复）**

```bash
git add -A
git commit -m "test: telegram web config 端到端验收通过" --allow-empty
```

---

## Self-Review Checklist

实施时按下面快速对一遍：

- **Spec 覆盖**：14 个字段（基础 4 + Topic 6 + 通知 2 + 安全 1 + 进阶 3）→ Task 1/2/3（常量提取）+ Task 16（UI 14 字段全铺）；token mask + 来源 → Task 4/6/11/12；probe-chat-id → Task 5/9/15；测试按钮 → Task 8/16；热重启 → Task 10/12。所有需求都映射到了 task。
- **占位符扫描**：无 TODO / TBD / "implement later" / "similar to Task N"。所有代码片段都给了完整代码。
- **类型一致**：`telegramBotHolder = { current }` / `unwrapHolder` / `setProbeListener` / `readBotTokenWithSource` 这几个名字在 Task 7、10、11、12、13 之间引用一致；`ProbeHit` / `TelegramTestResult` / `ProbeStartResult` 在 Task 14 定义后，Task 15、16 引用一致。
- **TDD 顺序**：Task 1-2、4-9、11-12 都是先写测、再实现、再确认通过，符合「失败 → 通过」节奏。Task 3、10、13、16-18 没有单元测试（涉及到 server 启动 / 前端组件），改为手测路径。

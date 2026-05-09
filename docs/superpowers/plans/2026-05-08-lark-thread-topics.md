# Lark Thread Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional Feishu/Lark thread-group support that mirrors the existing Telegram per-task Topic workflow.

**Architecture:** Add a focused `src/lark-bot.js` adapter for `lark-cli` send/reply/event subscription, then extend the existing wizard and bridge route model to carry Lark `rootMessageId` and `threadId`. Outbound hook messages go through `openclaw-bridge.postText`; inbound Lark message events normalize into `wizard.handleInbound({ channel: 'lark', ... })`.

**Tech Stack:** Node.js ESM, Express, Vitest, `lark-cli`, existing quadtodo DB / wizard / hook / PTY infrastructure.

---

## File Structure

- Create `src/lark-bot.js` — Lark CLI wrapper, event subscription lifecycle, message event normalization, duplicate filtering.
- Modify `src/config.js` — add default `lark` config and normalization.
- Modify `src/openclaw-bridge.js` — preserve Lark route fields, send `channel: 'lark'` messages through `larkBot.replyInThread`, route lookup by `threadId` or `rootMessageId`.
- Modify `src/openclaw-wizard.js` — make route keys channel-aware, create Lark root message on wizard completion, persist `larkRoute`, route Lark thread replies to PTY.
- Modify `src/server.js` — instantiate Lark stack, hot-restart on config changes, pass `larkBot` to bridge and wizard, stop it on server close.
- Create `test/lark-bot.test.js` — tests for CLI args, event normalization, bot self-message filtering, dedupe, restart behavior.
- Modify `test/config.test.js` — tests for `lark` defaults and normalization.
- Modify `test/openclaw-bridge.test.js` — tests for Lark route preservation, outbound reply routing, no root-message safety.
- Modify `test/openclaw-wizard.test.js` — tests for Lark wizard start, finalization, route persistence, stdin proxy.
- Modify `test/server.test.js` if needed — smoke test that Lark stack is wired without starting when disabled.
- Modify `docs/TELEGRAM.md` or create `docs/LARK.md` only if user asks for public setup docs; otherwise keep implementation and tests only.

---

### Task 1: Add Lark config defaults

**Files:**
- Modify: `src/config.js:45-86`, `src/config.js:258-360`
- Test: `test/config.test.js`

- [ ] **Step 1: Write failing config tests**

Append to `test/config.test.js`:

```js
describe('lark defaults', () => {
  it('adds lark defaults when config file omits lark section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'quadtodo-lark-config-'))
    try {
      const cfg = loadConfig({ rootDir: tmp })
      expect(cfg.lark).toEqual({
        enabled: false,
        chatId: '',
        requireThreadGroup: true,
        eventSubscribeEnabled: true,
        notificationCooldownMs: 600000,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('normalizes lark chatId and preserves explicit booleans', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'quadtodo-lark-config-'))
    try {
      writeFileSync(join(tmp, 'config.json'), JSON.stringify({
        lark: {
          enabled: true,
          chatId: '  oc_abc  ',
          requireThreadGroup: false,
          eventSubscribeEnabled: false,
          notificationCooldownMs: 0,
        },
      }))
      const cfg = loadConfig({ rootDir: tmp })
      expect(cfg.lark).toEqual({
        enabled: true,
        chatId: 'oc_abc',
        requireThreadGroup: false,
        eventSubscribeEnabled: false,
        notificationCooldownMs: 0,
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
npx vitest run test/config.test.js --runInBand
```

Expected: FAIL because `cfg.lark` is undefined or lacks the expected defaults.

- [ ] **Step 3: Add default config**

In `src/config.js`, after `DEFAULT_TELEGRAM_CONFIG`, add:

```js
const DEFAULT_LARK_CONFIG = {
	enabled: false,
	chatId: '',
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	notificationCooldownMs: 600_000,
};
```

In `defaultConfig()`, after the `telegram` block, add:

```js
			lark: { ...DEFAULT_LARK_CONFIG },
```

In `normalizeConfig(cfg = {})`, after the `telegram` block, add:

```js
			lark: {
				...DEFAULT_LARK_CONFIG,
				...(cfg.lark || {}),
				chatId: typeof cfg.lark?.chatId === 'string'
					? cfg.lark.chatId.trim()
					: DEFAULT_LARK_CONFIG.chatId,
			},
```

- [ ] **Step 4: Run config tests and verify pass**

Run:

```bash
npx vitest run test/config.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit task 1**

Do not commit unless the user explicitly requested commits. If commits are authorized, run:

```bash
git add src/config.js test/config.test.js
git commit -m "feat(lark): add thread group config defaults"
```

---

### Task 2: Add Lark bot outbound CLI wrapper

**Files:**
- Create: `src/lark-bot.js`
- Test: `test/lark-bot.test.js`

- [ ] **Step 1: Write failing outbound tests**

Create `test/lark-bot.test.js` with:

```js
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createLarkBot } from '../src/lark-bot.js'

function makeProc({ code = 0, stdout = '', stderr = '' } = {}) {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr))
    setImmediate(() => proc.emit('close', code))
  })
  return proc
}

function makeBot({ getConfig = () => ({ lark: { enabled: true, chatId: 'oc_1' } }), spawnFn } = {}) {
  return createLarkBot({
    getConfig,
    wizard: { handleInbound: vi.fn(async () => ({ reply: '' })) },
    spawnFn,
    logger: { info() {}, warn() {} },
  })
}

describe('lark-bot outbound', () => {
  it('sendMessage shells out to lark-cli messages-send with bot identity', async () => {
    const calls = []
    const bot = makeBot({
      spawnFn: (bin, args) => {
        calls.push({ bin, args })
        return makeProc({ stdout: JSON.stringify({ message_id: 'om_root', thread_id: 'omt_1' }) })
      },
    })

    const r = await bot.sendMessage({ chatId: 'oc_1', text: '#t123 demo' })

    expect(r.ok).toBe(true)
    expect(r.payload.message_id).toBe('om_root')
    expect(calls[0].bin).toBe('lark-cli')
    expect(calls[0].args).toEqual([
      'im', '+messages-send',
      '--chat-id', 'oc_1',
      '--text', '#t123 demo',
      '--as', 'bot',
    ])
  })

  it('replyInThread shells out to lark-cli messages-reply with reply-in-thread', async () => {
    const calls = []
    const bot = makeBot({
      spawnFn: (bin, args) => {
        calls.push({ bin, args })
        return makeProc({ stdout: JSON.stringify({ message_id: 'om_reply', root_id: 'om_root' }) })
      },
    })

    const r = await bot.replyInThread({ rootMessageId: 'om_root', text: 'AI output' })

    expect(r.ok).toBe(true)
    expect(calls[0].args).toEqual([
      'im', '+messages-reply',
      '--message-id', 'om_root',
      '--text', 'AI output',
      '--reply-in-thread',
      '--as', 'bot',
    ])
  })

  it('returns validation errors without spawning', async () => {
    const spawnFn = vi.fn()
    const bot = makeBot({ spawnFn })

    await expect(bot.sendMessage({ chatId: '', text: 'x' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(bot.sendMessage({ chatId: 'oc_1', text: '' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(bot.replyInThread({ rootMessageId: '', text: 'x' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(bot.replyInThread({ rootMessageId: 'om_1', text: '' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    expect(spawnFn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run outbound tests and verify failure**

Run:

```bash
npx vitest run test/lark-bot.test.js --runInBand
```

Expected: FAIL because `src/lark-bot.js` does not exist.

- [ ] **Step 3: Implement outbound wrapper**

Create `src/lark-bot.js`:

```js
import { spawn } from 'node:child_process'

const DEFAULT_CLI_BIN = 'lark-cli'
const DEFAULT_TIMEOUT_MS = 60_000

function parseJsonOrNull(text) {
  try { return JSON.parse(text) } catch { return null }
}

function runCli({ cliBin, spawnFn, args, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let proc
    try {
      proc = spawnFn(cliBin, args, { env: process.env })
    } catch (e) {
      finish({ ok: false, reason: 'cli_spawn_failed', detail: e.message })
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
      finish({ ok: false, reason: 'timeout', stderr })
    }, timeoutMs)
    timer.unref?.()

    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, reason: 'cli_error', detail: e.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ ok: false, reason: 'cli_failed', exitCode: code, stderr })
        return
      }
      finish({ ok: true, payload: parseJsonOrNull(stdout), stdout })
    })
  })
}

export function createLarkBot({
  getConfig,
  wizard,
  cliBin = DEFAULT_CLI_BIN,
  spawnFn = spawn,
  logger = console,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')
  if (!wizard || typeof wizard.handleInbound !== 'function') throw new Error('wizard_required')

  async function sendMessage({ chatId, text } = {}) {
    if (!chatId) return { ok: false, reason: 'chatId_required' }
    if (!text) return { ok: false, reason: 'text_required' }
    return await runCli({
      cliBin,
      spawnFn,
      args: ['im', '+messages-send', '--chat-id', String(chatId), '--text', String(text), '--as', 'bot'],
    })
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (!rootMessageId) return { ok: false, reason: 'rootMessageId_required' }
    if (!text) return { ok: false, reason: 'text_required' }
    return await runCli({
      cliBin,
      spawnFn,
      args: [
        'im', '+messages-reply',
        '--message-id', String(rootMessageId),
        '--text', String(text),
        '--reply-in-thread',
        '--as', 'bot',
      ],
    })
  }

  function describe() {
    const cfg = getConfig()?.lark || {}
    return {
      enabled: !!cfg.enabled,
      chatId: cfg.chatId || '',
      eventSubscribeEnabled: cfg.eventSubscribeEnabled !== false,
    }
  }

  return { sendMessage, replyInThread, describe }
}
```

- [ ] **Step 4: Run outbound tests and verify pass**

Run:

```bash
npx vitest run test/lark-bot.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit task 2**

If commits are authorized, run:

```bash
git add src/lark-bot.js test/lark-bot.test.js
git commit -m "feat(lark): add bot send and thread reply wrapper"
```

---

### Task 3: Add Lark event normalization and subscription lifecycle

**Files:**
- Modify: `src/lark-bot.js`
- Test: `test/lark-bot.test.js`

- [ ] **Step 1: Add failing event tests**

Append to `test/lark-bot.test.js`:

```js
describe('lark-bot inbound events', () => {
  function makeInboundBot({ wizardReply = '', getConfig } = {}) {
    const replies = []
    const wizard = {
      handleInbound: vi.fn(async () => ({ reply: wizardReply, action: 'handled' })),
    }
    const bot = createLarkBot({
      getConfig: getConfig || (() => ({ lark: { enabled: true, chatId: 'oc_1' } })),
      wizard,
      spawnFn: (bin, args) => {
        replies.push({ bin, args })
        return makeProc({ stdout: JSON.stringify({ message_id: 'om_reply' }) })
      },
      logger: { info() {}, warn() {} },
    })
    return { bot, wizard, replies }
  }

  it('normalizes thread message events and replies in thread', async () => {
    const { bot, wizard, replies } = makeInboundBot({ wizardReply: 'ack' })

    const r = await bot.handleEvent({
      event_id: 'evt_1',
      event: {
        message: {
          chat_id: 'oc_1',
          message_id: 'om_child',
          thread_id: 'omt_1',
          root_id: 'om_root',
          message_type: 'text',
          content: JSON.stringify({ text: 'continue' }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(r.ok).toBe(true)
    expect(wizard.handleInbound).toHaveBeenCalledWith({
      channel: 'lark',
      chatId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      messageId: 'om_child',
      text: 'continue',
      fromUserId: 'ou_user',
    })
    expect(replies[0].args).toContain('--message-id')
    expect(replies[0].args).toContain('om_root')
  })

  it('normalizes main-stream events and replies to chat', async () => {
    const { bot, wizard, replies } = makeInboundBot({ wizardReply: 'pick workdir' })

    await bot.handleEvent({
      event_id: 'evt_2',
      event: {
        message: {
          chat_id: 'oc_1',
          message_id: 'om_main',
          message_type: 'text',
          content: JSON.stringify({ text: '帮我做 X' }),
        },
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      },
    })

    expect(wizard.handleInbound).toHaveBeenCalledWith({
      channel: 'lark',
      chatId: 'oc_1',
      threadId: null,
      rootMessageId: null,
      messageId: 'om_main',
      text: '帮我做 X',
      fromUserId: 'ou_user',
    })
    expect(replies[0].args).toContain('--chat-id')
    expect(replies[0].args).toContain('oc_1')
  })

  it('drops events from other chats, bot messages, and duplicates', async () => {
    const { bot, wizard } = makeInboundBot()

    await bot.handleEvent({ event_id: 'evt_other', event: { message: { chat_id: 'oc_2', message_id: 'om_1', content: '{"text":"x"}' }, sender: { sender_type: 'user' } } })
    await bot.handleEvent({ event_id: 'evt_bot', event: { message: { chat_id: 'oc_1', message_id: 'om_2', content: '{"text":"x"}' }, sender: { sender_type: 'app' } } })
    await bot.handleEvent({ event_id: 'evt_dup', event: { message: { chat_id: 'oc_1', message_id: 'om_3', content: '{"text":"x"}' }, sender: { sender_type: 'user' } } })
    await bot.handleEvent({ event_id: 'evt_dup', event: { message: { chat_id: 'oc_1', message_id: 'om_3', content: '{"text":"x"}' }, sender: { sender_type: 'user' } } })

    expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run event tests and verify failure**

Run:

```bash
npx vitest run test/lark-bot.test.js --runInBand
```

Expected: FAIL because `handleEvent` is not implemented.

- [ ] **Step 3: Implement event normalization**

In `src/lark-bot.js`, add helpers above `createLarkBot`:

```js
function extractText(message = {}) {
  const content = typeof message.content === 'string' ? parseJsonOrNull(message.content) : message.content
  if (typeof content?.text === 'string') return content.text
  if (typeof content?.title === 'string') return content.title
  return ''
}

function rememberSeen(seen, key, max = 500) {
  if (!key) return false
  if (seen.has(key)) return false
  seen.set(key, Date.now())
  while (seen.size > max) {
    const first = seen.keys().next().value
    seen.delete(first)
  }
  return true
}

function normalizeEvent(raw) {
  const event = raw?.event || raw
  const message = event?.message || {}
  const sender = event?.sender || {}
  const chatId = message.chat_id || message.chatId || null
  const messageId = message.message_id || message.messageId || null
  const threadId = message.thread_id || message.threadId || null
  const rootMessageId = message.root_id || message.rootId || message.parent_id || message.parentId || null
  const fromUserId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || sender?.open_id || null
  const senderType = sender.sender_type || sender.type || null
  return {
    eventId: raw?.event_id || raw?.eventId || messageId,
    chatId: chatId ? String(chatId) : null,
    messageId: messageId ? String(messageId) : null,
    threadId: threadId ? String(threadId) : null,
    rootMessageId: rootMessageId ? String(rootMessageId) : null,
    text: extractText(message),
    fromUserId: fromUserId ? String(fromUserId) : null,
    senderType,
  }
}
```

Inside `createLarkBot`, before `sendMessage`, add:

```js
  const seenEvents = new Map()
```

Inside the returned object, include `handleEvent` and `__test__`:

```js
  async function handleEvent(raw) {
    const cfg = getConfig()?.lark || {}
    const ev = normalizeEvent(raw)
    if (!ev.eventId || !rememberSeen(seenEvents, ev.eventId)) return { ok: true, action: 'duplicate' }
    if (!ev.chatId || String(ev.chatId) !== String(cfg.chatId || '')) return { ok: true, action: 'ignored_chat' }
    if (ev.senderType === 'app' || ev.senderType === 'bot') return { ok: true, action: 'ignored_self' }
    if (!ev.text) return { ok: true, action: 'ignored_empty' }

    const result = await wizard.handleInbound({
      channel: 'lark',
      chatId: ev.chatId,
      threadId: ev.threadId,
      rootMessageId: ev.rootMessageId,
      messageId: ev.messageId,
      text: ev.text,
      fromUserId: ev.fromUserId,
    })

    if (result?.reply) {
      if (ev.rootMessageId) await replyInThread({ rootMessageId: ev.rootMessageId, text: result.reply })
      else await sendMessage({ chatId: ev.chatId, text: result.reply })
    }
    return { ok: true, action: result?.action || 'handled' }
  }
```

Change the return line to:

```js
  return { sendMessage, replyInThread, handleEvent, describe, __test__: { normalizeEvent } }
```

- [ ] **Step 4: Run event tests and verify pass**

Run:

```bash
npx vitest run test/lark-bot.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 5: Add subscription lifecycle tests**

Append:

```js
describe('lark-bot subscription lifecycle', () => {
  it('start spawns lark event subscriber when enabled', () => {
    const calls = []
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    const bot = createLarkBot({
      getConfig: () => ({ lark: { enabled: true, chatId: 'oc_1', eventSubscribeEnabled: true } }),
      wizard: { handleInbound: vi.fn(async () => ({ reply: '' })) },
      spawnFn: (bin, args) => { calls.push({ bin, args }); return proc },
      logger: { info() {}, warn() {} },
    })

    bot.start()

    expect(calls[0].bin).toBe('lark-cli')
    expect(calls[0].args).toEqual(['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--as', 'bot'])
    expect(bot.describe().running).toBe(true)
  })

  it('stop kills subscriber and disables restart', async () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = vi.fn()
    const bot = createLarkBot({
      getConfig: () => ({ lark: { enabled: true, chatId: 'oc_1', eventSubscribeEnabled: true } }),
      wizard: { handleInbound: vi.fn(async () => ({ reply: '' })) },
      spawnFn: () => proc,
      logger: { info() {}, warn() {} },
    })

    bot.start()
    await bot.stop()

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(bot.describe().running).toBe(false)
  })
})
```

- [ ] **Step 6: Implement subscription lifecycle**

In `src/lark-bot.js`, inside `createLarkBot`, add state:

```js
  let running = false
  let proc = null
  let buffer = ''
  let restartTimer = null
```

Add functions:

```js
  function scheduleRestart() {
    if (!running) return
    if (restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      start()
    }, 5000)
    restartTimer.unref?.()
  }

  function onStdout(chunk) {
    buffer += chunk.toString()
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      const parsed = parseJsonOrNull(line)
      if (!parsed) {
        logger.warn?.(`[lark] ignored non-json event line: ${line.slice(0, 120)}`)
        continue
      }
      handleEvent(parsed).catch((e) => logger.warn?.(`[lark] handle event failed: ${e.message}`))
    }
  }

  function start() {
    const cfg = getConfig()?.lark || {}
    if (!cfg.enabled || cfg.eventSubscribeEnabled === false) return { ok: false, reason: 'disabled' }
    if (!cfg.chatId) return { ok: false, reason: 'chatId_missing' }
    if (proc) return { ok: true, action: 'already_running' }
    running = true
    buffer = ''
    proc = spawnFn(cliBin, ['event', '+subscribe', '--event-types', 'im.message.receive_v1', '--compact', '--as', 'bot'], { env: process.env })
    proc.stdout?.on('data', onStdout)
    proc.stderr?.on('data', (d) => logger.warn?.(`[lark] ${d.toString().trim()}`))
    proc.on('error', (e) => {
      logger.warn?.(`[lark] subscriber error: ${e.message}`)
      proc = null
      scheduleRestart()
    })
    proc.on('close', (code) => {
      logger.warn?.(`[lark] subscriber exited code=${code}`)
      proc = null
      scheduleRestart()
    })
    return { ok: true, action: 'started' }
  }

  async function stop() {
    running = false
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const current = proc
    proc = null
    if (current?.kill) current.kill('SIGTERM')
    return { ok: true }
  }
```

Update `describe()` to include `running`:

```js
      running,
```

Update return:

```js
  return { start, stop, sendMessage, replyInThread, handleEvent, describe, __test__: { normalizeEvent } }
```

- [ ] **Step 7: Run all lark-bot tests**

Run:

```bash
npx vitest run test/lark-bot.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit task 3**

If commits are authorized, run:

```bash
git add src/lark-bot.js test/lark-bot.test.js
git commit -m "feat(lark): subscribe to message events"
```

---

### Task 4: Extend bridge routes and Lark outbound hook delivery

**Files:**
- Modify: `src/openclaw-bridge.js:145-442`
- Test: `test/openclaw-bridge.test.js`

- [ ] **Step 1: Add failing bridge tests**

Append to `test/openclaw-bridge.test.js`:

```js
describe('openclaw-bridge lark routing', () => {
  it('registerSessionRoute preserves lark rootMessageId threadId and app link', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true } }),
      spawnFn: () => makeFakeProc({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })

    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      topicName: '#t123 demo',
      messageAppLink: 'https://example.test/thread',
    })

    expect(bridge.resolveRoute('s-lark')).toMatchObject({
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      topicName: '#t123 demo',
      messageAppLink: 'https://example.test/thread',
    })
  })

  it('postText sends lark session messages via larkBot.replyInThread', async () => {
    const sent = []
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true } }),
      spawnFn: () => makeFakeProc({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
      larkBot: {
        replyInThread: async (args) => { sent.push(args); return { ok: true, payload: { message_id: 'om_reply' } } },
      },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      topicName: '#t123 demo',
    })

    const r = await bridge.postText({ sessionId: 's-lark', message: 'AI output' })

    expect(r).toMatchObject({ ok: true, fast: true })
    expect(sent).toEqual([{ rootMessageId: 'om_root', text: 'AI output' }])
  })

  it('postText refuses lark route without rootMessageId', async () => {
    let spawned = false
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true } }),
      spawnFn: () => { spawned = true; return makeFakeProc({ stdout: '{}' }) },
      logger: { warn() {}, info() {} },
      larkBot: { replyInThread: async () => ({ ok: true }) },
    })
    bridge.registerSessionRoute('s-lark', { channel: 'lark', targetUserId: 'oc_1', threadId: 'omt_1' })

    const r = await bridge.postText({ sessionId: 's-lark', message: 'AI output' })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('lark_root_message_missing')
    expect(spawned).toBe(false)
  })

  it('findSessionByRoute can match lark by threadId or rootMessageId', () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({ openclaw: { enabled: true } }),
      spawnFn: () => makeFakeProc({ stdout: '{}' }),
      logger: { warn() {}, info() {} },
    })
    bridge.registerSessionRoute('s-lark', {
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
    })

    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', threadId: 'omt_1' })).toBe('s-lark')
    expect(bridge.findSessionByRoute({ channel: 'lark', chatId: 'oc_1', rootMessageId: 'om_root' })).toBe('s-lark')
  })
})
```

- [ ] **Step 2: Run bridge tests and verify failure**

Run:

```bash
npx vitest run test/openclaw-bridge.test.js --runInBand
```

Expected: FAIL because `larkBot`, `rootMessageId`, and channel-aware route lookup are absent.

- [ ] **Step 3: Extend bridge constructor and route storage**

In `src/openclaw-bridge.js`, update `createOpenClawBridge` parameters:

```js
  larkBot: initialLarkBot = null,
```

After `let telegramBot = initialTelegramBot`, add:

```js
  let larkBot = initialLarkBot
```

Update `registerSessionRoute` signature and stored object:

```js
  function registerSessionRoute(sessionId, { targetUserId, account, channel, threadId, rootMessageId, topicName, triggerMessageId, messageAppLink } = {}) {
    if (!sessionId || !targetUserId) return
    sessionRoutes.set(sessionId, {
      targetUserId,
      account: account || null,
      channel: channel || getOpenClawConfig().channel || 'openclaw-weixin',
      threadId: threadId != null ? threadId : null,
      rootMessageId: rootMessageId || null,
      topicName: topicName || null,
      triggerMessageId: triggerMessageId != null ? triggerMessageId : null,
      messageAppLink: messageAppLink || null,
    })
  }
```

- [ ] **Step 4: Add Lark fast path in `postText`**

In `postText`, after the Telegram block and before CLI fallback, add:

```js
    if (effectiveChannel === 'lark') {
      const rootMessageId = route?.rootMessageId || null
      if (!rootMessageId) {
        logger.warn?.(`[openclaw-bridge] refuse lark send: sid=${sessionId} has no rootMessageId`)
        return { ok: false, reason: 'lark_root_message_missing' }
      }
      if (!larkBot?.replyInThread) return { ok: false, reason: 'lark_bot_not_running' }
      const r = await larkBot.replyInThread({ rootMessageId, text: message })
      if (r.ok) {
        recordSend()
        if (sessionId && rawTarget) lastPushByPeer.set(String(rawTarget), { sessionId, sentAt: Date.now() })
        return { ok: true, payload: r.payload, fast: true }
      }
      return { ok: false, reason: r.reason || 'lark_send_failed', detail: r.detail || r.stderr }
    }
```

- [ ] **Step 5: Extend route lookup and setters**

Replace `findSessionByRoute` with:

```js
  function findSessionByRoute({ channel = null, chatId, threadId = null, rootMessageId = null } = {}) {
    if (!chatId) return null
    const targetStr = String(chatId)
    for (const [sid, info] of sessionRoutes) {
      if (channel && info?.channel !== channel) continue
      if (String(info?.targetUserId || '') !== targetStr) continue
      if (rootMessageId && info?.rootMessageId === rootMessageId) return sid
      if ((info?.threadId || null) === (threadId || null)) return sid
    }
    return null
  }
```

Add near `setTelegramBot` if present, or near other public setters:

```js
  function setLarkBot(bot) {
    larkBot = bot || null
  }
```

Ensure the returned object includes `setLarkBot`.

- [ ] **Step 6: Run bridge tests and verify pass**

Run:

```bash
npx vitest run test/openclaw-bridge.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit task 4**

If commits are authorized, run:

```bash
git add src/openclaw-bridge.js test/openclaw-bridge.test.js
git commit -m "feat(lark): route hook output to thread replies"
```

---

### Task 5: Make wizard channel-aware and create Lark task topics

**Files:**
- Modify: `src/openclaw-wizard.js:240-1270`
- Test: `test/openclaw-wizard.test.js`

- [ ] **Step 1: Add failing wizard tests**

Append to `test/openclaw-wizard.test.js`:

```js
describe('openclaw-wizard lark topic integration', () => {
  it('Lark: handleInbound accepts main-stream events and starts wizard', async () => {
    const r = await wizard.handleInbound({ channel: 'lark', chatId: 'oc_1', threadId: null, messageId: 'om_main', text: '帮我做 飞书任务' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('📁')
  })

  it('Lark: finalizeWizard sends root topic message and registers route', async () => {
    const fakeLarkBot = {
      sendMessage: vi.fn(async () => ({
        ok: true,
        payload: {
          message_id: 'om_root',
          thread_id: 'omt_1',
          message_app_link: 'https://example.test/thread',
        },
      })),
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      larkBot: fakeLarkBot,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude', lark: { enabled: true, chatId: 'oc_1' } }),
    })

    const r = await w2.handleInbound({
      channel: 'lark',
      chatId: 'oc_1',
      threadId: null,
      messageId: 'om_trigger',
      text: '帮我做 飞书路由测试，目录 /tmp/foo, 象限 2, Bug 修复 模板',
    })

    expect(r.action).toBe('wizard_done')
    expect(fakeLarkBot.sendMessage).toHaveBeenCalledWith({ chatId: 'oc_1', text: expect.stringContaining('#t') })
    const ses = ai.sessions[0]
    expect(bridge.routes.get(ses.sessionId)).toMatchObject({
      channel: 'lark',
      targetUserId: 'oc_1',
      threadId: 'omt_1',
      rootMessageId: 'om_root',
      messageAppLink: 'https://example.test/thread',
    })
  })

  it('Lark: thread reply routes to PTY via lark route', async () => {
    const writes = []
    const fakePty = {
      has: (sid) => sid === 's-lark',
      write: (sid, data) => writes.push({ sid, data }),
    }
    const fakeBridge = {
      ...bridge,
      findSessionByRoute: ({ channel, chatId, threadId, rootMessageId }) => {
        if (channel === 'lark' && chatId === 'oc_1' && (threadId === 'omt_1' || rootMessageId === 'om_root')) return 's-lark'
        return null
      },
      getLastPushedSession: () => null,
    }
    const w2 = createOpenClawWizard({
      db, aiTerminal: { sessions: new Map([['s-lark', { todoId: 't1', status: 'running' }]]) }, openclaw: fakeBridge, pending,
      pty: fakePty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r = await w2.handleInbound({ channel: 'lark', chatId: 'oc_1', threadId: 'omt_1', rootMessageId: 'om_root', text: '继续' })

    expect(r.action).toBe('stdin_proxy')
    expect(writes[0]).toEqual({ sid: 's-lark', data: '继续' })
  })
})
```

- [ ] **Step 2: Run wizard tests and verify failure**

Run:

```bash
npx vitest run test/openclaw-wizard.test.js --runInBand
```

Expected: FAIL because `larkBot` and `channel` routing are absent.

- [ ] **Step 3: Make route key channel-aware**

Replace `makeRouteKey(chatId, threadId)` with:

```js
function makeRouteKey(channel, chatId, threadId) {
  return `${channel || 'openclaw'}:${chatId}:${threadId || 'general'}`
}
```

Update all calls:

```js
makeRouteKey(channel, chatId, threadId)
```

In `startWizard`, change signature:

```js
  function startWizard({ channel = 'openclaw', chatId, threadId, text, messageId = null, imagePaths = [] }) {
    const routeKey = makeRouteKey(channel, chatId, threadId)
```

Add `channel` to the wizard state:

```js
      channel,
```

- [ ] **Step 4: Accept `larkBot` in wizard constructor and inbound args**

Update constructor signature:

```js
  pty = null, telegramBot = null, larkBot = null, loadingTracker = null,
```

In `handleInbound`, after `chatId`:

```js
    const channel = args.channel || (chatId && /^-?\d+$/.test(String(chatId)) ? 'telegram' : 'openclaw')
```

Update route key:

```js
    const routeKey = makeRouteKey(channel, chatId, threadId)
```

Read Lark root message:

```js
    const rootMessageId = args.rootMessageId != null ? String(args.rootMessageId) : null
```

When calling `startWizard`, pass `channel` in every call:

```js
const w = startWizard({ channel, chatId, threadId, text: trimmed, messageId, imagePaths })
```

- [ ] **Step 5: Add Lark topic creation in `finalizeWizard`**

In `finalizeWizard`, after Telegram topic creation and before `spawnSession`, add:

```js
      let larkRootMessageId = null
      let larkThreadId = null
      let larkMessageAppLink = null
      const canCreateLarkTopic = w.channel === 'lark' && !!larkBot?.sendMessage
      if (canCreateLarkTopic) {
        const intro = [
          `${topicName}`,
          `AI 已启动，后续输出会回复在这个话题里。`,
          ``,
          `象限 Q${w.chosenQuadrant || 2} · 目录 ${w.chosenWorkdir || '默认'} · 模板 ${w.chosenTemplate?.name || '自由模式'}`,
        ].join('\n')
        const sent = await larkBot.sendMessage({ chatId: w.chatId, text: intro })
        if (sent.ok) {
          larkRootMessageId = sent.payload?.message_id || null
          larkThreadId = sent.payload?.thread_id || null
          larkMessageAppLink = sent.payload?.message_app_link || null
        } else {
          logger.warn?.(`[wizard] lark root message failed: ${sent.reason || 'unknown'} ${sent.detail || sent.stderr || ''}`)
        }
      }
```

- [ ] **Step 6: Register and persist Lark route**

Replace the `openclaw.registerSessionRoute` block with channel-specific route construction:

```js
        const route = (() => {
          if (w.channel === 'lark' && larkRootMessageId) {
            return {
              targetUserId: w.peer,
              threadId: larkThreadId,
              rootMessageId: larkRootMessageId,
              topicName,
              messageAppLink: larkMessageAppLink,
              triggerMessageId: w.triggerMessageId || null,
              account: null,
              channel: 'lark',
            }
          }
          return {
            targetUserId: w.peer,
            threadId: createdThreadId,
            topicName,
            triggerMessageId: w.triggerMessageId || null,
            account: null,
            channel: createdThreadId ? 'telegram' : null,
          }
        })()

        if (openclaw?.registerSessionRoute && w.peer) {
          openclaw.registerSessionRoute(sessionId, route)
        }
```

Replace Telegram-only persistence with:

```js
        if (sessionInfo) {
          try {
            const todoNow = db.getTodo(todo.id)
            if (todoNow) {
              const updatedSessions = (todoNow.aiSessions || []).map((s) => {
                if (s.sessionId !== sessionId) return s
                if (w.channel === 'lark' && larkRootMessageId) return { ...s, larkRoute: route }
                if (createdThreadId) return { ...s, telegramRoute: route }
                return s
              })
              db.updateTodo(todo.id, { aiSessions: updatedSessions })
            }
          } catch (e) {
            logger.warn?.(`[wizard] persist route failed: ${e.message}`)
          }
        }
```

- [ ] **Step 7: Make Lark thread replies route to PTY**

In PTY proxy target lookup, change the strict route branch to:

```js
        if ((threadId || rootMessageId) && openclaw?.findSessionByRoute) {
          const sid = openclaw.findSessionByRoute({ channel, chatId, threadId, rootMessageId })
          if (sid && pty.has?.(sid)) return sid
          if (sid && !pty.has?.(sid) && channel === 'lark') return { ended: true }
        }
```

Before the `targetSid && typeof targetSid === 'object' && targetSid.ambiguous` block, add:

```js
      if (targetSid && typeof targetSid === 'object' && targetSid.ended) {
        return {
          reply: '这个任务已结束，请在群里重新发起任务。',
          action: 'session_ended',
        }
      }
```

- [ ] **Step 8: Keep Telegram General protection scoped to Telegram only**

Change:

```js
const isSupergroup = chatId && /^-100\d+/.test(String(chatId))
```

to:

```js
const isSupergroup = channel === 'telegram' && chatId && /^-100\d+/.test(String(chatId))
```

Change `isInTopicOfSupergroup` and `isInGeneralOfSupergroup` checks to include `channel === 'telegram'`.

- [ ] **Step 9: Run wizard tests and verify pass**

Run:

```bash
npx vitest run test/openclaw-wizard.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 10: Commit task 5**

If commits are authorized, run:

```bash
git add src/openclaw-wizard.js test/openclaw-wizard.test.js
git commit -m "feat(lark): create per-task thread topics"
```

---

### Task 6: Wire Lark stack into server lifecycle

**Files:**
- Modify: `src/server.js:33-43`, `src/server.js:444-536`, `src/server.js:893-1070`, `src/server.js:1269-1273`
- Test: `test/server.test.js` or `test/server.config-mask.test.js`

- [ ] **Step 1: Add failing server smoke test**

Append to `test/server.test.js` if it already creates `createServer`; otherwise create the same pattern used by existing server tests:

```js
it('starts without lark enabled and exposes lark config defaults', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'quadtodo-server-lark-'))
  try {
    const srv = createServer({ configRootDir: tmp })
    const address = await srv.listen(0)
    const base = `http://127.0.0.1:${address.port}`
    const res = await fetch(`${base}/api/config`)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.config.lark).toMatchObject({
      enabled: false,
      chatId: '',
      requireThreadGroup: true,
      eventSubscribeEnabled: true,
    })
    await srv.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run server test and verify failure if imports/wiring absent**

Run:

```bash
npx vitest run test/server.test.js --runInBand
```

Expected before wiring: config default may pass after Task 1, but the test ensures server remains healthy. Continue with wiring even if this specific test already passes.

- [ ] **Step 3: Import Lark bot**

In `src/server.js`, add:

```js
import { createLarkBot } from './lark-bot.js'
```

- [ ] **Step 4: Detect Lark config changes in `/api/config` PUT**

Near Telegram patch logic, add:

```js
				const larkPatch = { ...(req.body?.lark || {}) };
```

Build merged Lark:

```js
				const mergedLark = { ...current.lark, ...larkPatch };
				const larkChanged = JSON.stringify(mergedLark) !== JSON.stringify(current.lark);
```

Exclude both sections from raw spread:

```js
				const { telegram: _t, lark: _l, ...bodyWithoutTelegram } = req.body || {};
```

Add `lark: mergedLark` to `next`.

Add restart result:

```js
				let larkRestart = { applied: false };
				if (larkChanged) {
					try {
						await restartLarkStack();
						larkRestart = { applied: true };
					} catch (e) {
						larkRestart = { applied: false, error: e.message };
					}
				}
```

Add `larkRestart` to `runtimeApplied` response object next to `telegramRestart`.

- [ ] **Step 5: Add Lark holder and stack lifecycle**

After Telegram holders:

```js
		const larkBotHolder = { current: null }
```

After `restartTelegramStack`, add:

```js
		function startLarkStack() {
			const cfg = loadConfig({ rootDir: configRootDir })
			const lk = cfg.lark || {}
			if (!lk.enabled) {
				console.log('[lark] disabled, skipping bot start')
				return
			}
			const bot = createLarkBot({
				getConfig: () => loadConfig({ rootDir: configRootDir }),
				wizard: {
					handleInbound: (...args) => openclawWizardLazyRef.handleInbound(...args),
				},
				logger: { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a) },
			})
			larkBotHolder.current = bot
			openclawBridge.setLarkBot?.(bot)
			bot.start?.()
			console.log(`[lark] bot started; chatId=${lk.chatId || '(unset)'}`)
		}

		async function stopLarkStack() {
			const bot = larkBotHolder.current
			if (!bot) return
			try { await bot.stop?.() } catch (e) { console.warn(`[lark] stop failed: ${e.message}`) }
			larkBotHolder.current = null
			try { openclawBridge.setLarkBot?.(null) } catch {}
			console.log('[lark] bot stopped')
		}

		async function restartLarkStack() {
			await stopLarkStack()
			startLarkStack()
		}
```

- [ ] **Step 6: Pass Lark bot proxy into bridge and wizard**

After `telegramBotProxy`:

```js
		const larkBotProxy = unwrapHolder(larkBotHolder, 'lark_bot')
```

Add Lark async methods to `unwrapHolder`:

```js
'start', 'stop', 'sendMessage', 'replyInThread', 'handleEvent',
```

When creating the bridge, either pass later via setter or constructor. Use setter after proxy creation:

```js
		openclawBridge.setLarkBot?.(larkBotProxy)
```

Add to wizard creation:

```js
			larkBot: larkBotProxy,
```

- [ ] **Step 7: Start and stop Lark stack**

After `startTelegramStack()`:

```js
		startLarkStack()
```

In `close()` add:

```js
			try { larkBotHolder.current?.stop?.() } catch { /* ignore */ }
```

- [ ] **Step 8: Rehydrate Lark routes**

In route rehydration block, after Telegram route handling:

```js
					if (aiSess?.larkRoute) {
						openclawBridge.registerSessionRoute(sid, aiSess.larkRoute)
						rehydrated++
					}
```

Update log wording:

```js
if (rehydrated > 0) console.log(`[server] rehydrated ${rehydrated} session route(s)`)
```

- [ ] **Step 9: Run server tests**

Run:

```bash
npx vitest run test/server.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 10: Commit task 6**

If commits are authorized, run:

```bash
git add src/server.js test/server.test.js
git commit -m "feat(lark): wire bot into server lifecycle"
```

---

### Task 7: Verify hook delivery, inbound routing, and regressions

**Files:**
- Modify if failures require fixes: `src/lark-bot.js`, `src/openclaw-bridge.js`, `src/openclaw-wizard.js`, `src/server.js`
- Test: existing test suite

- [ ] **Step 1: Run focused Lark and route tests**

Run:

```bash
npx vitest run test/lark-bot.test.js test/openclaw-bridge.test.js test/openclaw-wizard.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run Telegram regression tests**

Run:

```bash
npx vitest run test/telegram-bot.test.js test/telegram-sync.test.js test/telegram-loading-status.test.js test/openclaw-hook.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run full suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Manual dry-run checks for Lark CLI commands**

Run:

```bash
lark-cli im +messages-send --chat-id oc_dummy --text "#t123 dry run" --dry-run --as bot
lark-cli im +messages-reply --message-id om_dummy --text "dry run reply" --reply-in-thread --dry-run --as bot
lark-cli event +subscribe --event-types im.message.receive_v1 --dry-run --as bot
```

Expected: all commands print dry-run output and do not send real messages.

- [ ] **Step 5: Manual end-to-end validation with real Feishu only after user approves external message sending**

Ask the user to confirm the target Feishu group and permission to send test messages. After confirmation, run quadtodo with:

```bash
quadtodo config set lark.enabled true
quadtodo config set lark.chatId oc_xxx
quadtodo config set lark.eventSubscribeEnabled true
quadtodo start
```

Expected runtime behavior:

1. Main-stream Feishu message `帮我做 测试飞书双向，目录 /tmp, 象限 2, Bug 修复 模板` creates a todo and AI session.
2. Feishu thread group receives root topic message `#t... 测试飞书双向`.
3. AI Stop hook reply appears under that thread.
4. User thread reply `继续` is written to the matching PTY.
5. SessionEnd reply appears under the same thread.

- [ ] **Step 6: Commit verification fixes**

If tests required fixes and commits are authorized, run:

```bash
git add src test
git commit -m "fix(lark): stabilize thread topic routing"
```

---

## Self-Review

**Spec coverage:**
- Lark thread-group task root message: Task 5.
- AI output reply to thread: Task 4.
- Inbound Lark thread replies to PTY: Tasks 3 and 5.
- Event subscription lifecycle and dedupe: Task 3.
- Config and server lifecycle: Tasks 1 and 6.
- Telegram non-regression: Task 7.

**Placeholder scan:** No `TBD`, `TODO`, incomplete field names, or deferred implementation notes remain in this plan.

**Type consistency:** Route fields are consistent across tasks: `channel`, `targetUserId`, `threadId`, `rootMessageId`, `topicName`, `messageAppLink`. Lark bot methods are consistently `sendMessage({ chatId, text })` and `replyInThread({ rootMessageId, text })`.

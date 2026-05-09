# Web Terminal Reply Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a prominent Web/xterm reminder when a Claude Code assistant turn finishes, with progressive browser notification support when the page is hidden or unfocused.

**Architecture:** Use Claude Code `Stop` hooks as the single authoritative turn-completion event. Add a small AI-terminal broadcast API, have the hook handler call it best-effort for `stop`, and implement the existing frontend `turn_done` branch with an xterm banner, Ant Design toast/status highlight, and permission-gated browser notification.

**Tech Stack:** Node.js ESM, Express, WebSocket, Vitest, React 18, TypeScript, Ant Design, xterm.js, browser Notification API.

---

## File Structure

- Modify `src/routes/ai-terminal.js`
  - Add `notifyTurnDone(sessionId, payload)` to broadcast `{ type: 'turn_done' }` to browsers attached to one AI terminal session.
  - Export it on the object returned by `createAiTerminal`.

- Modify `src/openclaw-hook.js`
  - On Claude Code `stop` events, call `aiTerminal.notifyTurnDone(...)` best-effort.
  - Keep Telegram/OpenClaw result semantics unchanged: notification broadcast failures are logged and never change hook return values.

- Create `web/src/terminalTurnNotifications.ts`
  - Centralize banner strings and pure notification-decision helpers so frontend behavior is easy to test.

- Modify `web/src/AiTerminalMini.tsx`
  - Implement the existing `turn_done` WebSocket branch.
  - Add short-lived visual highlight and notification permission button.
  - Send browser system notifications only when permission is granted and the page is hidden or window is unfocused.

- Modify `test/ai-terminal.route.test.js`
  - Cover `notifyTurnDone` broadcast and unknown-session behavior.

- Modify `test/openclaw-hook.test.js`
  - Cover Stop hook broadcasting `turn_done`, broadcast independence from Telegram/OpenClaw failures, and broadcast exception isolation.

- Create `test/terminal-turn-notifications.test.js`
  - Cover pure frontend notification helpers.

Commits are only allowed if the user explicitly authorizes committing. If commit authorization is not present, run the same verification steps and leave changes uncommitted.

---

### Task 1: Add AI terminal `turn_done` broadcast API

**Files:**
- Modify: `test/ai-terminal.route.test.js`
- Modify: `src/routes/ai-terminal.js`

- [ ] **Step 1: Write failing tests for `notifyTurnDone`**

Add these tests inside `describe('routes/ai-terminal', () => { ... })` in `test/ai-terminal.route.test.js`, near the other WebSocket/session tests:

```js
  it('notifyTurnDone broadcasts turn_done to attached browsers', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hello', tool: 'claude' })

    const sent = []
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((data) => sent.push(JSON.parse(data))),
      close: vi.fn(),
    }
    ctx.ait.addBrowser(body.sessionId, ws)
    sent.length = 0

    const ok = ctx.ait.notifyTurnDone(body.sessionId, {
      event: 'stop',
      status: 'idle',
      todoTitle: 'T',
      timestamp: 123,
    })

    expect(ok).toBe(true)
    expect(sent).toEqual([
      {
        type: 'turn_done',
        event: 'stop',
        status: 'idle',
        todoTitle: 'T',
        timestamp: 123,
      },
    ])
  })

  it('notifyTurnDone returns false for an unknown session', () => {
    expect(ctx.ait.notifyTurnDone('missing-session')).toBe(false)
  })
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js --runInBand
```

Expected result: FAIL with an error like `ctx.ait.notifyTurnDone is not a function`.

- [ ] **Step 3: Implement `notifyTurnDone` in `src/routes/ai-terminal.js`**

Add this function near `broadcastToSession` and before `appendOutput`:

```js
  function notifyTurnDone(sessionId, payload = {}) {
    const session = sessions.get(sessionId)
    if (!session) return false
    broadcastToSession(session, {
      ...payload,
      type: 'turn_done',
      event: payload.event || 'stop',
      status: payload.status || 'idle',
      timestamp: payload.timestamp || Date.now(),
    })
    return true
  }
```

Then add `notifyTurnDone` to the returned object at the bottom of `createAiTerminal`:

```js
  return {
    router,
    sessions,
    todoSessionMap,
    nativeSessionMap,
    addBrowser,
    removeBrowser,
    handleBrowserMessage,
    broadcastToSession,
    notifyTurnDone,
    spawnSession,
    close,
  }
```

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js --runInBand
```

Expected result: PASS for `test/ai-terminal.route.test.js`.

- [ ] **Step 5: Checkpoint**

If commit authorization has been explicitly given, run:

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "feat(web-terminal): broadcast turn completion events"
```

If commit authorization has not been given, do not commit.

---

### Task 2: Wire Claude Code Stop hook to Web terminal broadcast

**Files:**
- Modify: `test/openclaw-hook.test.js`
- Modify: `src/openclaw-hook.js`

- [ ] **Step 1: Write failing hook tests**

Add these tests inside `describe('openclaw-hook handler', () => { ... })` in `test/openclaw-hook.test.js`:

```js
  it('broadcasts turn_done for Stop events', async () => {
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(notifyTurnDone).toHaveBeenCalledWith('s1', {
      event: 'stop',
      status: 'idle',
      todoTitle: 'Task A',
    })
  })

  it('broadcasts turn_done even when Telegram/OpenClaw push fails', async () => {
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'rate_limited' })
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('rate_limited')
    expect(notifyTurnDone).toHaveBeenCalledWith('s1', {
      event: 'stop',
      status: 'idle',
      todoTitle: 'Task A',
    })
  })

  it('does not let turn_done broadcast failures break Stop handling', async () => {
    const logger = { warn: vi.fn() }
    const notifyTurnDone = vi.fn(() => { throw new Error('ws failed') })
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
      logger,
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(logger.warn).toHaveBeenCalledWith('[openclaw-hook] notifyTurnDone failed: ws failed')
  })

  it('does not broadcast turn_done for non-Stop events', async () => {
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
      getConfig: () => ({ telegram: { suppressNotificationEvents: false, notificationCooldownMs: 0 } }),
    })

    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1', todoTitle: 'Task A' })
    await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1', todoTitle: 'Task A' })

    expect(notifyTurnDone).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
npx vitest run test/openclaw-hook.test.js --runInBand
```

Expected result: FAIL because `notifyTurnDone` is not called.

- [ ] **Step 3: Add best-effort broadcast helper in `src/openclaw-hook.js`**

Inside `createOpenClawHookHandler`, add this helper near `hasPendingAskUser`:

```js
  function notifyWebTurnDone(sessionId, todoTitle) {
    if (!sessionId || !aiTerminal?.notifyTurnDone) return
    try {
      aiTerminal.notifyTurnDone(sessionId, {
        event: 'stop',
        status: 'idle',
        todoTitle: todoTitle || undefined,
      })
    } catch (e) {
      logger.warn?.(`[openclaw-hook] notifyTurnDone failed: ${e.message}`)
    }
  }
```

Then call it in `handle` after the `notification` cooldown block and before transcript reading starts:

```js
    if (evt === 'stop') {
      notifyWebTurnDone(sessionId, todoTitle)
    }
```

The surrounding flow should remain:

```js
    if (evt === 'notification') {
      const cd = notificationCooldownMs()
      if (cd > 0 && isOnCooldown(sessionId, evt, cd)) {
        return { ok: true, action: 'skipped', reason: 'notification_cooldown', cooldownMs: cd }
      }
    }

    if (evt === 'stop') {
      notifyWebTurnDone(sessionId, todoTitle)
    }

    // 2) cooldown：默认不再对 Stop 启用 cooldown
```

Do not move or change the existing `openclaw.postText`, `recordSent`, or `loadingTracker.markIdle` logic.

- [ ] **Step 4: Run the targeted hook test and verify it passes**

Run:

```bash
npx vitest run test/openclaw-hook.test.js --runInBand
```

Expected result: PASS for `test/openclaw-hook.test.js`.

- [ ] **Step 5: Checkpoint**

If commit authorization has been explicitly given, run:

```bash
git add src/openclaw-hook.js test/openclaw-hook.test.js
git commit -m "feat(web-terminal): emit turn done from claude stop hook"
```

If commit authorization has not been given, do not commit.

---

### Task 3: Add tested frontend notification helpers

**Files:**
- Create: `web/src/terminalTurnNotifications.ts`
- Create: `test/terminal-turn-notifications.test.js`

- [ ] **Step 1: Write failing helper tests**

Create `test/terminal-turn-notifications.test.js` with:

```js
import { describe, it, expect } from 'vitest'
import {
  TURN_DONE_BANNER,
  TURN_DONE_TEXT,
  shouldSendTurnDoneSystemNotification,
} from '../web/src/terminalTurnNotifications.ts'

describe('terminal turn notification helpers', () => {
  it('provides an ANSI banner with the approved copy', () => {
    expect(TURN_DONE_TEXT).toBe('AI 回复完成，请验收')
    expect(TURN_DONE_BANNER).toContain(TURN_DONE_TEXT)
    expect(TURN_DONE_BANNER).toContain('\x1b[')
  })

  it('sends system notifications when granted and document is hidden', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: true,
      windowFocused: true,
    })).toBe(true)
  })

  it('sends system notifications when granted and window is unfocused', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: false,
      windowFocused: false,
    })).toBe(true)
  })

  it('does not send system notifications when page is visible and focused', () => {
    expect(shouldSendTurnDoneSystemNotification({
      permission: 'granted',
      documentHidden: false,
      windowFocused: true,
    })).toBe(false)
  })

  it('does not send system notifications without granted permission', () => {
    for (const permission of ['default', 'denied', 'unsupported']) {
      expect(shouldSendTurnDoneSystemNotification({
        permission,
        documentHidden: true,
        windowFocused: false,
      })).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
npx vitest run test/terminal-turn-notifications.test.js --runInBand
```

Expected result: FAIL because `web/src/terminalTurnNotifications.ts` does not exist.

- [ ] **Step 3: Implement `web/src/terminalTurnNotifications.ts`**

Create `web/src/terminalTurnNotifications.ts` with:

```ts
export type BrowserNotificationPermission = NotificationPermission | 'unsupported'

export const TURN_DONE_TEXT = 'AI 回复完成，请验收'

export const TURN_DONE_BANNER = [
  '',
  '\x1b[1;32m╔══════════════════════════════════════╗\x1b[0m',
  `\x1b[1;32m║        ${TURN_DONE_TEXT}        ║\x1b[0m`,
  '\x1b[1;32m╚══════════════════════════════════════╝\x1b[0m',
].join('\r\n') + '\r'

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission
}

export function shouldSendTurnDoneSystemNotification({
  permission,
  documentHidden,
  windowFocused,
}: {
  permission: BrowserNotificationPermission | string
  documentHidden: boolean
  windowFocused: boolean
}) {
  return permission === 'granted' && (documentHidden || !windowFocused)
}
```

- [ ] **Step 4: Run the helper test and verify it passes**

Run:

```bash
npx vitest run test/terminal-turn-notifications.test.js --runInBand
```

Expected result: PASS.

- [ ] **Step 5: Checkpoint**

If commit authorization has been explicitly given, run:

```bash
git add web/src/terminalTurnNotifications.ts test/terminal-turn-notifications.test.js
git commit -m "test(web-terminal): cover turn notification helpers"
```

If commit authorization has not been given, do not commit.

---

### Task 4: Implement frontend `turn_done` reminder UI

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 1: Import helper functions**

In `web/src/AiTerminalMini.tsx`, add this import after the terminal theme imports:

```ts
import {
  getBrowserNotificationPermission,
  shouldSendTurnDoneSystemNotification,
  TURN_DONE_BANNER,
  TURN_DONE_TEXT,
  BrowserNotificationPermission,
} from './terminalTurnNotifications'
```

- [ ] **Step 2: Add component state and refs**

Inside `AiTerminalMini`, after `const [wsConnected, setWsConnected] = useState(false)`, add:

```ts
  const [turnDoneNotice, setTurnDoneNotice] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>(() => getBrowserNotificationPermission())
```

After `const onSessionRecoveredRef = useRef<typeof onSessionRecovered>(onSessionRecovered)`, add:

```ts
  const turnDoneNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const windowFocusedRef = useRef<boolean>(typeof document === 'undefined' ? true : document.hasFocus())
```

- [ ] **Step 3: Add window focus tracking and timer cleanup**

After the existing effect that syncs `resumeTargetRef` and `onSessionRecoveredRef`, add:

```ts
  useEffect(() => {
    const handleFocus = () => { windowFocusedRef.current = true }
    const handleBlur = () => { windowFocusedRef.current = false }
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (turnDoneNoticeTimerRef.current) clearTimeout(turnDoneNoticeTimerRef.current)
    }
  }, [])
```

- [ ] **Step 4: Add browser notification permission request handler**

After `tryAutoRecover`, add:

```ts
  const requestBrowserNotifications = useCallback(async () => {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      setNotificationPermission('unsupported')
      message.info('当前浏览器不支持系统通知')
      return
    }
    try {
      const permission = await window.Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission === 'granted') message.success('已开启浏览器通知')
      else if (permission === 'denied') message.warning('浏览器通知权限已被拒绝，可在浏览器设置中重新开启')
    } catch (error) {
      console.warn('[AiTerminalMini] request notification permission failed:', error)
      setNotificationPermission(getBrowserNotificationPermission())
      message.warning('浏览器通知权限请求失败')
    }
  }, [])
```

- [ ] **Step 5: Add `showTurnDoneReminder` handler**

After `requestBrowserNotifications`, add:

```ts
  const showTurnDoneReminder = useCallback(() => {
    const term = termRef.current
    if (term) {
      term.writeln(TURN_DONE_BANNER)
      if (followTailRef.current) term.scrollToBottom()
    }

    setTurnDoneNotice(true)
    if (turnDoneNoticeTimerRef.current) clearTimeout(turnDoneNoticeTimerRef.current)
    turnDoneNoticeTimerRef.current = setTimeout(() => {
      setTurnDoneNotice(false)
      turnDoneNoticeTimerRef.current = null
    }, 8000)

    if (!document.hidden) {
      message.success({ content: TURN_DONE_TEXT, key: `turn-done-${sessionId}`, duration: 4 })
    }

    const permission = getBrowserNotificationPermission()
    setNotificationPermission(permission)
    if (!shouldSendTurnDoneSystemNotification({
      permission,
      documentHidden: document.hidden,
      windowFocused: windowFocusedRef.current,
    })) {
      return
    }

    try {
      new window.Notification('quadtodo', {
        body: TURN_DONE_TEXT,
        tag: `quadtodo-turn-done-${sessionId}`,
        renotify: true,
      })
    } catch (error) {
      console.warn('[AiTerminalMini] show browser notification failed:', error)
    }
  }, [sessionId])
```

- [ ] **Step 6: Implement the WebSocket `turn_done` branch**

Replace the existing empty branch:

```ts
            case 'turn_done':
              break
```

with:

```ts
            case 'turn_done':
              showTurnDoneReminder()
              break
```

- [ ] **Step 7: Update the existing `done` xterm line to keep wording distinct**

Replace the existing `done` terminal line:

```ts
              term.writeln(`\r\n\x1b[${msg.exitCode === 0 ? '32' : '31'}m=== ${msg.status === 'done' ? 'AI 完成，请验收' : '任务失败'} ===\x1b[0m\r`)
```

with:

```ts
              term.writeln(`\r\n\x1b[${msg.exitCode === 0 ? '32' : '31'}m=== ${msg.status === 'done' ? 'AI 任务已结束' : '任务失败'} ===\x1b[0m\r`)
```

- [ ] **Step 8: Add toolbar visual affordances**

In the toolbar JSX, after the existing `sessionStatus === 'ai_done'` Tag block, add:

```tsx
        {turnDoneNotice && sessionStatus !== 'ai_done' && (
          <Tag color="success" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>回复完成</Tag>
        )}
        {notificationPermission === 'default' && (
          <Tooltip title="页面隐藏或窗口失焦时，用浏览器系统通知提醒 Claude 回复完成">
            <Button
              size="small"
              onClick={requestBrowserNotifications}
              style={{ height: 22, paddingInline: 8 }}
            >
              开启通知
            </Button>
          </Tooltip>
        )}
```

- [ ] **Step 9: Add green short-lived highlight without causing layout shift**

In both wrapper style branches where `boxShadow` is computed, change the expression from:

```ts
        boxShadow: sessionStatus === 'ai_pending'
          ? '0 0 0 1px #ff4d4f, 0 10px 24px rgba(8, 13, 30, 0.16)'
          : '0 10px 24px rgba(8, 13, 30, 0.16)',
```

to:

```ts
        boxShadow: sessionStatus === 'ai_pending'
          ? '0 0 0 1px #ff4d4f, 0 10px 24px rgba(8, 13, 30, 0.16)'
          : turnDoneNotice
            ? '0 0 0 1px #52c41a, 0 10px 24px rgba(8, 13, 30, 0.16)'
            : '0 10px 24px rgba(8, 13, 30, 0.16)',
```

Make this replacement in the `fillHeight` branch and the normal branch. Do not change the fullscreen branch, because it has no border/highlight treatment today.

- [ ] **Step 10: Build the Web frontend**

Run:

```bash
npm run build:web
```

Expected result: TypeScript and Vite build complete successfully.

- [ ] **Step 11: Checkpoint**

If commit authorization has been explicitly given, run:

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(web-terminal): show turn completion reminders"
```

If commit authorization has not been given, do not commit.

---

### Task 5: Full regression verification

**Files:**
- No code changes unless verification finds a failure.

- [ ] **Step 1: Run focused backend/helper tests**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js test/openclaw-hook.test.js test/terminal-turn-notifications.test.js --runInBand
```

Expected result: PASS for all three test files.

- [ ] **Step 2: Run the full root test suite**

Run:

```bash
npm test
```

Expected result: PASS.

- [ ] **Step 3: Run the Web build**

Run:

```bash
npm run build:web
```

Expected result: PASS.

- [ ] **Step 4: Manual Web verification**

Run the app locally in the way this repository normally uses for Web UI testing:

```bash
npm run start
```

Then open the Web UI, start or attach to a Claude Code AI terminal session, and verify:

1. When a Claude Code assistant turn completes, the terminal prints the green `AI 回复完成，请验收` banner.
2. While the page is visible, an Ant Design success toast appears.
3. The toolbar briefly shows the green `回复完成` tag.
4. If browser notification permission is `default`, the toolbar shows `开启通知`.
5. Clicking `开启通知` requests permission from the browser.
6. With permission granted, when the Web page is hidden or the window is unfocused, a system notification appears after a Claude Code turn completes.
7. With permission denied, no browser error appears and the xterm banner/toast behavior still works.
8. When the PTY session exits, the terminal still shows the distinct session-end message `AI 任务已结束` or `任务失败`.

- [ ] **Step 5: Stop local server if it was started for manual verification**

If `npm run start` is still running in the current terminal, stop it with Ctrl+C. If it was started through the project daemon flow, use the repository's normal stop command:

```bash
npm run stop
```

Expected result: local verification server is no longer running.

- [ ] **Step 6: Final status check**

Run:

```bash
git status --short
```

Expected result: only the planned files are modified or created:

```text
 M src/openclaw-hook.js
 M src/routes/ai-terminal.js
 M test/ai-terminal.route.test.js
 M test/openclaw-hook.test.js
 M web/src/AiTerminalMini.tsx
?? test/terminal-turn-notifications.test.js
?? web/src/terminalTurnNotifications.ts
```

The design and plan docs may also appear as untracked/modified if they have not been committed in this session.

---

## Self-Review

- Spec coverage: Task 1 and Task 2 implement the `Stop` hook to WebSocket `turn_done` path. Task 3 and Task 4 implement the xterm banner, page toast/status highlight, browser system notification conditions, and no-default-sound policy. Task 5 verifies existing Telegram/OpenClaw behavior through focused and full tests.
- Placeholder scan: The plan contains concrete file paths, code snippets, commands, expected failures, and expected passing states. There are no unresolved placeholders.
- Type consistency: The backend message uses `type: 'turn_done'`, `event: 'stop'`, and `status: 'idle'` consistently. The frontend helper type is `BrowserNotificationPermission`, and the React component imports and uses that same type.

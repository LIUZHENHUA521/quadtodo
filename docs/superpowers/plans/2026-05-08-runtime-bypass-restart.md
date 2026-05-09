# Runtime Bypass Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an already-running Claude Code session actually enter full-managed mode by restarting and resuming it with `--permission-mode bypassPermissions` when the user switches to “全托管”.

**Architecture:** Keep startup-time permission handling as the source of truth. A runtime `set_auto_mode: bypass` message for Claude will create a replacement PTY session via `spawnSession({ resumeNativeId, permissionMode: 'bypass' })`, broadcast the replacement `sessionId`, and let the frontend reconnect to it. If the native Claude session id is unavailable, do not guess or auto-confirm; broadcast a clear “future sessions only” notice.

**Tech Stack:** Node.js ESM, Express route module, WebSocket terminal messages, React/TypeScript frontend, Vitest + Supertest.

---

## File Structure

- Modify `src/routes/ai-terminal.js`
  - Add a focused helper for runtime auto-mode changes.
  - Preserve existing `set_auto_mode` behavior for non-restart cases.
  - For Claude + `bypass` + available `nativeSessionId`, spawn a replacement session with the same todo, cwd, prompt, tool, and `resumeNativeId`.
  - Broadcast a new terminal event so browsers can switch to the replacement session.
- Modify `web/src/AiTerminalMini.tsx`
  - Handle the replacement-session event by asking the parent to open the new session id.
  - Show a warning when runtime bypass cannot immediately apply.
- Modify `web/src/TodoManage.tsx`
  - Pass a session-switch callback into `AiTerminalMini` so the terminal can update `expandedTerminal` / visible session state.
- Modify `web/src/api.ts` only if TypeScript types require the new callback/event shape. Prefer no API change.
- Modify `test/ai-terminal.route.test.js`
  - Add backend route/unit coverage for runtime bypass restart and no-native-id fallback.
- Modify `test/pty.test.js`
  - Add or extend PTY argument coverage for Claude resume with bypass permission mode.

---

## Task 1: Backend test for runtime bypass restart

**Files:**
- Modify: `test/ai-terminal.route.test.js`
- Test: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Write the failing test for restart-on-bypass**

Add this test near the existing WebSocket/browser tests in `test/ai-terminal.route.test.js`, after `addBrowser replays existing outputHistory immediately` or before the pending-confirm tests:

```js
  it('set_auto_mode bypass restarts a running Claude session with resumeNativeId', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: '/tmp' })

    ctx.pty.emit('native-session', {
      sessionId: body.sessionId,
      nativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })

    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'set_auto_mode', autoMode: 'bypass' }, ws)

    expect(ctx.pty.started).toHaveLength(2)
    expect(ctx.pty.started[1]).toMatchObject({
      todoId: todo.id,
      tool: 'claude',
      prompt: 'hi',
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      permissionMode: 'bypass',
    })
    expect(ctx.pty.stopped).toEqual([body.sessionId])
    const restartEvent = sent.find(m => m.type === 'session_restarted')
    expect(restartEvent).toMatchObject({
      oldSessionId: body.sessionId,
      newSessionId: ctx.pty.started[1].sessionId,
      autoMode: 'bypass',
    })
  })
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js -t "set_auto_mode bypass restarts"
```

Expected: FAIL because `set_auto_mode` currently only sets `session.autoMode` and does not call `pty.start()` a second time or emit `session_restarted`.

- [ ] **Step 3: Write the failing no-native-id fallback test**

Add this test next to the previous one:

```js
  it('set_auto_mode bypass does not restart Claude when nativeSessionId is missing', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: '/tmp' })

    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'set_auto_mode', autoMode: 'bypass' }, ws)

    expect(ctx.pty.started).toHaveLength(1)
    expect(ctx.pty.stopped).toEqual([])
    expect(sent).toContainEqual({
      type: 'auto_mode_notice',
      autoMode: 'bypass',
      immediate: false,
      reason: 'native_session_missing',
      message: '当前 Claude 会话尚未拿到原生 session id，全托管将仅对后续启动/恢复的会话生效。',
    })
  })
```

- [ ] **Step 4: Run both focused tests to verify they fail for the expected reasons**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js -t "set_auto_mode bypass"
```

Expected: both tests FAIL. The first should show no second `started` entry; the second should show missing `auto_mode_notice`.

---

## Task 2: Backend implementation for restart-on-bypass

**Files:**
- Modify: `src/routes/ai-terminal.js`
- Test: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Add a direct-message helper**

In `src/routes/ai-terminal.js`, after `broadcastToSession(session, msg)` add:

```js
  function sendToBrowser(ws, msg) {
    if (!ws || ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(msg))
  }
```

- [ ] **Step 2: Add runtime auto-mode helper**

In `src/routes/ai-terminal.js`, place this helper after `clearPendingConfirm(session)` and before `handleBrowserMessage(sessionId, msg, ws)`:

```js
  function handleSetAutoMode(sessionId, msg, ws) {
    const session = sessions.get(sessionId)
    if (!session) return

    const nextAutoMode = msg.autoMode || null
    session.autoMode = nextAutoMode
    broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })

    if (nextAutoMode !== 'bypass' || session.tool !== 'claude') return

    if (!session.nativeSessionId) {
      sendToBrowser(ws, {
        type: 'auto_mode_notice',
        autoMode: 'bypass',
        immediate: false,
        reason: 'native_session_missing',
        message: '当前 Claude 会话尚未拿到原生 session id，全托管将仅对后续启动/恢复的会话生效。',
      })
      return
    }

    let restarted
    try {
      restarted = spawnSession({
        todoId: session.todoId,
        prompt: session.prompt || '',
        tool: session.tool,
        cwd: session.cwd || undefined,
        resumeNativeId: session.nativeSessionId,
        permissionMode: 'bypass',
        label: 'runtime:bypass',
        skipTelegram: true,
      })
    } catch (e) {
      sendToBrowser(ws, {
        type: 'auto_mode_notice',
        autoMode: 'bypass',
        immediate: false,
        reason: 'restart_failed',
        message: `切换全托管失败：${e.message}`,
      })
      return
    }

    const newSessionId = restarted.sessionId
    broadcastToSession(session, {
      type: 'session_restarted',
      oldSessionId: sessionId,
      newSessionId,
      autoMode: 'bypass',
      message: '已通过恢复会话切换到全托管；当前 PTY 会被中断。',
    })
    if (newSessionId !== sessionId) pty.stop(sessionId)
  }
```

Important details:
- `spawnSession()` is a function declaration in the same closure, so this helper can call it.
- `skipTelegram: true` avoids creating a duplicate Telegram topic for a UI-internal restart.
- Do not auto-write Enter or any other confirmation input.

- [ ] **Step 3: Route `set_auto_mode` to the helper**

Replace this block in `handleBrowserMessage()`:

```js
    } else if (msg.type === 'set_auto_mode') {
      const session = sessions.get(sessionId)
      if (!session) return
      session.autoMode = msg.autoMode || null
      broadcastToSession(session, { type: 'auto_mode', autoMode: session.autoMode || null })
    }
```

with:

```js
    } else if (msg.type === 'set_auto_mode') {
      handleSetAutoMode(sessionId, msg, ws)
    }
```

- [ ] **Step 4: Run focused backend tests**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js -t "set_auto_mode bypass"
```

Expected: PASS.

- [ ] **Step 5: Run nearby ai-terminal route tests**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js
```

Expected: PASS.

---

## Task 3: PTY argument regression test

**Files:**
- Modify: `test/pty.test.js`
- Test: `test/pty.test.js`

- [ ] **Step 1: Add test for Claude resume with bypass permission mode**

In `test/pty.test.js`, after `start with resumeNativeId passes --resume flag`, add:

```js
  it('claude resume with bypass permission mode passes bypassPermissions before --resume', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({
      sessionId: 's1',
      tool: 'claude',
      prompt: null,
      cwd: '/tmp',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
      permissionMode: 'bypass',
    })
    const args = factory.created[0]._args
    expect(args).toContain('--permission-mode')
    expect(args).toContain('bypassPermissions')
    expect(args).toContain('--resume')
    expect(args.indexOf('--permission-mode')).toBeLessThan(args.indexOf('--resume'))
  })
```

- [ ] **Step 2: Run the focused PTY test**

Run:

```bash
npx vitest run test/pty.test.js -t "claude resume with bypass"
```

Expected: PASS. If it fails, inspect `src/pty.js:18-23` and `src/pty.js:297-302`; the expected behavior is already intended by the current implementation, so this is a regression lock.

---

## Task 4: Frontend event handling and session switch

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`
- Modify: `web/src/TodoManage.tsx`
- Test: build verification via `npm run build`

- [ ] **Step 1: Add optional callback prop to `AiTerminalMini`**

In `web/src/AiTerminalMini.tsx`, locate the props/interface definition for the component and add:

```ts
  onSessionSwitch?: (sessionId: string) => void
```

Then destructure it from props where the component function receives props:

```ts
  onSessionSwitch,
```

- [ ] **Step 2: Handle `session_restarted` and `auto_mode_notice` WebSocket messages**

In `web/src/AiTerminalMini.tsx`, inside the existing `ws.onmessage` switch, add cases:

```ts
            case 'session_restarted':
              if (typeof msg.newSessionId === 'string' && msg.newSessionId) {
                message.info(msg.message || '已切换到恢复后的全托管会话')
                onSessionSwitch?.(msg.newSessionId)
              }
              break
            case 'auto_mode_notice':
              if (msg.message) message.warning(msg.message)
              break
```

Use the existing imported Ant Design `message` symbol. If `message` is not already imported in the file, extend the existing `antd` import to include it.

- [ ] **Step 3: Pass session switch callback from todo card**

In `web/src/TodoManage.tsx`, find the `AiTerminalMini` render inside `SortableTodoCard`. Add this prop:

```tsx
            onSessionSwitch={(nextSessionId) => {
              setExpandedTerminal?.({ todoId: todo.id, sessionId: nextSessionId })
              onRefresh?.()
            }}
```

If `setExpandedTerminal` is not available inside that render but a similarly named prop already is, use the existing prop that updates the expanded terminal state. The callback must update the visible terminal session id for the same todo.

- [ ] **Step 4: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS. If TypeScript reports prop-name or type errors, fix only the mismatched prop/interface names needed for the new callback.

---

## Task 5: Full verification

**Files:**
- Verify only; no source changes expected unless tests expose a bug.

- [ ] **Step 1: Run backend/unit tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual behavior check**

Run the app with the normal local command:

```bash
npm start
```

Manual acceptance path:
1. Start a Claude Code AI terminal session in manual mode.
2. Wait until the terminal is connected and a native Claude session id has been captured.
3. Use the terminal toolbar dropdown to choose `完全托管（全自动）`.
4. Confirm the terminal switches to a new live session rather than staying attached to the old stopped PTY.
5. Confirm the resumed Claude command was started with bypass mode by checking server log output like:

```text
[pty] starting claude ... args=["--permission-mode","bypassPermissions",...,"--resume","abcdef12-3456-7890-abcd-ef1234567890"]
```

6. Trigger a follow-up tool action and verify Claude Code no longer asks for permission.

- [ ] **Step 4: Verify fallback behavior**

Manual fallback path:
1. Start a Claude terminal and immediately switch to full-managed mode before native id capture, or simulate via backend test.
2. Confirm the UI warns:

```text
当前 Claude 会话尚未拿到原生 session id，全托管将仅对后续启动/恢复的会话生效。
```

3. Confirm no current PTY is stopped in this fallback path.

---

## Self-Review

**Spec coverage:**
- Runtime switch should actually affect current Claude session: Task 1 and Task 2 implement restart/resume with bypass.
- Only Claude gets restart behavior: Task 2 gates on `session.tool !== 'claude'`.
- No native session id fallback: Task 1 and Task 2 broadcast `auto_mode_notice` and do not stop the PTY.
- Do not auto-confirm prompts: Task 2 explicitly avoids writing Enter.
- Frontend follows replacement session: Task 4 handles `session_restarted` and updates parent state.
- Verification: Task 5 covers unit tests, build, and manual acceptance.

**Placeholder scan:** No TBD/TODO placeholders. The only conditional instruction is constrained to existing prop naming in `TodoManage.tsx` because the exact component prop block may differ slightly; the intended callback behavior is explicit.

**Type consistency:** Event names are `session_restarted` and `auto_mode_notice`; backend emits these exact strings and frontend handles the same strings. Runtime mode string remains existing `bypass`.

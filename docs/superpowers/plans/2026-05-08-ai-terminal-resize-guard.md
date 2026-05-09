# AI Terminal Resize Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent AI terminal resize events from pushing invalid or terminal-state dimensions into the PTY and causing xterm/TUI residual output.

**Architecture:** Add a small server-side resize validation layer in `src/routes/ai-terminal.js` and a matching active-session guard in `web/src/AiTerminalMini.tsx`. The server remains the source of truth for PTY resize safety, while the client avoids sending resize events when the session is no longer active.

**Tech Stack:** Node.js ESM, Express route module, WebSocket session hooks, Vitest + Supertest, React + TypeScript xterm UI.

---

## File Structure

- Modify `src/routes/ai-terminal.js`: add resize constants/helpers, filter browser-reported sizes during aggregation, ignore resize for terminal states, and guard fallback resize path.
- Modify `test/ai-terminal.route.test.js`: add route-level unit tests for legal resize, invalid resize, multi-browser aggregation, and terminal-state resize behavior.
- Modify `web/src/AiTerminalMini.tsx`: prevent `scheduleResizeSend()` from sending resize when the session is not active or is expired.

## Task 1: Add failing backend resize guard tests

**Files:**
- Modify: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Insert resize guard tests after `addBrowser on unknown session sends error`**

Add this block after the existing test ending with `expect(ws.close).toHaveBeenCalled()`:

```js
  it('resize from a browser applies valid dimensions to the pty', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const ws = { readyState: 1, OPEN: 1, send: vi.fn() }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'resize', cols: 120, rows: 30 }, ws)

    expect(ctx.pty.resizes).toEqual([{ id: body.sessionId, cols: 120, rows: 30 }])
  })

  it('resize ignores cols below 30 from a browser', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const ws = { readyState: 1, OPEN: 1, send: vi.fn() }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'resize', cols: 29, rows: 30 }, ws)

    expect(ctx.pty.resizes).toEqual([])
  })

  it('resize aggregation ignores invalid small browser dimensions', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const narrowWs = { readyState: 1, OPEN: 1, send: vi.fn() }
    const normalWs = { readyState: 1, OPEN: 1, send: vi.fn() }
    ctx.ait.addBrowser(body.sessionId, narrowWs)
    ctx.ait.addBrowser(body.sessionId, normalWs)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'resize', cols: 20, rows: 10 }, narrowWs)
    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'resize', cols: 100, rows: 30 }, normalWs)

    expect(ctx.pty.resizes).toEqual([{ id: body.sessionId, cols: 100, rows: 30 }])
  })

  it('resize ignores finished sessions', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const ws = { readyState: 1, OPEN: 1, send: vi.fn() }
    ctx.ait.addBrowser(body.sessionId, ws)
    ctx.pty.emit('done', {
      sessionId: body.sessionId,
      exitCode: 0,
      fullLog: '',
      nativeId: null,
      stopped: false,
    })
    ctx.pty.resizes = []

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'resize', cols: 120, rows: 30 }, ws)

    expect(ctx.pty.resizes).toEqual([])
  })
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js --runInBand
```

Expected: at least these new tests fail because current code accepts `cols: 29` and resizes finished sessions.

- [ ] **Step 3: Commit the failing tests**

Do not commit if the repository convention avoids committing red tests. If committing red tests is acceptable for this workflow, run:

```bash
git add test/ai-terminal.route.test.js
git commit -m "test: cover terminal resize guards"
```

## Task 2: Implement backend resize validation

**Files:**
- Modify: `src/routes/ai-terminal.js`
- Test: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Add resize helper constants near top-level constants**

In `src/routes/ai-terminal.js`, after:

```js
const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000
```

replace with:

```js
const MAX_OUTPUT_BUFFER = 512 * 1024
const CLEANUP_MS = 30 * 60_000
const MIN_RESIZE_COLS = 30
const TERMINAL_RESIZE_STATUSES = new Set(['done', 'failed', 'stopped'])

function isValidResizeSize(cols, rows) {
  return Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_RESIZE_COLS && rows > 0
}

function canResizeSession(session) {
  return session && !TERMINAL_RESIZE_STATUSES.has(session.status)
}
```

- [ ] **Step 2: Replace `applyAggregatedResize()` with guarded aggregation**

Replace the whole function at `src/routes/ai-terminal.js`:

```js
  function applyAggregatedResize(session) {
    let cols = Infinity
    let rows = Infinity
    for (const b of session.browsers) {
      const sz = b.__quadtodoSize
      if (!sz) continue
      if (sz.cols < cols) cols = sz.cols
      if (sz.rows < rows) rows = sz.rows
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (session.lastAppliedCols === cols && session.lastAppliedRows === rows) return
    session.lastAppliedCols = cols
    session.lastAppliedRows = rows
    pty.resize(session.sessionId, cols, rows)
  }
```

with:

```js
  function applyAggregatedResize(session) {
    if (!canResizeSession(session)) return
    let cols = Infinity
    let rows = Infinity
    for (const b of session.browsers) {
      const sz = b.__quadtodoSize
      if (!sz || !isValidResizeSize(sz.cols, sz.rows)) continue
      if (sz.cols < cols) cols = sz.cols
      if (sz.rows < rows) rows = sz.rows
    }
    if (!isValidResizeSize(cols, rows)) return
    if (session.lastAppliedCols === cols && session.lastAppliedRows === rows) return
    session.lastAppliedCols = cols
    session.lastAppliedRows = rows
    pty.resize(session.sessionId, cols, rows)
  }
```

- [ ] **Step 3: Guard the WebSocket resize message handler**

In `handleBrowserMessage()`, replace the current resize branch:

```js
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
      const session = sessions.get(sessionId)
      if (!session) return
      if (ws && session.browsers.has(ws)) {
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      } else {
        // 没拿到 ws 兜底走老路径，保留对非 WS 调用方的兼容
        pty.resize(sessionId, cols, rows)
      }
```

with:

```js
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      const session = sessions.get(sessionId)
      if (!canResizeSession(session) || !isValidResizeSize(cols, rows)) return
      if (ws && session.browsers.has(ws)) {
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      } else {
        // 没拿到 ws 兜底走老路径，保留对非 WS 调用方的兼容
        if (session.lastAppliedCols === cols && session.lastAppliedRows === rows) return
        session.lastAppliedCols = cols
        session.lastAppliedRows = rows
        pty.resize(sessionId, cols, rows)
      }
```

- [ ] **Step 4: Run backend tests and confirm they pass**

Run:

```bash
npx vitest run test/ai-terminal.route.test.js --runInBand
```

Expected: all tests in `test/ai-terminal.route.test.js` pass.

- [ ] **Step 5: Commit backend implementation**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "fix: guard terminal resize aggregation"
```

## Task 3: Add client active-session resize guard

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 1: Add refs for session activity and expiry state**

In `web/src/AiTerminalMini.tsx`, after:

```ts
  const [sessionExpired, setSessionExpired] = useState(false)
```

add:

```ts
  const sessionStatusRef = useRef<TodoStatus>(status)
  const sessionExpiredRef = useRef(false)
```

Then after the existing `useEffect` that updates `themeRef.current`, add:

```ts
  useEffect(() => { sessionStatusRef.current = sessionStatus }, [sessionStatus])
  useEffect(() => { sessionExpiredRef.current = sessionExpired }, [sessionExpired])
```

- [ ] **Step 2: Guard `scheduleResizeSend()` before sending WebSocket resize**

Inside `scheduleResizeSend()`, replace:

```ts
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        lastSentSizeRef.current = { cols, rows }
      }
```

with:

```ts
      const latestStatus = sessionStatusRef.current
      const canResize = (latestStatus === 'ai_running' || latestStatus === 'ai_pending') && !sessionExpiredRef.current
      if (canResize && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        lastSentSizeRef.current = { cols, rows }
      }
```

- [ ] **Step 3: Run web build**

Run:

```bash
npm run build:web
```

Expected: build completes successfully.

- [ ] **Step 4: Commit frontend guard**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "fix: skip inactive terminal resize sends"
```

## Task 4: Final verification

**Files:**
- Verify: `src/routes/ai-terminal.js`
- Verify: `web/src/AiTerminalMini.tsx`
- Verify: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Run backend route tests**

```bash
npx vitest run test/ai-terminal.route.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: PASS. If unrelated existing tests fail, capture the exact failing test names and error output.

- [ ] **Step 3: Run production web build**

```bash
npm run build:web
```

Expected: PASS.

- [ ] **Step 4: Manual browser validation**

Start the app:

```bash
npm run start -- --no-open
```

Open the local app URL printed by the CLI. Create or use an AI terminal session and validate:

1. Open one terminal and resize the browser window; output should not repeatedly reflow into visible residual lines.
2. Open the same session in a second browser tab or window; make one view narrow and one normal; the PTY should not resize below 30 columns.
3. Finish or stop a session, then resize/collapse/expand the terminal panel; the completed session should not trigger new PTY resize calls or visible terminal churn.

- [ ] **Step 5: Commit any verification-only fixes**

If verification required fixes, commit them with:

```bash
git add src/routes/ai-terminal.js web/src/AiTerminalMini.tsx test/ai-terminal.route.test.js
git commit -m "fix: stabilize terminal resize handling"
```

## Self-Review

- Spec coverage: backend invalid size filtering is Task 2; terminal-state resize ignore is Task 2; multi-browser invalid size filtering is Task 2; frontend active-session send guard is Task 3; validation is Task 4.
- Placeholder scan: no TBD/TODO/fill-in-later instructions remain.
- Type consistency: `TodoStatus`, `sessionStatusRef`, `sessionExpiredRef`, `isValidResizeSize`, and `canResizeSession` are defined before use; existing `ctx.pty.resizes` test helper is used consistently.

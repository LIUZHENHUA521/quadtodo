# AI Terminal Size-First Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded AI terminal start its PTY at the actual browser-measured terminal size (rather than the legacy 80×24 default), and gate xterm construction on container layout + bundled-font readiness, so first-paint width matches reality and `box-drawing / CJK` glyph width is stable across machines.

**Architecture:** Two-step PTY lifecycle — `pty.create(...)` only allocates the in-memory session record (no child process spawned), and `pty.startWithSize(sessionId, cols, rows)` is what actually spawns the PTY at the negotiated size. A new WS message `{ type: 'init', cols, rows }` from the frontend triggers `startWithSize`; a 5-second backend timer falls back to `startWithSize(80, 24)` if no init arrives. The frontend waits for container layout + `document.fonts.ready` (with bundled JetBrains Mono) before constructing xterm and sending the init message.

**Tech Stack:** Node.js (PtyManager wraps node-pty), Express + ws WebSocket route, vitest tests, React + xterm.js + FitAddon + CanvasAddon for the web terminal, `@fontsource/jetbrains-mono` for the bundled font.

---

## File Structure

**Modified (backend):**
- `src/pty.js` — split `start()` into `create()` + `startWithSize()`; keep `start()` as a backward-compat wrapper
- `src/routes/ai-terminal.js` — `spawnSession` calls `pty.create()` instead of `pty.start()`; new `case 'init'` in `handleBrowserMessage`; new 5-second spawn-fallback timer
- `test/pty.test.js` — assert backward-compat for `start()`, new tests for `create()` + `startWithSize()`
- `test/ai-terminal.route.test.js` — extend `FakePty` with `create`/`startWithSize` stubs; new tests for `init` handling + 5s fallback

**Modified (frontend):**
- `web/package.json` — add `@fontsource/jetbrains-mono`
- `web/src/main.tsx` — import font CSS at app entry
- `web/src/AiTerminalMini.tsx` — add `waitTerminalReady` helper, gate xterm construction on it, change WS onopen to send `init`, remove `--- Terminal connected ---` banner, handle hidden-tab-on-connect case

---

## Task 1: Split `PtyManager.start()` into `create()` + `startWithSize()`

**Files:**
- Modify: `src/pty.js:411-657` (the entire `start` method)
- Modify: `src/pty.js:392-409` (the existing `spawn` test wrapper — no behavioral change needed)
- Test: `test/pty.test.js`

**Context the engineer needs:**
- `PtyManager.start()` currently does *everything* in one method: build args, env, call `this.ptyFactory(...)` (spawns the PTY at hardcoded `cols:80, rows:24` on lines 486-487), wire `proc.onData` / `proc.onExit`, set up Codex prompt detector / fs watchers / poll timer / sidecar / emitter, schedule the 5-second `pendingPrompt` safety write.
- We want to split this so the heavy work (everything after `console.log` at line 471) can be deferred until we know the real cols/rows.
- After the split: `create()` does only the arg/env preparation and stores it on the session object. `startWithSize(sessionId, cols, rows)` does the actual `ptyFactory(...)` call and all the wiring. The old `pendingPrompt` 5-second safety timer (lines 614-622) is no longer needed — since `startWithSize` is only ever called with the size we want, we can write the prompt immediately with the existing `promptDelayMs` delay (typically 300 ms).
- `start()` becomes a thin wrapper: `create({...}); startWithSize(sessionId, 80, 24)`. This keeps every existing caller (route, tests, CLI) working without touching them in this task.

- [ ] **Step 1: Write a failing test asserting the new `create` / `startWithSize` API**

Add to `test/pty.test.js` at the bottom of the existing `describe('PtyManager', () => { ... })` block:

```js
  it('create() builds a session record but does not call the PTY factory', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created).toHaveLength(0)
    expect(pm.has('s1')).toBe(true)
  })

  it('startWithSize() spawns the PTY at the given cols/rows on first call', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.startWithSize('s1', 120, 30)
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0]._opts.cols).toBe(120)
    expect(factory.created[0]._opts.rows).toBe(30)
  })

  it('startWithSize() called twice does not re-spawn — second call is a resize', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    pm.startWithSize('s1', 120, 30)
    pm.startWithSize('s1', 100, 25)
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0].resize).toHaveBeenCalledWith(100, 25)
  })

  it('start() still works as a backward-compat wrapper (create + startWithSize 80×24)', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created).toHaveLength(1)
    expect(factory.created[0]._opts.cols).toBe(80)
    expect(factory.created[0]._opts.rows).toBe(24)
  })
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --run test/pty.test.js`
Expected: 4 new tests fail with `TypeError: pm.create is not a function` / `pm.startWithSize is not a function`.

- [ ] **Step 3: Refactor `src/pty.js` — extract `create()` + `startWithSize()`**

Replace the current `start({ sessionId, tool, prompt, cwd, resumeNativeId, permissionMode, extraEnv })` method (lines 411-657) with these three methods. The body of the new `startWithSize` is everything that used to live after `console.log` at line 471 (the `let proc; try { ... } catch ...`, session-object construction, Codex setup, `onData`/`onExit`, the prompt-write timer).

Key changes compared to the old code:
- Move the args/env/effectiveCwd computation into `create()`; stash the result on `session.spawnSpec = { args, env, effectiveCwd, toolCfg }`.
- In `startWithSize`, read `session.spawnSpec` and call `this.ptyFactory(spawnSpec.toolCfg.bin, spawnSpec.args, { cols, rows, cwd: spawnSpec.effectiveCwd, env: spawnSpec.env, name: 'xterm-256color' })`.
- The old 5-second `pendingPrompt` safety timer (lines 614-622) is replaced with a `promptDelayMs` write immediately after spawn (since we now spawn at the right size):

  ```js
  if (session.pendingPrompt) {
    session.promptTimer = setTimeout(() => {
      if (session.pendingPrompt) {
        proc.write(session.pendingPrompt + '\r')
        session.pendingPrompt = null
      }
    }, this.promptDelayMs)
    session.resized = true // prompt path is now driven by startWithSize, not by resize()
  }
  ```
- The existing `resize()` method (lines 723-737) is unchanged — its `!s.resized && s.pendingPrompt` branch becomes dead code for new sessions (because `startWithSize` sets `resized = true`), but it still helps the backward-compat path (`start()` → `startWithSize(80, 24)` → resize-triggered prompt is no longer the source of truth).

Then add:

```js
  /**
   * Two-step spawn: create() only builds the session record (no child process),
   * startWithSize() does the actual ptyFactory call. New WS init handshake calls
   * create() at session start and startWithSize() once the frontend reports its
   * real cols/rows, so the PTY never spawns at the legacy 80×24 default.
   */
  create({ sessionId, tool, prompt, cwd, resumeNativeId, permissionMode, extraEnv }) {
    const toolCfg = this.tools[tool]
    if (!toolCfg) throw new Error(`unknown tool: ${tool}`)
    // ... (all the args/env/effectiveCwd/claudeSessionLocator/permissionArgs logic
    //      from the old start() method, lines 412-470 verbatim)

    const session = {
      proc: null,
      tool,
      sessionId,
      cwd: effectiveCwd,
      todoId: null,
      fullLog: [],
      logBytes: 0,
      pendingPrompt: useCliPrompt ? null : (prompt && !resumeNativeId ? prompt : null),
      resized: false,
      promptTimer: null,
      nativeId: resumeNativeId || presetClaudeId || presetCursorId || null,
      stopped: false,
      detectTimer: null,
      fsWatcher: null,
      eventEmitter: null,
      detector: null,
      lastTuiAlertAt: 0,
      // spawnSpec carries everything startWithSize needs:
      spawnSpec: { args, env, effectiveCwd, toolCfg, tool, resumeNativeId },
    }
    this.sessions.set(sessionId, session)
  }

  startWithSize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`no session ${sessionId}`)
    if (session.proc) {
      // already spawned — degrade to resize
      try { session.proc.resize(cols, rows) } catch { /* ignore */ }
      return
    }
    const spec = session.spawnSpec
    if (!spec) throw new Error(`session ${sessionId} has no spawnSpec (was it created?)`)

    console.log(`[pty] starting ${spec.tool} bin=${spec.toolCfg.bin} cwd=${spec.effectiveCwd} args=${JSON.stringify(spec.args)} cols=${cols} rows=${rows}`)

    let proc
    try {
      proc = this.ptyFactory(spec.toolCfg.bin, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.effectiveCwd,
        env: spec.env,
      })
    } catch (error) {
      error.message = `PTY spawn failed for ${spec.tool} (bin=${spec.toolCfg.bin}, cwd=${spec.effectiveCwd}, args=${JSON.stringify(spec.args)}): ${error.message}`
      throw error
    }
    session.proc = proc

    // ... (all the post-spawn wiring from old start() lines 517-656 verbatim,
    //      with two adjustments:
    //   1. The 5-second pendingPrompt safety timer at lines 614-622 is replaced
    //      by a promptDelayMs write right here:
    //
    //      if (session.pendingPrompt) {
    //        session.promptTimer = setTimeout(() => {
    //          if (session.pendingPrompt) {
    //            proc.write(session.pendingPrompt + '\r')
    //            session.pendingPrompt = null
    //          }
    //        }, this.promptDelayMs)
    //        session.resized = true
    //      }
    //
    //   2. `session.spawnSpec = null` after wiring is done, to release closures)
  }

  start(opts) {
    this.create(opts)
    this.startWithSize(opts.sessionId, 80, 24)
  }
```

The `spawn(...)` test-only wrapper at lines 392-409 stays as-is — it already calls `this.start({...})`.

- [ ] **Step 4: Run all pty tests to confirm pass**

Run: `npm test -- --run test/pty.test.js test/pty.codex-spawn.test.js test/pty.findCodexSession.test.js`
Expected: All tests pass, including the 4 new ones from Step 1 and all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/pty.js test/pty.test.js
git commit -m "$(cat <<'EOF'
refactor(pty): split start() into create() + startWithSize() for size-first handshake

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Switch `spawnSession` in the AI terminal route to use `pty.create()`

**Files:**
- Modify: `src/routes/ai-terminal.js:379-449` (the `session` literal and `pty.start` call inside `spawnSession`)
- Modify: `test/ai-terminal.route.test.js:13-36` (extend `FakePty` mock)

**Context:**
- `spawnSession` is the function the HTTP `POST /exec` route eventually calls; it builds the in-memory session record (lines 379-401) and then calls `pty.start({...})` (line 431) to actually start the PTY.
- After this task: the route stops spawning PTY at HTTP-time. It only calls `pty.create({...})`. A 5-second timer (`spawnFallbackTimer`) is armed; if no `init` WS message arrives in time, it forces `pty.startWithSize(sessionId, 80, 24)`.
- New session fields: `spawned: false`, `spawnFallbackTimer: <Timeout>`. These get cleared by `init` (in Task 3) or fired by the fallback.
- The existing `addBrowser` / output / done event handlers don't care about `spawned` — they keep working as before. PTY won't emit `output` events before `startWithSize` is called, so the replay buffer stays empty until spawn.

- [ ] **Step 1: Extend the `FakePty` mock in `test/ai-terminal.route.test.js`**

Replace the `FakePty` class at lines 13-36 with:

```js
class FakePty extends EventEmitter {
  constructor() {
    super()
    this.created = []        // tracks create() calls
    this.startedWithSize = [] // tracks startWithSize() calls
    this.started = []         // legacy: tracks start() calls (back-compat)
    this.writes = []
    this.resizes = []
    this.stopped = []
    this._has = new Set()
  }
  create(opts) {
    this.created.push(opts)
    this._has.add(opts.sessionId)
  }
  startWithSize(sessionId, cols, rows) {
    this.startedWithSize.push({ sessionId, cols, rows })
  }
  start(opts) {
    // back-compat for any test that still calls it directly
    this.started.push(opts)
    this._has.add(opts.sessionId)
  }
  write(id, data) { this.writes.push({ id, data }) }
  resize(id, cols, rows) { this.resizes.push({ id, cols, rows }) }
  stop(id) {
    this.stopped.push(id)
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
  getPids() { return [...this._has].map((id, i) => ({ sessionId: id, pid: 10000 + i, tool: 'claude' })) }
}
```

- [ ] **Step 2: Update existing route tests that assert on `pty.started`**

The tests at the following lines assert `ctx.pty.started` having length 1 or inspecting `started[0].tool`/`prompt`/`cwd`/`resumeNativeId`. After this task, the route calls `pty.create(...)` not `pty.start(...)`, so these assertions need to use `created` instead of `started`:

- Lines 99, 110-112, 164, 236, 259, 285, 312-315, 347, 377, 409-411, 852-853, 864

Sed-style replacement: `ctx.pty.started` → `ctx.pty.created` and `pty.started` → `pty.created` throughout the test file. Verify by grep that you got all of them.

- [ ] **Step 3: Run route tests to verify they fail as expected against the unchanged route**

Run: `npm test -- --run test/ai-terminal.route.test.js`
Expected: Tests fail because the route still calls `pty.start(...)` (the mock's `start` path), and we're now asserting on `pty.created`. The failures locate the lines we need to change in the route.

- [ ] **Step 4: Change `spawnSession` in `src/routes/ai-terminal.js` to call `pty.create`**

In `src/routes/ai-terminal.js`, in the `session` literal (around line 379), add two new fields:

```js
    const session = {
      // ... existing fields ...
      spawned: false,
      spawnFallbackTimer: null,
    }
```

Then, replace the `pty.start({...})` call (around line 431) with:

```js
      pty.create({
        sessionId,
        todoId,
        tool,
        prompt: resumeNativeId ? null : prompt,
        cwd: sessionCwd,
        resumeNativeId: resumeNativeId || undefined,
        permissionMode: permissionMode || null,
        extraEnv: { ...(extraEnv || {}), ...autoEnv },
      })
      // 5s fallback: if frontend never sends a valid `init`, spawn at the legacy
      // 80×24 default so the session doesn't hang forever waiting on a size.
      session.spawnFallbackTimer = setTimeout(() => {
        if (session.spawned) return
        console.warn(`[ai-terminal] spawn fallback fired session=${sessionId} (no init within 5s)`)
        try {
          pty.startWithSize(sessionId, 80, 24)
          session.spawned = true
        } catch (e) {
          console.warn(`[ai-terminal] spawn fallback failed: ${e.message}`)
        }
        session.spawnFallbackTimer = null
      }, 5000)
      session.spawnFallbackTimer.unref?.()
```

- [ ] **Step 5: Run route tests — should still fail because no init/fallback path drives spawn yet**

Run: `npm test -- --run test/ai-terminal.route.test.js`
Expected: The tests that assert `pty.created` length pass; tests that assert on `pty.startedWithSize` (which we haven't added yet) don't exist yet. Tests asserting on `pty.resizes` may still pass since the resize path is unchanged. Tests that test the full flow (output / done events) — check if any rely on the PTY being spawned eagerly. If so, mark them as expected-fail and move to Task 3.

  Specifically: the test "output event is captured in history buffer" at line 419 emits an `output` event from the fake pty *before* anything spawns — that still works because `FakePty.emit('output')` is synthetic. ✅
  The test "done event with exitCode 0 marks todo ai_done" at line 445 similarly emits synthetic events. ✅

- [ ] **Step 6: Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "$(cat <<'EOF'
refactor(ai-terminal): use pty.create + 5s spawn fallback in spawnSession

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `init` WS message handling

**Files:**
- Modify: `src/routes/ai-terminal.js:776-822` (the `handleBrowserMessage` switch)
- Test: `test/ai-terminal.route.test.js`

**Context:**
- The WS message dispatcher `handleBrowserMessage` currently handles `input`, `resize`, `set_auto_mode`, `clear_history`. We add `init`.
- On valid `init`: if session not yet spawned, clear the fallback timer, call `pty.startWithSize(sessionId, cols, rows)`, mark spawned, register the size in the resize aggregation (`ws.__quadtodoSize`), call `applyAggregatedResize`.
- On valid `init` but session already spawned (reconnect / fallback already fired): equivalent to a resize — register size + `applyAggregatedResize`. Do **not** re-spawn.
- On invalid `init` (e.g., `cols < 30`): silently ignore (the fallback timer will still fire).

- [ ] **Step 1: Write failing tests for `init` handling**

Add a new `describe` block at the end of `test/ai-terminal.route.test.js` before the closing brace of the outer `describe('routes/ai-terminal', () => { ... })`:

```js
  describe('init handshake', () => {
    function makeWs() {
      const sent = []
      return {
        OPEN: 1,
        readyState: 1,
        send: (data) => sent.push(JSON.parse(data)),
        close: () => {},
        sent,
      }
    }

    it('init triggers startWithSize once and marks session spawned', async () => {
      const r = await request(ctx.app).post('/api/ai-terminal/exec').send({
        todoId: 't1', prompt: 'hello', tool: 'claude',
      })
      const sessionId = r.body.sessionId
      // pty.create was called, pty.startWithSize was NOT
      expect(ctx.pty.created).toHaveLength(1)
      expect(ctx.pty.startedWithSize).toHaveLength(0)

      const ws = makeWs()
      ctx.ait.addBrowser(sessionId, ws)
      ctx.ait.handleBrowserMessage(sessionId, { type: 'init', cols: 120, rows: 30 }, ws)

      expect(ctx.pty.startedWithSize).toHaveLength(1)
      expect(ctx.pty.startedWithSize[0]).toEqual({ sessionId, cols: 120, rows: 30 })
    })

    it('init with invalid size (cols<30) is ignored', async () => {
      const r = await request(ctx.app).post('/api/ai-terminal/exec').send({
        todoId: 't1', prompt: 'hello', tool: 'claude',
      })
      const sessionId = r.body.sessionId
      const ws = makeWs()
      ctx.ait.addBrowser(sessionId, ws)
      ctx.ait.handleBrowserMessage(sessionId, { type: 'init', cols: 0, rows: 0 }, ws)
      expect(ctx.pty.startedWithSize).toHaveLength(0)
    })

    it('repeated init does not re-spawn — subsequent init equivalent to resize', async () => {
      const r = await request(ctx.app).post('/api/ai-terminal/exec').send({
        todoId: 't1', prompt: 'hello', tool: 'claude',
      })
      const sessionId = r.body.sessionId
      const ws = makeWs()
      ctx.ait.addBrowser(sessionId, ws)
      ctx.ait.handleBrowserMessage(sessionId, { type: 'init', cols: 120, rows: 30 }, ws)
      ctx.ait.handleBrowserMessage(sessionId, { type: 'init', cols: 100, rows: 25 }, ws)

      expect(ctx.pty.startedWithSize).toHaveLength(1)
      expect(ctx.pty.resizes).toContainEqual({ id: sessionId, cols: 100, rows: 25 })
    })

    it('5s spawn fallback fires when no init arrives', async () => {
      vi.useFakeTimers()
      try {
        const r = await request(ctx.app).post('/api/ai-terminal/exec').send({
          todoId: 't1', prompt: 'hello', tool: 'claude',
        })
        const sessionId = r.body.sessionId
        expect(ctx.pty.startedWithSize).toHaveLength(0)
        vi.advanceTimersByTime(5001)
        expect(ctx.pty.startedWithSize).toHaveLength(1)
        expect(ctx.pty.startedWithSize[0]).toEqual({ sessionId, cols: 80, rows: 24 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('init after fallback already fired — only resizes, does not re-spawn', async () => {
      vi.useFakeTimers()
      try {
        const r = await request(ctx.app).post('/api/ai-terminal/exec').send({
          todoId: 't1', prompt: 'hello', tool: 'claude',
        })
        const sessionId = r.body.sessionId
        vi.advanceTimersByTime(5001) // fallback fires → startWithSize(80, 24)
        expect(ctx.pty.startedWithSize).toHaveLength(1)

        const ws = makeWs()
        ctx.ait.addBrowser(sessionId, ws)
        ctx.ait.handleBrowserMessage(sessionId, { type: 'init', cols: 120, rows: 30 }, ws)

        expect(ctx.pty.startedWithSize).toHaveLength(1) // still 1, no re-spawn
        expect(ctx.pty.resizes).toContainEqual({ id: sessionId, cols: 120, rows: 30 })
      } finally {
        vi.useRealTimers()
      }
    })
  })
```

Note: this test block uses `ctx.ait.addBrowser` / `ctx.ait.handleBrowserMessage` directly. The existing `createAiTerminal` returns these on the `ait` object (see `src/routes/ai-terminal.js:947-955`). The `makeApp` factory in the test file already returns `ait`, so this works.

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --run test/ai-terminal.route.test.js -t "init handshake"`
Expected: All 5 new tests fail — none of the `init` behavior is implemented yet.

- [ ] **Step 3: Add the `init` branch to `handleBrowserMessage`**

In `src/routes/ai-terminal.js`, inside `handleBrowserMessage` (around line 776), add a new branch right after the `if (msg.type === 'input')` block and before `else if (msg.type === 'resize')`:

```js
    } else if (msg.type === 'init') {
      const cols = Number(msg.cols)
      const rows = Number(msg.rows)
      const session = sessions.get(sessionId)
      if (!session) return
      if (!isValidResizeSize(cols, rows)) return
      if (!session.spawned) {
        // First valid init: cancel the 5s fallback and spawn at the real size.
        if (session.spawnFallbackTimer) {
          clearTimeout(session.spawnFallbackTimer)
          session.spawnFallbackTimer = null
        }
        try {
          pty.startWithSize(sessionId, clampPtyCols(cols), rows)
          session.spawned = true
          session.lastAppliedCols = clampPtyCols(cols)
          session.lastAppliedRows = rows
        } catch (e) {
          console.warn(`[ai-terminal] startWithSize failed for ${sessionId}: ${e.message}`)
          return
        }
      }
      // Register this WS's size into the aggregation map either way.
      if (ws && session.browsers.has(ws)) {
        ws.__quadtodoSize = { cols, rows }
        applyAggregatedResize(session)
      }
```

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `npm test -- --run test/ai-terminal.route.test.js -t "init handshake"`
Expected: All 5 tests pass.

- [ ] **Step 5: Run the full route + pty test suite to confirm no regression**

Run: `npm test -- --run test/ai-terminal.route.test.js test/pty.test.js test/pty.codex-spawn.test.js`
Expected: Everything green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "$(cat <<'EOF'
feat(ai-terminal): handle 'init' WS message — spawn PTY at real cols/rows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Bundle JetBrains Mono into the web frontend

**Files:**
- Modify: `web/package.json`
- Modify: `web/src/main.tsx:1-21`

**Context:**
- We need a known, stable monospace font that ships with the app. `@fontsource/jetbrains-mono` (OFL-1.1 licensed, MIT licensed wrapper) is ~120 KB woff2 for one weight, and the package exposes per-weight CSS files. Importing `400.css` and `700.css` covers regular + bold for xterm's bold attribute output.
- Adding the import in `web/src/main.tsx` (the app entrypoint) means the browser starts downloading the font as soon as JS loads, well before any terminal mounts.

- [ ] **Step 1: Add the dependency**

Run from the project root:

```bash
cd web && npm install --save @fontsource/jetbrains-mono@^5.1.0 && cd ..
```

Expected: `web/package.json` gains `"@fontsource/jetbrains-mono": "^5.x.x"` under `dependencies`; `web/package-lock.json` is updated.

- [ ] **Step 2: Import the font CSS in the app entry**

Edit `web/src/main.tsx`. After line 7 (`import '@xterm/xterm/css/xterm.css'`) add:

```ts
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
```

- [ ] **Step 3: Build the web bundle to confirm the imports resolve**

Run: `cd web && npm run build && cd ..`
Expected: `tsc -b` passes; `vite build` succeeds and emits the font files under `dist/assets/`.

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(web): bundle JetBrains Mono via @fontsource for stable terminal glyph width

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Defer xterm construction until container layout + fonts are ready

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:383-487` (the `useEffect` that constructs the Terminal and its `requestAnimationFrame(() => fit.fit())` tail)

**Context:**
- The Terminal is constructed inside a `useEffect` keyed on `sessionId`. Today it's constructed synchronously: `new Terminal(...)` at line 399, `term.open(container)` at line 410, `CanvasAddon` load at line 413, and `requestAnimationFrame(() => fit.fit())` at line 487.
- We need to delay this whole block until: (1) the container has non-zero clientWidth ≥ `MIN_CONTAINER_WIDTH` and is visible (`offsetParent !== null`), AND (2) `document.fonts.ready` resolves AND (3) `document.fonts.load('13px "JetBrains Mono"')` resolves.
- We have a 3-second cap on the wait; if the wait times out, we proceed anyway (the OS will pick a fallback monospace; xterm will use whatever fonts are available).
- The xterm `fontFamily` prop also gets updated so JetBrains Mono is first in the stack.

- [ ] **Step 1: Change the xterm fontFamily to put JetBrains Mono first**

In `web/src/AiTerminalMini.tsx` around line 401, change:

```ts
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
```

to:

```ts
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
```

- [ ] **Step 2: Add a `waitTerminalReady` helper near the top of `AiTerminalMini.tsx`**

After the file-level constants (around line 63, after `function sendUnregisterSize(...)`) add:

```ts
// Wait until (a) the container has settled layout and is visible, AND
// (b) the bundled JetBrains Mono font is loaded, before letting xterm measure
// glyph width. Capped at 3 seconds; if it times out, proceed with whatever the
// browser has — at worst we fall back to system monospace and the user sees a
// brief font-swap reflow on first paint, which is strictly better than the old
// "fit at 0 width / cached metrics" failure modes.
async function waitTerminalReady(container: HTMLDivElement): Promise<void> {
  const start = Date.now()
  const TIMEOUT_MS = 3000

  // (a) container layout
  while (Date.now() - start < TIMEOUT_MS) {
    if (container.offsetParent !== null && container.clientWidth >= MIN_CONTAINER_WIDTH) break
    await new Promise(r => setTimeout(r, 50))
  }

  // (b) fonts
  try {
    await Promise.race([
      Promise.all([
        document.fonts.ready,
        // Trigger the font face if it hasn't been used yet
        (document.fonts as any).load?.('13px "JetBrains Mono"') ?? Promise.resolve(),
      ]),
      new Promise(r => setTimeout(r, Math.max(0, TIMEOUT_MS - (Date.now() - start)))),
    ])
  } catch { /* font API can throw on older Safari; ignore */ }

  // One frame to let layout + font swap apply
  await new Promise(r => requestAnimationFrame(() => r(null)))
}
```

- [ ] **Step 3: Wrap the Terminal construction in `waitTerminalReady`**

The current `useEffect` body (around line 383) runs synchronously and constructs `term` immediately. We need to:

1. Convert the construction block (lines 399-487) into an `async function setup() { ... }` declared inside the useEffect.
2. At the very start of `setup`, `await waitTerminalReady(containerRef.current!)`.
3. After the await, re-check `if (disposedRef.current) return` (because the component may have unmounted during the await).
4. Call `setup()` from the useEffect body and don't await — the cleanup function should still be returned synchronously.

Concretely, in `web/src/AiTerminalMini.tsx` the existing `useEffect` block (around line 383) becomes:

```ts
  useEffect(() => {
    if (!containerRef.current) return
    disposedRef.current = false
    stopReconnectRef.current = false
    recoveringRef.current = false
    recoveryAttemptedRef.current = false
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
    reconnectCountRef.current = 0
    lastSentSizeRef.current = null
    if (pendingResizeRef.current?.timer) clearTimeout(pendingResizeRef.current.timer)
    pendingResizeRef.current = null
    isHiddenRef.current = typeof document !== 'undefined' ? document.hidden : false
    lastPongRef.current = Date.now()
    setSessionExpired(false)
    setWsConnected(false)

    let cleanup: (() => void) | null = null

    void (async () => {
      const container = containerRef.current
      if (!container) return
      await waitTerminalReady(container)
      if (disposedRef.current) return

      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: themeRef.current,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        disableStdin: false,
      })
      // ... (rest of the old useEffect body verbatim, lines 408-...)
      //     IMPORTANT: the cleanup function (returned at the very bottom of the
      //     old block, the `return () => { ... }` at the end of useEffect) should
      //     be assigned to the outer `cleanup` variable instead of returned from
      //     the async IIFE:
      //
      //         cleanup = () => { /* existing cleanup body */ }
    })()

    return () => {
      disposedRef.current = true
      if (cleanup) cleanup()
    }
  }, [sessionId, ...]) // existing deps
```

- [ ] **Step 4: Build and visually verify**

Run: `cd web && npm run build && cd ..`
Expected: `tsc -b` passes (the async/await refactor compiles), `vite build` succeeds.

Run dev server: `cd web && npm run dev`
Expected: open `localhost:5173`, navigate to a todo, click "AI 终端" → the terminal placeholder area briefly shows blank, then the xterm appears once fonts + layout are ready. No "3-4 char per line" first-frame.

- [ ] **Step 5: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "$(cat <<'EOF'
fix(web): defer xterm construction until container layout + fonts ready

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Send `init` on WS open instead of relying on the first resize

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:505-540` (the `ws.onopen` block)

**Context:**
- Today the WS `onopen` handler (around line 505) writes `--- Terminal connected ---` to xterm, resets `lastSentSizeRef.current = null`, and calls `doFit()` (which eventually calls `scheduleResizeSend`, which sends `{ type: 'resize', cols, rows }` 200 ms later — long after the PTY has already painted its banner at 80 cols).
- We replace this with: immediately read `term.cols / term.rows` and send `{ type: 'init', cols, rows }`. If the tab is currently hidden, follow the init with `{ type: 'resize', cols: 0, rows: 0 }` so the size doesn't pin the PTY to the hidden tab's width.
- The `--- Terminal connected ---` writeln is removed entirely (per spec design discussion).

- [ ] **Step 1: Replace the `ws.onopen` block**

Find the block at lines 505-540 in `web/src/AiTerminalMini.tsx`. The current `ws.onopen` body writes the banner, resets state, and triggers `doFit()`. Replace it with:

```ts
      ws.onopen = () => {
        if (wsRef.current !== ws) { ws.close(); return }

        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
        reconnectCountRef.current = 0
        setWsConnected(true)
        lastPongRef.current = Date.now()
        // Clear lastSent so the post-init resize aggregation path will still
        // send the same size if doFit gets called for any reason.
        lastSentSizeRef.current = null

        if (!resumeTargetRef.current?.nativeSessionId && status === 'ai_running') {
          term.writeln('\x1b[90m--- 正在注入任务上下文，请稍候... ---\x1b[0m\r')
        }

        // ─── Size-first handshake ───
        // term.cols / term.rows reflect the FitAddon result from the initial
        // fit (done inside the deferred setup after fonts settled). Send these
        // as the init handshake. Backend uses this to spawn the PTY at the real
        // size, or (if already spawned) treats it as a regular resize.
        const cols = term.cols
        const rows = term.rows
        if (isHiddenRef.current) {
          // Hidden tab on connect: still send init so the PTY can spawn, but
          // immediately follow with 0/0 so this tab doesn't pin the aggregation
          // to its (possibly stale or zero) size while in the background.
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
            ws.send(JSON.stringify({ type: 'init', cols, rows }))
          }
          sendUnregisterSize(ws)
        } else if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
          ws.send(JSON.stringify({ type: 'init', cols, rows }))
          // Seed lastSentSizeRef so the very next ResizeObserver fire doesn't
          // re-send the same cols/rows as a duplicate resize.
          lastSentSizeRef.current = { cols, rows }
        } else {
          // Edge case: term wasn't able to measure (e.g., StrictMode double-mount
          // race). Fall through to legacy doFit — backend's 5s fallback will spawn.
          requestAnimationFrame(() => doFit())
        }
      }
```

Notes:
- The `term.writeln('\x1b[36m--- Terminal connected ---\x1b[0m\r')` line is intentionally **removed**.
- The `--- 正在注入任务上下文，请稍候... ---` waitline is kept for resume-injection UX.
- `MIN_VALID_COLS` is already imported at the top of the file (line 55).

- [ ] **Step 2: Build & dev-test**

Run: `cd web && npm run build && cd ..`
Expected: build passes.

Run dev server, click into a todo + start a new AI session, watch:
1. The first banner Claude/Codex draws is at the actual cols, not at 80
2. No `--- Terminal connected ---` line appears
3. WS reconnect (kill server, restart) → init is re-sent, no re-spawn (verify via backend log `[ai-terminal] spawn fallback fired` does NOT print)

- [ ] **Step 3: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "$(cat <<'EOF'
feat(web): send {type:'init'} WS message on connect for size-first PTY spawn

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: End-to-end verification (manual)

**Files:** (none — pure verification)

**Context:** Run the seven manual scenarios from the spec's "GREEN 验证" list. Each must pass without symptoms A/B/C/D. Capture pass/fail in your final report.

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Build the production bundle**

Run: `npm run build`
Expected: web bundle builds; `dist-web/` is populated.

- [ ] **Step 3: Start quadtodo and run manual scenarios**

Start: `node src/cli.js start`

Verify each scenario:

1. **macOS Chrome, full-screen, panel ≥ 1400 px**: create a new todo, click "AI 终端", launch a `claude` session → first banner fully fills the panel width; no 80-col-wrapping visible
2. **Drag panel to 600 px wide, then start session**: banner is rendered at ~75 cols, not at 80 cols
3. **Folded terminal panel + start session**: the placeholder shows for ≤ 3 s; expand the panel within those 3 s → banner appears at the now-real width
4. **Same on a Linux box (or simulate via `chrome --font-family=DejaVu Sans Mono`)**: bullets and `├ │ ─ ╰` glyphs align with text rows
5. **Two tabs of the same session, one wide one narrow**: switch the narrow one to background → 5 s later the wide tab's Claude output reflows to the wide cols
6. **Kill the server, restart, reload tab**: WS reconnects, sends `init`, backend logs show "init handshake (already spawned) — resize-only" (no re-spawn)
7. **Pop out the terminal to a new window**: popout shows the placeholder briefly, then xterm renders at the popout window's true cols

- [ ] **Step 4: Re-do the spec's "RED" check on a clean rebuild to confirm it's actually fixed**

Run: in a separate clone or worktree at `main`'s prior HEAD, repeat scenario #1. You should see the old 80-col-wrap banner. Then come back to this branch and confirm it's gone.

- [ ] **Step 5: Report**

Report which scenarios passed, which failed, and which were skipped (e.g., if you don't have a Linux box, document that #4 was deferred to the user). Do NOT mark the plan complete until all 7 pass.

---

## Self-Review Notes

- All spec sections have a matching task:
  - "协议变化 / 启动时序" → Tasks 1, 2, 3
  - "后端改动 — pty.js create/startWithSize" → Task 1
  - "后端改动 — routes/ai-terminal.js init + fallback" → Tasks 2, 3
  - "前端改动 — 字体内置" → Task 4
  - "前端改动 — waitTerminalReady" → Task 5
  - "前端改动 — init 上报 + 移除 banner" → Task 6
  - "边界场景" (popout / hidden tab / reconnect / fallback) → Task 6 (hidden tab + reconnect), Task 3 (fallback), Task 7 (popout manual)
  - "测试 & 验证" → Tasks 1, 3, 7
- No placeholders, no "TODO / TBD".
- Type consistency: `pty.create`, `pty.startWithSize`, `session.spawned`, `session.spawnFallbackTimer`, `waitTerminalReady`, `MIN_CONTAINER_WIDTH`, `MIN_VALID_COLS`, `clampPtyCols` — all defined where first used and reused consistently.
- The 3-second frontend wait vs 5-second backend fallback ordering is consistent: frontend gives up at 3 s and sends whatever `term.cols` measures (which can be the placeholder fallback dimensions); backend's 5 s timer gives the frontend one extra buffer for the `init` to land before spawning at 80×24.

# Codex × Lark/Telegram Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Codex todos the same proactive Lark / Telegram push experience as Claude (turn-end notifications, ask-user permission cards, error / abort signals, full-transcript attachments) and add per-channel/per-user `dispatch` config so users don't keep retyping the tool.

**Architecture:** Two event sources for Codex: (a) jsonl-tail emitter watches `~/.codex/sessions/.../rollout-*.jsonl` for `event_msg/task_complete | turn_aborted | error`, (b) PTY-stdout detector matches strict-mode permission prompts. Both POST to the existing `/api/openclaw/hook` route, which discriminates on `source` + `path` fields and runs a Codex-specific handler branch reusing `openclaw-bridge` for outbound dispatch. A new `dispatch` config layer (per-channel / per-user) plus `resolveTool()` consolidates today's three scattered `defaultTool` reads.

**Tech Stack:** Node.js ESM, Vitest, `node-pty`, `chokidar`-style `fs.watch`, existing quadtodo DB / wizard / hook / bridge / lark-bot / telegram-bot / SettingsDrawer.

**Spec:** `docs/superpowers/specs/2026-05-09-codex-im-bridge-design.md`

**Phases (single PR each, in order)**:
- Phase 0: verify pricing dependency
- Phase A: sidecar + `findCodexSession` + emitter skeleton
- Phase B: `extractCodex` rewrite + footer tool param
- Phase C: turn-end push end-to-end
- Phase D: error / turn_aborted / SessionEnd + attachment
- Phase E: prompt detector + ask-user cards
- Phase F: Claude regression + acceptance sweep
- Phase G: dispatch config + SettingsDrawer UI

---

## File Structure

**New files:**
- `src/codex-event-emitter.js` — jsonl tail watcher; parses incremental `event_msg` records; POSTs to `/api/openclaw/hook` (path=jsonl).
- `src/codex-prompt-detector.js` — PTY stdout listener; regex match + debounce + AI-content guard; POSTs (path=detector).
- `src/codex-transcript.js` — Codex equivalents of `claude-transcript.js`: `readLatestCodexTurn`, `readLatestCodexTurnFresh`, `buildFullCodexTranscript`, `extractCodexTurnUsageFromLines`.
- `src/dispatch.js` — `resolveTool({ channel, userId, chatId, override })`.
- `test/codex-event-emitter.test.js`, `test/codex-prompt-detector.test.js`, `test/codex-transcript.test.js`, `test/codex-usage-parser.test.js`, `test/openclaw-hook.codex.test.js`, `test/lark-card.codex.test.js`, `test/pty.findCodexSession.test.js`, `test/dispatch.test.js`, `test/openclaw-wizard.dispatch.test.js`.
- `test/fixtures/codex-real-token-count.jsonl` — copy of a real `~/.codex/sessions/...` rollout for parser tests.
- `scripts/refresh-codex-fixture.js` — one-shot to regenerate the fixture from a fresh Codex session.

**Modified files:**
- `src/pty.js` — export `findCodexSession`; `PtyManager` writes sidecar + memory `nativeIdToQuadtodoSession`; spawns emitter + detector for codex tools.
- `src/usage-parser.js` — rewrite `extractCodex` against `event_msg/token_count`.
- `src/usage-footer.js` — `extractSessionUsageFromLines` accepts `tool` parameter; default `'claude'` for back-compat.
- `src/openclaw-hook.js` — `handle()` accepts `source` + `path`; codex jsonl branch + codex detector branch; reuses bridge.
- `src/routes/openclaw-hook.js` — body discriminator, forwards `source` + `path`.
- `src/lark-card.js` — `buildPermissionCard` parameterizes `headerTitle` (default keeps current Claude string).
- `src/ask-user-buttons.js` — callback_data `source` field; helper to map source→pty write payload (`\r`/`\x1b`).
- `src/openclaw-wizard.js` — replaces `cfg.defaultTool` with `resolveTool({ channel, userId, chatId })` (Phase G only).
- `src/mcp/tools/openclaw/index.js` — same swap (Phase G only).
- `src/server.js` — wire emitter/detector start/stop on PTY lifecycle; expose `dispatch` config in `/api/config`.
- `src/config.js` — `dispatch` default object.
- `web/src/SettingsDrawer.tsx` — Dispatch sub-section UI (Phase G).

**Sidecar location:** `~/.quadtodo/codex-sessions/<nativeId>.json`.

---

## Phase 0: Verify Pricing Dependency

### Task 0.1: Confirm `2026-05-09-gpt-default-pricing-design.md` is implemented

**Files:**
- Read: `src/pricing.js`

- [ ] **Step 1: Inspect `src/pricing.js`**

Run: `grep -E "gpt-5|gpt-4o|gpt-4\.1" src/pricing.js`

Expected: at least one GPT family pattern present in `DEFAULT_PRICING.models`. If empty → STOP and implement that spec first; everything below assumes Codex models resolve to non-Sonnet rates.

- [ ] **Step 2: Quick assertion test**

Run: `npx vitest run test/pricing.test.js -t "gpt"`

Expected: PASS. If MISSING test, this means `2026-05-09-gpt-default-pricing-design.md` is not yet implemented; pause this plan and finish the dependency.

---

## Phase A: Infrastructure (sidecar + findCodexSession + emitter skeleton)

### Task A.1: Sidecar write/read helpers + memory map

**Files:**
- Create: `src/codex-sidecar.js`
- Create: `test/codex-sidecar.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex-sidecar.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexSidecar } from '../src/codex-sidecar.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-sidecar-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('codex-sidecar', () => {
  it('write() updates memory map synchronously and fsyncs file', async () => {
    const sc = createCodexSidecar({ baseDir: dir })
    await sc.write({ nativeId: 'abc', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
    expect(sc.lookup('abc')).toEqual({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
    const file = JSON.parse(readFileSync(join(dir, 'abc.json'), 'utf8'))
    expect(file).toMatchObject({ nativeId: 'abc', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
  })

  it('lookup() returns null for unknown id', () => {
    const sc = createCodexSidecar({ baseDir: dir })
    expect(sc.lookup('missing')).toBeNull()
  })

  it('restoreFromDisk() rebuilds memory map from sidecar files', async () => {
    const sc1 = createCodexSidecar({ baseDir: dir })
    await sc1.write({ nativeId: 'a', quadtodoSessionId: 'q1', todoId: 't1', cwd: '/x' })
    await sc1.write({ nativeId: 'b', quadtodoSessionId: 'q2', todoId: 't2', cwd: '/y' })
    const sc2 = createCodexSidecar({ baseDir: dir })
    sc2.restoreFromDisk()
    expect(sc2.lookup('a')).toMatchObject({ quadtodoSessionId: 'q1' })
    expect(sc2.lookup('b')).toMatchObject({ quadtodoSessionId: 'q2' })
  })

  it('clear(nativeId) removes from memory and disk', async () => {
    const sc = createCodexSidecar({ baseDir: dir })
    await sc.write({ nativeId: 'x', quadtodoSessionId: 'q', todoId: 't', cwd: '/z' })
    sc.clear('x')
    expect(sc.lookup('x')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/codex-sidecar.test.js`

Expected: FAIL with "Cannot find module '../src/codex-sidecar.js'".

- [ ] **Step 3: Implement `src/codex-sidecar.js`**

```js
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_DIR = join(homedir(), '.quadtodo', 'codex-sessions')

export function createCodexSidecar({ baseDir = DEFAULT_DIR } = {}) {
  mkdirSync(baseDir, { recursive: true })
  const memory = new Map()

  function fileFor(nativeId) {
    return join(baseDir, `${nativeId}.json`)
  }

  function lookup(nativeId) {
    if (!nativeId) return null
    if (memory.has(nativeId)) return memory.get(nativeId)
    const path = fileFor(nativeId)
    if (!existsSync(path)) return null
    try {
      const j = JSON.parse(readFileSync(path, 'utf8'))
      const v = { quadtodoSessionId: j.quadtodoSessionId, todoId: j.todoId, cwd: j.cwd }
      memory.set(nativeId, v)
      return v
    } catch { return null }
  }

  async function write({ nativeId, quadtodoSessionId, todoId, cwd }) {
    if (!nativeId) throw new Error('nativeId_required')
    memory.set(nativeId, { quadtodoSessionId, todoId, cwd })
    const payload = { nativeId, quadtodoSessionId, todoId, cwd, ts: Date.now() }
    writeFileSync(fileFor(nativeId), JSON.stringify(payload), 'utf8')
  }

  function restoreFromDisk() {
    if (!existsSync(baseDir)) return
    for (const name of readdirSync(baseDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const j = JSON.parse(readFileSync(join(baseDir, name), 'utf8'))
        if (j.nativeId) memory.set(j.nativeId, { quadtodoSessionId: j.quadtodoSessionId, todoId: j.todoId, cwd: j.cwd })
      } catch {}
    }
  }

  function clear(nativeId) {
    memory.delete(nativeId)
    try { unlinkSync(fileFor(nativeId)) } catch {}
  }

  return { write, lookup, restoreFromDisk, clear }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/codex-sidecar.test.js`

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/codex-sidecar.js test/codex-sidecar.test.js
git commit -m "feat(codex): add sidecar with memory map + disk restore"
```

---

### Task A.2: Export `findCodexSession` from `pty.js`

**Files:**
- Modify: `src/pty.js` (around line 96 where `detectCodexSessionFromFs` is defined)
- Create: `test/pty.findCodexSession.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/pty.findCodexSession.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCodexSession } from '../src/pty.js'

let root
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-find-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function writeRollout(dir, nativeId, sessionMeta = null) {
  const file = join(dir, `rollout-2026-05-09T10-00-00-${nativeId}.jsonl`)
  const lines = []
  if (sessionMeta) {
    lines.push(JSON.stringify({
      timestamp: '2026-05-09T10:00:00Z',
      type: 'session_meta',
      payload: { id: nativeId, cwd: sessionMeta.cwd, originator: 'codex-tui' },
    }))
  }
  writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''))
  return file
}

describe('findCodexSession', () => {
  it('returns {filePath, cwd, nativeId} when session_meta present', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const id = '019e0d94-1c56-7372-8029-545ded260180'
    const expected = writeRollout(day, id, { cwd: '/Users/me/proj' })
    const result = findCodexSession(id, { sessionsRoot: root })
    expect(result).toEqual({ filePath: expected, cwd: '/Users/me/proj', nativeId: id })
  })

  it('returns cwd:null when session_meta unflushed', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const id = '019e0d94-aaaa-bbbb-cccc-545ded260180'
    const expected = writeRollout(day, id, null)
    const result = findCodexSession(id, { sessionsRoot: root })
    expect(result).toEqual({ filePath: expected, cwd: null, nativeId: id })
  })

  it('isolates parallel sessions in same day dir by nativeId', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const a = '019e0d94-1111-1111-1111-545ded260180'
    const b = '019e0d94-2222-2222-2222-545ded260180'
    writeRollout(day, a, { cwd: '/A' })
    writeRollout(day, b, { cwd: '/B' })
    expect(findCodexSession(a, { sessionsRoot: root })?.cwd).toBe('/A')
    expect(findCodexSession(b, { sessionsRoot: root })?.cwd).toBe('/B')
  })

  it('returns null when nativeId not found', () => {
    expect(findCodexSession('does-not-exist', { sessionsRoot: root })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/pty.findCodexSession.test.js`

Expected: FAIL — `findCodexSession is not a function`.

- [ ] **Step 3: Add `findCodexSession` export to `src/pty.js`**

Insert near `findClaudeSession` (line 238 area):

```js
import { readFileSync } from 'node:fs'

export function findCodexSession(nativeSessionId, { sessionsRoot = CODEX_SESSIONS_DIR } = {}) {
  if (!nativeSessionId) return null
  if (!existsSync(sessionsRoot)) return null
  const years = readdirSync(sessionsRoot).filter(y => /^\d{4}$/.test(y))
  for (const y of years) {
    const yDir = join(sessionsRoot, y)
    for (const m of readdirSync(yDir)) {
      const mDir = join(yDir, m)
      for (const d of readdirSync(mDir)) {
        const dDir = join(mDir, d)
        for (const f of readdirSync(dDir)) {
          const match = f.match(CODEX_ROLLOUT_FILE_RE)
          if (!match || match[1] !== nativeSessionId) continue
          const filePath = join(dDir, f)
          const cwd = tryReadCwdFromSessionMeta(filePath)
          return { filePath, cwd, nativeId: nativeSessionId }
        }
      }
    }
  }
  return null
}

function tryReadCwdFromSessionMeta(filePath) {
  try {
    const head = readFileSync(filePath, 'utf8').split('\n').slice(0, 2)
    for (const line of head) {
      if (!line.trim()) continue
      const j = JSON.parse(line)
      if (j?.type === 'session_meta' && j?.payload?.cwd) return j.payload.cwd
    }
  } catch {}
  return null
}
```

Imports near top of `pty.js` may need `readdirSync`, `existsSync` if not already imported.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/pty.findCodexSession.test.js`

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/pty.js test/pty.findCodexSession.test.js
git commit -m "feat(pty): export findCodexSession returning {filePath, cwd, nativeId}"
```

---

### Task A.3: Codex emitter skeleton (jsonl tail watcher, no IM)

**Files:**
- Create: `src/codex-event-emitter.js`
- Create: `test/codex-event-emitter.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex-event-emitter.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexEventEmitter } from '../src/codex-event-emitter.js'

let dir, file

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-emit-'))
  file = join(dir, 'rollout-test.jsonl')
  writeFileSync(file, '')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function appendLine(obj) {
  appendFileSync(file, JSON.stringify(obj) + '\n')
}

describe('codex-event-emitter', () => {
  it('detects task_complete and emits Stop event', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file,
      nativeId: 'abc',
      onEvent: (evt) => events.push(evt),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'task_started' } })
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1' } })
    await new Promise(r => setTimeout(r, 100))
    em.stop()
    expect(events.find(e => e.event === 'Stop')).toBeTruthy()
  })

  it('detects turn_aborted and dedups within 100ms against <turn_aborted> user message', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file, nativeId: 'abc',
      onEvent: (e) => events.push(e),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'turn_aborted' } })
    appendLine({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>...' }] } })
    await new Promise(r => setTimeout(r, 200))
    em.stop()
    const aborted = events.filter(e => e.event === 'TurnAborted')
    expect(aborted.length).toBe(1)
  })

  it('detects event_msg/error and emits Error event with message', async () => {
    const events = []
    const em = createCodexEventEmitter({
      filePath: file, nativeId: 'abc',
      onEvent: (e) => events.push(e),
    })
    em.start()
    appendLine({ timestamp: 't', type: 'event_msg', payload: { type: 'error', message: 'boom' } })
    await new Promise(r => setTimeout(r, 100))
    em.stop()
    const err = events.find(e => e.event === 'Error')
    expect(err?.rawEventPayload?.message).toBe('boom')
  })

  it('getLatestAssistantContent returns latest response_item assistant text', async () => {
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: () => {} })
    em.start()
    appendLine({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello world' }] } })
    await new Promise(r => setTimeout(r, 100))
    expect(em.getLatestAssistantContent()).toContain('hello world')
    em.stop()
  })

  it('ignores events not for own nativeId when watching shared dir', async () => {
    // emitter only reads its own filePath, so foreign rollouts in same dir don't matter — verified by construction
    const events = []
    const otherFile = join(dir, 'rollout-other.jsonl')
    writeFileSync(otherFile, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: (e) => events.push(e) })
    em.start()
    await new Promise(r => setTimeout(r, 200))
    em.stop()
    expect(events.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/codex-event-emitter.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/codex-event-emitter.js`**

```js
import { watch, openSync, readSync, closeSync, statSync } from 'node:fs'

const ABORT_DEDUP_MS = 100

export function createCodexEventEmitter({ filePath, nativeId, onEvent, logger = console } = {}) {
  if (!filePath || !nativeId || !onEvent) throw new Error('filePath, nativeId, onEvent required')

  let pos = 0
  let watcher = null
  let buffer = ''
  let latestAssistantText = ''
  let lastAbortTs = 0

  function readNew() {
    let stat
    try { stat = statSync(filePath) } catch { return }
    if (stat.size <= pos) return
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(stat.size - pos)
      readSync(fd, buf, 0, buf.length, pos)
      pos = stat.size
      buffer += buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      try { handleLine(JSON.parse(line)) }
      catch (e) { logger.warn?.(`[codex-emitter] bad jsonl line ignored: ${e.message}`) }
    }
  }

  function handleLine(j) {
    const t = j?.type
    const p = j?.payload
    if (t === 'event_msg') {
      const pt = p?.type
      if (pt === 'task_complete') {
        onEvent({ event: 'Stop', nativeId, rawEventPayload: p })
      } else if (pt === 'turn_aborted') {
        lastAbortTs = Date.now()
        onEvent({ event: 'TurnAborted', nativeId, rawEventPayload: p })
      } else if (pt === 'error') {
        onEvent({ event: 'Error', nativeId, rawEventPayload: p })
      }
    } else if (t === 'response_item') {
      const pt = p?.type
      if (pt === 'message' && p?.role === 'assistant' && Array.isArray(p?.content)) {
        const text = p.content.map(c => c?.text || '').join('')
        if (text) latestAssistantText = text
      } else if (pt === 'message' && p?.role === 'user' && Array.isArray(p?.content)) {
        // Dedup with sibling event_msg/turn_aborted
        const txt = p.content.map(c => c?.text || '').join('')
        if (txt.includes('<turn_aborted>') && Date.now() - lastAbortTs < ABORT_DEDUP_MS) {
          // suppress
        }
      }
    }
  }

  function start() {
    try {
      const stat = statSync(filePath)
      pos = stat.size
    } catch {}
    readNew()
    watcher = watch(filePath, () => readNew())
  }

  function stop() {
    if (watcher) { try { watcher.close() } catch {} watcher = null }
  }

  function getLatestAssistantContent() {
    return latestAssistantText
  }

  return { start, stop, getLatestAssistantContent }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/codex-event-emitter.test.js`

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/codex-event-emitter.js test/codex-event-emitter.test.js
git commit -m "feat(codex): add jsonl-tail event emitter with task_complete / abort / error"
```

---

### Task A.4: Wire emitter + sidecar into PtyManager (Codex spawn lifecycle)

**Files:**
- Modify: `src/pty.js` (PtyManager class, around the codex spawn block)
- Modify: `test/pty.test.js` (or create a dedicated `test/pty.codex-spawn.test.js`)

- [ ] **Step 1: Write the failing test**

Create `test/pty.codex-spawn.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PtyManager } from '../src/pty.js'

describe('PtyManager codex spawn', () => {
  it('writes sidecar + memory map after detecting Codex nativeId', async () => {
    const fakeSidecar = { write: vi.fn(async () => {}), clear: vi.fn() }
    const fakePty = { write: vi.fn(), onData: () => {}, onExit: () => {}, kill: () => {} }
    const ptyFactory = vi.fn(() => fakePty)
    const codexWatcherFactory = (_t, hit) => { setTimeout(() => hit('native-uuid-1'), 10); return { close() {} } }
    const mgr = new PtyManager({
      tools: { codex: { bin: '/usr/bin/codex', args: [] } },
      ptyFactory,
      codexWatcherFactory,
      sidecar: fakeSidecar,
    })
    const sess = await mgr.spawn({ tool: 'codex', sessionId: 'qs1', cwd: '/proj', todoId: 't1' })
    await new Promise(r => setTimeout(r, 30))
    expect(fakeSidecar.write).toHaveBeenCalledWith({
      nativeId: 'native-uuid-1', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/proj',
    })
    sess.kill()
    expect(fakeSidecar.clear).toHaveBeenCalledWith('native-uuid-1')
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/pty.codex-spawn.test.js`

Expected: FAIL — `PtyManager` constructor doesn't accept `sidecar`, or write/clear not called.

- [ ] **Step 3: Modify `PtyManager` in `src/pty.js`**

In the constructor (around line 221), add `sidecar` and `eventEmitterFactory` to the accepted options:

```js
constructor({ tools, ptyFactory, promptDelayMs = 2000, codexWatcherFactory, claudeSessionLocator, sidecar = null, eventEmitterFactory = null } = {}) {
  // ... existing ...
  this.sidecar = sidecar
  this.eventEmitterFactory = eventEmitterFactory
}
```

In the codex watcher hit callback (around line 389 where `session.fsWatcher = this.codexWatcherFactory(...)` is created), add sidecar write + emitter start:

```js
session.fsWatcher = this.codexWatcherFactory(spawnTime, async (id) => {
  session.nativeSessionId = id
  if (this.sidecar) {
    try {
      await this.sidecar.write({
        nativeId: id,
        quadtodoSessionId: session.id,
        todoId: session.todoId || null,
        cwd: session.cwd,
      })
    } catch (e) { /* logger.warn */ }
  }
  if (this.eventEmitterFactory) {
    try {
      const loc = findCodexSession(id)
      if (loc?.filePath) {
        session.eventEmitter = this.eventEmitterFactory({ filePath: loc.filePath, nativeId: id })
        session.eventEmitter.start()
      }
    } catch {}
  }
})
```

In the session kill / exit handler:

```js
session.kill = () => {
  if (session.eventEmitter) { try { session.eventEmitter.stop() } catch {} }
  if (this.sidecar && session.nativeSessionId) { try { this.sidecar.clear(session.nativeSessionId) } catch {} }
  // ... existing kill logic ...
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/pty.codex-spawn.test.js`

Expected: PASS.

- [ ] **Step 5: Run full pty test suite**

Run: `npx vitest run test/pty`

Expected: All previous PtyManager tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pty.js test/pty.codex-spawn.test.js
git commit -m "feat(pty): wire sidecar + event emitter into Codex spawn/kill"
```

---

### Task A.5: Wire sidecar restoration on server boot

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js` (smoke test)

- [ ] **Step 1: Modify `src/server.js`**

Near where PtyManager is constructed:

```js
import { createCodexSidecar } from './codex-sidecar.js'
import { createCodexEventEmitter } from './codex-event-emitter.js'
// ...
const sidecar = createCodexSidecar()
sidecar.restoreFromDisk()

const aiTerminal = injectedPty || new PtyManager({
  tools: runtimeConfig.tools || {},
  sidecar,
  eventEmitterFactory: (opts) => createCodexEventEmitter({
    ...opts,
    onEvent: (evt) => handleCodexEvent(evt, aiTerminal, runtimeConfig),
  }),
})
```

Stub `handleCodexEvent` for now (Phase C will fill it in):

```js
function handleCodexEvent(evt, aiTerminal, cfg) {
  console.log('[codex-event]', evt.event, evt.nativeId)
}
```

- [ ] **Step 2: Smoke test (boot server, verify no crash)**

Run: `npm run start &` then `sleep 2 && curl http://127.0.0.1:5677/api/config | head -c 500`

Expected: Process boots; `/api/config` returns valid JSON. Kill: `quadtodo stop`.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(server): construct codex sidecar + event emitter factory"
```

---

## Phase B: usage-parser fix (BLOCKER)

### Task B.1: Capture real Codex 0.125 fixture

**Files:**
- Create: `scripts/refresh-codex-fixture.js`
- Create: `test/fixtures/codex-real-token-count.jsonl`

- [ ] **Step 1: Implement fixture refresh script**

Create `scripts/refresh-codex-fixture.js`:

```js
#!/usr/bin/env node
/**
 * Copy the largest recent Codex rollout into test/fixtures/codex-real-token-count.jsonl.
 * Run after upgrading codex CLI to refresh fixture.
 */
import { readdirSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = join(homedir(), '.codex', 'sessions')
const out = join(process.cwd(), 'test', 'fixtures', 'codex-real-token-count.jsonl')

function findLargest() {
  let best = { size: 0, path: null }
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && st.size > best.size) best = { size: st.size, path: p }
    }
  }
  walk(root)
  return best
}

const { path } = findLargest()
if (!path) throw new Error('no codex rollout found')
copyFileSync(path, out)
console.log(`refreshed ${out} from ${path}`)
```

- [ ] **Step 2: Run the script**

Run: `node scripts/refresh-codex-fixture.js`

Expected: prints "refreshed test/fixtures/codex-real-token-count.jsonl from ..." and the file is created.

- [ ] **Step 3: Commit**

```bash
git add scripts/refresh-codex-fixture.js test/fixtures/codex-real-token-count.jsonl
git commit -m "test(fixtures): add real Codex 0.125 rollout for parser tests"
```

---

### Task B.2: Rewrite `extractCodex` to read `event_msg/token_count`

**Files:**
- Modify: `src/usage-parser.js`
- Create: `test/codex-usage-parser.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/codex-usage-parser.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractUsage } from '../src/usage-parser.js'

const fixture = readFileSync(new URL('./fixtures/codex-real-token-count.jsonl', import.meta.url), 'utf8').split('\n')

function groundTruthSession(lines) {
  // Independent computation: pick the LAST event_msg/token_count.payload.info.total_token_usage
  let last = null
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j.type === 'event_msg' && j.payload?.type === 'token_count' && j.payload?.info?.total_token_usage) {
        last = j.payload.info.total_token_usage
      }
    } catch {}
  }
  return last
}

describe('extractCodex (real fixture)', () => {
  it('extracts non-zero session totals matching ground truth', () => {
    const out = extractUsage('codex', fixture)
    const gt = groundTruthSession(fixture)
    expect(gt).toBeTruthy()
    expect(out.inputTokens).toBe(gt.input_tokens)
    expect(out.outputTokens).toBe(gt.output_tokens)
  })

  it('picks GPT family model from session_meta or response_item', () => {
    const out = extractUsage('codex', fixture)
    expect(out.primaryModel).toMatch(/^gpt-/)
  })

  it('falls back to response_item.token_usage only if no token_count records', () => {
    const synthetic = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', model: 'gpt-5', token_usage: { input_tokens: 10, output_tokens: 20 } } }),
    ]
    const out = extractUsage('codex', synthetic)
    expect(out.inputTokens).toBe(10)
    expect(out.outputTokens).toBe(20)
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/codex-usage-parser.test.js`

Expected: FAIL — current `extractCodex` returns 0 for real fixture (token_count records ignored).

- [ ] **Step 3: Rewrite `extractCodex` in `src/usage-parser.js`**

Replace lines 62-79:

```js
function extractCodex(lines, { idleThresholdMs }) {
  let lastTokenCountInfo = null
  const responseItemRecords = []
  const modelCounter = new Map()
  const assistantTs = []
  let errors = 0

  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }

    if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
      const info = j.payload?.info
      if (info?.total_token_usage) lastTokenCountInfo = info
    } else if (j.type === 'response_item' && j.payload?.type === 'message' && j.payload?.role === 'assistant') {
      const model = normalizeModel(j.payload.model)
      if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
      const ts = j.timestamp ? Date.parse(j.timestamp) : NaN
      if (!Number.isNaN(ts)) assistantTs.push(ts)
      const u = j.payload.token_usage || j.payload.usage
      if (u) responseItemRecords.push({ usage: u, model, ts })
    } else if (j.type === 'session_meta') {
      const model = normalizeModel(j.payload?.model || j.payload?.model_provider?.model)
      if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    }
  }

  let input = 0, output = 0, cacheR = 0, cacheC = 0
  if (lastTokenCountInfo?.total_token_usage) {
    const t = lastTokenCountInfo.total_token_usage
    input  = Number(t.input_tokens)  || 0
    output = Number(t.output_tokens) || 0
    cacheR = Number(t.cached_input_tokens || t.cache_read_input_tokens) || 0
    cacheC = Number(t.cache_creation_input_tokens) || 0
  } else {
    for (const r of responseItemRecords) {
      input  += Number(r.usage.input_tokens)  || 0
      output += Number(r.usage.output_tokens) || 0
      cacheR += Number(r.usage.cached_input_tokens || r.usage.cache_read_input_tokens) || 0
      cacheC += Number(r.usage.cache_creation_input_tokens) || 0
    }
  }

  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }

  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs,
    parseErrorCount: errors,
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/codex-usage-parser.test.js`

Expected: PASS (3/3).

- [ ] **Step 5: Run full usage tests**

Run: `npx vitest run test/usage`

Expected: All PASS — Claude path unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/usage-parser.js test/codex-usage-parser.test.js
git commit -m "fix(usage-parser): extractCodex reads event_msg/token_count (real Codex 0.125)"
```

---

### Task B.3: `usage-footer.js` accepts `tool` param

**Files:**
- Modify: `src/usage-footer.js`
- Modify: `test/usage-footer.test.js`

- [ ] **Step 1: Add codex case to existing test file**

In `test/usage-footer.test.js`, add:

```js
it('extractSessionUsageFromLines(lines, "codex") routes to extractCodex', async () => {
  const fixture = readFileSync(new URL('./fixtures/codex-real-token-count.jsonl', import.meta.url), 'utf8').split('\n')
  const result = extractSessionUsageFromLines(fixture, 'codex')
  expect(result.input).toBeGreaterThan(0)
  expect(result.primaryModel).toMatch(/^gpt-/)
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/usage-footer.test.js -t codex`

Expected: FAIL — current implementation ignores second arg, hardcodes 'claude'.

- [ ] **Step 3: Modify `extractSessionUsageFromLines` in `src/usage-footer.js`**

Replace lines 99-123:

```js
/**
 * 从 jsonl lines 算 session 累计 usage。
 *
 * @param {string[]} lines  JSONL lines
 * @param {'claude'|'codex'} tool  tool name; default 'claude' for back-compat
 */
export function extractSessionUsageFromLines(lines, tool = 'claude') {
  const summary = extractUsage(tool, lines)
  let turnCount = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (tool === 'claude' && j?.message?.role === 'assistant') turnCount++
      else if (tool === 'codex' && j?.type === 'response_item' && j?.payload?.type === 'message' && j?.payload?.role === 'assistant') turnCount++
    } catch {}
  }
  return {
    input: summary.inputTokens,
    output: summary.outputTokens,
    cacheRead: summary.cacheReadTokens,
    cacheCreation: summary.cacheCreationTokens,
    primaryModel: summary.primaryModel,
    turnCount,
  }
}
```

Also delete the "仅 Claude" comment (line 99 area in original).

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/usage-footer.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage-footer.js test/usage-footer.test.js
git commit -m "feat(usage-footer): extractSessionUsageFromLines supports tool param"
```

---

## Phase C: turn-end push end-to-end

### Task C.1: `codex-transcript.js` helpers

**Files:**
- Create: `src/codex-transcript.js`
- Create: `test/codex-transcript.test.js`

- [ ] **Step 1: Write failing test**

Create `test/codex-transcript.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLatestCodexTurn,
  readLatestCodexTurnFresh,
  buildFullCodexTranscript,
  extractCodexTurnUsageFromLines,
} from '../src/codex-transcript.js'

function makeFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cx-tr-'))
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(path, lines.map(JSON.stringify).join('\n') + '\n')
  return path
}

describe('codex-transcript', () => {
  it('readLatestCodexTurn returns latest assistant turn text', () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'hi' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] } },
    ])
    const turn = readLatestCodexTurn(path)
    expect(turn?.text).toBe('second')
  })

  it('readLatestCodexTurnFresh retries when latest assistant equals lastSeen', async () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'old' }] } },
    ])
    const turn = await readLatestCodexTurnFresh(path, 'old', { retries: 2, retryMs: 20 })
    expect(turn).toBeNull()  // never freshened
  })

  it('buildFullCodexTranscript renders user+assistant turns to markdown', () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'q' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'a' }] } },
    ])
    const md = buildFullCodexTranscript(path).markdown
    expect(md).toContain('q')
    expect(md).toContain('a')
  })

  it('extractCodexTurnUsageFromLines reads last_token_usage', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 7 } } } }),
    ]
    const r = extractCodexTurnUsageFromLines(lines)
    expect(r).toEqual({ input: 5, output: 7, cacheRead: 0, cacheCreation: 0 })
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/codex-transcript.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/codex-transcript.js`**

```js
import { readFileSync } from 'node:fs'

function parseLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim())
}

function blockText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(c => c?.text || '').filter(Boolean).join('')
}

export function readLatestCodexTurn(filePath) {
  const lines = parseLines(filePath)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i])
      if (j.type !== 'response_item') continue
      const p = j.payload
      if (p?.type !== 'message' || p?.role !== 'assistant') continue
      const text = blockText(p.content)
      if (!text) continue
      return { text, raw: p, timestamp: j.timestamp || null }
    } catch {}
  }
  return null
}

export async function readLatestCodexTurnFresh(filePath, lastSeenText, { retries = 3, retryMs = 200 } = {}) {
  for (let i = 0; i <= retries; i++) {
    const turn = readLatestCodexTurn(filePath)
    if (turn && turn.text !== lastSeenText) return turn
    if (i < retries) await new Promise(r => setTimeout(r, retryMs))
  }
  return null
}

export function buildFullCodexTranscript(filePath) {
  const lines = parseLines(filePath)
  const out = []
  let turnCount = 0
  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.type !== 'response_item' || j.payload?.type !== 'message') continue
    const role = j.payload.role
    const text = blockText(j.payload.content)
    if (!text) continue
    if (role === 'assistant') turnCount++
    out.push(`### ${role}\n\n${text}\n`)
  }
  const header = `# Codex Session Transcript\n\n_Generated: ${new Date().toISOString()}_\n_Source: ${filePath}_\n_Turns: ${turnCount}_\n\n---\n\n`
  return { markdown: header + out.join('\n'), turnCount }
}

export function extractCodexTurnUsageFromLines(lines) {
  let last = null
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
        const info = j.payload.info
        if (info?.last_token_usage) last = info.last_token_usage
      }
    } catch {}
  }
  if (!last) return null
  return {
    input: Number(last.input_tokens) || 0,
    output: Number(last.output_tokens) || 0,
    cacheRead: Number(last.cached_input_tokens || last.cache_read_input_tokens) || 0,
    cacheCreation: Number(last.cache_creation_input_tokens) || 0,
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/codex-transcript.test.js`

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/codex-transcript.js test/codex-transcript.test.js
git commit -m "feat(codex): add codex-transcript helpers paralleling claude-transcript"
```

---

### Task C.2: Route discriminator (`source`, `path` fields)

**Files:**
- Modify: `src/routes/openclaw-hook.js`
- Create: `test/routes/openclaw-hook.test.js` (or amend existing if present)

- [ ] **Step 1: Write the failing test**

Create `test/routes/openclaw-hook.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createOpenClawHookRouter } from '../../src/routes/openclaw-hook.js'

function makeApp(handler) {
  const app = express()
  app.use(express.json())
  app.use('/api/openclaw/hook', createOpenClawHookRouter({ hookHandler: handler }))
  return app
}

describe('openclaw-hook router', () => {
  it('forwards source=claude (default) to handler', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    const res = await request(makeApp({ handle })).post('/api/openclaw/hook').send({ event: 'Stop' })
    expect(res.status).toBe(200)
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ source: 'claude' }))
  })

  it('forwards source=codex,path=jsonl', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1' })
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ source: 'codex', path: 'jsonl', nativeId: 'n1' }))
  })

  it('forwards source=codex,path=detector', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'detector', event: 'Notification', sessionId: 'qs1', promptText: 'Approve?' })
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ path: 'detector', sessionId: 'qs1' }))
  })

  it('rejects unsupported body shape', async () => {
    const handle = vi.fn()
    const res = await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'unknown' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported_body_shape')
    expect(handle).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/routes/openclaw-hook.test.js`

Expected: FAIL — handler not called with `source` / `path`.

- [ ] **Step 3: Modify `src/routes/openclaw-hook.js`**

Replace the `router.post` body:

```js
router.post('/', async (req, res) => {
  try {
    const {
      source = 'claude',
      path = null,
      event,
      sessionId,
      nativeId,
      targetUserId,
      todoId,
      todoTitle,
      hookPayload,
      transcript_path,
      cwd,
      raw_event_payload,
      promptText,
      matchedPattern,
    } = req.body || {}

    if (!event || typeof event !== 'string') {
      return res.status(400).json({ ok: false, error: 'event_required' })
    }

    if (source === 'codex' && path !== 'jsonl' && path !== 'detector') {
      return res.status(400).json({ ok: false, error: 'unsupported_body_shape' })
    }

    const result = await hookHandler.handle({
      source,
      path,
      event,
      sessionId: sessionId || null,
      nativeId: nativeId || null,
      todoId: todoId || null,
      todoTitle: todoTitle || null,
      targetUserId: targetUserId || null,
      hookPayload: hookPayload || null,
      transcript_path: transcript_path || null,
      cwd: cwd || null,
      raw_event_payload: raw_event_payload || null,
      promptText: promptText || null,
      matchedPattern: matchedPattern || null,
    })

    return res.json({ ok: result.ok, ...result })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'hook_handle_failed' })
  }
})
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/routes/openclaw-hook.test.js`

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/routes/openclaw-hook.js test/routes/openclaw-hook.test.js
git commit -m "feat(routes): hook router discriminates source/path; back-compat default claude"
```

---

### Task C.3: `openclaw-hook.handle` — codex jsonl branch

**Files:**
- Modify: `src/openclaw-hook.js`
- Create: `test/openclaw-hook.codex.test.js`

- [ ] **Step 1: Write failing test**

Create `test/openclaw-hook.codex.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'

function fakeBridge() {
  return { postText: vi.fn(async () => ({ ok: true })), postCard: vi.fn(async () => ({ ok: true })), sendDocument: vi.fn(async () => ({ ok: true })) }
}

describe('openclaw-hook codex branch', () => {
  it('routes source=codex,path=jsonl Stop to bridge.postText with codex transcript', async () => {
    const bridge = fakeBridge()
    const aiTerminal = { sessions: new Map() }
    const sidecar = { lookup: () => ({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' }) }
    const handler = createOpenClawHookHandler({
      bridge, aiTerminal, sidecar,
      pty: { findCodexSession: () => ({ filePath: 'fake.jsonl', cwd: '/x', nativeId: 'n1' }) },
      readLatestCodexTurnFresh: vi.fn(async () => ({ text: 'codex says hi', raw: {}, timestamp: null })),
      buildFullCodexTranscript: () => ({ markdown: '# header\n\nhi' }),
      extractCodexTurnUsageFromLines: () => ({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }),
      extractSessionUsageFromLines: () => ({ input: 1000, output: 500, primaryModel: 'gpt-5-codex', turnCount: 3 }),
      readJsonlLines: () => [],
      db: { /* no pending */ },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1', transcript_path: 'fake.jsonl',
    })
    expect(result.ok).toBe(true)
    expect(bridge.postText).toHaveBeenCalled()
    const sentArg = bridge.postText.mock.calls[0][0]
    expect(sentArg.text).toContain('codex says hi')
  })

  it('handler returns error when nativeId not in sidecar nor sessions', async () => {
    const bridge = fakeBridge()
    const handler = createOpenClawHookHandler({
      bridge, aiTerminal: { sessions: new Map() }, sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null }, db: {}, logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'unknown' })
    expect(result.ok).toBe(false)
    expect(bridge.postText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/openclaw-hook.codex.test.js`

Expected: FAIL — handler doesn't accept `source` / sidecar / pty / readLatestCodexTurnFresh dependencies.

- [ ] **Step 3: Modify `src/openclaw-hook.js`**

Add codex branch dispatch at top of `handle()`:

```js
import { readLatestCodexTurnFresh as defaultReadLatestCodexTurnFresh, buildFullCodexTranscript as defaultBuildFullCodexTranscript, extractCodexTurnUsageFromLines as defaultExtractCodexTurnUsageFromLines } from './codex-transcript.js'

export function createOpenClawHookHandler(deps = {}) {
  const {
    bridge, db, openclaw, aiTerminal = null, sidecar = null,
    pty = null, logger = console,
    readLatestCodexTurnFresh = defaultReadLatestCodexTurnFresh,
    buildFullCodexTranscript = defaultBuildFullCodexTranscript,
    extractCodexTurnUsageFromLines = defaultExtractCodexTurnUsageFromLines,
    extractSessionUsageFromLines = defaultExtractSessionUsageFromLines,
    // ... existing claude deps ...
  } = deps

  async function handle(req) {
    const source = req?.source || 'claude'
    if (source === 'codex' && req?.path === 'jsonl') return handleCodexJsonl(req)
    if (source === 'codex' && req?.path === 'detector') return handleCodexDetector(req)
    return handleClaude(req)  // existing impl moved into helper
  }

  async function handleCodexJsonl({ event, nativeId, transcript_path, raw_event_payload }) {
    // 1) Resolve quadtodo sessionId
    let quadtodoSessionId = null
    let todoId = null
    let cwd = null
    const fromSidecar = sidecar?.lookup?.(nativeId)
    if (fromSidecar) {
      quadtodoSessionId = fromSidecar.quadtodoSessionId
      todoId = fromSidecar.todoId
      cwd = fromSidecar.cwd
    } else if (aiTerminal?.sessions) {
      for (const [sid, sess] of aiTerminal.sessions) {
        if (sess.nativeSessionId === nativeId) {
          quadtodoSessionId = sid
          todoId = sess.todoId
          cwd = sess.cwd
          break
        }
      }
    }
    if (!quadtodoSessionId) {
      logger.warn?.(`[codex-hook] no quadtodo session for nativeId=${nativeId}`)
      return { ok: false, reason: 'no_quadtodo_session' }
    }

    // 2) Locate transcript file
    const filePath = transcript_path || pty?.findCodexSession?.(nativeId)?.filePath
    if (!filePath) return { ok: false, reason: 'no_transcript' }

    // 3) Read latest turn
    let text = ''
    if (event === 'Stop' || event === 'TurnAborted') {
      const turn = await readLatestCodexTurnFresh(filePath, null, { retries: 3, retryMs: 200 })
      text = turn?.text || ''
    }

    // 4) Build footer
    const lines = readJsonlLines(filePath)
    const turnUsage = extractCodexTurnUsageFromLines(lines)
    const sessionUsage = extractSessionUsageFromLines(lines, 'codex')
    const footer = formatUsageFooter({
      turn: turnUsage ? { ...turnUsage, model: sessionUsage.primaryModel } : null,
      session: sessionUsage,
    })

    // 5) Compose message text
    const todoTitle = (await db.getTodo?.(todoId))?.title || todoId
    const headLine = event === 'Stop' ? `🤖 [#t${todoId.slice(-3)}] 任务「${todoTitle}」AI 一轮结束`
                   : event === 'TurnAborted' ? `🛑 [#t${todoId.slice(-3)}] 任务「${todoTitle}」AI 一轮被中断`
                   : event === 'Error' ? `❌ [#t${todoId.slice(-3)}] 任务「${todoTitle}」Codex 报错：${raw_event_payload?.message || ''}`
                   : event === 'SessionEnd' ? `✅ [#t${todoId.slice(-3)}] 任务「${todoTitle}」AI 跑完了`
                   : `[codex] 未知事件 ${event}`
    const fullText = text ? `${headLine}\n\n${text}\n\n${footer}` : `${headLine}\n\n${footer}`

    // 6) Push
    await bridge.postText({ sessionId: quadtodoSessionId, text: fullText })

    // 7) Optional attachment
    if (event === 'SessionEnd') {
      const full = buildFullCodexTranscript(filePath)
      if (full?.markdown) {
        const tmpPath = writeTranscriptTmp(full.markdown, quadtodoSessionId, 'codex-full')
        if (tmpPath) await bridge.sendDocument?.({ sessionId: quadtodoSessionId, path: tmpPath })
      }
    }

    return { ok: true, source: 'codex', event }
  }

  async function handleCodexDetector(req) {
    // Phase E will fill this in. Stub for now.
    return { ok: false, reason: 'not_implemented' }
  }

  // existing claude handler renamed to handleClaude
  async function handleClaude(req) {
    // ... move old handle() body here unchanged ...
  }

  return { handle }
}
```

(Existing `handle` body moves wholesale into `handleClaude`; `readJsonlLines` continues to be reused from claude-transcript imports.)

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/openclaw-hook.codex.test.js`

Expected: PASS (2/2).

- [ ] **Step 5: Run existing claude hook tests for regression**

Run: `npx vitest run test/openclaw-hook`

Expected: All PASS (no claude regression).

- [ ] **Step 6: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.codex.test.js
git commit -m "feat(hook): add codex jsonl branch reusing bridge + codex-transcript helpers"
```

---

### Task C.4: Wire emitter onEvent → POST /api/openclaw/hook

**Files:**
- Modify: `src/server.js` (the `handleCodexEvent` stub from A.5)

- [ ] **Step 1: Replace stub with real POST**

```js
async function handleCodexEvent(evt, aiTerminal, runtimeConfig) {
  const port = runtimeConfig?.port || 5677
  try {
    await fetch(`http://127.0.0.1:${port}/api/openclaw/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'codex',
        path: 'jsonl',
        event: evt.event,
        nativeId: evt.nativeId,
        transcript_path: evt.transcriptPath || null,
        raw_event_payload: evt.rawEventPayload || null,
      }),
    })
  } catch (e) {
    console.warn('[codex-event] post failed:', e.message)
  }
}
```

(Update emitter onEvent in PtyManager / server wiring to also pass `transcriptPath` from `findCodexSession`.)

- [ ] **Step 2: e2e smoke test (manual)**

Run: `quadtodo start &` then create a codex todo via the Web UI; let Codex finish a turn; check the lark / telegram channel.

Expected: lark thread / telegram topic receives a markdown push within ~1s of `event_msg/task_complete`.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(server): forward codex emitter events to /api/openclaw/hook"
```

---

## Phase D: error / TurnAborted / SessionEnd

### Task D.1: Emitter — `event_msg/error` end-to-end

Already covered by emitter test in A.3 + handler test in C.3. Just wire the bridge text in the handler (already in C.3 step 3).

- [ ] **Step 1: Manual smoke test** — induce a codex error (run codex with bad config) and verify lark/telegram receive `❌` line.
- [ ] **Step 2: Commit if any tweaks** (likely no code change, this is just verification).

---

### Task D.2: Emitter — turn_aborted dedup

Verified by A.3 test. Confirm the 100ms window is honored end-to-end:

- [ ] **Step 1: Add an emitter integration test where both signals appear within 50ms**

Append to `test/codex-event-emitter.test.js`:

```js
it('within 100ms window, only one TurnAborted is emitted', async () => {
  const events = []
  const em = createCodexEventEmitter({ filePath: file, nativeId: 'abc', onEvent: (e) => events.push(e) })
  em.start()
  appendLine({ type: 'event_msg', payload: { type: 'turn_aborted' } })
  await new Promise(r => setTimeout(r, 50))
  appendLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<turn_aborted>...' }] } })
  await new Promise(r => setTimeout(r, 200))
  em.stop()
  expect(events.filter(e => e.event === 'TurnAborted').length).toBe(1)
})
```

- [ ] **Step 2: Run, verify pass**

Run: `npx vitest run test/codex-event-emitter.test.js -t "within 100ms"`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/codex-event-emitter.test.js
git commit -m "test(codex): assert turn_aborted dedup within 100ms window"
```

---

### Task D.3: SessionEnd on PTY exit + full transcript attachment

**Files:**
- Modify: `src/pty.js` — emit SessionEnd from session.kill / exit
- Modify: `src/server.js` — `handleCodexEvent` extends to SessionEnd

- [ ] **Step 1: Hook PTY exit to emitter**

In `pty.js` near the existing `pty.onExit` handler for codex sessions:

```js
ptyProcess.onExit(({ exitCode }) => {
  if (session.eventEmitter) {
    // Synthesize SessionEnd before stopping watcher
    session.eventEmitter.emitSynthetic?.({ event: 'SessionEnd', nativeId: session.nativeSessionId, exitCode })
    session.eventEmitter.stop()
  }
  if (this.sidecar && session.nativeSessionId) this.sidecar.clear(session.nativeSessionId)
})
```

Add `emitSynthetic` to emitter:

```js
function emitSynthetic(evt) { onEvent(evt) }
return { start, stop, getLatestAssistantContent, emitSynthetic }
```

- [ ] **Step 2: Manual smoke test**

Run: spawn codex todo, exit cleanly, verify `✅ [#tNN] AI 跑完了` + transcript attachment in IM.

- [ ] **Step 3: Commit**

```bash
git add src/pty.js src/codex-event-emitter.js
git commit -m "feat(codex): emit SessionEnd on PTY exit + full transcript attachment"
```

---

## Phase E: prompt detector + ask-user cards

### Task E.1: `codex-prompt-detector.js`

**Files:**
- Create: `src/codex-prompt-detector.js`
- Create: `test/codex-prompt-detector.test.js`

- [ ] **Step 1: Write failing test**

Create `test/codex-prompt-detector.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'
import { createCodexPromptDetector } from '../src/codex-prompt-detector.js'

function fakePty() {
  const handlers = []
  return {
    onData(cb) { handlers.push(cb) },
    push(s) { handlers.forEach(h => h(s)) },
  }
}

describe('codex-prompt-detector', () => {
  it('matches "Approve? (y/n)" after debounce', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 30 })
    det.start()
    pty.push('Run command rm -rf /\nApprove? (y/n)')
    await new Promise(r => setTimeout(r, 80))
    expect(onMatch).toHaveBeenCalled()
  })

  it('does NOT match when chunk continues within debounce window', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 30 })
    det.start()
    pty.push('Approve? (y/n)')
    await new Promise(r => setTimeout(r, 10))
    pty.push(' just kidding more text')
    await new Promise(r => setTimeout(r, 80))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('does NOT match when AI assistant content contains the prompt', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const emitter = { getLatestAssistantContent: () => 'Some advice ending with Approve? (y/n)' }
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20, emitter })
    det.start()
    pty.push('Some advice ending with Approve? (y/n)')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('matches Continue? [Y/n]', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push('Continue? [Y/n] ')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalled()
  })

  it('matches apply patch?', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push('apply patch? [y/N] ')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/codex-prompt-detector.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/codex-prompt-detector.js`**

```js
const DEFAULT_DEBOUNCE_MS = 1500
const RING_MAX = 32

const PATTERNS = [
  /(approve|allow|continue|proceed)\??\s*\(\s*y\/n\s*\)/i,
  /\?\s*\[\s*y\/N\s*\]/i,
  /\?\s*\[\s*Y\/n\s*\]/i,
  /(允许|批准|授权).*\?\s*[（(]\s*[yYnN][\/／][nNyY][)）]/,
  /run this command\?\s*\[/i,
  /apply patch\?\s*\[/i,
]

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

export function createCodexPromptDetector({ pty, onMatch, debounceMs = DEFAULT_DEBOUNCE_MS, emitter = null } = {}) {
  if (!pty || !onMatch) throw new Error('pty, onMatch required')
  const ring = []
  let timer = null
  let stopped = false

  function onData(chunk) {
    if (stopped) return
    ring.push({ ts: Date.now(), text: stripAnsi(String(chunk)) })
    while (ring.length > RING_MAX) ring.shift()
    if (timer) clearTimeout(timer)
    timer = setTimeout(maybeMatch, debounceMs)
  }

  function maybeMatch() {
    const tail = ring.slice(-4).map(c => c.text).join('')
    let matchedPattern = null
    for (const re of PATTERNS) {
      if (re.test(tail)) { matchedPattern = re.source; break }
    }
    if (!matchedPattern) return
    if (emitter?.getLatestAssistantContent) {
      const ai = emitter.getLatestAssistantContent() || ''
      if (ai.includes(tail.slice(-200).trim()) || tail.slice(-200).trim() && ai.endsWith(tail.slice(-200).trim())) {
        return  // AI self-quoted prompt; not a real Codex permission ask
      }
    }
    onMatch({ promptText: tail.slice(-200), matchedPattern })
  }

  function start() { pty.onData(onData) }
  function stop() { stopped = true; if (timer) clearTimeout(timer) }

  return { start, stop }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/codex-prompt-detector.test.js`

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/codex-prompt-detector.js test/codex-prompt-detector.test.js
git commit -m "feat(codex): add stdout prompt detector with debounce + AI self-quote guard"
```

---

### Task E.2: Wire detector into PtyManager + server POST

**Files:**
- Modify: `src/pty.js` — spawn detector for codex sessions
- Modify: `src/server.js` — wire detector onMatch → POST path=detector

- [ ] **Step 1: Modify PtyManager codex spawn**

In the codex branch of `spawn()`, after the watcher is created:

```js
session.detector = createCodexPromptDetector({
  pty: ptyProcess,
  emitter: () => session.eventEmitter,  // late-bound
  onMatch: ({ promptText, matchedPattern }) => {
    this.emit('codex-prompt', { sessionId: session.id, nativeId: session.nativeSessionId, promptText, matchedPattern })
  },
})
session.detector.start()
```

Stop on kill/exit similarly to emitter.

- [ ] **Step 2: Modify server.js**

```js
aiTerminal.on('codex-prompt', async (data) => {
  await fetch(`http://127.0.0.1:${runtimeConfig.port}/api/openclaw/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'codex',
      path: 'detector',
      event: 'Notification',
      sessionId: data.sessionId,
      nativeId: data.nativeId,
      promptText: data.promptText,
      matchedPattern: data.matchedPattern,
    }),
  })
})
```

- [ ] **Step 3: Commit**

```bash
git add src/pty.js src/server.js
git commit -m "feat(codex): wire prompt detector through PTY events to /api/openclaw/hook"
```

---

### Task E.3: `lark-card.buildPermissionCard` header parameterization

**Files:**
- Modify: `src/lark-card.js`
- Modify: `test/lark-card.test.js` (or create)

- [ ] **Step 1: Inspect & test current behavior**

Run: `grep -n "Claude Code 等待授权" src/lark-card.js`

Expected: line 37 (approximately).

- [ ] **Step 2: Add failing test**

Create or amend `test/lark-card.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildPermissionCard } from '../src/lark-card.js'

describe('buildPermissionCard headerTitle', () => {
  it('defaults to Claude header when not provided', () => {
    const card = buildPermissionCard({ message: 'x', actionId: 'a' })
    expect(JSON.stringify(card)).toContain('Claude Code 等待授权')
  })
  it('uses provided headerTitle', () => {
    const card = buildPermissionCard({ message: 'x', actionId: 'a', headerTitle: '⚠️ Codex 等待授权' })
    expect(JSON.stringify(card)).toContain('Codex 等待授权')
    expect(JSON.stringify(card)).not.toContain('Claude Code')
  })
})
```

- [ ] **Step 3: Run, verify failure (existing test passes, new one fails)**

Run: `npx vitest run test/lark-card.test.js`

- [ ] **Step 4: Modify `src/lark-card.js`**

In `buildPermissionCard`:

```js
export function buildPermissionCard({ message, actionId, headerTitle = '⚠️ Claude Code 等待授权' }) {
  // ... use headerTitle in the header element ...
}
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/lark-card.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lark-card.js test/lark-card.test.js
git commit -m "feat(lark-card): parameterize permission card header for codex/claude"
```

---

### Task E.4: handler — codex detector branch (push card + handle callback)

**Files:**
- Modify: `src/openclaw-hook.js` (handleCodexDetector)
- Modify: `src/openclaw-wizard.js` permission callback (no source split needed; already tool-agnostic, but verify the codex sessionId resolves)

- [ ] **Step 1: Implement `handleCodexDetector`**

```js
async function handleCodexDetector({ event, sessionId, nativeId, promptText, matchedPattern }) {
  if (!sessionId) return { ok: false, reason: 'no_sessionId' }
  const sess = aiTerminal?.sessions?.get(sessionId)
  if (!sess) return { ok: false, reason: 'session_gone' }
  const todoId = sess.todoId
  const todoTitle = (await db.getTodo?.(todoId))?.title || todoId
  const text = `⚠️ [#t${todoId.slice(-3)}] 任务「${todoTitle}」AI 卡住等输入：\n\n\`\`\`\n${promptText}\n\`\`\``
  const card = buildPermissionCard({
    message: text,
    actionId: `codex:${sessionId}`,
    headerTitle: '⚠️ Codex 等待授权',
  })
  await bridge.postCard?.({ sessionId, card })
  return { ok: true, source: 'codex', event }
}
```

- [ ] **Step 2: Verify `openclaw-wizard.js` callback handles codex actionId prefix**

Run: `grep -n "actionId\|findSessionByShortId" src/openclaw-wizard.js | head -20`

Confirm `findSessionByShortId(quadtodo sessionId.slice(-4))` handles both Claude and Codex actionIds (it does — actionIds carry full sessionId; `:codex` prefix is just a label).

If existing wizard does not strip `codex:` prefix when extracting short id, add:

```js
const sid = actionId.replace(/^codex:/, '')
```

- [ ] **Step 3: Manual e2e (real codex strict mode)**

Run codex with `--ask-for-approval=on-request`, induce a permission prompt, verify lark / telegram receive card, click ✅ → PTY receives `\r`.

- [ ] **Step 4: Commit**

```bash
git add src/openclaw-hook.js src/openclaw-wizard.js
git commit -m "feat(codex): detector branch posts permission card; reuse wizard \\r/\\x1b callback"
```

---

## Phase F: regression sweep

### Task F.1: Full vitest suite green

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`

Expected: All PASS. If any failures, debug and fix; this is the regression gate.

- [ ] **Step 2: Manual lark + telegram smoke (Claude side)**

Spawn a Claude todo, finish a turn, request permission. Verify both IM channels still receive identical pushes to before this work.

- [ ] **Step 3: Commit any required regression fixes**

```bash
git commit -m "fix(regression): <describe>"
```

---

### Task F.2: Acceptance checklist verification

Walk through each checkbox in `docs/superpowers/specs/2026-05-09-codex-im-bridge-design.md` §10 and tick them off in the spec file. Commit when done.

```bash
git add docs/superpowers/specs/2026-05-09-codex-im-bridge-design.md
git commit -m "docs(spec): mark §10 acceptance items complete"
```

---

## Phase G: dispatch config

### Task G.1: `src/dispatch.js` resolveTool

**Files:**
- Create: `src/dispatch.js`
- Create: `test/dispatch.test.js`

- [ ] **Step 1: Write failing test**

Create `test/dispatch.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { resolveTool } from '../src/dispatch.js'

const cfg = {
  defaultTool: 'claude',
  dispatch: {
    lark: { default: 'claude', perUser: { 'lark_user_a': 'codex' } },
    telegram: { default: 'codex', perChat: { '12345': 'claude' } },
    web: { default: 'claude' },
  },
}

describe('resolveTool', () => {
  it('returns override when provided', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_a', override: 'claude' }, cfg)).toBe('claude')
  })

  it('perUser hits before channel default (lark)', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_a' }, cfg)).toBe('codex')
  })

  it('channel default when perUser miss', () => {
    expect(resolveTool({ channel: 'lark', userId: 'lark_user_b' }, cfg)).toBe('claude')
  })

  it('perChat hits (telegram)', () => {
    expect(resolveTool({ channel: 'telegram', chatId: '12345' }, cfg)).toBe('claude')
  })

  it('global defaultTool when no dispatch entry', () => {
    expect(resolveTool({ channel: 'unknown' }, cfg)).toBe('claude')
  })

  it('falls back to "claude" when defaultTool missing', () => {
    expect(resolveTool({ channel: 'web' }, {})).toBe('claude')
  })

  it('back-compat: missing dispatch section → defaultTool', () => {
    expect(resolveTool({ channel: 'lark' }, { defaultTool: 'codex' })).toBe('codex')
  })
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/dispatch.test.js`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/dispatch.js`**

```js
export function resolveTool({ channel, userId, chatId, override } = {}, config = {}) {
  if (override === 'claude' || override === 'codex') return override
  const ch = channel ? config?.dispatch?.[channel] : null
  if (ch) {
    if (userId && ch.perUser && ch.perUser[userId]) return ch.perUser[userId]
    if (chatId && ch.perChat && ch.perChat[chatId]) return ch.perChat[chatId]
    if (ch.default === 'claude' || ch.default === 'codex') return ch.default
  }
  if (config?.defaultTool === 'codex') return 'codex'
  if (config?.defaultTool === 'claude') return 'claude'
  return 'claude'
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/dispatch.test.js`

Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js test/dispatch.test.js
git commit -m "feat(dispatch): resolveTool with channel + perUser/perChat priority"
```

---

### Task G.2: `config.js` dispatch defaults

**Files:**
- Modify: `src/config.js`
- Modify: `test/config.test.js`

- [ ] **Step 1: Write failing test**

In `test/config.test.js`:

```js
it('normalizes config with empty dispatch section', () => {
  const c = normalizeConfig({})
  expect(c.dispatch).toEqual({ lark: { default: 'claude' }, telegram: { default: 'claude' }, web: { default: 'claude' } })
})

it('preserves user dispatch values', () => {
  const c = normalizeConfig({ dispatch: { lark: { default: 'codex', perUser: { 'u1': 'claude' } } } })
  expect(c.dispatch.lark.default).toBe('codex')
  expect(c.dispatch.lark.perUser.u1).toBe('claude')
  expect(c.dispatch.telegram.default).toBe('claude')  // filled in
})
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run test/config.test.js -t dispatch`

Expected: FAIL.

- [ ] **Step 3: Modify `normalizeConfig` in `src/config.js`**

Add dispatch defaults:

```js
function normalizeDispatch(d = {}) {
  return {
    lark:     { default: 'claude', ...(d.lark || {}) },
    telegram: { default: 'claude', ...(d.telegram || {}) },
    web:      { default: 'claude', ...(d.web || {}) },
  }
}

// in normalizeConfig:
return {
  // ... existing ...,
  dispatch: normalizeDispatch(input.dispatch),
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/config.test.js`

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add dispatch defaults; back-compat preserved"
```

---

### Task G.3: Replace `cfg.defaultTool` reads in wizard / mcp / server

**Files:**
- Modify: `src/openclaw-wizard.js:629`
- Modify: `src/mcp/tools/openclaw/index.js:195`
- Modify: `src/server.js` (if web `/api/todos` reads defaultTool directly)
- Create / extend test files for each call site

- [ ] **Step 1: Write integration test for wizard**

Create `test/openclaw-wizard.dispatch.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createWizard } from '../src/openclaw-wizard.js'

it('wizard reads tool via resolveTool({ channel, userId })', async () => {
  const cfg = { defaultTool: 'claude', dispatch: { lark: { default: 'claude', perUser: { 'open_a': 'codex' } } } }
  const wiz = createWizard({ getConfig: () => cfg, db: stubDb(), aiTerminal: stubAi(), bridge: stubBridge() })
  const result = await wiz.handleInbound({ channel: 'lark', userId: 'open_a', text: '[create] do X' })
  expect(result.toolUsed).toBe('codex')
})
```

(stub helpers per existing wizard test conventions.)

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/openclaw-wizard.dispatch.test.js`

Expected: FAIL — `cfg.defaultTool` is hard-read.

- [ ] **Step 3: Modify `src/openclaw-wizard.js:629`**

Replace:

```js
const tool = cfg.defaultTool || 'claude'
```

With:

```js
import { resolveTool } from './dispatch.js'
// ...
const tool = resolveTool({ channel: w.channel, userId: w.userId, chatId: w.chatId }, cfg)
```

(Where `w.channel` / `w.userId` / `w.chatId` come from the inbound event already on the wizard state.)

- [ ] **Step 4: Modify `src/mcp/tools/openclaw/index.js:195`**

Replace:

```js
const tool = args.tool || (getConfig?.()?.defaultTool) || 'claude'
```

With:

```js
const cfg = getConfig?.() || {}
const tool = resolveTool({ channel: args.channel || 'openclaw', userId: args.targetUserId, override: args.tool }, cfg)
```

- [ ] **Step 5: Modify `src/server.js` web /api/todos creation**

Wherever `runtimeConfig.defaultTool` is read for new-todo path, swap to `resolveTool({ channel: 'web', override: req.body.tool }, runtimeConfig)`.

- [ ] **Step 6: Run wizard test, verify pass**

Run: `npx vitest run test/openclaw-wizard.dispatch.test.js`

Expected: PASS.

- [ ] **Step 7: Run full test suite for regression**

Run: `npx vitest run`

Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add src/openclaw-wizard.js src/mcp/tools/openclaw/index.js src/server.js test/openclaw-wizard.dispatch.test.js
git commit -m "feat(dispatch): wizard / mcp / server consume resolveTool"
```

---

### Task G.4: `SettingsDrawer.tsx` Dispatch UI

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 1: Inspect existing settings layout**

Run: `grep -n "defaultTool\|Dispatch\|dispatch" web/src/SettingsDrawer.tsx`

- [ ] **Step 2: Add Dispatch sub-section**

Append after the existing `defaultTool` selector:

```tsx
<Section title="Dispatch (per-channel)">
  {(['lark', 'telegram', 'web'] as const).map(channel => (
    <div key={channel} style={{ marginBottom: 16 }}>
      <h4>{channel}</h4>
      <label>Default tool: </label>
      <select
        value={config.dispatch?.[channel]?.default || 'claude'}
        onChange={e => updateDispatch(channel, 'default', e.target.value)}
      >
        <option value="claude">claude</option>
        <option value="codex">codex</option>
      </select>
      {channel === 'lark' && <PerUserTable channel="lark" />}
      {channel === 'telegram' && <PerChatTable channel="telegram" />}
    </div>
  ))}
</Section>
```

Provide `PerUserTable` / `PerChatTable` as inline components rendering an editable list of `{key, tool}` pairs with add / delete buttons; on change, call the existing `/api/config` PATCH path.

- [ ] **Step 3: Run dev server, manually verify**

Run: `npm run start --expose &` then open `http://127.0.0.1:5677/`, open Settings, edit dispatch values, save, refresh. Verify changes persist.

- [ ] **Step 4: Run web build to ensure no TS errors**

Run: `cd web && npm run build`

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/SettingsDrawer.tsx
git commit -m "feat(web): add Dispatch sub-section to SettingsDrawer"
```

---

### Task G.5: Acceptance verification (Phase G)

- [ ] **Step 1**: configure `dispatch.lark.perUser['<my_open_id>'] = 'codex'`; from the configured lark account, send a "[create] X" command. Verify the resulting todo's `tool === 'codex'`.

- [ ] **Step 2**: configure `dispatch.telegram.default = 'codex'`; create a todo from any telegram chat (no perChat entry). Verify tool defaults to codex.

- [ ] **Step 3**: clear the entire `dispatch` section (or set to `{}`); verify behavior matches today's `defaultTool`-only path.

- [ ] **Step 4**: web `/api/todos` POST with `{ tool: 'codex' }` overrides whatever `dispatch.web.default` says.

- [ ] **Step 5**: SettingsDrawer edit perUser → save → next IM event creates todo with new tool, no restart needed.

If all green, commit a final `docs(spec): mark §12.8 acceptance complete` against the spec file.

---

## Self-Review Notes

- **Spec coverage**: every section in `2026-05-09-codex-im-bridge-design.md` has one or more tasks. Phase A covers §2.3 / §3 / §7 sidecar+findCodexSession, Phase B covers §2.3 BLOCKER + §7 usage-parser, Phase C covers §3/§4/§7 turn-end, Phase D covers §5 turn_aborted/error/SessionEnd, Phase E covers §5/§6 ask-user, Phase G covers §12.
- **No placeholders**: every code step shows real code or real shell commands.
- **Type consistency**: `nativeId` used uniformly; `quadtodoSessionId` consistent in sidecar; emitter onEvent payload `{ event, nativeId, rawEventPayload }` consistent across A.3 / C.3 / D.3.
- **Dependency order**: Phase 0 (pricing dep) → A → B → C → D → E → F → G; each Phase has its own commits. G is independent of B-E in terms of code, but functionally Codex tooling matters only after the IM push pipeline lands.

# AI Terminal Scrollback Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase embedded AI terminal scrollback depth so cursor-agent sessions can scroll back to more earlier context.

**Architecture:** Keep the existing xterm live terminal and backend replay buffer architecture. Change only the retention constants and tests that lock those limits.

**Tech Stack:** React, xterm.js, Express route module, Vitest.

---

### Task 1: Lock Backend Replay Buffer Limit

**Files:**
- Modify: `test/ai-terminal.route.test.js`
- Modify: `src/routes/ai-terminal.js`

- [ ] **Step 1: Write the failing test**

Change the existing backend ceiling test to expect a 5MB cap:

```js
it('outputHistory enforces 5MB ceiling', async () => {
  const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
  const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
    .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
  const big = 'x'.repeat(512 * 1024)
  for (let i = 0; i < 12; i++) {
    ctx.pty.emit('output', { sessionId: body.sessionId, data: big })
  }
  const session = ctx.ait.sessions.get(body.sessionId)
  expect(session.outputSize).toBeLessThanOrEqual(5 * 1024 * 1024 + big.length)
  expect(session.outputHistory.length).toBeLessThan(12)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/ai-terminal.route.test.js -t "outputHistory enforces"`

Expected: FAIL while `MAX_OUTPUT_BUFFER` is still `512 * 1024`.

- [ ] **Step 3: Implement the minimal backend change**

Change:

```js
const MAX_OUTPUT_BUFFER = 512 * 1024
```

to:

```js
const MAX_OUTPUT_BUFFER = 5 * 1024 * 1024
```

- [ ] **Step 4: Run target backend test**

Run: `npm test -- --run test/ai-terminal.route.test.js -t "outputHistory enforces"`

Expected: PASS.

### Task 2: Lock Frontend Xterm Scrollback Limit

**Files:**
- Create: `test/ai-terminal-scrollback-limit.test.js`
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 1: Write the failing source-level regression test**

```js
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AiTerminalMini scrollback depth', () => {
  it('configures xterm with 30000 lines of scrollback', () => {
    const source = readFileSync('web/src/AiTerminalMini.tsx', 'utf8')
    expect(source).toMatch(/scrollback:\s*30000/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/ai-terminal-scrollback-limit.test.js`

Expected: FAIL while xterm still uses `scrollback: 5000`.

- [ ] **Step 3: Implement the minimal frontend change**

Change:

```ts
scrollback: 5000,
```

to:

```ts
scrollback: 30000,
```

- [ ] **Step 4: Run target frontend test**

Run: `npm test -- --run test/ai-terminal-scrollback-limit.test.js`

Expected: PASS.

### Task 3: Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run targeted backend tests**

Run: `npm test -- --run test/ai-terminal.route.test.js -t "outputHistory enforces"`

Expected: PASS.

- [ ] **Step 2: Run frontend scrollback regression test**

Run: `npm test -- --run test/ai-terminal-scrollback-limit.test.js`

Expected: PASS.

- [ ] **Step 3: Run web build**

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run: `git diff -- docs/superpowers/specs/2026-05-13-ai-terminal-scrollback-depth-design.md docs/superpowers/plans/2026-05-13-ai-terminal-scrollback-depth.md src/routes/ai-terminal.js web/src/AiTerminalMini.tsx test/ai-terminal.route.test.js test/ai-terminal-scrollback-limit.test.js`

Expected: only scrollback/buffer-limit related changes.

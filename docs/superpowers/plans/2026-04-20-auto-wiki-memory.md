# Auto Wiki Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-only "沉淀到记忆" feature that lets users spawn `claude -p` in a local `~/.quadtodo/wiki/` markdown wiki to incrementally maintain topic/project pages from completed todos.

**Architecture:** New `src/wiki/` module with pure helpers (redact, sources builder, guide constant) + a `createWikiService` that runs init / runOnce. New `src/routes/wiki.js`, two new SQLite tables (`wiki_runs`, `wiki_todo_coverage`), plus a new `WikiDrawer.tsx` and a per-todo 「沉淀到记忆」button. No cron, no auto-run.

**Tech Stack:** Node 20 + ESM, better-sqlite3, express, vitest (backend). React 18 + antd + react-markdown + remark-gfm (frontend — all already installed).

---

## Reference: Spec

See `docs/superpowers/specs/2026-04-20-auto-wiki-memory-design.md` for full design. Short summary:

- Wiki dir = `~/.quadtodo/wiki/` (its own git repo)
- Two trigger entries: todo detail 「沉淀到记忆」button (single todo) + Wiki 抽屉 「沉淀选中」(batch checkboxes)
- Flow: gather todo + transcripts → write `sources/*.md` → spawn `claude -p` cwd=wikiDir → git commit
- Optional dry-run button (generate sources only, skip LLM)

---

## File Structure

### Backend — new
```
src/wiki/
├── redact.js          # redact(text: string): string — regex-based API key redaction
├── guide.js           # WIKI_GUIDE_CONTENT string constant (no logic)
├── sources.js         # buildSourceMarkdown({...}) → string (pure; takes injected loaders)
├── index.js           # createWikiService({ db, logDir, wikiDir, getTools, maxTailTurns, timeoutMs, execClaude? })
                       # exports: init(), runOnce({ todoIds, dryRun }), status(), pending()
src/routes/wiki.js     # express router (status, pending, tree, file, run, init, runs)

test/
├── wiki.redact.test.js
├── wiki.sources.test.js
├── wiki.service.test.js
├── wiki.route.test.js
└── db.wiki.test.js
```

### Backend — modified
- `src/db.js` — add `wiki_runs` + `wiki_todo_coverage` schema and helper functions
- `src/config.js` — add `wiki` section to `defaultConfig()` / `normalizeConfig()`
- `src/server.js` — wire wiki router, invoke `service.init()` on startup (non-blocking)

### Frontend — new
```
web/src/
├── WikiDrawer.tsx     # main wiki browser + pending list + action buttons
├── WikiDrawer.css     # minor styling for layout
```

### Frontend — modified
- `web/src/api.ts` — add wiki API functions + types
- `web/src/TodoManage.tsx` — top-bar 🧠 button opens WikiDrawer; todo detail「沉淀到记忆」button

---

## Commit convention

All commits use the project's existing style (short Chinese/English hybrid prefix). Each task lists its commit message.

---

## Task 1: `redact.js` — API key redaction utility

**Files:**
- Create: `src/wiki/redact.js`
- Test: `test/wiki.redact.test.js`

- [ ] **Step 1: Write failing test**

Create `test/wiki.redact.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { redact } from '../src/wiki/redact.js'

describe('wiki/redact', () => {
  it('returns same string when nothing to redact', () => {
    expect(redact('hello world')).toBe('hello world')
  })

  it('redacts Anthropic/OpenAI sk- keys', () => {
    const out = redact('use sk-ant-api03-abcdefghij1234567890XYZ0 for auth')
    expect(out).not.toContain('sk-ant-api03-abcdefghij1234567890XYZ0')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts AWS access key id', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]')
  })

  it('redacts github personal token', () => {
    expect(redact('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567')).toContain('[REDACTED]')
  })

  it('redacts Google API key', () => {
    expect(redact('AIzaSyA-abcdefghijklmnopqrstuvwxyz12345')).toContain('[REDACTED]')
  })

  it('redacts env-style SECRET_KEY= line', () => {
    const out = redact('SECRET_KEY=super-secret-value-123')
    expect(out).toMatch(/SECRET_KEY\s*=\s*\[REDACTED\]/)
  })

  it('redacts api_key: "..." inline', () => {
    const out = redact('api_key: "abc123xyz789"')
    expect(out).not.toContain('abc123xyz789')
    expect(out).toContain('[REDACTED]')
  })

  it('does not redact ordinary text that happens to contain "key"', () => {
    expect(redact('the key to success is persistence')).toBe('the key to success is persistence')
  })

  it('handles non-string input safely', () => {
    expect(redact(null)).toBe('')
    expect(redact(undefined)).toBe('')
    expect(redact(42)).toBe('42')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run test/wiki.redact.test.js`
Expected: FAIL — "Cannot find module '../src/wiki/redact.js'"

- [ ] **Step 3: Create `src/wiki/redact.js`**

```js
// API key / secret redaction for wiki source markdown.
// Catches obvious leak patterns; not a security guarantee — user should never
// paste real production secrets into todo descriptions, this is a seatbelt.

const PATTERNS = [
  // Anthropic / OpenAI sk- style keys
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens (personal, oauth, server-to-server, refresh)
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_\-]{30,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,
]

// env-style SECRET_KEY=..., API_TOKEN=..., etc. Replace value but keep key.
const ENV_LINE = /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))\s*=\s*\S+/g

// inline key: "value", api_key: 'value', password = "value"
const INLINE_KV = /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*['"]?[^\s'",}]{6,}/gi

export function redact(input) {
  if (input == null) return ''
  let s = typeof input === 'string' ? input : String(input)
  for (const re of PATTERNS) s = s.replace(re, '[REDACTED]')
  s = s.replace(ENV_LINE, (_, key) => `${key}=[REDACTED]`)
  s = s.replace(INLINE_KV, (match, key) => {
    const sep = match.includes(':') ? ':' : '='
    return `${key}${sep} [REDACTED]`
  })
  return s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/wiki.redact.test.js`
Expected: PASS, all 9 tests green

- [ ] **Step 5: Commit**

```bash
git add src/wiki/redact.js test/wiki.redact.test.js
git commit -m "feat(wiki): add redact() for API key / secret scrubbing"
```

---

## Task 2: `guide.js` — WIKI_GUIDE.md content constant

**Files:**
- Create: `src/wiki/guide.js`

- [ ] **Step 1: Create `src/wiki/guide.js`**

```js
// Rendered verbatim into ~/.quadtodo/wiki/WIKI_GUIDE.md on first init.
// Users are free to edit the file afterwards; we only write it if it's missing.
export const WIKI_GUIDE_CONTENT = `# Wiki 维护指南（LLM 读这个）

## 你的职责
每次被调用时，\`sources/\` 下会有一批新的 todo 素材文件。你的任务是：读完新 sources，把其中可沉淀的知识融入 \`topics/\` / \`projects/\` / \`index.md\`，让 wiki 保持有条理、可检索。

## 硬规则
- \`sources/*.md\` 是输入，**永远不要修改它们**
- 页面命名：kebab-case，例如 \`topics/cloudbase-cloud-function-deploy.md\`
- 页面间用相对 markdown 链接互相引用（例如 \`[CloudBase 部署](../topics/cloudbase-cloud-function-deploy.md)\`）
- 每个页面专注一个主题，不要让单页膨胀到难读

## 决策流程
对每个新 source，问自己：
1. 这条 todo 揭示了什么**可复用**的知识？（踩过的坑、通用模式、项目结构摘要、外部工具配置）
2. 对应 topic 页是否已经存在？
   - 存在 → 在合适的段落追加；合并类似条目
   - 不存在 → 新建 topic 页
3. 这条 todo 有 workDir（项目路径）吗？
   - 有 → 同时更新 \`projects/<projectName>.md\`：项目概述、该项目沉淀过的主要知识点列表（带链接指向 topic）
4. 如果这条 todo 只是琐碎任务（比如"写邮件"、"买东西"），可以跳过，不强行产出内容

## 更新 index.md
\`index.md\` 是顶级目录。每次都确保：
- 列出 topics/ 下所有页面（按主题分类）
- 列出 projects/ 下所有页面
- 最近 7 天的变更可以用一个 "Recent" 段落点出

## 追加 log.md
最后一步：往 log.md 追加一个 \`## YYYY-MM-DD HH:MM\` 段落，写清楚你这次改了/新增了哪些页，每条一句话。

## 语言
中文优先，代码/命令/路径保留原文。
`

export const EMPTY_INDEX_CONTENT = `# Wiki Index

还没有沉淀任何主题。去 quadtodo 里点「沉淀到记忆」按钮开始。
`

export const EMPTY_LOG_CONTENT = `# Wiki 更新日志

`
```

- [ ] **Step 2: Commit**

```bash
git add src/wiki/guide.js
git commit -m "feat(wiki): add WIKI_GUIDE.md content constants"
```

---

## Task 3: `sources.js` — build source markdown from a todo

**Files:**
- Create: `src/wiki/sources.js`
- Test: `test/wiki.sources.test.js`

This is a pure function that takes already-loaded data + injected functions (for transcript loading and summarization). Callers at a higher layer do the I/O. This keeps the unit testable without touching the filesystem.

- [ ] **Step 1: Write failing test**

Create `test/wiki.sources.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildSourceMarkdown, sourceFileName } from '../src/wiki/sources.js'

function makeTodo(overrides = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    parentId: null,
    title: '修 CloudBase 云函数部署',
    description: '部署时报 403，怀疑是权限配置',
    quadrant: 1,
    status: 'done',
    dueDate: null,
    workDir: '/Users/foo/project',
    createdAt: Date.parse('2026-04-18T09:00:00Z'),
    updatedAt: Date.parse('2026-04-20T12:30:00Z'),
    aiSessions: [],
    ...overrides,
  }
}

describe('wiki/sources', () => {
  it('sourceFileName uses YYYY-MM-DD prefix and shortened todo id', () => {
    const todo = makeTodo()
    const name = sourceFileName(todo, Date.parse('2026-04-20T12:30:00Z'))
    expect(name).toBe('2026-04-20-aaaaaaaa.md')
  })

  it('produces markdown with frontmatter + title + description', async () => {
    const todo = makeTodo()
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'empty', turns: [] }),
      summarize: async () => '',
      redact: (s) => s,
      maxTailTurns: 20,
    })
    expect(md).toMatch(/^---\ntodoId: aaaaaaaa/m)
    expect(md).toMatch(/title: 修 CloudBase 云函数部署/)
    expect(md).toMatch(/^# 修 CloudBase 云函数部署$/m)
    expect(md).toMatch(/## 描述\n部署时报 403/)
  })

  it('includes comments section when present', async () => {
    const todo = makeTodo()
    const comments = [
      { id: 'c1', todoId: todo.id, content: '怀疑是 role 没加', createdAt: Date.parse('2026-04-19T10:00:00Z') },
      { id: 'c2', todoId: todo.id, content: '加了就好了', createdAt: Date.parse('2026-04-19T11:00:00Z') },
    ]
    const md = await buildSourceMarkdown({
      todo, comments,
      loadTranscript: () => ({ source: 'empty', turns: [] }),
      summarize: async () => '',
      redact: (s) => s,
      maxTailTurns: 20,
    })
    expect(md).toMatch(/## 评论（2）/)
    expect(md).toMatch(/怀疑是 role 没加/)
    expect(md).toMatch(/加了就好了/)
  })

  it('includes session summary and last N turns', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1',
        tool: 'claude',
        nativeSessionId: 'native-1',
        cwd: '/x',
        status: 'done',
        startedAt: Date.parse('2026-04-20T10:00:00Z'),
        completedAt: Date.parse('2026-04-20T11:00:00Z'),
        prompt: '',
      }],
    })
    const turns = []
    for (let i = 0; i < 30; i++) {
      turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` })
    }
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns }),
      summarize: async () => '摘要：修好了',
      redact: (s) => s,
      maxTailTurns: 5,
    })
    expect(md).toMatch(/### Session 1 — claude/)
    expect(md).toMatch(/\*\*摘要\*\*：摘要：修好了/)
    expect(md).toMatch(/turn 29/)
    expect(md).not.toMatch(/turn 0\b/)
    expect(md).not.toMatch(/turn 24\b/)
  })

  it('applies redact to transcript content', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1', tool: 'claude', nativeSessionId: 'n1',
        cwd: '/x', status: 'done',
        startedAt: 0, completedAt: 0, prompt: '',
      }],
    })
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns: [
        { role: 'user', content: 'my key is sk-abcdefghij1234567890XYZ' },
      ]}),
      summarize: async () => '',
      redact: (s) => s.replace(/sk-\w+/g, '[REDACTED]'),
      maxTailTurns: 5,
    })
    expect(md).toContain('[REDACTED]')
    expect(md).not.toContain('sk-abcdefghij1234567890XYZ')
  })

  it('truncates output at maxBytes and notes truncation', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1', tool: 'claude', nativeSessionId: 'n1',
        cwd: '/x', status: 'done',
        startedAt: 0, completedAt: 0, prompt: '',
      }],
    })
    const big = 'x'.repeat(200_000)
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns: [{ role: 'user', content: big }] }),
      summarize: async () => 'ok',
      redact: (s) => s,
      maxTailTurns: 5,
      maxBytes: 10_000,
    })
    expect(md.length).toBeLessThan(11_000)
    expect(md).toMatch(/截断/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiki.sources.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/wiki/sources.js`**

```js
function pad(n) { return String(n).padStart(2, '0') }

function toDate(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toDateTime(ts) {
  const d = new Date(ts)
  return `${toDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortId(id) {
  return String(id).slice(0, 8)
}

function hoursBetween(startMs, endMs) {
  if (!startMs || !endMs) return null
  return +((endMs - startMs) / 3_600_000).toFixed(2)
}

export function sourceFileName(todo, nowMs = Date.now()) {
  return `${toDate(nowMs)}-${shortId(todo.id)}.md`
}

function renderTurn(turn) {
  const roleMap = {
    user: '用户',
    assistant: 'AI',
    thinking: '思考',
    tool_use: `工具调用(${turn.toolName || ''})`,
    tool_result: '工具输出',
    raw: '原始',
  }
  const role = roleMap[turn.role] || turn.role
  const content = String(turn.content || '').slice(0, 2000)
  return `【${role}】${content}`
}

export async function buildSourceMarkdown({
  todo,
  comments = [],
  loadTranscript,
  summarize,
  redact,
  maxTailTurns = 20,
  maxBytes = 128 * 1024,
  now = Date.now(),
}) {
  const lines = []

  const duration = hoursBetween(todo.createdAt, todo.updatedAt)
  lines.push('---')
  lines.push(`todoId: ${todo.id}`)
  lines.push(`title: ${todo.title.replace(/\n/g, ' ')}`)
  lines.push(`quadrant: ${todo.quadrant}`)
  lines.push(`workDir: ${todo.workDir || '-'}`)
  lines.push(`createdAt: ${new Date(todo.createdAt).toISOString()}`)
  lines.push(`completedAt: ${new Date(todo.updatedAt).toISOString()}`)
  if (duration != null) lines.push(`durationHours: ${duration}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${todo.title}`)
  lines.push('')

  if (todo.description && todo.description.trim()) {
    lines.push('## 描述')
    lines.push(redact(todo.description))
    lines.push('')
  }

  if (comments.length) {
    lines.push(`## 评论（${comments.length}）`)
    for (const c of comments) {
      lines.push(`- [${toDateTime(c.createdAt)}] ${redact(c.content)}`)
    }
    lines.push('')
  }

  const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
  if (sessions.length) {
    lines.push('## AI 会话')
    let idx = 0
    for (const s of sessions) {
      idx += 1
      const parsed = loadTranscript(s) || { source: 'empty', turns: [] }
      const turns = Array.isArray(parsed.turns) ? parsed.turns : []
      const completed = s.completedAt ? toDateTime(s.completedAt) : '-'
      lines.push(`### Session ${idx} — ${s.tool}（${turns.length} 轮，完成时间 ${completed}）`)

      let summary = ''
      if (turns.length) {
        try {
          summary = await summarize(turns, { tool: s.tool })
        } catch (e) {
          summary = `（摘要失败：${e.message}）`
        }
      }
      if (summary) {
        lines.push(`**摘要**：${redact(summary)}`)
        lines.push('')
      }

      const tail = turns.slice(-maxTailTurns)
      if (tail.length) {
        lines.push(`**最后 ${tail.length} 轮原文**：`)
        lines.push('')
        for (const t of tail) {
          lines.push(redact(renderTurn(t)))
          lines.push('')
        }
      }
    }
  }

  let out = lines.join('\n')
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    const head = out.slice(0, maxBytes - 200)
    out = `${head}\n\n...（内容过长已截断，原始 transcript 保留在本地）...\n`
  }
  return out
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/wiki.sources.test.js`
Expected: PASS, all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add src/wiki/sources.js test/wiki.sources.test.js
git commit -m "feat(wiki): buildSourceMarkdown for per-todo source file"
```

---

## Task 4: DB schema — `wiki_runs` + `wiki_todo_coverage`

**Files:**
- Modify: `src/db.js` (add schema and helper functions)
- Test: `test/db.wiki.test.js`

- [ ] **Step 1: Write failing test**

Create `test/db.wiki.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'

describe('db wiki tables', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('createWikiRun + completeWikiRun roundtrip', () => {
    const run = db.createWikiRun({ todoCount: 3, dryRun: 0 })
    expect(run.id).toBeGreaterThan(0)
    expect(run.started_at).toBeGreaterThan(0)
    expect(run.completed_at).toBeNull()

    db.completeWikiRun(run.id, { exitCode: 0, note: 'ok' })
    const [row] = db.listWikiRuns({ limit: 10 })
    expect(row.id).toBe(run.id)
    expect(row.exit_code).toBe(0)
    expect(row.completed_at).toBeGreaterThan(0)
    expect(row.note).toBe('ok')
  })

  it('failWikiRun sets error', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.failWikiRun(run.id, 'claude spawn failed')
    const [row] = db.listWikiRuns({ limit: 10 })
    expect(row.error).toBe('claude spawn failed')
    expect(row.completed_at).toBeGreaterThan(0)
  })

  it('upsertCoverage stores llm_applied flag', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 1 })
    db.upsertWikiCoverage(run.id, 'todo-xyz', 'sources/2026-04-20-todo-xyz.md', false)
    const coverage = db.listCoverageForTodo('todo-xyz')
    expect(coverage).toHaveLength(1)
    expect(coverage[0].llm_applied).toBe(0)
    expect(coverage[0].source_path).toBe('sources/2026-04-20-todo-xyz.md')
  })

  it('markCoverageApplied updates llm_applied=1', () => {
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.upsertWikiCoverage(run.id, 'todo-xyz', 'sources/a.md', false)
    db.markCoverageApplied(run.id)
    const coverage = db.listCoverageForTodo('todo-xyz')
    expect(coverage[0].llm_applied).toBe(1)
  })

  it('listUnappliedDoneTodos returns done todos without llm_applied=1 coverage', () => {
    const t1 = db.createTodo({ title: 'a', quadrant: 1, status: 'done' })
    const t2 = db.createTodo({ title: 'b', quadrant: 1, status: 'done' })
    const t3 = db.createTodo({ title: 'c', quadrant: 1, status: 'todo' })  // not done
    const run = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.upsertWikiCoverage(run.id, t2.id, 'sources/b.md', true)

    const pending = db.listUnappliedDoneTodos()
    const ids = pending.map(t => t.id)
    expect(ids).toContain(t1.id)
    expect(ids).not.toContain(t2.id)
    expect(ids).not.toContain(t3.id)
  })

  it('findOrphanWikiRuns returns runs with null completed_at', () => {
    const a = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    const b = db.createWikiRun({ todoCount: 1, dryRun: 0 })
    db.completeWikiRun(b.id, { exitCode: 0, note: '' })

    const orphans = db.findOrphanWikiRuns()
    const ids = orphans.map(r => r.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(b.id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db.wiki.test.js`
Expected: FAIL — `db.createWikiRun is not a function`

- [ ] **Step 3: Add schema + helpers to `src/db.js`**

In `src/db.js`, extend the `SCHEMA` constant to append:

```js
CREATE TABLE IF NOT EXISTS wiki_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  todo_count    INTEGER NOT NULL DEFAULT 0,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  exit_code     INTEGER,
  error         TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_wiki_runs_started ON wiki_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS wiki_todo_coverage (
  wiki_run_id   INTEGER NOT NULL,
  todo_id       TEXT NOT NULL,
  source_path   TEXT,
  llm_applied   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wiki_run_id, todo_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_cov_todo ON wiki_todo_coverage(todo_id, llm_applied);
```

Inside `openDb()`, after the existing `ptStmts` section, add:

```js
const wikiStmts = {
  insertRun: db.prepare(`
    INSERT INTO wiki_runs (started_at, todo_count, dry_run)
    VALUES (?, ?, ?)
  `),
  completeRun: db.prepare(`
    UPDATE wiki_runs SET completed_at = ?, exit_code = ?, note = ?
    WHERE id = ?
  `),
  failRun: db.prepare(`
    UPDATE wiki_runs SET completed_at = ?, exit_code = ?, error = ?
    WHERE id = ?
  `),
  listRuns: db.prepare(`
    SELECT * FROM wiki_runs ORDER BY started_at DESC LIMIT ?
  `),
  orphanRuns: db.prepare(`
    SELECT * FROM wiki_runs WHERE completed_at IS NULL
  `),
  upsertCoverage: db.prepare(`
    INSERT INTO wiki_todo_coverage (wiki_run_id, todo_id, source_path, llm_applied)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(wiki_run_id, todo_id) DO UPDATE SET
      source_path = excluded.source_path,
      llm_applied = excluded.llm_applied
  `),
  markApplied: db.prepare(`
    UPDATE wiki_todo_coverage SET llm_applied = 1 WHERE wiki_run_id = ?
  `),
  coverageForTodo: db.prepare(`
    SELECT * FROM wiki_todo_coverage WHERE todo_id = ? ORDER BY wiki_run_id DESC
  `),
  unappliedDoneTodos: db.prepare(`
    SELECT t.* FROM todos t
    WHERE t.status = 'done'
      AND NOT EXISTS (
        SELECT 1 FROM wiki_todo_coverage c
        WHERE c.todo_id = t.id AND c.llm_applied = 1
      )
    ORDER BY t.updated_at DESC
  `),
}

function createWikiRun({ todoCount = 0, dryRun = 0 } = {}) {
  const now = Date.now()
  const info = wikiStmts.insertRun.run(now, Number(todoCount) || 0, dryRun ? 1 : 0)
  return { id: info.lastInsertRowid, started_at: now, completed_at: null }
}
function completeWikiRun(id, { exitCode = 0, note = '' } = {}) {
  wikiStmts.completeRun.run(Date.now(), exitCode, note || '', id)
}
function failWikiRun(id, errorMsg) {
  wikiStmts.failRun.run(Date.now(), -1, String(errorMsg || 'unknown'), id)
}
function listWikiRuns({ limit = 20 } = {}) {
  return wikiStmts.listRuns.all(Math.max(1, Math.min(200, limit)))
}
function findOrphanWikiRuns() {
  return wikiStmts.orphanRuns.all()
}
function upsertWikiCoverage(runId, todoId, sourcePath, llmApplied) {
  wikiStmts.upsertCoverage.run(runId, todoId, sourcePath || null, llmApplied ? 1 : 0)
}
function markCoverageApplied(runId) {
  wikiStmts.markApplied.run(runId)
}
function listCoverageForTodo(todoId) {
  return wikiStmts.coverageForTodo.all(todoId)
}
function listUnappliedDoneTodos() {
  return wikiStmts.unappliedDoneTodos.all().map(rowToTodo)
}
```

Then in the final `return { raw: db, ... }` object, add these properties (alongside existing ones):

```js
createWikiRun,
completeWikiRun,
failWikiRun,
listWikiRuns,
findOrphanWikiRuns,
upsertWikiCoverage,
markCoverageApplied,
listCoverageForTodo,
listUnappliedDoneTodos,
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/db.wiki.test.js`
Expected: PASS, all 6 tests green

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `npm test`
Expected: all previously passing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db.wiki.test.js
git commit -m "feat(db): add wiki_runs + wiki_todo_coverage tables"
```

---

## Task 5: `config.js` — add `wiki` section defaults

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js` (extend)

- [ ] **Step 1: Extend test**

Open `test/config.test.js` and append:

```js
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('config wiki defaults', () => {
  it('loadConfig returns wiki section with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qt-wiki-'))
    const cfg = loadConfig({ rootDir: dir })
    expect(cfg.wiki).toBeTruthy()
    expect(cfg.wiki.wikiDir).toBeTruthy()
    expect(cfg.wiki.maxTailTurns).toBe(20)
    expect(cfg.wiki.tool).toBe('claude')
    expect(cfg.wiki.timeoutMs).toBe(600_000)
    expect(cfg.wiki.redact).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js -t 'wiki'`
Expected: FAIL — `expect(cfg.wiki).toBeTruthy()` assertion fails

- [ ] **Step 3: Update `src/config.js`**

At the top, import `join` if not already, and `homedir`. (`join` is already imported.)

Extend `defaultConfig()`'s return:

```js
function defaultConfig() {
  return {
    port: 5677,
    defaultTool: "claude",
    defaultCwd: homedir(),
    tools: resolveToolsConfig(),
    webhook: { ...DEFAULT_WEBHOOK_CONFIG },
    pricing: cloneDefaultPricing(),
    stats: { idleThresholdMs: 120_000 },
    wiki: {
      wikiDir: join(homedir(), ".quadtodo", "wiki"),
      maxTailTurns: 20,
      tool: "claude",
      timeoutMs: 600_000,
      redact: true,
    },
  }
}
```

Extend `normalizeConfig()`'s return to include:

```js
    wiki: {
      ...defaults.wiki,
      ...(cfg.wiki || {}),
    },
```

(Insert before the closing `}` of the returned object.)

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/config.test.js`
Expected: all config tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add wiki section defaults"
```

---

## Task 6: `src/wiki/index.js` — `init()` for wiki directory

**Files:**
- Create: `src/wiki/index.js`
- Test: `test/wiki.service.test.js`

Service exports `createWikiService({ db, logDir, wikiDir, getTools, maxTailTurns, timeoutMs, redactEnabled, execClaude })`. `execClaude` is injected for tests (defaults to a real spawn).

- [ ] **Step 1: Write failing test**

Create `test/wiki.service.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb } from '../src/db.js'
import { createWikiService } from '../src/wiki/index.js'

function tmp() { return mkdtempSync(join(tmpdir(), 'qt-wiki-svc-')) }

describe('wiki service init', () => {
  let root, wikiDir, db
  beforeEach(() => {
    root = tmp()
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('init creates wiki dir, writes GUIDE + index + log, runs git init', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const res = await svc.init()
    expect(res.state).toBe('ready')
    expect(existsSync(join(wikiDir, 'WIKI_GUIDE.md'))).toBe(true)
    expect(existsSync(join(wikiDir, 'index.md'))).toBe(true)
    expect(existsSync(join(wikiDir, 'log.md'))).toBe(true)
    expect(existsSync(join(wikiDir, '.git'))).toBe(true)
    expect(readFileSync(join(wikiDir, 'WIKI_GUIDE.md'), 'utf8')).toMatch(/Wiki 维护指南/)
  })

  it('init is idempotent when already git-initialized', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const a = await svc.init()
    const b = await svc.init()
    expect(a.state).toBe('ready')
    expect(b.state).toBe('ready')
  })

  it('init returns exists-not-git if dir exists and is not a git repo', async () => {
    mkdirSync(wikiDir, { recursive: true })
    writeFileSync(join(wikiDir, 'hello.md'), 'pre-existing content')
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    const res = await svc.init()
    expect(res.state).toBe('exists-not-git')
    expect(existsSync(join(wikiDir, 'WIKI_GUIDE.md'))).toBe(false)  // no overwrite
  })

  it('status returns state + wikiDir + lastRun=null when fresh', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
    })
    await svc.init()
    const s = svc.status()
    expect(s.wikiDir).toBe(wikiDir)
    expect(s.initState).toBe('ready')
    expect(s.lastRun).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiki.service.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/wiki/index.js` (init + status only for now)**

```js
import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { WIKI_GUIDE_CONTENT, EMPTY_INDEX_CONTENT, EMPTY_LOG_CONTENT } from './guide.js'

const execFileP = promisify(execFile)

function isGitRepo(dir) {
  return existsSync(join(dir, '.git'))
}

function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

async function gitInit(wikiDir) {
  await execFileP('git', ['init', '-q'], { cwd: wikiDir })
  await execFileP('git', ['add', '-A'], { cwd: wikiDir })
  try {
    await execFileP('git', ['commit', '-q', '-m', 'wiki: initial commit'], { cwd: wikiDir })
  } catch {
    // If git identity is unset in CI, fall back to a single-shot config via commit -c
    await execFileP(
      'git',
      ['-c', 'user.email=quadtodo@local', '-c', 'user.name=quadtodo', 'commit', '-q', '-m', 'wiki: initial commit'],
      { cwd: wikiDir },
    )
  }
}

export function createWikiService({
  db,
  logDir,
  wikiDir,
  getTools,
  maxTailTurns = 20,
  timeoutMs = 600_000,
  redactEnabled = true,
  execClaude = null,   // override for tests
}) {
  let running = false
  let lastInitState = 'unknown'

  async function init() {
    if (existsSync(wikiDir) && isNonEmptyDir(wikiDir) && !isGitRepo(wikiDir)) {
      lastInitState = 'exists-not-git'
      return { state: 'exists-not-git', wikiDir }
    }
    if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true })
    mkdirSync(join(wikiDir, 'sources'), { recursive: true })
    mkdirSync(join(wikiDir, 'topics'), { recursive: true })
    mkdirSync(join(wikiDir, 'projects'), { recursive: true })

    const guidePath = join(wikiDir, 'WIKI_GUIDE.md')
    if (!existsSync(guidePath)) writeFileSync(guidePath, WIKI_GUIDE_CONTENT)
    const indexPath = join(wikiDir, 'index.md')
    if (!existsSync(indexPath)) writeFileSync(indexPath, EMPTY_INDEX_CONTENT)
    const logPath = join(wikiDir, 'log.md')
    if (!existsSync(logPath)) writeFileSync(logPath, EMPTY_LOG_CONTENT)

    if (!isGitRepo(wikiDir)) {
      try { await gitInit(wikiDir) } catch (e) {
        lastInitState = 'git-failed'
        return { state: 'git-failed', wikiDir, error: e.message }
      }
    }
    lastInitState = 'ready'
    return { state: 'ready', wikiDir }
  }

  function status() {
    const runs = db.listWikiRuns({ limit: 1 })
    const pendingCount = db.listUnappliedDoneTodos().length
    return {
      wikiDir,
      initState: lastInitState,
      lastRun: runs[0] || null,
      pendingTodoCount: pendingCount,
      running,
    }
  }

  function pending() {
    return db.listUnappliedDoneTodos().map(t => ({
      id: t.id,
      title: t.title,
      workDir: t.workDir,
      quadrant: t.quadrant,
      completedAt: t.updatedAt,
    }))
  }

  async function runOnce(_opts) {
    throw new Error('runOnce: not yet implemented — see Task 7')
  }

  return { init, status, pending, runOnce }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/wiki.service.test.js`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/wiki/index.js test/wiki.service.test.js
git commit -m "feat(wiki): createWikiService init() + status()"
```

---

## Task 7: `runOnce()` — main batch flow with injected claude

**Files:**
- Modify: `src/wiki/index.js` (replace the stub runOnce)
- Modify: `test/wiki.service.test.js` (add runOnce tests)

The design: `runOnce({ todoIds, dryRun })` does the full pipeline. For testability, accept an injected `execClaude` function. If not injected, default to a real spawn using the tools config.

- [ ] **Step 1: Write failing tests**

Append to `test/wiki.service.test.js`:

```js
import { loadTranscript } from '../src/transcript.js'  // (won't actually be used by tests; we inject loadTranscript)

describe('wiki service runOnce', () => {
  let root, wikiDir, db, todo
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qt-wiki-run-'))
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
    todo = db.createTodo({ title: 'fix deploy', description: 'broke', quadrant: 1, status: 'done' })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('runOnce rejects empty todoIds', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    await svc.init()
    await expect(svc.runOnce({ todoIds: [] })).rejects.toThrow(/todoIds/)
  })

  it('runOnce in dryRun mode writes sources but does not call claude', async () => {
    let called = 0
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => { called++; return { exitCode: 0, stdout: '', stderr: '' } },
    })
    await svc.init()
    const res = await svc.runOnce({ todoIds: [todo.id], dryRun: true })
    expect(called).toBe(0)
    expect(res.dryRun).toBe(true)
    expect(res.sourcesWritten).toBe(1)
    const files = readdirSync(join(wikiDir, 'sources'))
    expect(files).toHaveLength(1)
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(0)
  })

  it('runOnce in normal mode calls claude, commits, marks llm_applied', async () => {
    let claudeCalled = 0
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async ({ cwd, stdin }) => {
        claudeCalled++
        // simulate LLM writing a topic file
        writeFileSync(join(cwd, 'topics', 'deploy.md'), '# Deploy Notes\n\npatched from todo.\n')
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      },
    })
    await svc.init()
    const res = await svc.runOnce({ todoIds: [todo.id], dryRun: false })
    expect(claudeCalled).toBe(1)
    expect(res.dryRun).toBe(false)
    expect(res.exitCode).toBe(0)
    expect(existsSync(join(wikiDir, 'topics', 'deploy.md'))).toBe(true)
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(1)

    // git log should show 2 commits: initial + this batch
    const log = execFileSync('git', ['log', '--oneline'], { cwd: wikiDir, encoding: 'utf8' })
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2)
    expect(log).toMatch(/wiki: batch/)
  })

  it('runOnce locks concurrent invocations', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: () => new Promise(r => setTimeout(() => r({ exitCode: 0, stdout: '', stderr: '' }), 100)),
    })
    await svc.init()
    const p1 = svc.runOnce({ todoIds: [todo.id], dryRun: false })
    await expect(svc.runOnce({ todoIds: [todo.id], dryRun: false })).rejects.toThrow(/already running/i)
    await p1
  })

  it('runOnce records error when claude fails', async () => {
    const svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async () => ({ exitCode: 1, stdout: '', stderr: 'claude missing' }),
    })
    await svc.init()
    await expect(svc.runOnce({ todoIds: [todo.id], dryRun: false })).rejects.toThrow(/claude/)
    const runs = db.listWikiRuns({ limit: 5 })
    expect(runs[0].error).toMatch(/claude/)
    // coverage should still be there but NOT llm_applied
    const coverage = db.listCoverageForTodo(todo.id)
    expect(coverage[0].llm_applied).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiki.service.test.js -t 'runOnce'`
Expected: FAIL — `runOnce: not yet implemented`

- [ ] **Step 3: Implement runOnce in `src/wiki/index.js`**

At the top of the file, add imports:

```js
import { spawn } from 'node:child_process'
import { loadTranscript as defaultLoadTranscript } from '../transcript.js'
import { summarizeTurns } from '../summarize.js'
import { redact as defaultRedact } from './redact.js'
import { buildSourceMarkdown, sourceFileName } from './sources.js'
```

Replace the stub `runOnce` and the factory signature. The full updated file:

```js
import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { WIKI_GUIDE_CONTENT, EMPTY_INDEX_CONTENT, EMPTY_LOG_CONTENT } from './guide.js'
import { loadTranscript as defaultLoadTranscript } from '../transcript.js'
import { summarizeTurns as defaultSummarize } from '../summarize.js'
import { redact as defaultRedact } from './redact.js'
import { buildSourceMarkdown, sourceFileName } from './sources.js'

const execFileP = promisify(execFile)

function isGitRepo(dir) { return existsSync(join(dir, '.git')) }
function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false
  try { return readdirSync(dir).length > 0 } catch { return false }
}

async function gitInit(wikiDir) {
  await execFileP('git', ['init', '-q'], { cwd: wikiDir })
  await execFileP('git', ['add', '-A'], { cwd: wikiDir })
  try {
    await execFileP('git', ['commit', '-q', '-m', 'wiki: initial commit'], { cwd: wikiDir })
  } catch {
    await execFileP(
      'git',
      ['-c', 'user.email=quadtodo@local', '-c', 'user.name=quadtodo', 'commit', '-q', '-m', 'wiki: initial commit'],
      { cwd: wikiDir },
    )
  }
}

async function gitCommit(wikiDir, message) {
  await execFileP('git', ['add', '-A'], { cwd: wikiDir })
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: wikiDir })
    if (!stdout.trim()) return { committed: false }
  } catch {}
  try {
    await execFileP('git', ['commit', '-q', '-m', message], { cwd: wikiDir })
  } catch {
    await execFileP(
      'git',
      ['-c', 'user.email=quadtodo@local', '-c', 'user.name=quadtodo', 'commit', '-q', '-m', message],
      { cwd: wikiDir },
    )
  }
  return { committed: true }
}

function defaultExecClaude({ command, bin, args = [], cwd, stdin, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const cmd = bin || command
    const child = spawn(cmd, [...args, '-p', '--output-format', 'text'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`claude timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }) })
    if (stdin != null) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

function buildClaudePrompt(newSourceFiles) {
  const list = newSourceFiles.map(f => `- sources/${f}`).join('\n')
  return `请严格按照 WIKI_GUIDE.md 的规则维护本 wiki。先读 WIKI_GUIDE.md，再读下面这批新的 sources，然后更新 topics/ projects/ index.md 和 log.md：

${list}

约束重申：
- 不要修改 sources/*.md
- 只产出 markdown 文件修改，不要输出总结到终端`
}

export function createWikiService({
  db,
  logDir,
  wikiDir,
  getTools,
  maxTailTurns = 20,
  timeoutMs = 600_000,
  redactEnabled = true,
  loadTranscript = (session) => defaultLoadTranscript({
    tool: session.tool,
    nativeSessionId: session.nativeSessionId,
    cwd: session.cwd || null,
    sessionId: session.sessionId,
    logDir,
  }),
  summarize = defaultSummarize,
  execClaude = null,
}) {
  let running = false
  let lastInitState = 'unknown'

  async function init() {
    if (existsSync(wikiDir) && isNonEmptyDir(wikiDir) && !isGitRepo(wikiDir)) {
      lastInitState = 'exists-not-git'
      return { state: 'exists-not-git', wikiDir }
    }
    if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true })
    mkdirSync(join(wikiDir, 'sources'), { recursive: true })
    mkdirSync(join(wikiDir, 'topics'), { recursive: true })
    mkdirSync(join(wikiDir, 'projects'), { recursive: true })

    const guidePath = join(wikiDir, 'WIKI_GUIDE.md')
    if (!existsSync(guidePath)) writeFileSync(guidePath, WIKI_GUIDE_CONTENT)
    if (!existsSync(join(wikiDir, 'index.md'))) writeFileSync(join(wikiDir, 'index.md'), EMPTY_INDEX_CONTENT)
    if (!existsSync(join(wikiDir, 'log.md'))) writeFileSync(join(wikiDir, 'log.md'), EMPTY_LOG_CONTENT)

    if (!isGitRepo(wikiDir)) {
      try { await gitInit(wikiDir) } catch (e) {
        lastInitState = 'git-failed'
        return { state: 'git-failed', wikiDir, error: e.message }
      }
    }
    lastInitState = 'ready'
    return { state: 'ready', wikiDir }
  }

  function status() {
    const runs = db.listWikiRuns({ limit: 1 })
    return {
      wikiDir,
      initState: lastInitState,
      lastRun: runs[0] || null,
      pendingTodoCount: db.listUnappliedDoneTodos().length,
      running,
    }
  }

  function pending() {
    return db.listUnappliedDoneTodos().map(t => ({
      id: t.id, title: t.title, workDir: t.workDir,
      quadrant: t.quadrant, completedAt: t.updatedAt,
    }))
  }

  async function runOnce({ todoIds, dryRun = false } = {}) {
    if (!Array.isArray(todoIds) || todoIds.length === 0) {
      throw new Error('todoIds must be a non-empty array')
    }
    if (running) throw new Error('wiki run already running')
    running = true
    const run = db.createWikiRun({ todoCount: todoIds.length, dryRun: dryRun ? 1 : 0 })

    try {
      // 1. resolve todos + write sources
      const writtenFiles = []
      for (const todoId of todoIds) {
        const todo = db.getTodo(todoId)
        if (!todo) throw new Error(`todo_not_found: ${todoId}`)
        const comments = db.listComments(todoId)
        const redactFn = redactEnabled ? defaultRedact : (s) => String(s ?? '')
        const md = await buildSourceMarkdown({
          todo, comments,
          loadTranscript,
          summarize,
          redact: redactFn,
          maxTailTurns,
        })
        const filename = sourceFileName(todo)
        const abs = join(wikiDir, 'sources', filename)
        writeFileSync(abs, md)
        writtenFiles.push(filename)
        db.upsertWikiCoverage(run.id, todoId, `sources/${filename}`, false)
      }

      // 2. dryRun short-circuit
      if (dryRun) {
        db.completeWikiRun(run.id, { exitCode: 0, note: `dry-run: ${writtenFiles.length} sources` })
        appendFileSync(join(wikiDir, 'log.md'),
          `\n- [${new Date().toISOString()}] dry-run, wrote ${writtenFiles.length} source(s)\n`)
        return { dryRun: true, runId: run.id, sourcesWritten: writtenFiles.length, exitCode: 0 }
      }

      // 3. spawn claude
      const tools = getTools()
      const tool = tools.claude || {}
      const runner = execClaude || defaultExecClaude
      const prompt = buildClaudePrompt(writtenFiles)
      const result = await runner({
        command: tool.command || 'claude',
        bin: tool.bin,
        args: tool.args || [],
        cwd: wikiDir,
        stdin: prompt,
        timeoutMs,
      })
      if (result.exitCode !== 0) {
        throw new Error(`claude exited ${result.exitCode}: ${String(result.stderr || '').slice(0, 400)}`)
      }

      // 4. git commit
      const now = new Date()
      const tag = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}`
      await gitCommit(wikiDir, `wiki: batch ${tag} (${todoIds.length} todos)`)

      // 5. mark applied + log
      db.markCoverageApplied(run.id)
      db.completeWikiRun(run.id, { exitCode: 0, note: `batch: ${writtenFiles.length} sources` })
      appendFileSync(join(wikiDir, 'log.md'),
        `\n- [${now.toISOString()}] batch run #${run.id}: ${writtenFiles.length} source(s), exit 0\n`)

      return { dryRun: false, runId: run.id, sourcesWritten: writtenFiles.length, exitCode: 0 }
    } catch (e) {
      db.failWikiRun(run.id, e.message)
      throw e
    } finally {
      running = false
    }
  }

  function markOrphansAsFailed() {
    for (const orphan of db.findOrphanWikiRuns()) {
      db.failWikiRun(orphan.id, 'quadtodo process died mid-run')
    }
  }

  return { init, status, pending, runOnce, markOrphansAsFailed }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/wiki.service.test.js`
Expected: all 9 tests pass

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/wiki/index.js test/wiki.service.test.js
git commit -m "feat(wiki): implement runOnce with dryRun + lock + git commit"
```

---

## Task 8: `src/routes/wiki.js` — HTTP routes

**Files:**
- Create: `src/routes/wiki.js`
- Test: `test/wiki.route.test.js`

- [ ] **Step 1: Write failing test**

Create `test/wiki.route.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createWikiService } from '../src/wiki/index.js'
import { createWikiRouter } from '../src/routes/wiki.js'

function makeApp(svc) {
  const app = express()
  app.use(express.json())
  app.use('/api/wiki', createWikiRouter({ service: svc }))
  return app
}

describe('routes/wiki', () => {
  let root, wikiDir, db, svc, todo

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qt-wiki-route-'))
    wikiDir = join(root, 'wiki')
    db = openDb(':memory:')
    todo = db.createTodo({ title: 't1', quadrant: 1, status: 'done' })
    svc = createWikiService({
      db, logDir: root, wikiDir,
      getTools: () => ({ claude: { command: 'claude', bin: 'claude', args: [] } }),
      execClaude: async ({ cwd }) => {
        writeFileSync(join(cwd, 'topics', 'x.md'), '# X\n')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    await svc.init()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    try { db.raw.close() } catch {}
  })

  it('GET /api/wiki/status returns wikiDir + initState', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/status')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status.wikiDir).toBe(wikiDir)
    expect(res.body.status.initState).toBe('ready')
  })

  it('GET /api/wiki/pending returns unapplied done todos', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/pending')
    expect(res.status).toBe(200)
    expect(res.body.list).toHaveLength(1)
    expect(res.body.list[0].id).toBe(todo.id)
  })

  it('POST /api/wiki/run with empty todoIds returns 400', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [] })
    expect(res.status).toBe(400)
  })

  it('POST /api/wiki/run with dryRun=true returns success without calling claude', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: true })
    expect(res.status).toBe(200)
    expect(res.body.dryRun).toBe(true)
    expect(res.body.sourcesWritten).toBe(1)
  })

  it('POST /api/wiki/run with dryRun=false calls claude and returns success', async () => {
    const res = await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: false })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
  })

  it('GET /api/wiki/tree returns file list under wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/tree')
    expect(res.status).toBe(200)
    const paths = res.body.files.map(f => f.path)
    expect(paths).toContain('WIKI_GUIDE.md')
    expect(paths).toContain('index.md')
  })

  it('GET /api/wiki/file reads file content within wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: 'WIKI_GUIDE.md' })
    expect(res.status).toBe(200)
    expect(res.body.content).toMatch(/Wiki 维护指南/)
  })

  it('GET /api/wiki/file rejects path traversal', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: '../../../etc/passwd' })
    expect(res.status).toBe(400)
  })

  it('GET /api/wiki/file rejects absolute path outside wikiDir', async () => {
    const res = await request(makeApp(svc)).get('/api/wiki/file').query({ path: '/etc/passwd' })
    expect(res.status).toBe(400)
  })

  it('GET /api/wiki/runs returns recent runs', async () => {
    await request(makeApp(svc)).post('/api/wiki/run').send({ todoIds: [todo.id], dryRun: true })
    const res = await request(makeApp(svc)).get('/api/wiki/runs')
    expect(res.status).toBe(200)
    expect(res.body.list.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wiki.route.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/routes/wiki.js`**

```js
import { Router } from 'express'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

function walkDir(root, current = root, out = [], maxDepth = 5, depth = 0) {
  if (depth > maxDepth) return out
  let entries = []
  try { entries = readdirSync(current, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === '.git') continue
    const abs = join(current, e.name)
    const rel = relative(root, abs)
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'dir' })
      walkDir(root, abs, out, maxDepth, depth + 1)
    } else if (e.isFile()) {
      let size = 0
      try { size = statSync(abs).size } catch {}
      out.push({ path: rel, type: 'file', size })
    }
  }
  return out
}

function isPathSafe(wikiDir, relPath) {
  if (typeof relPath !== 'string' || !relPath) return false
  if (relPath.startsWith('/')) return false
  const abs = resolve(wikiDir, relPath)
  const wikiResolved = resolve(wikiDir)
  return abs === wikiResolved || abs.startsWith(wikiResolved + '/')
}

export function createWikiRouter({ service }) {
  const router = Router()

  router.get('/status', (_req, res) => {
    try {
      res.json({ ok: true, status: service.status() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/pending', (_req, res) => {
    try {
      res.json({ ok: true, list: service.pending() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/tree', (_req, res) => {
    try {
      const s = service.status()
      if (!existsSync(s.wikiDir)) {
        res.json({ ok: true, files: [] })
        return
      }
      res.json({ ok: true, files: walkDir(s.wikiDir) })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/file', (req, res) => {
    try {
      const s = service.status()
      const p = typeof req.query.path === 'string' ? req.query.path : ''
      if (!isPathSafe(s.wikiDir, p)) {
        res.status(400).json({ ok: false, error: 'invalid_path' })
        return
      }
      const abs = resolve(s.wikiDir, p)
      if (!existsSync(abs)) {
        res.status(404).json({ ok: false, error: 'not_found' })
        return
      }
      const st = statSync(abs)
      if (st.isDirectory()) {
        res.status(400).json({ ok: false, error: 'is_directory' })
        return
      }
      if (st.size > 2 * 1024 * 1024) {
        res.status(400).json({ ok: false, error: 'file_too_large' })
        return
      }
      res.json({ ok: true, path: p, content: readFileSync(abs, 'utf8') })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/run', async (req, res) => {
    try {
      const { todoIds, dryRun = false } = req.body || {}
      if (!Array.isArray(todoIds) || todoIds.length === 0) {
        res.status(400).json({ ok: false, error: 'todoIds must be non-empty array' })
        return
      }
      const result = await service.runOnce({ todoIds, dryRun: !!dryRun })
      res.json({ ok: true, ...result })
    } catch (e) {
      const code = /already running/i.test(e.message) ? 409 : 500
      res.status(code).json({ ok: false, error: e.message })
    }
  })

  router.post('/init', async (_req, res) => {
    try {
      const r = await service.init()
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/runs', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
      // service exposes .status() → lastRun; for history we use db directly via status:
      // Easier: add a helper
      const all = service._listRuns ? service._listRuns(limit) : (service.__db?.listWikiRuns({ limit }) || [])
      res.json({ ok: true, list: all })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
```

Now add a `listRuns` passthrough to the service. Edit `src/wiki/index.js` and in the returned object add:

```js
  listRuns: (limit = 20) => db.listWikiRuns({ limit }),
```

Then in `src/routes/wiki.js` replace the `/runs` handler body with:

```js
  router.get('/runs', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20))
      res.json({ ok: true, list: service.listRuns(limit) })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run test/wiki.route.test.js`
Expected: all 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/routes/wiki.js src/wiki/index.js test/wiki.route.test.js
git commit -m "feat(wiki): express router (status/pending/tree/file/run/init/runs)"
```

---

## Task 9: Wire wiki service into `src/server.js`

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add imports and wire service + router**

At top of `src/server.js`, add these imports next to the existing `createTranscriptsService` import:

```js
import { createWikiService } from "./wiki/index.js";
import { createWikiRouter } from "./routes/wiki.js";
```

In `createServer()`, after the existing `transcriptsService` wiring and before `// async startup scan`, add:

```js
	const wikiConfig = (initialConfig && initialConfig.wiki) || {
		wikiDir: join(process.env.HOME || process.cwd(), ".quadtodo", "wiki"),
		maxTailTurns: 20,
		tool: "claude",
		timeoutMs: 600_000,
		redact: true,
	};
	const wikiService = createWikiService({
		db,
		logDir,
		wikiDir: wikiConfig.wikiDir,
		getTools: () => runtimeConfig.tools || {},
		maxTailTurns: wikiConfig.maxTailTurns ?? 20,
		timeoutMs: wikiConfig.timeoutMs ?? 600_000,
		redactEnabled: wikiConfig.redact !== false,
	});
	app.use("/api/wiki", createWikiRouter({ service: wikiService }));
	// async startup: init wiki dir + clean orphan runs (non-blocking)
	Promise.resolve()
		.then(() => wikiService.init())
		.then((r) => console.log(`[wiki] init state=${r.state} dir=${r.wikiDir}`))
		.catch((e) => console.warn(`[wiki] init failed:`, e.message));
	try { wikiService.markOrphansAsFailed() } catch (e) { console.warn('[wiki] orphan sweep failed:', e.message) }
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all existing tests still pass (server.test.js should not regress)

- [ ] **Step 3: Sanity-check dev server boots**

Run: `node src/cli.js start --port 5680 --no-open &` then `curl -s http://127.0.0.1:5680/api/wiki/status` then kill the process.
Expected: JSON response with `"ok": true, "status": { "wikiDir": "..." }`

Kill server: `node src/cli.js stop` (or `kill <pid>`).

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(server): mount wiki service and routes"
```

---

## Task 10: Frontend API — `web/src/api.ts`

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Append types + functions to `web/src/api.ts`**

At the end of `web/src/api.ts`, add:

```ts
// ─── Wiki ───

export interface WikiRun {
  id: number
  started_at: number
  completed_at: number | null
  todo_count: number
  dry_run: 0 | 1
  exit_code: number | null
  error: string | null
  note: string | null
}

export interface WikiStatus {
  wikiDir: string
  initState: 'ready' | 'exists-not-git' | 'git-failed' | 'unknown'
  lastRun: WikiRun | null
  pendingTodoCount: number
  running: boolean
}

export interface WikiPendingTodo {
  id: string
  title: string
  workDir: string | null
  quadrant: Quadrant
  completedAt: number
}

export interface WikiFile {
  path: string
  type: 'file' | 'dir'
  size?: number
}

export async function getWikiStatus(): Promise<WikiStatus> {
  const body = await jsonFetch<{ ok: true; status: WikiStatus }>('/api/wiki/status')
  return body.status
}

export async function getWikiPending(): Promise<WikiPendingTodo[]> {
  const body = await jsonFetch<{ ok: true; list: WikiPendingTodo[] }>('/api/wiki/pending')
  return body.list
}

export async function getWikiTree(): Promise<WikiFile[]> {
  const body = await jsonFetch<{ ok: true; files: WikiFile[] }>('/api/wiki/tree')
  return body.files
}

export async function getWikiFile(path: string): Promise<string> {
  const qs = new URLSearchParams({ path })
  const body = await jsonFetch<{ ok: true; content: string }>(`/api/wiki/file?${qs.toString()}`)
  return body.content
}

export async function listWikiRuns(limit = 20): Promise<WikiRun[]> {
  const body = await jsonFetch<{ ok: true; list: WikiRun[] }>(`/api/wiki/runs?limit=${limit}`)
  return body.list
}

export interface WikiRunResult {
  dryRun: boolean
  runId: number
  sourcesWritten: number
  exitCode: number
}

export async function runWiki(input: { todoIds: string[]; dryRun?: boolean }): Promise<WikiRunResult> {
  const body = await jsonFetch<{ ok: true } & WikiRunResult>('/api/wiki/run', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body
}

export async function initWiki(): Promise<{ state: string; wikiDir: string; error?: string }> {
  const body = await jsonFetch<{ ok: true; state: string; wikiDir: string; error?: string }>('/api/wiki/init', {
    method: 'POST',
  })
  return body
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc -b --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web/api): add wiki endpoint bindings"
```

---

## Task 11: `WikiDrawer.tsx` — main UI component

**Files:**
- Create: `web/src/WikiDrawer.tsx`
- Create: `web/src/WikiDrawer.css`

- [ ] **Step 1: Create `web/src/WikiDrawer.css`**

```css
.wiki-drawer-body { display: flex; height: calc(100vh - 120px); gap: 12px; }
.wiki-tree-pane {
  width: 260px; flex-shrink: 0; overflow: auto;
  border-right: 1px solid #f0f0f0; padding-right: 8px;
}
.wiki-tree-section { margin-bottom: 12px; }
.wiki-tree-section-title { font-weight: 600; font-size: 12px; color: #888; margin-bottom: 4px; text-transform: uppercase; }
.wiki-tree-item {
  padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wiki-tree-item:hover { background: #f0f0f0; }
.wiki-tree-item.active { background: #e6f4ff; color: #1677ff; }

.wiki-content-pane { flex: 1; overflow: auto; padding: 0 8px; }
.wiki-content-empty { color: #aaa; padding: 24px 0; text-align: center; }
.wiki-content-md pre { background: #f6f8fa; padding: 12px; border-radius: 4px; overflow: auto; }
.wiki-content-md code { background: #f6f8fa; padding: 2px 4px; border-radius: 3px; font-size: 90%; }

.wiki-pending-section { margin-bottom: 12px; border: 1px solid #f0f0f0; border-radius: 4px; padding: 8px; }
.wiki-pending-title { font-weight: 600; margin-bottom: 8px; }
.wiki-pending-row { padding: 4px 0; border-top: 1px solid #fafafa; }
.wiki-pending-row:first-child { border-top: none; }
.wiki-pending-meta { font-size: 12px; color: #888; margin-left: 8px; }
```

- [ ] **Step 2: Create `web/src/WikiDrawer.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer, Button, Checkbox, Empty, Spin, Space, Tag, Alert, message, Modal } from 'antd'
import { FolderOpenOutlined, SyncOutlined, FileTextOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import dayjs from 'dayjs'
import {
  getWikiStatus, getWikiPending, getWikiTree, getWikiFile, runWiki,
  WikiStatus, WikiFile, WikiPendingTodo,
} from './api'
import './WikiDrawer.css'

type TreeGroups = { topLevel: WikiFile[]; topics: WikiFile[]; projects: WikiFile[]; sources: WikiFile[] }

function groupTree(files: WikiFile[]): TreeGroups {
  const out: TreeGroups = { topLevel: [], topics: [], projects: [], sources: [] }
  for (const f of files) {
    if (f.type === 'dir') continue
    if (f.path.startsWith('topics/')) out.topics.push(f)
    else if (f.path.startsWith('projects/')) out.projects.push(f)
    else if (f.path.startsWith('sources/')) out.sources.push(f)
    else if (!f.path.includes('/')) out.topLevel.push(f)
  }
  const byName = (a: WikiFile, b: WikiFile) => a.path.localeCompare(b.path)
  out.topLevel.sort(byName); out.topics.sort(byName)
  out.projects.sort(byName); out.sources.sort((a, b) => b.path.localeCompare(a.path))
  return out
}

function TreeSection({
  title, files, active, onPick,
}: { title: string; files: WikiFile[]; active: string | null; onPick: (p: string) => void }) {
  if (!files.length) return null
  return (
    <div className="wiki-tree-section">
      <div className="wiki-tree-section-title">{title}</div>
      {files.map((f) => (
        <div
          key={f.path}
          className={`wiki-tree-item${active === f.path ? ' active' : ''}`}
          onClick={() => onPick(f.path)}
          title={f.path}
        >
          <FileTextOutlined style={{ marginRight: 4, fontSize: 12 }} />
          {f.path.split('/').pop()}
        </div>
      ))}
    </div>
  )
}

export default function WikiDrawer({
  open, onClose,
}: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<WikiStatus | null>(null)
  const [pending, setPending] = useState<WikiPendingTodo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tree, setTree] = useState<WikiFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [loadingTree, setLoadingTree] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const [running, setRunning] = useState(false)

  const groups = useMemo(() => groupTree(tree), [tree])

  const refresh = useCallback(async () => {
    setLoadingTree(true)
    try {
      const [s, p, t] = await Promise.all([getWikiStatus(), getWikiPending(), getWikiTree()])
      setStatus(s); setPending(p); setTree(t)
    } catch (e: any) {
      message.error(`加载 wiki 失败：${e.message}`)
    } finally { setLoadingTree(false) }
  }, [])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  useEffect(() => {
    if (!activePath) { setContent(''); return }
    setLoadingContent(true)
    getWikiFile(activePath).then((c) => { setContent(c) }).catch((e) => {
      message.error(`读取文件失败：${e.message}`); setContent('')
    }).finally(() => setLoadingContent(false))
  }, [activePath])

  const handleRun = async (dryRun: boolean) => {
    if (selected.size === 0) {
      message.warning('先勾选要沉淀的 todo')
      return
    }
    const ids = [...selected]
    const label = dryRun ? '只生成 sources' : '沉淀选中'
    setRunning(true)
    try {
      const res = await runWiki({ todoIds: ids, dryRun })
      message.success(`${label} 完成：写了 ${res.sourcesWritten} 个 source，exit ${res.exitCode}`)
      setSelected(new Set())
      await refresh()
    } catch (e: any) {
      message.error(`${label} 失败：${e.message}`)
    } finally { setRunning(false) }
  }

  const toggleAll = () => {
    setSelected(selected.size === pending.length ? new Set() : new Set(pending.map(p => p.id)))
  }
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const openInFinder = () => {
    if (!status?.wikiDir) return
    window.open(`file://${status.wikiDir}`)
  }

  const lastRunLabel = status?.lastRun
    ? `上次沉淀：${dayjs(status.lastRun.started_at).format('MM-DD HH:mm')}${status.lastRun.error ? ' · 失败' : status.lastRun.dry_run ? ' · dry-run' : ' · 成功'}`
    : '从未沉淀'

  return (
    <Drawer
      title={<span>🧠 记忆（Wiki）</span>}
      open={open}
      onClose={onClose}
      width={1100}
      extra={
        <Space>
          <Tag>{lastRunLabel}</Tag>
          <Button icon={<SyncOutlined />} onClick={refresh} loading={loadingTree}>刷新</Button>
          <Button icon={<FolderOpenOutlined />} onClick={openInFinder}>打开目录</Button>
        </Space>
      }
    >
      {status?.initState === 'exists-not-git' && (
        <Alert
          style={{ marginBottom: 12 }}
          type="error" showIcon
          message="wiki 目录已存在但不是 git 仓库"
          description={`为避免覆盖现有内容，自动初始化被拒绝。请进入 ${status.wikiDir} 处理（移走或 git init）`}
        />
      )}
      {status?.initState === 'git-failed' && (
        <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="git init 失败" description="wiki 可用但没有 git 保护，误删无法回滚" />
      )}

      <div className="wiki-pending-section">
        <div className="wiki-pending-title">
          未沉淀 done todo（{pending.length}）
          {pending.length > 0 && (
            <Button size="small" type="link" onClick={toggleAll}>
              {selected.size === pending.length ? '清空' : '全选'}
            </Button>
          )}
        </div>
        {pending.length === 0 ? (
          <Empty description="全部 done todo 都已沉淀" imageStyle={{ height: 40 }} />
        ) : (
          pending.map((p) => (
            <div key={p.id} className="wiki-pending-row">
              <Checkbox checked={selected.has(p.id)} onChange={() => toggleOne(p.id)}>
                {p.title}
              </Checkbox>
              <span className="wiki-pending-meta">
                {p.workDir ? p.workDir.split('/').pop() : '-'} · {dayjs(p.completedAt).format('MM-DD')}
              </span>
            </div>
          ))
        )}
        <Space style={{ marginTop: 8 }}>
          <Button type="primary" disabled={selected.size === 0} loading={running} onClick={() => handleRun(false)}>
            沉淀选中（{selected.size}）
          </Button>
          <Button disabled={selected.size === 0} loading={running} onClick={() => {
            Modal.confirm({
              title: '只生成 sources（不调 LLM）',
              content: '用于预览素材规模；不会更新 topics/projects，选中 todo 仍显示在未沉淀列表。',
              onOk: () => handleRun(true),
            })
          }}>只生成 sources（预览）</Button>
        </Space>
      </div>

      <div className="wiki-drawer-body">
        <div className="wiki-tree-pane">
          {loadingTree ? <Spin /> : (
            <>
              <TreeSection title="顶层" files={groups.topLevel} active={activePath} onPick={setActivePath} />
              <TreeSection title="topics" files={groups.topics} active={activePath} onPick={setActivePath} />
              <TreeSection title="projects" files={groups.projects} active={activePath} onPick={setActivePath} />
              <TreeSection title="sources" files={groups.sources} active={activePath} onPick={setActivePath} />
            </>
          )}
        </div>
        <div className="wiki-content-pane">
          {!activePath ? (
            <div className="wiki-content-empty">选择左侧文件查看</div>
          ) : loadingContent ? (
            <Spin />
          ) : (
            <div className="wiki-content-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd web && npx tsc -b --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add web/src/WikiDrawer.tsx web/src/WikiDrawer.css
git commit -m "feat(web): WikiDrawer with pending list, tree, markdown viewer"
```

---

## Task 12: Top-bar 🧠 button in `TodoManage.tsx`

**Files:**
- Modify: `web/src/TodoManage.tsx`

- [ ] **Step 1: Add import and state**

Near the top of `web/src/TodoManage.tsx`, after other drawer imports (around line 34-42), add:

```tsx
import WikiDrawer from './WikiDrawer'
```

Find the spot where `StatsDrawer` open state is declared (search for `StatsDrawer`). Near it, add:

```tsx
  const [wikiOpen, setWikiOpen] = useState(false)
```

Find the top-bar button row (where the 📊 stats button lives). Add a new button before it (or next to it):

```tsx
          <Button icon={<span role="img" aria-label="memory">🧠</span>} onClick={() => setWikiOpen(true)}>
            记忆
          </Button>
```

Find where `<StatsDrawer open={...} />` is rendered. After it, add:

```tsx
        <WikiDrawer open={wikiOpen} onClose={() => setWikiOpen(false)} />
```

- [ ] **Step 2: Build frontend to confirm no errors**

Run: `cd web && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(web): add 🧠 memory button to top bar"
```

---

## Task 13: Per-todo 「沉淀到记忆」button in todo detail

**Files:**
- Modify: `web/src/TodoManage.tsx`

The detail drawer in `TodoManage.tsx` already has action buttons for editing, running AI, etc. We add one more in the same section.

- [ ] **Step 1: Locate and add the button**

In `web/src/TodoManage.tsx`, find the todo detail drawer area (search for `"详情"` or the Drawer where the currently-viewed todo is rendered). Identify the action button row near `startAiExec` / `openTerminal`.

Add above the existing action row:

```tsx
  const [memorizing, setMemorizing] = useState(false)
  const [todoCoverage, setTodoCoverage] = useState<Record<string, boolean>>({})  // todoId → already applied

  const handleMemorize = useCallback(async (todo: Todo, force = false) => {
    if (memorizing) return
    const already = todoCoverage[todo.id]
    if (already && !force) {
      Modal.confirm({
        title: '这条已经沉淀过',
        content: '重新沉淀会再跑一次 claude（消耗 token）。确认吗？',
        onOk: () => handleMemorize(todo, true),
      })
      return
    }
    setMemorizing(true)
    try {
      const res = await runWiki({ todoIds: [todo.id], dryRun: false })
      message.success(`已沉淀到记忆：写了 ${res.sourcesWritten} 个 source`)
      setTodoCoverage((prev) => ({ ...prev, [todo.id]: true }))
    } catch (e: any) {
      message.error(`沉淀失败：${e.message}`)
    } finally { setMemorizing(false) }
  }, [memorizing, todoCoverage])
```

(Place these declarations alongside other useState/useCallback declarations in the TodoManage component, not inside the render.)

Import `runWiki` from `./api` — add `runWiki` to the existing import list at the top (around line 23-31).

Inside the detail drawer's button area (near the `<Button>` for 启动 AI / 打开终端), add:

```tsx
                    <Button
                      onClick={() => handleMemorize(selectedTodo!)}
                      loading={memorizing}
                    >
                      {todoCoverage[selectedTodo!.id] ? '已沉淀 · 重新沉淀' : '沉淀到记忆'}
                    </Button>
```

Replace `selectedTodo` with whatever variable name is in use (probably `viewingTodo`, `activeTodo`, or similar — grep for the surrounding Drawer).

On drawer open, fetch coverage status. Near the effect that loads the detail drawer's data (e.g. `loadComments`), add:

```tsx
  useEffect(() => {
    if (!selectedTodo) return
    // Fast-path: hit /api/wiki/pending and infer whether this id is in pending list
    getWikiPending().then((list) => {
      const isPending = list.some((p) => p.id === selectedTodo.id)
      setTodoCoverage((prev) => ({ ...prev, [selectedTodo.id]: !isPending && selectedTodo.status === 'done' }))
    }).catch(() => { /* silent */ })
  }, [selectedTodo?.id])
```

Also add `getWikiPending` to the import list.

- [ ] **Step 2: Build frontend**

Run: `cd web && npm run build`
Expected: build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(web): per-todo 沉淀到记忆 button in detail drawer"
```

---

## Task 14: End-to-end manual validation

This task has no test file — it's the acceptance checklist from the spec.

**Prerequisites:**
- `claude` CLI available on PATH (or `tools.claude.bin` configured)
- A test quadtodo with at least one done todo bound to an AI transcript

- [ ] **Step 1: Fresh-install verification**

```bash
rm -rf /tmp/qt-test-home
QUADTODO_ROOT_DIR=/tmp/qt-test-home node src/cli.js start --port 5690 --no-open &
sleep 2
curl -s http://127.0.0.1:5690/api/wiki/status | jq
ls /tmp/qt-test-home/wiki
cat /tmp/qt-test-home/wiki/WIKI_GUIDE.md | head -20
cd /tmp/qt-test-home/wiki && git log --oneline
```

Expected:
- `wikiDir: "/tmp/qt-test-home/wiki"`, `initState: "ready"`
- Directory contains WIKI_GUIDE.md, index.md, log.md, and git history with one commit "wiki: initial commit"

Stop server: `kill %1`

- [ ] **Step 2: Manual smoke with real claude**

Using your own machine's existing `~/.quadtodo`:

1. `node src/cli.js start` (opens browser)
2. Open the 🧠 记忆 drawer — status shows "从未沉淀"
3. Pick one done todo that has an AI session. Open detail, click 「沉淀到记忆」.
4. Wait for claude to finish (a few seconds to a few minutes). Success toast.
5. Refresh the 记忆 drawer. Tree shows topics/ and projects/ files. Click one — markdown renders.
6. Open `~/.quadtodo/wiki && git log --oneline`. Should show at least 2 commits.
7. Click 「已沉淀 · 重新沉淀」 — confirm modal appears.
8. In Wiki drawer, pick another done todo via checkbox → 「沉淀选中」 → successful.
9. Click 「只生成 sources（预览）」 on a third todo → confirm modal → success; that todo stays in the未沉淀 list.

- [ ] **Step 3: Edge-case verification**

1. **Wrapped CLI:** `quadtodo config set tools.claude.bin /path/to/claude-w` then sediment a todo — confirm it spawns the wrapped bin (check `ps aux` during run or log).
2. **Concurrent run:** Click 「沉淀选中」 twice in quick succession → second call returns 409 / "already running".
3. **Path traversal:** `curl 'http://127.0.0.1:5677/api/wiki/file?path=../../../etc/passwd'` → 400.
4. **Secrets:** Create a test todo with description `my api key is sk-ant-api03-TESTFAKE0987654321abcdef01`, mark done, sediment. Check `~/.quadtodo/wiki/sources/*.md` — should say `[REDACTED]`.
5. **Orphan run recovery:** Start server, begin a real sediment, `kill -9` the process mid-run, restart. Call `GET /api/wiki/runs` — that run shows `error: "quadtodo process died mid-run"`.

- [ ] **Step 4: Commit checklist write-up (optional)**

If you found bugs during the above, fix them in isolated commits and re-run. If everything passes:

```bash
git commit --allow-empty -m "docs(wiki): e2e validation complete"
```

---

## Self-review (to be performed by plan author before handing off)

**Spec coverage:**
- §三 Storage → Tasks 2, 6 ✓
- §四 Triggers (manual only) → Task 11 (batch drawer) + Task 13 (per-todo button) ✓
- §五 Flow → Task 7 ✓
- §六 WIKI_GUIDE.md → Task 2 ✓
- §七 Frontend → Tasks 10, 11, 12, 13 ✓
- §八 Backend (files, API, DB, config) → Tasks 4, 5, 6, 7, 8, 9 ✓
- §九 Redact → Task 1 ✓
- §十 Source template → Task 3 ✓
- §十一 Risks (lock, git, redact, path check, exists-not-git) → Tasks 6, 7, 8 ✓
- §十二 Acceptance → Task 14 ✓

**Type consistency check:** All methods used by tasks (createWikiRun, completeWikiRun, failWikiRun, listWikiRuns, findOrphanWikiRuns, upsertWikiCoverage, markCoverageApplied, listCoverageForTodo, listUnappliedDoneTodos; init, status, pending, runOnce, listRuns, markOrphansAsFailed) are declared in Task 4 / Task 6 / Task 7 before use in Task 8 and Task 9. ✓

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate handling" — each step has real code. ✓

---

## Execution Options

After you approve this plan, you have two execution modes:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using `executing-plans`, batching with checkpoints for your review.

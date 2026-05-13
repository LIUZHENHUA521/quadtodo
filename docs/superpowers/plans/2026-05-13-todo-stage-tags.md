# Todo Stage Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent "stage tag" dimension (待开发/待评审/待测试/待发布/阻塞中) to every todo, switchable from the card and from the detail panel.

**Architecture:** New nullable column `stage_tag` on `todos`, fully orthogonal to the existing `status` field. One reusable React component (`StageTagChip`) is mounted in both the card footer and the detail panel; both edit through the existing `PUT /api/todos/:id` endpoint. Backend whitelist-validates the value.

**Tech Stack:** better-sqlite3, Express, React + TypeScript, antd `Dropdown`, vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-05-13-todo-stage-tags-design.md` (commit `51ba7d2`).

**Important deviations from spec:**
- The existing route uses `PUT /api/todos/:id`, not `PATCH`. We extend the existing PUT, no new endpoint.
- The popover menu uses antd `Dropdown` (already imported in `TodoCard.tsx`), not a hand-rolled popover.

---

## File Map

**Create:**
- `web/src/stageTags.ts` — single source of truth for tag enum, labels, emojis, classNames
- `web/src/components/StageTagChip/StageTagChip.tsx` — chip + dropdown menu, props `{ value, onChange }`
- `web/src/components/StageTagChip/index.ts` — re-export

**Modify:**
- `src/db.js` — add migration, `rowToTodo`, `updateTodo` map
- `src/routes/todos.js` — whitelist + validate `stageTag` in PUT body
- `web/src/api.ts` — extend `Todo` interface, export `StageTag` type
- `web/src/components/TodoCard/TodoCard.tsx` — render `<StageTagChip>` next to `todo-status-chip`
- `web/src/TodoManage.tsx` — render `<StageTagChip>` in detail panel meta strip
- `web/src/TodoManage.css` — `.stage-tag-chip` base + 5 color variants + empty-state ➕

**Test:**
- `test/db.test.js` — append stage_tag tests
- `test/todos.route.test.js` — append PUT validation tests

---

## Task 1: db — schema migration + rowToTodo + updateTodo map

**Files:**
- Modify: `src/db.js` (migration block ~line 264, `rowToTodo` ~line 154, `updateTodo` map ~line 380)
- Test: `test/db.test.js` (append at end of `describe('db', ...)`)

- [ ] **Step 1: Write the failing tests**

Append at the end of the `describe('db', ...)` block in `test/db.test.js`, just before the closing `})`:

```js
  it('createTodo defaults stageTag to null', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    expect(t.stageTag).toBeNull()
  })

  it('updateTodo sets a valid stageTag', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    const updated = db.updateTodo(t.id, { stageTag: 'dev' })
    expect(updated.stageTag).toBe('dev')
  })

  it('updateTodo can clear stageTag back to null', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(t.id, { stageTag: 'release' })
    const cleared = db.updateTodo(t.id, { stageTag: null })
    expect(cleared.stageTag).toBeNull()
  })

  it('listTodos returns stageTag for each row', () => {
    const a = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(a.id, { stageTag: 'test' })
    db.createTodo({ title: 'B', quadrant: 1 })
    const list = db.listTodos({})
    const byTitle = Object.fromEntries(list.map(t => [t.title, t.stageTag]))
    expect(byTitle.A).toBe('test')
    expect(byTitle.B).toBeNull()
  })

  it('stageTag is independent of status (does not change on done toggle)', () => {
    const t = db.createTodo({ title: 'A', quadrant: 1 })
    db.updateTodo(t.id, { stageTag: 'release' })
    db.updateTodo(t.id, { status: 'done' })
    expect(db.getTodo(t.id).stageTag).toBe('release')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/db.test.js -t stageTag`
Expected: 5 FAIL with messages about `stageTag` being undefined.

- [ ] **Step 3: Add the migration**

In `src/db.js`, inside `openDb()`, after the existing column-add block (around line 290, after the `archived_at` block, before the `CREATE INDEX` lines for recurring/parent/etc.), add:

```js
  if (!columns.some(col => col.name === 'stage_tag')) {
    db.exec(`ALTER TABLE todos ADD COLUMN stage_tag TEXT`)
  }
```

Note: Do NOT add `stage_tag` to the `SCHEMA` constant at the top of the file — we follow the existing migration-only pattern (same as `brainstorm`, `applied_template_ids`, `recurring_rule_id`, etc.). New installs run the migration too, so the column will be present.

- [ ] **Step 4: Map the column in `rowToTodo`**

In `rowToTodo` (around line 154–177 in `src/db.js`), add `stageTag` to the returned object. Place it right after `completedAt` to keep grouping coherent:

```js
    completedAt: row.completed_at ?? null,
    stageTag: row.stage_tag ?? null,
    archivedAt: row.archived_at ?? null,
```

- [ ] **Step 5: Whitelist `stageTag` in `updateTodo`**

In `updateTodo` (around line 380 in `src/db.js`), add `stageTag` to the `map` object:

```js
    const map = {
      title: 'title',
      description: 'description',
      quadrant: 'quadrant',
      status: 'status',
      dueDate: 'due_date',
      workDir: 'work_dir',
      brainstorm: 'brainstorm',
      sortOrder: 'sort_order',
      stageTag: 'stage_tag',
    }
```

The existing loop `for (const [k, col] of Object.entries(map))` then handles binding — `null` is bound correctly by better-sqlite3.

Note: do NOT touch `createTodo` or its INSERT statement. New rows get `stage_tag = NULL` from the column default.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/db.test.js -t stageTag`
Expected: 5 PASS.

Then run the full db suite to make sure nothing regressed:

Run: `npx vitest run test/db.test.js`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat(db): add stage_tag column to todos"
```

---

## Task 2: routes — whitelist + validation in PUT /api/todos/:id

**Files:**
- Modify: `src/routes/todos.js` (PUT handler around line 62–130)
- Test: `test/todos.route.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append at the end of the `describe('routes/todos', ...)` block in `test/todos.route.test.js`, just before the closing `})`:

```js
  it('PUT /api/todos/:id accepts a valid stageTag', async () => {
    const { body: c } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    const res = await request(app).put(`/api/todos/${c.todo.id}`).send({ stageTag: 'dev' })
    expect(res.status).toBe(200)
    expect(res.body.todo.stageTag).toBe('dev')
  })

  it('PUT /api/todos/:id accepts null stageTag (clear)', async () => {
    const { body: c } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    await request(app).put(`/api/todos/${c.todo.id}`).send({ stageTag: 'release' })
    const res = await request(app).put(`/api/todos/${c.todo.id}`).send({ stageTag: null })
    expect(res.status).toBe(200)
    expect(res.body.todo.stageTag).toBeNull()
  })

  it('PUT /api/todos/:id rejects an invalid stageTag', async () => {
    const { body: c } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    const res = await request(app).put(`/api/todos/${c.todo.id}`).send({ stageTag: 'shipped' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toBe('invalid_stage_tag')
  })

  it('GET /api/todos returns stageTag in the list', async () => {
    const { body: c } = await request(app).post('/api/todos').send({ title: 'A', quadrant: 1 })
    await request(app).put(`/api/todos/${c.todo.id}`).send({ stageTag: 'test' })
    const res = await request(app).get('/api/todos')
    expect(res.status).toBe(200)
    expect(res.body.list[0].stageTag).toBe('test')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/todos.route.test.js -t stageTag`
Expected: the "accepts a valid", "clear", and "GET returns" cases pass (db + rowToTodo already wired in Task 1, no validation rejects anything yet); the "rejects an invalid" case FAILS because the bogus value is currently passed straight through.

If "accepts a valid" also fails, double-check Task 1 was committed first.

- [ ] **Step 3: Add validation in the PUT handler**

In `src/routes/todos.js`, inside the PUT handler (`router.put('/:id', ...)`), insert validation right after the `const patch = req.body || {}` line (around line 69), before any other check:

```js
      const patch = req.body || {}
      if (patch.stageTag !== undefined) {
        const ALLOWED_STAGE_TAGS = ['dev', 'review', 'test', 'release', 'blocked']
        if (patch.stageTag !== null && !ALLOWED_STAGE_TAGS.includes(patch.stageTag)) {
          res.status(400).json({ ok: false, error: 'invalid_stage_tag' })
          return
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/todos.route.test.js -t stageTag`
Expected: 4 PASS.

Then full route suite:

Run: `npx vitest run test/todos.route.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/todos.js test/todos.route.test.js
git commit -m "feat(routes/todos): whitelist stageTag in PUT body"
```

---

## Task 3: web — extend Todo interface, add StageTag type

**Files:**
- Modify: `web/src/api.ts` (around line 5 and line 31–50)

- [ ] **Step 1: Add the `StageTag` type and extend `Todo`**

In `web/src/api.ts`, just below the `TodoStatus` line (line 5), add:

```ts
export type StageTag = 'dev' | 'review' | 'test' | 'release' | 'blocked'
```

Then in the `Todo` interface (line 31–50), add `stageTag` right after `completedAt`:

```ts
  completedAt: number | null
  stageTag: StageTag | null
  createdAt: number
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors. (Pre-existing errors unrelated to stage_tag are fine — note them but don't fix.)

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): add StageTag type to api"
```

---

## Task 4: web — create stageTags.ts dictionary

**Files:**
- Create: `web/src/stageTags.ts`

- [ ] **Step 1: Create the file**

```ts
import type { StageTag } from './api'

export const STAGE_TAGS: readonly StageTag[] = ['dev', 'review', 'test', 'release', 'blocked'] as const

export const STAGE_TAG_META: Record<StageTag, { label: string; emoji: string; className: string }> = {
  dev:     { label: '待开发', emoji: '🔧', className: 'stage-tag-dev' },
  review:  { label: '待评审', emoji: '👀', className: 'stage-tag-review' },
  test:    { label: '待测试', emoji: '🧪', className: 'stage-tag-test' },
  release: { label: '待发布', emoji: '🚀', className: 'stage-tag-release' },
  blocked: { label: '阻塞中', emoji: '⛔', className: 'stage-tag-blocked' },
}
```

`STAGE_TAGS` doubles as the dropdown render order.

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/stageTags.ts
git commit -m "feat(web): add stageTags dictionary"
```

---

## Task 5: web — create StageTagChip component

**Files:**
- Create: `web/src/components/StageTagChip/StageTagChip.tsx`
- Create: `web/src/components/StageTagChip/index.ts`

- [ ] **Step 1: Create the component**

`web/src/components/StageTagChip/StageTagChip.tsx`:

```tsx
import { Dropdown } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { StageTag } from '../../api'
import { STAGE_TAGS, STAGE_TAG_META } from '../../stageTags'

export interface StageTagChipProps {
  value: StageTag | null
  onChange: (next: StageTag | null) => void
  disabled?: boolean
}

export function StageTagChip({ value, onChange, disabled }: StageTagChipProps) {
  const items = [
    ...STAGE_TAGS.map(tag => {
      const meta = STAGE_TAG_META[tag]
      return { key: tag, label: `${meta.emoji} ${meta.label}` }
    }),
    { type: 'divider' as const },
    { key: '__clear__', label: '清除', disabled: value == null },
  ]

  const handleClick = ({ key }: { key: string }) => {
    if (key === '__clear__') onChange(null)
    else onChange(key as StageTag)
  }

  const trigger = value == null
    ? (
      <button type="button" className="stage-tag-chip stage-tag-chip--empty" disabled={disabled}>
        <PlusOutlined />
        <span>加阶段</span>
      </button>
    )
    : (() => {
      const meta = STAGE_TAG_META[value]
      return (
        <button type="button" className={`stage-tag-chip ${meta.className}`} disabled={disabled}>
          <span>{meta.emoji}</span>
          <span>{meta.label}</span>
        </button>
      )
    })()

  return (
    <Dropdown
      menu={{ items, onClick: handleClick }}
      trigger={['click']}
      disabled={disabled}
    >
      <span onClick={(e) => e.stopPropagation()}>{trigger}</span>
    </Dropdown>
  )
}
```

`web/src/components/StageTagChip/index.ts`:

```ts
export { StageTagChip } from './StageTagChip'
export type { StageTagChipProps } from './StageTagChip'
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/StageTagChip
git commit -m "feat(web): add StageTagChip component"
```

---

## Task 6: TodoCard — wire StageTagChip into card footer

**Files:**
- Modify: `web/src/components/TodoCard/TodoCard.tsx` (imports + render around line 130–135)

- [ ] **Step 1: Import the component and the API helper**

At the top of `web/src/components/TodoCard/TodoCard.tsx`, add to the existing import block:

```tsx
import { updateTodo, type StageTag } from '../../api'
import { StageTagChip } from '../StageTagChip'
```

(`Todo` and `AiTool` are already imported from `'../../api'` — extend that line with `StageTag` if you prefer; either form works.)

- [ ] **Step 2: Add `onRefresh` invocation helper**

`onRefresh` is already in props. We use it to re-fetch after PATCH so the card reflects the new tag (the fetch happens via the existing TodoManage refresh chain).

Add this handler inside the component body, just before the `return` statement (around line 100):

```tsx
  const handleStageTagChange = async (next: StageTag | null) => {
    try {
      await updateTodo(todo.id, { stageTag: next })
      onRefresh()
    } catch (e: any) {
      message.error(e?.message || '阶段标签更新失败')
    }
  }
```

- [ ] **Step 3: Render the chip next to the status chip**

In the title row (around line 131–134), add `<StageTagChip>` right after `<span className={\`todo-status-chip ...\`}>`:

```tsx
            <div className="todo-card-title-row">
              <div className="todo-card-title">{todo.title}</div>
              <span className={`todo-status-chip ${statusChip.className}`}>{statusChip.text}</span>
              <StageTagChip value={todo.stageTag} onChange={handleStageTagChange} />
            </div>
```

- [ ] **Step 4: Verify TypeScript still compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TodoCard/TodoCard.tsx
git commit -m "feat(todo-card): mount StageTagChip in title row"
```

---

## Task 7: Detail panel — wire StageTagChip into meta strip

**Files:**
- Modify: `web/src/TodoManage.tsx` (detail panel meta block around line 1411–1457)

- [ ] **Step 1: Import the component**

Add to the imports at the top of `web/src/TodoManage.tsx`:

```tsx
import { StageTagChip } from './components/StageTagChip'
import type { StageTag } from './api'
```

(Skip the second import if `StageTag` isn't directly referenced — the chip's `onChange` arg already carries the type.)

- [ ] **Step 2: Add the chip to the meta strip**

Find the meta strip (`<div className="todo-detail-meta">`, around line 1412). After the `level` chip (around line 1427), add a new chip-row entry:

```tsx
                <span className="todo-detail-chip todo-detail-chip--stage" onClick={(e) => e.stopPropagation()}>
                  <span className="todo-detail-chip__label">阶段</span>
                  <StageTagChip
                    value={detailTodo.stageTag}
                    onChange={async (next) => {
                      try {
                        await updateTodo(detailTodo.id, { stageTag: next })
                        await refreshTodos()
                      } catch (e: any) {
                        message.error(e?.message || '阶段标签更新失败')
                      }
                    }}
                  />
                </span>
```

Verify `updateTodo`, `refreshTodos`, and `message` are already in scope at this point in the file (they should be — they are used by the surrounding handlers). If `refreshTodos` has a different name in this file, use the existing refetch helper used by neighboring chips/buttons.

- [ ] **Step 3: Verify TypeScript still compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(todo-detail): mount StageTagChip in meta strip"
```

---

## Task 8: CSS — chip styles + 5 color variants + empty state

**Files:**
- Modify: `web/src/TodoManage.css` (append a new block after `.status-chip-complete` around line 408)

- [ ] **Step 1: Append the styles**

```css
/* ─── stage tag chip (待开发 / 待评审 / 待测试 / 待发布 / 阻塞中) ─── */

.stage-tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  background: var(--surface-2);
  color: var(--text-primary);
  transition: filter 0.15s ease;
}

.stage-tag-chip:hover {
  filter: brightness(1.05);
}

.stage-tag-chip:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.stage-tag-chip--empty {
  background: transparent;
  border: 1px dashed var(--border-default);
  color: var(--text-secondary);
  font-weight: 500;
}

.stage-tag-dev {
  background: color-mix(in srgb, #2f80ed 20%, var(--surface-1));
  color: #2f80ed;
  border-color: color-mix(in srgb, #2f80ed 35%, transparent);
}

.stage-tag-review {
  background: color-mix(in srgb, #9b51e0 20%, var(--surface-1));
  color: #9b51e0;
  border-color: color-mix(in srgb, #9b51e0 35%, transparent);
}

.stage-tag-test {
  background: color-mix(in srgb, #f2994a 22%, var(--surface-1));
  color: #f2994a;
  border-color: color-mix(in srgb, #f2994a 35%, transparent);
}

.stage-tag-release {
  background: color-mix(in srgb, #27ae60 22%, var(--surface-1));
  color: #27ae60;
  border-color: color-mix(in srgb, #27ae60 35%, transparent);
}

.stage-tag-blocked {
  background: color-mix(in srgb, #eb5757 22%, var(--surface-1));
  color: #eb5757;
  border-color: color-mix(in srgb, #eb5757 35%, transparent);
}

/* keep detail-panel chip alignment consistent with other meta chips */
.todo-detail-chip--stage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/TodoManage.css
git commit -m "feat(web): style stage tag chip variants"
```

---

## Task 9: Build + manual smoke

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all green (vitest run).

- [ ] **Step 2: Build the web bundle**

Run: `npm run build`
Expected: build succeeds, no new warnings about missing modules / type errors related to stage_tag.

- [ ] **Step 3: Manual UI verification**

Start the server (`npm run dev` or `agentquad start`), open the app, and verify:

1. A todo card shows a dashed "➕ 加阶段" chip next to the status chip when no tag is set.
2. Clicking the chip opens a 5-item dropdown + "清除" entry; "清除" is disabled when no tag is set.
3. Picking "待开发" turns the chip blue with "🔧 待开发"; the card re-renders without a manual refresh.
4. Opening the detail panel shows the same chip in the meta strip with the same value.
5. Changing the tag from the detail panel updates the card chip after closing the panel (or live, depending on store wiring).
6. A subtodo card also shows its own chip and switching it does not affect the parent's chip.
7. Toggling the parent's "已完成" checkbox does NOT clear or change the stage tag (orthogonality check).
8. Refreshing the page preserves the tag.

- [ ] **Step 4: Commit any tweaks discovered during smoke (if any)**

```bash
git add -p   # stage only the smoke fixes
git commit -m "fix(stage-tag): <describe>"
```

If no tweaks, skip.

---

## Self-Review Notes

**Spec coverage:**
- §1 data model → Task 1 ✓
- §2 enum/dictionary → Task 4 ✓
- §3 API (PUT validation, GET returns field, no creation field, no batch) → Task 2 ✓; creation/batch explicitly NOT touched ✓
- §4.1 card chip → Task 6 ✓
- §4.2 detail panel chip → Task 7 ✓
- §4.3 no creation field → covered by not modifying POST handler ✓
- §4.4 dropdown menu → Task 5 (uses antd `Dropdown`, deviation noted in header) ✓
- §5 explicit non-goals → no tasks touch filter / batch / AI status / export / migration script / stats ✓
- §6 testing scope → db + route tests in Task 1, 2; manual UI in Task 9 ✓
- §7 implementation order → tasks 1-9 follow the spec order ✓

**Type consistency:**
- `StageTag` exported from `api.ts` (Task 3), imported by `stageTags.ts` (Task 4), `StageTagChip` (Task 5), and consumers (Task 6, 7). All references match.
- DB column `stage_tag` (snake_case) ↔ JS field `stageTag` (camelCase) — translation lives only in `rowToTodo` and the `updateTodo` map in `db.js`.

# AI 会话三态严格化与标签统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端"AI 会话状态"在 6 个点位收敛为 `running / 待确认 / idle` 三态，删除所有 `status === 'pending_confirm' || unread` 混合表达式与 `pendingConfirmSids` 特殊路径；顶栏 pill 从 `active / tok / pending` 改为 `running / idle / 待确认`。

**Architecture:** 新增一个纯函数 `deriveAiState(status, unread)` 作为单一来源，所有展示点位调用它。后端 `AiStatus` 契约不动；改的是前端展示层。`replyHub` 的 `UnreadReason` 类型与 `pendingConfirmSids` 整段删除。

**Tech Stack:** React 18 + TypeScript + Zustand + Vite + Vitest + AntD 5。测试用 vitest（`npm test`，跑 `vitest run`）。

**Spec:** `docs/superpowers/specs/2026-05-13-ai-state-3-state-strict-design.md`

---

## File Structure

**新建：**
- `web/src/design/aiPresentationState.ts` — 纯推导函数 + 标签常量
- `test/ai-presentation-state.test.ts` — 单测

**改写：**
- `web/src/components/TodoCard/TodoCard.tsx:163-185` — 内联状态行
- `web/src/TodoManage.css:945-960` — CSS 类名重命名
- `web/src/design/useDispatchStats.ts` — 接口与计数逻辑
- `web/src/components/TopbarDispatch/TopbarDispatch.tsx` — pill 渲染、删 tok、Popover 简化
- `web/src/replyHub.ts` — 删 pending_confirm 分支与 reason
- `test/reply-hub.test.ts` — 删过时 case
- `web/src/components/SessionFocus/FocusSubbar.tsx` — pill 文案
- `web/src/TranscriptView.tsx:46-53` — status chip

每个任务都先跑 `npm test` 与 `npm --prefix web run build`（TS 编译检查）。前端无可执行单测 setup（test runner 在根目录 vitest），所有新测都放 `test/` 目录用 vitest。

---

## Task 1: 建立单一推导函数（`deriveAiState`）

**Files:**
- Create: `web/src/design/aiPresentationState.ts`
- Test: `test/ai-presentation-state.test.ts`

- [ ] **Step 1.1: 写失败测试**

Create `test/ai-presentation-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveAiState, AI_STATE_LABEL, AI_STATE_PILL_LABEL } from '../web/src/design/aiPresentationState.ts'

describe('deriveAiState', () => {
  it('returns running when status is running, regardless of unread', () => {
    expect(deriveAiState('running', false)).toBe('running')
    expect(deriveAiState('running', true)).toBe('running')
  })

  it('returns pending when not running but unread', () => {
    expect(deriveAiState('done', true)).toBe('pending')
    expect(deriveAiState('failed', true)).toBe('pending')
    expect(deriveAiState('stopped', true)).toBe('pending')
    expect(deriveAiState('pending_confirm', true)).toBe('pending')
    expect(deriveAiState(undefined, true)).toBe('pending')
    expect(deriveAiState(null, true)).toBe('pending')
  })

  it('returns idle when not running and not unread (including pending_confirm with no unread)', () => {
    expect(deriveAiState('done', false)).toBe('idle')
    expect(deriveAiState('failed', false)).toBe('idle')
    expect(deriveAiState('stopped', false)).toBe('idle')
    expect(deriveAiState('pending_confirm', false)).toBe('idle')
    expect(deriveAiState(undefined, false)).toBe('idle')
    expect(deriveAiState(null, false)).toBe('idle')
  })
})

describe('AI_STATE_LABEL / AI_STATE_PILL_LABEL', () => {
  it('inline label has icon prefix', () => {
    expect(AI_STATE_LABEL.running).toBe('● running')
    expect(AI_STATE_LABEL.pending).toBe('⚠ 待确认')
    expect(AI_STATE_LABEL.idle).toBe('○ 空闲')
  })

  it('pill label is plain text only', () => {
    expect(AI_STATE_PILL_LABEL.running).toBe('running')
    expect(AI_STATE_PILL_LABEL.pending).toBe('待确认')
    expect(AI_STATE_PILL_LABEL.idle).toBe('idle')
  })
})
```

- [ ] **Step 1.2: 跑测试，预期失败**

Run: `npm test -- ai-presentation-state`
Expected: FAIL — module not found.

- [ ] **Step 1.3: 写实现**

Create `web/src/design/aiPresentationState.ts`:

```ts
import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

/**
 * 单一来源：把后端 AiStatus + 前端 unread 推导成 3 态展示态。
 *
 * 规则：
 *   - status === 'running'  →  running（claude 正在执行）
 *   - 否则 unread === true  →  pending（claude 回复了，用户没看）
 *   - 其它一切             →  idle
 *
 * 注意：status === 'pending_confirm' 不再是 pending 的充分条件；
 * 用户看过后即归 idle，直到后端把 status 推回 running。
 */
export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
): AiPresentationState {
  if (status === 'running') return 'running'
  if (unread) return 'pending'
  return 'idle'
}

/** 卡片内联展示用，带图形字符 */
export const AI_STATE_LABEL: Record<AiPresentationState, string> = {
  running: '● running',
  pending: '⚠ 待确认',
  idle:    '○ 空闲',
}

/** 顶栏 pill 用，纯文字 */
export const AI_STATE_PILL_LABEL: Record<AiPresentationState, string> = {
  running: 'running',
  pending: '待确认',
  idle:    'idle',
}
```

- [ ] **Step 1.4: 跑测试，预期通过**

Run: `npm test -- ai-presentation-state`
Expected: PASS — all assertions green.

- [ ] **Step 1.5: 跑全量测试 + 编译**

Run: `npm test && npm --prefix web run build`
Expected: 全绿（仅新增文件，不应有回归）。

- [ ] **Step 1.6: 提交**

```bash
git add web/src/design/aiPresentationState.ts test/ai-presentation-state.test.ts
git commit -m "feat(ai-state): add deriveAiState single source of truth"
```

---

## Task 2: TodoCard 内联状态行接入新推导 + CSS 类名重命名

**Files:**
- Modify: `web/src/components/TodoCard/TodoCard.tsx:162-185`
- Modify: `web/src/TodoManage.css:945-960`

> 这里没有现成单元测试覆盖此行（TodoCard 没有独立测试文件），改完依赖 TS 编译 + 手动验证 + 视觉回归。

- [ ] **Step 2.1: 改 `TodoCard.tsx`**

替换 `TodoCard.tsx:162-185` 整块：

```tsx
          {todo.aiSession && (() => {
            // 三态严格定义：running / pending(待确认) / idle。详见
            // docs/superpowers/specs/2026-05-13-ai-state-3-state-strict-design.md
            const liveSession = liveSessionsMap.get(todo.aiSession.sessionId)
            const liveTurnDoneAt = liveSession?.lastTurnDoneAt ?? null
            const turnDoneAt = liveTurnDoneAt || todo.aiSession.lastTurnDoneAt || null
            const unread = isSessionUnread(turnDoneAt, lastSeenMap.get(todo.aiSession.sessionId))
            const state = deriveAiState(liveSession?.status, unread)
            return (
              <div className="todo-ai-status-row" onClick={(e) => e.stopPropagation()}>
                <span className="todo-ai-tag">{todo.aiSession.tool}</span>
                <span className={`todo-ai-state todo-ai-state-${state}`}>{AI_STATE_LABEL[state]}</span>
                <ActivitySparkline sessionId={todo.aiSession.sessionId} width={70} height={14} />
              </div>
            )
          })()}
```

并在 `TodoCard.tsx` 顶部 import 区域加：

```tsx
import { deriveAiState, AI_STATE_LABEL } from '../../design/aiPresentationState'
```

- [ ] **Step 2.2: 改 `TodoManage.css:945-955`**

把以下整块：

```css
.todo-ai-state-running {
  color: var(--ai-running);
  animation: todo-ai-pulse 1.6s ease-in-out infinite;
}
.todo-ai-state-pending_confirm {
  color: var(--ai-pending-confirm);
  animation: todo-ai-pulse 1.2s ease-in-out infinite;
}
.todo-ai-state-done { color: var(--ai-running); }
.todo-ai-state-failed { color: var(--ai-error); }
.todo-ai-state-stopped, .todo-ai-state-idle { color: var(--ai-idle); }
```

替换为：

```css
.todo-ai-state-running {
  color: var(--ai-running);
  animation: todo-ai-pulse 1.6s ease-in-out infinite;
}
.todo-ai-state-pending {
  color: var(--ai-pending-confirm);
  animation: todo-ai-pulse 1.2s ease-in-out infinite;
}
.todo-ai-state-idle { color: var(--ai-idle); }
```

> 删了 `done/failed/stopped` 子类（折成 idle）和 `pending_confirm` 类（改名 `pending`）。

- [ ] **Step 2.3: 跑编译 + 测试**

Run: `npm --prefix web run build && npm test`
Expected: 编译通过，测试全绿。

- [ ] **Step 2.4: 提交**

```bash
git add web/src/components/TodoCard/TodoCard.tsx web/src/TodoManage.css
git commit -m "refactor(todo-card): use deriveAiState + rename pending_confirm CSS class"
```

---

## Task 3: TranscriptView 状态 chip 接入新推导

**Files:**
- Modify: `web/src/TranscriptView.tsx:46-53` (函数定义), `:754` (唯一调用点)

> TranscriptView 现在显示 5 种状态（运行中/待交互/已完成/失败/已停止），按 spec Q3=a 严格折成 3 态。函数 `sessionStatusMeta` 改成接 `AiPresentationState`；调用点（line 754，主组件内部）补 unread 计算。

- [ ] **Step 3.1: 改 `sessionStatusMeta` 函数签名与实现（line 46-53）**

替换 `TranscriptView.tsx:46-53`：

```tsx
function sessionStatusMeta(state: AiPresentationState) {
  if (state === 'running') return { color: 'processing', text: 'running' }
  if (state === 'pending') return { color: 'error', text: '待确认' }
  return { color: 'default', text: '空闲' }
}
```

- [ ] **Step 3.2: 在文件顶部加 imports**

先 grep 确认是否已 import：

```bash
grep -n "useUnreadStore\|isSessionUnread\|aiPresentationState\|useAiSessionStore" web/src/TranscriptView.tsx
```

未命中的项在 import 区（文件顶部，紧跟其它本地 import 之后）加上：

```tsx
import { deriveAiState, type AiPresentationState } from './design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from './store/unreadStore'
import { useAiSessionStore } from './store/aiSessionStore'
```

> 注意：`data.session`（transcript API 返回）只有 `sessionId / tool / nativeSessionId / status / label / startedAt / completedAt`，**没有 `lastTurnDoneAt`**。我们需要从 `useAiSessionStore` 的 live session 取。

- [ ] **Step 3.3: 改唯一调用点（line 754）**

把：

```tsx
  const statusMeta = sessionStatusMeta(data?.session.status)
```

替换为（主组件函数体内，紧贴原行的位置）：

```tsx
  const transcriptSessionId = data?.session?.sessionId ?? null
  const transcriptLiveSession = useAiSessionStore((s) =>
    transcriptSessionId ? s.sessions.get(transcriptSessionId) : undefined,
  )
  const transcriptLastSeen = useUnreadStore((s) =>
    transcriptSessionId ? s.lastSeenAt.get(transcriptSessionId) : undefined,
  )
  const transcriptUnread = isSessionUnread(
    transcriptLiveSession?.lastTurnDoneAt,
    transcriptLastSeen,
  )
  const transcriptState = deriveAiState(data?.session?.status, transcriptUnread)
  const statusMeta = sessionStatusMeta(transcriptState)
```

> hook 形式（`useAiSessionStore((s) => …)` / `useUnreadStore((s) => …)`）保持响应式：当用户在别处把 session 标已读 / 新 turn_done 产出，TranscriptView 的 chip 会同步刷新。若该 session 已不在 live store（历史会话浏览场景），`transcriptLiveSession` 为 `undefined`，`unread = false`，chip 会按 `data.session.status` 落到 `running` 或 `idle`。

- [ ] **Step 3.4: 编译检查**

Run: `npm --prefix web run build`
Expected: 编译通过。若 TS 报 `state` / `AiPresentationState` 类型错，对照 Step 1 导出修。

- [ ] **Step 3.5: 跑测试**

Run: `npm test`
Expected: 全绿（TranscriptView 无单测，仅依赖编译）。

- [ ] **Step 3.6: 提交**

```bash
git add web/src/TranscriptView.tsx
git commit -m "refactor(transcript): collapse status chip to 3-state strict via deriveAiState"
```

---

## Task 4: FocusSubbar 状态 pill 接入新推导

**Files:**
- Modify: `web/src/components/SessionFocus/FocusSubbar.tsx`

- [ ] **Step 4.1: 改写 `FocusSubbar.tsx`**

把整个 `FocusSubbar.tsx` 替换为：

```tsx
import { Tooltip } from 'antd'
import type { SessionMeta } from '../../store/aiSessionStore'
import { deriveAiState, AI_STATE_PILL_LABEL } from '../../design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  onClose: () => void
}

export function FocusSubbar({ session, onClose }: Props) {
  const title = session?.todoTitle ?? '(untitled)'
  const tool = session?.tool ?? 'ai'
  const sessionShortId = session?.sessionId?.slice(0, 8) ?? '—'
  const quadrant = session?.quadrant ?? 0

  const lastSeen = useUnreadStore((s) =>
    session?.sessionId ? s.lastSeenAt.get(session.sessionId) : undefined,
  )
  const unread = isSessionUnread(session?.lastTurnDoneAt, lastSeen)
  const state = deriveAiState(session?.status, unread)
  const statusLabel = AI_STATE_PILL_LABEL[state]

  const quadColor =
    quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'

  return (
    <div className="focus-subbar">
      <button className="focus-back" onClick={onClose} aria-label="Back to grid">
        <span>←</span>
        <span>Grid</span>
      </button>
      <div className="focus-task-title">
        <span
          className="quad-dot"
          style={{ background: quadColor, boxShadow: `0 0 8px ${quadColor}` }}
        />
        <span>{title}</span>
        <span className="focus-task-id">#{sessionShortId}</span>
      </div>
      <div className="focus-actions">
        <span className="pill-select green">{tool} · {statusLabel}</span>
        <Tooltip title="Close (Esc)">
          <button className="focus-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </Tooltip>
      </div>
    </div>
  )
}
```

> 关键变化：原 5 个 status 分支（运行中/待确认/完成/失败/停止）折成 3 态；引入 `useUnreadStore` 取 `lastSeenAt`。

- [ ] **Step 4.2: 编译 + 测试**

Run: `npm --prefix web run build && npm test`
Expected: 通过。

- [ ] **Step 4.3: 提交**

```bash
git add web/src/components/SessionFocus/FocusSubbar.tsx
git commit -m "refactor(focus-subbar): use deriveAiState + AI_STATE_PILL_LABEL"
```

---

## Task 5: `useDispatchStats` 简化（删 tokenSum、加 idleCount、严格 pending）

**Files:**
- Modify: `web/src/design/useDispatchStats.ts`

> 调用方目前只有 `TopbarDispatch.tsx`，我们在 Task 7 一起改。本任务先把 hook 改造好，让 Task 7 拿到新接口。

- [ ] **Step 5.1: 用整文件替换写新版本**

完整替换 `web/src/design/useDispatchStats.ts`：

```ts
import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../store/unreadStore'
import { deriveAiState } from './aiPresentationState'

export interface DispatchStats {
  /** status === 'running' 的 session 数 */
  runningCount: number
  /** 严格 unread（且非 running）的 session 数 */
  pendingCount: number
  /** 既非 running 也非 unread 的 session 数 */
  idleCount: number
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)

  return useMemo(() => {
    let runningCount = 0
    let pendingCount = 0
    let idleCount = 0
    sessions.forEach((session) => {
      const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
      const state = deriveAiState(session.status, unread)
      if (state === 'running') runningCount += 1
      else if (state === 'pending') pendingCount += 1
      else idleCount += 1
    })
    return { runningCount, pendingCount, idleCount }
  }, [sessions, lastSeenMap])
}
```

> 删除：`tokenSum / tokenSumLabel / formatTokens / activeCount`。接口里 `pendingCount` 字段保留但语义收紧（仅 unread，不再 || pending_confirm）。

- [ ] **Step 5.2: 编译（预期 TS 报 TopbarDispatch 引用 activeCount/tokenSumLabel）**

Run: `npm --prefix web run build`
Expected: FAIL — `TopbarDispatch.tsx` 还在用 `activeCount, tokenSumLabel`。下一个 task 修。

> 因为还在中间状态，不在这步提交。

---

## Task 6: TopbarDispatch 改 3 颗 pill + Popover 简化

**Files:**
- Modify: `web/src/components/TopbarDispatch/TopbarDispatch.tsx`

> 接 Task 5 的编译错误。要做：
> 1. pill 从 `active / tok / pending` 改为 `running / idle / 待确认`。
> 2. `running` 颗保留原 tooltip 行为（列 running sessions）。
> 3. 新 `idle` 颗的 tooltip：列 idle sessions（前 8 条 + 余数）。
> 4. `待确认` 颗 Popover 不动行为，但行内 `item.reason` 相关分支会在 Task 7（replyHub）后变冗余——暂保留 `item.reason === 'pending_confirm'` 的 fallback，本任务先确保不依赖。

- [ ] **Step 6.1: 用整文件替换写新版本**

替换 `web/src/components/TopbarDispatch/TopbarDispatch.tsx`：

```tsx
import { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'
import { deriveAiState } from '../../design/aiPresentationState'
import type { UnreadSessionItem } from '../../replyHub'
import './TopbarDispatch.css'

const IDLE_TOOLTIP_LIMIT = 8

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
}

export function TopbarDispatch({ unreadItems, onJump }: TopbarDispatchProps) {
  const { runningCount, idleCount } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const [pendingOpen, setPendingOpen] = useState(false)

  const sessions = useAiSessionStore((s) => s.sessions)
  const lastSeenMap = useUnreadStore((s) => s.lastSeenAt)
  const runningList: { id: string; title: string; tool: string }[] = []
  const idleList: { id: string; title: string; tool: string }[] = []
  sessions.forEach((session) => {
    const unread = isSessionUnread(session.lastTurnDoneAt, lastSeenMap.get(session.sessionId))
    const state = deriveAiState(session.status, unread)
    const entry = { id: session.sessionId, title: session.todoTitle, tool: session.tool }
    if (state === 'running') runningList.push(entry)
    else if (state === 'idle') idleList.push(entry)
  })

  const pendingCount = unreadItems.length

  const handlePickItem = (item: UnreadSessionItem) => {
    setPendingOpen(false)
    onJump(item)
  }

  const pendingPopoverContent =
    pendingCount === 0 ? (
      <div className="topbar-tooltip-empty">No pending</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">待确认 ({pendingCount})</div>
        <div className="topbar-pending-list">
          {unreadItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="topbar-tooltip-row topbar-pending-row"
              onClick={() => handlePickItem(item)}
              data-testid="topbar-pending-row"
            >
              <span
                className="topbar-tooltip-dot"
                style={{ background: 'var(--ai-pending-confirm)' }}
              />
              <span className="topbar-tooltip-name">{item.todoTitle}</span>
              <span className="topbar-tooltip-meta">{item.tool} · 未读</span>
            </button>
          ))}
        </div>
      </>
    )

  const idleListVisible = idleList.slice(0, IDLE_TOOLTIP_LIMIT)
  const idleRemainder = idleList.length - idleListVisible.length

  return (
    <div className="topbar-dispatch">
      <div className="topbar-logo">
        <div className="topbar-logo-mark">A</div>
        <span>AgentQuad</span>
      </div>

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-running)"
        value={runningCount}
        label="running"
        data-testid="stat-running"
        tooltip={
          runningList.length === 0 ? (
            <div className="topbar-tooltip-empty">No running sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Running sessions ({runningList.length})</div>
              {runningList.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-running)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
            </>
          )
        }
      />

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-idle)"
        value={idleCount}
        label="idle"
        data-testid="stat-idle"
        tooltip={
          idleList.length === 0 ? (
            <div className="topbar-tooltip-empty">No idle sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Idle sessions ({idleList.length})</div>
              {idleListVisible.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-idle)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
              {idleRemainder > 0 && (
                <div className="topbar-tooltip-row">
                  <span className="topbar-tooltip-meta">还有 {idleRemainder} 条</span>
                </div>
              )}
            </>
          )
        }
      />

      <Popover
        open={pendingOpen}
        onOpenChange={setPendingOpen}
        trigger="click"
        placement="bottomRight"
        overlayClassName="topbar-pending-popover"
        content={pendingPopoverContent}
      >
        <span data-testid="stat-pending-trigger">
          <StatPill
            variant={pendingCount > 0 ? 'alert' : 'default'}
            icon="pulse-dot"
            iconColor="var(--ai-pending-confirm)"
            value={pendingCount}
            label="待确认"
            data-testid="stat-pending"
            onClick={() => setPendingOpen((v) => !v)}
          />
        </span>
      </Popover>

      <div className="topbar-spacer" />

      <button className="topbar-cmdk-btn" onClick={togglePalette} data-testid="topbar-cmdk-btn">
        <span className="topbar-cmdk-prefix">⌘</span>
        <span>Search or run a command</span>
        <kbd>⌘K</kbd>
      </button>

      <Tooltip title="历史会话找回">
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('recover')}
          aria-label="Recover session"
          data-testid="topbar-recover-btn"
        >
          <SearchOutlined />
        </button>
      </Tooltip>
      <Tooltip title="Stats &amp; Reports">
        <button className="topbar-icon-btn" onClick={() => openDrawer('statsReports')} data-testid="topbar-stats-btn">📊</button>
      </Tooltip>
      <Tooltip title="Wiki">
        <button className="topbar-icon-btn" onClick={() => openDrawer('wiki')} data-testid="topbar-wiki-btn">📖</button>
      </Tooltip>
      <Tooltip title="Settings">
        <button className="topbar-icon-btn" onClick={() => openDrawer('settings')} data-testid="topbar-settings-btn">⚙</button>
      </Tooltip>
      <ThemeToggle />
    </div>
  )
}
```

> 改动重点：
> - 删 `tok` 颗（替为 `idle` 颗）
> - `active` 颗 → `running` 颗（label + testid 变更）
> - 新 `idle` 颗（tooltip 限 8 条 + 余数）
> - `待确认` 颗 label 从 `pending` 改为 `待确认`
> - Popover 行简化：所有项一律 "未读"，删除 `item.reason === 'pending_confirm'` 分支与"待批准"文案。这是为 Task 7 删 `reason` 字段做准备；这里先不依赖 reason 字段，但因 TS 类型还有 `reason` 字段所以编译能过。

- [ ] **Step 6.2: 编译 + 测试**

Run: `npm --prefix web run build && npm test`
Expected: 编译通过，测试全绿。

- [ ] **Step 6.3: 检查测试 testid 引用**

Run: `grep -rn "stat-active\|stat-tokens" test/ web/src 2>/dev/null`
Expected: 无结果（如有，需要在引用方同步改成 `stat-running` / 删除）。如果 grep 找到任何引用，更新它们后再提交。

- [ ] **Step 6.4: 提交**

```bash
git add web/src/design/useDispatchStats.ts web/src/components/TopbarDispatch/TopbarDispatch.tsx
git commit -m "refactor(topbar): 3 pills running/idle/待确认 via deriveAiState; drop tok pill"
```

---

## Task 7: `replyHub.ts` 删 pending_confirm 分支与 `UnreadReason`

**Files:**
- Modify: `web/src/replyHub.ts`
- Modify: `test/reply-hub.test.ts`

- [ ] **Step 7.1: 先删测试里依赖 pending_confirm 的 case**

> 这些 case 的预期行为现在反了（pending_confirm 不再被特殊处理），不是改 case 而是删 + 新增。

打开 `test/reply-hub.test.ts`，**删除**以下 5 个 it-block（按当前文件行号大致定位）：
- `'includes live pending_confirm sessions even when lastTurnDoneAt is not newer than lastSeen'`（约 line 146）
- `'tags purely unread reply items with reason="unread"'`（约 line 170）
- `'dedupes when a session is both pending_confirm and unread, preferring reason=pending_confirm'`（约 line 181）
- `'sorts mixed reasons by timestamp desc'`（约 line 199）
- `'keeps a pending_confirm session even when lastSeen has already caught up'`（约 line 217）

并在 `describe('buildUnreadSessionItems', () => {` 块内末尾新增：

```ts
  it('excludes pending_confirm sessions that have no unread reply', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Already seen pending_confirm' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastOutputAt: 3000,
        lastTurnDoneAt: null,
      })],
      lastSeenMap: new Map(),
    })

    expect(items).toEqual([])
  })

  it('treats pending_confirm with newer lastTurnDoneAt purely as unread', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Pending with reply' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 5000,
      })],
      lastSeenMap: new Map([['s-pc', 4000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 's-pc', timestamp: 5000 })
    // reason field has been removed in spec
    expect((items[0] as Record<string, unknown>).reason).toBeUndefined()
  })

  it('excludes pending_confirm sessions whose lastSeen already covers the latest reply', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Seen pending' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 1000,
      })],
      lastSeenMap: new Map([['s-pc', 1000]]),
    })

    expect(items).toEqual([])
  })
```

- [ ] **Step 7.2: 跑测试，预期失败**

Run: `npm test -- reply-hub`
Expected: 3 个新 case FAIL（旧实现仍有 pending_confirm 特殊路径），其它原 case 仍通过。

- [ ] **Step 7.3: 改实现，删 pending_confirm 分支与 reason**

完整替换 `web/src/replyHub.ts`：

```ts
import type { AiSession, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export interface UnreadSessionItem {
  id: string
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
}

export interface BuildUnreadSessionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  lastSeenMap: Map<string, number>
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildUnreadSessionItems({ todos, liveSessions, lastSeenMap }: BuildUnreadSessionItemsInput): UnreadSessionItem[] {
  const tsBySid = new Map<string, number>()
  const metaBySid = new Map<string, { todoId: string; todoTitle: string; quadrant: Quadrant; tool: AiTool; label?: string }>()

  for (const todo of todos) {
    for (const session of uniqueTodoSessions(todo)) {
      const ts = session.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(session.sessionId) || 0
        if (ts > prev) tsBySid.set(session.sessionId, ts)
      }
      if (!metaBySid.has(session.sessionId)) {
        metaBySid.set(session.sessionId, {
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          label: session.label,
        })
      }
    }
  }

  for (const live of liveSessions) {
    const ts = live.lastTurnDoneAt || 0
    if (ts > 0) {
      const prev = tsBySid.get(live.sessionId) || 0
      if (ts > prev) tsBySid.set(live.sessionId, ts)
    }
    if (!metaBySid.has(live.sessionId)) {
      metaBySid.set(live.sessionId, {
        todoId: live.todoId,
        todoTitle: live.todoTitle || '(无标题)',
        quadrant: live.quadrant,
        tool: live.tool,
      })
    }
  }

  const items: UnreadSessionItem[] = []
  for (const [sid, ts] of tsBySid) {
    const lastSeen = lastSeenMap.get(sid) || 0
    if (ts <= lastSeen) continue
    const meta = metaBySid.get(sid)
    if (!meta) continue
    items.push({
      id: `unread:${sid}`,
      sessionId: sid,
      timestamp: ts,
      ...meta,
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}
```

> 关键变化：
> - 删 `UnreadReason` 类型导出
> - `UnreadSessionItem` 删 `reason` 字段
> - 删 `pendingConfirmSids` Set + "always include" 分支
> - live session 与 todo session 处理逻辑统一为 "lastTurnDoneAt > lastSeen"

- [ ] **Step 7.4: 跑测试，预期通过**

Run: `npm test -- reply-hub`
Expected: 所有 case PASS。

- [ ] **Step 7.5: 编译检查（顺便确认 TopbarDispatch 没残留 reason 引用）**

Run: `npm --prefix web run build`
Expected: 通过（Task 6 已把 TopbarDispatch 内的 `item.reason` 引用清掉）。

若编译报错某处 `UnreadReason` 找不到：grep 该符号全仓库 (`grep -rn "UnreadReason" web/src`)，找到剩余引用并删除。

- [ ] **Step 7.6: 提交**

```bash
git add web/src/replyHub.ts test/reply-hub.test.ts
git commit -m "refactor(reply-hub): drop pending_confirm special-case and UnreadReason"
```

---

## Task 8: 全量 grep 终检 + 手动回归

**Files:**
- 仅读，不改（除非 grep 发现遗漏）

- [ ] **Step 8.1: 全仓库扫描 `status === 'pending_confirm' || unread` 残留**

Run:
```bash
grep -rn "pending_confirm.*||.*unread\|unread.*||.*pending_confirm" web/src
```
Expected: 无结果。

- [ ] **Step 8.2: 扫描 `UnreadReason` / `pendingConfirmSids` 残留**

Run:
```bash
grep -rn "UnreadReason\|pendingConfirmSids" web/src test
```
Expected: 无结果。

- [ ] **Step 8.3: 扫描 `pending_confirm` 旧 CSS 类名 / 旧标签**

Run:
```bash
grep -rn "todo-ai-state-pending_confirm\|todo-ai-state-done\|todo-ai-state-failed\|todo-ai-state-stopped" web/src
```
Expected: 无结果。

Run:
```bash
grep -rn "运行中\|已完成\|已停止\|待交互" web/src
```
Expected:
- `运行中`：无（FocusSubbar / TranscriptView 已改）。
- `已完成 / 已停止`：无（TranscriptView 已改）。
- `待交互`：剩余命中应**只有** `TodoManage.tsx:128`（这是 `todo.status === 'ai_pending'`，TodoStatus 维度，**不动**）。

若 `运行中 / 已完成 / 已停止` 在 `web/src` 出现，回到对应 task 修。

- [ ] **Step 8.4: 全量测试 + 编译**

Run: `npm test && npm --prefix web run build`
Expected: 全部通过。

- [ ] **Step 8.5: 手动 UI 回归（开发服务器 + 浏览器）**

Run:
```bash
npm --prefix web run dev
```
然后用浏览器打开开发服务器 URL，逐项验证：

**场景 1：running 同步**
1. 在 quadtodo 里创建一个 todo，启动 claude AI 终端，让它产出一段输出。
2. 验证 TodoCard 内联状态显示 `● running`，顶栏 `running` 颗 +1，FocusSubbar pill 显示 `running`（如果进 focus mode）。

**场景 2：待确认 → idle 跃迁（关键）**
1. 在场景 1 的 session，等到 turn_done 后回到 grid（关掉 focus mode）。
2. 验证 TodoCard 显示 `⚠ 待确认`，顶栏 `待确认` Popover 出现该 session。
3. 点击 Popover 行 jump 到该 session（或 ⌘ to focus）。
4. 验证：focus mount → markSeen → 退出 focus 后 TodoCard 显示 `○ 空闲`，顶栏 `待确认` 计数 -1、`idle` 计数 +1。

**场景 3：pending_confirm 严格规则**
1. 触发一个会 ask permission 的 session（claude 提示 y/n 暂停）。
2. **看一眼后退出 focus**：验证 TodoCard 显示 `○ 空闲`（即使后端仍 `pending_confirm`），顶栏 `idle` +1、`待确认` 0。
3. 回到 session 敲 y 让它继续：验证状态变 `● running`。

**场景 4：done/failed/stopped 折叠**
1. 让一个 session 完成（done）。
2. 验证 TodoCard 显示 `○ 空闲`（不再有 done 子标签）。
3. TranscriptView 状态 chip 显示 `空闲`（不再 `已完成`）。

- [ ] **Step 8.6: 提交 final**

> 若 Step 8.5 全部通过且 Step 8.1-8.3 grep 全部干净，本任务无需 commit；若发现残留并修了，按相关任务的 commit message 风格补一个 cleanup commit。

```bash
# 仅当 8.1-8.3 发现并修复了遗漏时执行
git add -p
git commit -m "chore(ai-state): final cleanup after grep audit"
```

- [ ] **Step 8.7: 跑 final 全量验证**

Run: `npm test && npm --prefix web run build`
Expected: 全绿。

---

## 验收（来自 Spec）

- [ ] 行为：三处展示（TodoCard / FocusSubbar / TranscriptView）+ 顶栏计数始终一致。
- [ ] 行为：已读后 `pending_confirm` session 立即变 idle，不需要 backend 状态翻转。
- [ ] 代码清理：仓库内（`web/src/` 范围）**不再出现** `status === 'pending_confirm' || unread`。
- [ ] 代码清理：`replyHub.ts` 不再有 `pendingConfirmSids` / `UnreadReason` / `reason` 字段。
- [ ] 代码清理：顶栏不再有 `tok` 胶囊。
- [ ] 测试：新单测 (`ai-presentation-state.test.ts`) 全绿；调整后的 `reply-hub.test.ts` 全绿；其它现有 test 套件全绿。
- [ ] 手动回归：场景 1-4 全部表现一致。

# Terminal Dock 重构 + Pet 移除 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 终端从「卡片内嵌」迁出来变成右侧 Dock 面板（多 Tab + split + 浮层），同时移除 Pet。

**Architecture:** 新增独立的 `terminalDockStore` (zustand) + `<TerminalDock>` 组件，常驻在 `<TodoManage>` 右侧；卡片只负责调 `dock.activate()`。`<AiTerminalMini>` 实例由 Dock 持有，Tab 切换用 `display:none` 保活，浮层用 React Portal 把同一个 React 节点搬到独立窗口 DOM。`<AttentionRail>` 取代当前的红色 FAB 在左侧 48px 列出待回应会话。Pet 全删。

**Tech Stack:** React 18 / TypeScript / Vite / zustand 5 / Ant Design 5 / xterm 5 + addon-fit + addon-canvas / @dnd-kit/sortable

**Spec:** `docs/superpowers/specs/2026-05-09-terminal-dock-redesign-design.md`

---

## 工作目录

所有路径相对 `quadtodo/`（即 `/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo/`）。

## 启动 dev server（每次任务前确认在跑）

终端 1：
```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
node src/cli.js start --no-open --port 5677
# 或：quadtodo start --no-open
```

终端 2：
```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo/web
npm run dev
# vite 默认 5173；它通过 vite proxy 把 /api、/ws 转发到 5677
```

打开 http://127.0.0.1:5173 验证。

## 全局风格约定

- 路径 / 文件命名：参考现有 `web/src/dashboard/`、`web/src/transcripts/`，新增模块放 `web/src/dock/`。CSS 跟随同名 `.css`。
- zustand 模板：照抄 `web/src/store/aiSessionStore.ts` 的 `create<State>((set) => ({ ... }))` 写法。
- 提交信息：项目沿用 `feat(web): ...` / `refactor(web): ...` / `chore(web): ...` 风格（参考 `git log --oneline`）。

---

## Stage 1：底座（Dock 空壳 + 拖动 + 宽度持久化）

### Task 1：terminalDockStore 骨架

**Files:**
- Create: `web/src/store/terminalDockStore.ts`

- [ ] **Step 1：写 store**

```ts
// web/src/store/terminalDockStore.ts
import { create } from 'zustand'

export type DockTabStatus = 'running' | 'idle' | 'pending_reply' | 'closed'

export interface DockTab {
  id: string           // = sessionId
  todoId: string
  todoTitle: string
  status: DockTabStatus
  createdAt: number
}

interface DockState {
  openTabs: DockTab[]
  activeTabId: string | null
  splitSecondaryTabId: string | null
  poppedOutTabIds: string[]
  widthPx: number
  isCollapsed: boolean

  activate: (todoId: string, sessionId: string, todoTitle: string) => void
  close: (tabId: string) => void
  setActive: (tabId: string) => void
  reorder: (tabIds: string[]) => void
  splitWith: (tabId: string) => void
  unsplit: () => void
  popOut: (tabId: string) => void
  dock: (tabId: string) => void
  setWidth: (px: number) => void
  toggleCollapsed: () => void
  setStatus: (tabId: string, status: DockTabStatus) => void
  setTodoTitle: (todoId: string, title: string) => void
}

const WIDTH_KEY = 'quadtodo.dock.width'
const COLLAPSED_KEY = 'quadtodo.dock.collapsed'
const MIN_W = 320
const MAX_W = 720
const DEFAULT_W = 480

const readWidth = (): number => {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(v) && v >= MIN_W && v <= MAX_W) return v
  } catch {}
  return DEFAULT_W
}
const readCollapsed = (): boolean => {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return true }
}
const writeWidth = (px: number) => { try { localStorage.setItem(WIDTH_KEY, String(px)) } catch {} }
const writeCollapsed = (c: boolean) => { try { localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0') } catch {} }

export const useTerminalDockStore = create<DockState>((set, get) => ({
  openTabs: [],
  activeTabId: null,
  splitSecondaryTabId: null,
  poppedOutTabIds: [],
  widthPx: readWidth(),
  isCollapsed: readCollapsed(),

  activate: (todoId, sessionId, todoTitle) => {
    const { openTabs } = get()
    const exists = openTabs.find(t => t.id === sessionId)
    if (exists) {
      set({ activeTabId: sessionId, isCollapsed: false })
      writeCollapsed(false)
      return
    }
    const next: DockTab = {
      id: sessionId,
      todoId,
      todoTitle,
      status: 'running',
      createdAt: Date.now(),
    }
    set({ openTabs: [...openTabs, next], activeTabId: sessionId, isCollapsed: false })
    writeCollapsed(false)
  },

  close: (tabId) => {
    const { openTabs, activeTabId, splitSecondaryTabId, poppedOutTabIds } = get()
    const remaining = openTabs.filter(t => t.id !== tabId)
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      nextActive = remaining[remaining.length - 1]?.id ?? null
    }
    set({
      openTabs: remaining,
      activeTabId: nextActive,
      splitSecondaryTabId: splitSecondaryTabId === tabId ? null : splitSecondaryTabId,
      poppedOutTabIds: poppedOutTabIds.filter(id => id !== tabId),
    })
  },

  setActive: (tabId) => set({ activeTabId: tabId }),

  reorder: (tabIds) => {
    const { openTabs } = get()
    const map = new Map(openTabs.map(t => [t.id, t]))
    const next = tabIds.map(id => map.get(id)).filter(Boolean) as DockTab[]
    if (next.length === openTabs.length) set({ openTabs: next })
  },

  splitWith: (tabId) => {
    const { activeTabId } = get()
    if (!activeTabId || activeTabId === tabId) return
    set({ splitSecondaryTabId: tabId })
  },
  unsplit: () => set({ splitSecondaryTabId: null }),

  popOut: (tabId) => {
    const { poppedOutTabIds } = get()
    if (poppedOutTabIds.includes(tabId)) return
    if (poppedOutTabIds.length >= 4) return
    set({ poppedOutTabIds: [...poppedOutTabIds, tabId] })
  },
  dock: (tabId) => {
    const { poppedOutTabIds } = get()
    set({ poppedOutTabIds: poppedOutTabIds.filter(id => id !== tabId) })
  },

  setWidth: (px) => {
    const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(px)))
    set({ widthPx: clamped })
    writeWidth(clamped)
  },
  toggleCollapsed: () => {
    const { isCollapsed } = get()
    const next = !isCollapsed
    set({ isCollapsed: next })
    writeCollapsed(next)
  },

  setStatus: (tabId, status) => {
    const { openTabs } = get()
    set({ openTabs: openTabs.map(t => t.id === tabId ? { ...t, status } : t) })
  },
  setTodoTitle: (todoId, title) => {
    const { openTabs } = get()
    set({ openTabs: openTabs.map(t => t.todoId === todoId ? { ...t, todoTitle: title } : t) })
  },
}))

export const DOCK_LIMITS = { MIN_W, MAX_W, DEFAULT_W }
```

- [ ] **Step 2：smoke check**

```bash
cd web && npx tsc -b --noEmit
```

期望：无类型错误。

- [ ] **Step 3：commit**

```bash
git add web/src/store/terminalDockStore.ts
git commit -m "feat(web): add terminalDockStore for terminal dock state"
```

---

### Task 2：空壳 TerminalDock + 拖动分隔条

**Files:**
- Create: `web/src/dock/TerminalDock.tsx`
- Create: `web/src/dock/dock.css`

- [ ] **Step 1：写 TerminalDock 空壳**

```tsx
// web/src/dock/TerminalDock.tsx
import React, { useCallback, useEffect, useRef } from 'react'
import { Button, Tooltip } from 'antd'
import { CloseOutlined, MenuFoldOutlined } from '@ant-design/icons'
import { useTerminalDockStore, DOCK_LIMITS } from '../store/terminalDockStore'
import './dock.css'

export default function TerminalDock() {
  const { widthPx, isCollapsed, openTabs, toggleCollapsed, setWidth } = useTerminalDockStore()
  const dragStartRef = useRef<{ x: number; w: number } | null>(null)

  const onMouseDownDivider = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, w: widthPx }
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      // 分隔条向左拖 -> width 增大
      const next = start.w + (start.x - ev.clientX)
      setWidth(next)
    }
    const onUp = () => {
      dragStartRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [widthPx, setWidth])

  if (isCollapsed) {
    return (
      <div className="terminal-dock terminal-dock--collapsed">
        <Tooltip title="展开 AI 终端 Dock">
          <Button
            type="text"
            icon={<MenuFoldOutlined style={{ transform: 'scaleX(-1)' }} />}
            onClick={toggleCollapsed}
            className="terminal-dock__expand-btn"
          />
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      className="terminal-dock"
      style={{ width: widthPx, minWidth: DOCK_LIMITS.MIN_W, maxWidth: DOCK_LIMITS.MAX_W }}
    >
      <div className="terminal-dock__divider" onMouseDown={onMouseDownDivider} />
      <div className="terminal-dock__head">
        <span className="terminal-dock__title">AI 终端 Dock</span>
        <span className="terminal-dock__count">{openTabs.length} 个会话</span>
        <Tooltip title="折叠">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={toggleCollapsed} />
        </Tooltip>
      </div>
      <div className="terminal-dock__body">
        {openTabs.length === 0 ? (
          <div className="terminal-dock__empty">没有打开的会话</div>
        ) : (
          <div className="terminal-dock__placeholder">[会话渲染区]</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2：写最小可见的 dock.css**

```css
/* web/src/dock/dock.css */
.terminal-dock {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  height: 100%;
  border-left: 1px solid #d9d9d9;
  background: #fff;
  user-select: none;
}
.terminal-dock--collapsed {
  width: 24px;
  flex: 0 0 24px;
  align-items: center;
  justify-content: flex-start;
  padding-top: 8px;
}
.terminal-dock__divider {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 5;
}
.terminal-dock__divider:hover {
  background: rgba(22, 119, 255, 0.2);
}
.terminal-dock__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #f0f0f0;
}
.terminal-dock__title { font-weight: 600; flex: 1; }
.terminal-dock__count { color: #8c8c8c; font-size: 12px; }
.terminal-dock__body { flex: 1; min-height: 0; overflow: hidden; }
.terminal-dock__empty,
.terminal-dock__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #bfbfbf;
}
.terminal-dock__expand-btn { padding: 4px; }
```

- [ ] **Step 3：commit**

```bash
git add web/src/dock/
git commit -m "feat(web): add empty TerminalDock shell with resizable divider"
```

---

### Task 3：在 TodoManage 中挂占位 Dock，验证布局让位

**Files:**
- Modify: `web/src/TodoManage.tsx`（外层布局容器）

- [ ] **Step 1：定位 TodoManage 的最外层 wrapper**

```bash
grep -n "return (" web/src/TodoManage.tsx | head -5
grep -n "todo-manage\|todoManageRoot\|className=\"todo-manage" web/src/TodoManage.tsx | head -10
```

确认主页面外层 div 的 className（很可能是 `todo-manage` 或类似）。如果当前是 `<div className="todo-manage">{...}</div>` 单层，目标改成：

```tsx
<div className="todo-manage todo-manage--with-dock">
  <div className="todo-manage__main">{/* 原有内容 */}</div>
  <TerminalDock />
</div>
```

- [ ] **Step 2：插入 TerminalDock**

在 TodoManage.tsx 文件顶部加 import：

```tsx
import TerminalDock from './dock/TerminalDock'
```

把最外层包成 flex row 布局（参考 dock.css 已定义的 `.terminal-dock` 是 flex 子元素）：

修改最外层 JSX。**关键**：原最外层结构是个 `<div>` 加各种 children；包一层 flex row 容器，主内容区接管剩余空间，Dock 在右侧。

具体定位 + 修改步骤：
1. 找到 `function TodoManage()` 内部的 `return (`
2. 把现有最外层 div 重命名为 `<div className="todo-manage__main">`
3. 在外面再包 `<div className="todo-manage-shell">`
4. `<TerminalDock />` 作为 sibling 放在 `__main` 之后

- [ ] **Step 3：在 TodoManage.css 加 shell 布局**

```css
/* 追加到 web/src/TodoManage.css */
.todo-manage-shell {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100vh;
  min-height: 0;
}
.todo-manage__main {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
```

注意：原来的 `.todo-manage`（如有 100vh / overflow / padding）留给 `__main` 的内层；shell 只管横向布局。如果原 `.todo-manage` 有 `padding`，在 `__main` 上保留即可。

- [ ] **Step 4：dev server 验证**

启动 dev server（见文件顶部「启动 dev server」），打开 http://127.0.0.1:5173。

期望：
- 默认看板全宽（Dock 处于 collapsed，只占 24px 右侧细条）
- 点 24px 细条上的箭头按钮 → Dock 展开成 480px，看板让位
- 拖左侧分隔条改宽度，Dock 实时变宽，松手宽度持久化
- 刷新页面 → Dock 仍在展开状态、宽度仍是上次的值
- 折叠 → 看板全宽
- 刷新 → Dock 还是折叠状态

`localStorage.getItem('quadtodo.dock.width')` 在 console 里能读到值。

- [ ] **Step 5：commit**

```bash
git add web/src/TodoManage.tsx web/src/TodoManage.css
git commit -m "feat(web): mount TerminalDock placeholder in TodoManage layout"
```

---

## Stage 2：迁移（把 AiTerminalMini 接进 Dock，下线卡片内嵌渲染）

### Task 4：TerminalDockTab + 单会话渲染

**Files:**
- Create: `web/src/dock/TerminalDockTab.tsx`
- Modify: `web/src/dock/TerminalDock.tsx`

- [ ] **Step 1：写 TerminalDockTab**

```tsx
// web/src/dock/TerminalDockTab.tsx
import React from 'react'
import AiTerminalMini from '../AiTerminalMini'
import { TodoStatus, ResumeSessionInput } from '../api'
import { useTerminalDockStore, DockTab } from '../store/terminalDockStore'

interface Props {
  tab: DockTab
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  visible: boolean   // false 时 display:none，xterm 实例保活
  onSessionRecovered?: (next: string) => void
  onSessionSwitch?: (next: string) => void
  onDone?: (r: { status: string; exitCode?: number }) => void
}

export default function TerminalDockTab({
  tab, cwd, resumeTarget, visible,
  onSessionRecovered, onSessionSwitch, onDone,
}: Props) {
  const close = useTerminalDockStore(s => s.close)
  const setStatus = useTerminalDockStore(s => s.setStatus)

  return (
    <div
      className="terminal-dock-tab"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}
    >
      <AiTerminalMini
        sessionId={tab.id}
        todoId={tab.todoId}
        status={tab.status === 'pending_reply' ? 'pending_confirm' as TodoStatus : 'doing' as TodoStatus}
        cwd={cwd}
        resumeTarget={resumeTarget}
        onSessionRecovered={(next) => {
          // sessionId 改变：dock store 不直接知道映射，先交给上层回调
          onSessionRecovered?.(next)
        }}
        onSessionSwitch={onSessionSwitch}
        onClose={() => close(tab.id)}
        onDone={(r) => {
          setStatus(tab.id, r.exitCode === 0 ? 'idle' : 'closed')
          onDone?.(r)
        }}
        fillHeight
      />
    </div>
  )
}
```

> **注意**：`AiTerminalMini` 的 `status` prop 接受 `TodoStatus`。Dock 自己的 `DockTabStatus` 是子集映射；具体映射在 Stage 3 完善，MVP 用 `'doing'` 让终端正常工作。

- [ ] **Step 2：在 TerminalDock 渲染所有 openTabs**

修改 `web/src/dock/TerminalDock.tsx`，把 `__placeholder` 区域换成实际渲染：

```tsx
// 在 import 区
import TerminalDockTab from './TerminalDockTab'
import { useTodoSessionMeta } from '../hooks/useTodoSessionMeta'  // 新建，见下

// 在 body 渲染处替换
<div className="terminal-dock__body">
  {openTabs.length === 0 ? (
    <div className="terminal-dock__empty">没有打开的会话</div>
  ) : (
    openTabs.map(tab => (
      <TerminalDockTab
        key={tab.id}
        tab={tab}
        cwd={null}      // Stage 3 接通真实 cwd
        visible={tab.id === activeTabId}
      />
    ))
  )}
</div>
```

并把 `activeTabId` 从 store 拿出：
```tsx
const { widthPx, isCollapsed, openTabs, activeTabId, toggleCollapsed, setWidth } = useTerminalDockStore()
```

- [ ] **Step 3：在 TodoManage 顶栏加一个临时调试按钮（用完即删）**

为了在卡片侧改造前能验证 Dock 自己工作，临时加一个 debug 按钮触发 dock.activate：

在 TodoManage.tsx 现有顶栏按钮区域加：
```tsx
<Button
  size="small"
  onClick={() => {
    const t = todos[0]
    if (!t) return
    const sid = t.aiSession?.sessionId
    if (!sid) { alert('第一个 todo 没有 session'); return }
    useTerminalDockStore.getState().activate(t.id, sid, t.title)
  }}
>
  [debug] 把第一个 todo 的会话扔进 Dock
</Button>
```

import：
```tsx
import { useTerminalDockStore } from './store/terminalDockStore'
```

- [ ] **Step 4：dev server 验证**

1. 找一个有 AI 会话的 todo（`aiSession.sessionId` 非空），点[debug]按钮
2. 期望：Dock 自动展开，里面挂出 AiTerminalMini，xterm 输出可见，可以输入命令
3. 折叠 Dock 再展开 → 终端连接保持、scrollback 不丢
4. 拖动分隔条改宽 → xterm 自动 fit，无 1px 闪烁

如果 xterm 拖动时高频 fit 抖动，回去 store 的 `setWidth` 加 rAF 节流——但 `AiTerminalMini` 内已有节流，应该够用。

- [ ] **Step 5：删除 debug 按钮**（功能验证完毕）

把 Step 3 加的 Button 块删掉。

- [ ] **Step 6：commit**

```bash
git add web/src/dock/ web/src/TodoManage.tsx
git commit -m "feat(web): render AiTerminalMini inside TerminalDock"
```

---

### Task 5：卡片"打开 AI 终端"按钮接 dock.activate

**Files:**
- Modify: `web/src/TodoManage.tsx`

- [ ] **Step 1：找到 SortableTodoCard 内 onOpenTerminal 的调用点**

```bash
grep -n "onOpenTerminal\|onAiExec\b" web/src/TodoManage.tsx | head -20
```

参考 `SortableTodoCard` 的 props（`TodoManage.tsx:179`）：当前是父级 `setExpandedTerminal({ todoId, sessionId })`。

- [ ] **Step 2：定义 dock activate 回调**

在 TodoManage 的主组件函数体内（`function TodoManage()` 顶部 hook 区域附近）加：

```tsx
const dockActivate = useTerminalDockStore(s => s.activate)
const handleOpenTerminalInDock = useCallback((todoId: string, sessionId: string) => {
  const todo = todosRef.current.find(t => t.id === todoId)  // 或用现有 state
  dockActivate(todoId, sessionId, todo?.title ?? '(无标题)')
}, [dockActivate])
```

> 找现有最近的 `todos` state，复用。如果当前实现里有 `todosRef` 就用，没有就用 closure 拿到的 `todos.find(...)`。

- [ ] **Step 3：把 setExpandedTerminal 调用替换成 handleOpenTerminalInDock**

搜索所有 `setExpandedTerminal(` 出现的位置（在 `TodoManage.tsx` 内）。对于"用户主动打开终端"的入口（点击卡片按钮、AttentionHub 入口），改成 `handleOpenTerminalInDock(todoId, sessionId)`。

**保留**：`setExpandedTerminal(null)` 的关闭逻辑暂时留着，Stage 5 清理。

- [ ] **Step 4：让卡片不再渲染 AiTerminalMini**

定位 `SortableTodoCard` 内部渲染 `<AiTerminalMini />` 的代码块（约 `TodoManage.tsx:574-690` 之间，包含 `terminalOpen ? ...` 判断和 `todo-terminal-body` 容器）。

把整个内嵌终端的 JSX 删除：
- `terminalOpen ? <AiTerminalMini ... /> : null` 删除
- `todo-terminal-body` 容器整块删除
- `sideBySide` 条件渲染块也删除（CSS 类 `.side-by-side` 资产保留）

- [ ] **Step 5：清理 SortableTodoCard 的 props**

从 `SortableTodoCardProps` 移除：
- `expandedTerminal`、`setExpandedTerminal`
- `hiddenTerminalSessionId`、`hiddenTerminalSessionIdByTodo`、`onHideTerminal`、`onShowTerminal`
- `terminalCollapsed`、`collapsedTerminalByTodo`、`onToggleTerminalCollapsed`
- `sideBySideSessionId`、`sideBySideByTodo`、`onSetSideBySide`

同步从 QuadrantZone props 移除（`TodoManage.tsx:689-704` 区域）。

同步从 `TodoManage` 主体里把这些 state / setter 全部删除，并清理传参。

- [ ] **Step 6：dev server 验证**

1. 重启前端
2. 任意 todo 点"打开 AI 终端"按钮
3. 期望：卡片本身不再展开任何东西；Dock 自动展开 + 出 Tab + xterm 可用
4. 关闭 Dock 折叠按钮再展开 → 会话保活
5. 检查：浏览器控制台无 React warnings 或 undefined 报错
6. 再点同一个 todo 的按钮 → Dock 不会创建重复 Tab，只是切到该 Tab

- [ ] **Step 7：commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "refactor(web): route open-terminal button to TerminalDock, remove inline render"
```

---

### Task 6：清理卡片内嵌终端遗留 CSS + 验证四象限恢复

**Files:**
- Modify: `web/src/TodoManage.css`

- [ ] **Step 1：定位与卡片内终端相关的 CSS 类**

```bash
grep -n "todo-terminal-body\|side-by-side\|todo-terminal-collapsed" web/src/TodoManage.css | head -30
```

- [ ] **Step 2：删除已不复存在的 DOM 对应的样式**

删除：
- `.todo-terminal-body` 及其所有 `&.side-by-side` 嵌套
- 卡片内 terminal 折叠/展开动画相关
- 与 expandedTerminal 关联的卡片高度撑开规则

**保留**：`.side-by-side` 通用列容器样式（如有），后续 split 模式复用。

- [ ] **Step 3：dev server 验证**

1. 看板上卡片高度回到正常（不会因为内嵌终端被强制撑高）
2. 没有任何"按按钮无反应"或"按钮残留 hover 样式找不到目标"的视觉异常

- [ ] **Step 4：commit**

```bash
git add web/src/TodoManage.css
git commit -m "chore(web): remove dead inline-terminal CSS"
```

---

## Stage 3：多会话（Tab 头 + 切换 + 重排）

### Task 7：Tab 头渲染 + 切换 + 关闭

**Files:**
- Modify: `web/src/dock/TerminalDock.tsx`
- Modify: `web/src/dock/dock.css`

- [ ] **Step 1：在 TerminalDock head 下增加 Tab 列**

在 `TerminalDock.tsx` 中，`__head` 之后、`__body` 之前插入：

```tsx
{openTabs.length > 0 && (
  <div className="terminal-dock__tabs">
    {openTabs.map(tab => (
      <div
        key={tab.id}
        className={`terminal-dock__tab ${tab.id === activeTabId ? 'is-active' : ''}`}
        onClick={() => useTerminalDockStore.getState().setActive(tab.id)}
        onMouseDown={(e) => {
          if (e.button === 1) {  // middle click 关闭
            e.preventDefault()
            useTerminalDockStore.getState().close(tab.id)
          }
        }}
        title={tab.todoTitle}
      >
        <span className={`terminal-dock__tab-dot status-${tab.status}`} />
        <span className="terminal-dock__tab-label">
          {tab.todoTitle.length > 14 ? tab.todoTitle.slice(0, 14) + '…' : tab.todoTitle}
        </span>
        <CloseOutlined
          className="terminal-dock__tab-close"
          onClick={(e) => {
            e.stopPropagation()
            useTerminalDockStore.getState().close(tab.id)
          }}
        />
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2：tab 样式**

追加到 `web/src/dock/dock.css`：

```css
.terminal-dock__tabs {
  display: flex;
  flex-direction: row;
  gap: 2px;
  padding: 4px 6px 0 6px;
  border-bottom: 1px solid #f0f0f0;
  background: #fafafa;
  overflow-x: auto;
}
.terminal-dock__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  flex: 0 0 auto;
  user-select: none;
  font-size: 12px;
  color: #595959;
}
.terminal-dock__tab:hover { background: #f0f0f0; }
.terminal-dock__tab.is-active {
  background: #fff;
  border-color: #d9d9d9;
  border-bottom-color: #fff;
  margin-bottom: -1px;
  color: #262626;
  font-weight: 500;
}
.terminal-dock__tab-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #bfbfbf;
}
.terminal-dock__tab-dot.status-running { background: #52c41a; }
.terminal-dock__tab-dot.status-pending_reply { background: #faad14; }
.terminal-dock__tab-dot.status-idle { background: #bfbfbf; }
.terminal-dock__tab-dot.status-closed { background: #ff4d4f; }
.terminal-dock__tab-close {
  font-size: 10px;
  opacity: 0.5;
}
.terminal-dock__tab-close:hover { opacity: 1; color: #ff4d4f; }
```

- [ ] **Step 3：dev server 验证**

1. 打开两个不同 todo 的终端 → 顶部出现两个 Tab
2. 点 Tab 切换 → xterm 正确切换可见，内容保留
3. 中键点击 / 点 ✕ 关闭 Tab → 关掉的 Tab 消失，剩余 Tab 中相邻一个变 active
4. 关闭最后一个 Tab → body 显示"没有打开的会话"

- [ ] **Step 4：commit**

```bash
git add web/src/dock/
git commit -m "feat(web): tab strip with click switch and close in TerminalDock"
```

---

### Task 8：Tab 拖动重排（dnd-kit Sortable）

**Files:**
- Modify: `web/src/dock/TerminalDock.tsx`

- [ ] **Step 1：替换 tabs 渲染为 dnd-kit Sortable**

参考 `web/src/TodoManage.tsx` 现有 `@dnd-kit/sortable` 用法（已有 `DndContext` / `SortableContext`）。在 TerminalDock 内：

```tsx
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// 抽出单 tab 子组件
function SortableDockTab({ tab, isActive }: { tab: DockTab; isActive: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: tab.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const { setActive, close } = useTerminalDockStore.getState()
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes} {...listeners}
      className={`terminal-dock__tab ${isActive ? 'is-active' : ''}`}
      onClick={() => setActive(tab.id)}
      onMouseDown={(e) => {
        if (e.button === 1) { e.preventDefault(); close(tab.id) }
      }}
      title={tab.todoTitle}
    >
      <span className={`terminal-dock__tab-dot status-${tab.status}`} />
      <span className="terminal-dock__tab-label">
        {tab.todoTitle.length > 14 ? tab.todoTitle.slice(0, 14) + '…' : tab.todoTitle}
      </span>
      <CloseOutlined
        className="terminal-dock__tab-close"
        onClick={(e) => { e.stopPropagation(); close(tab.id) }}
      />
    </div>
  )
}
```

替换 tabs 区域：

```tsx
const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor))
const onDragEnd = (e: DragEndEvent) => {
  const { active, over } = e
  if (!over || active.id === over.id) return
  const ids = openTabs.map(t => t.id)
  const oldIdx = ids.indexOf(String(active.id))
  const newIdx = ids.indexOf(String(over.id))
  if (oldIdx < 0 || newIdx < 0) return
  useTerminalDockStore.getState().reorder(arrayMove(ids, oldIdx, newIdx))
}

{openTabs.length > 0 && (
  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
    <SortableContext items={openTabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
      <div className="terminal-dock__tabs">
        {openTabs.map(t => (
          <SortableDockTab key={t.id} tab={t} isActive={t.id === activeTabId} />
        ))}
      </div>
    </SortableContext>
  </DndContext>
)}
```

- [ ] **Step 2：dev server 验证**

1. 开 3 个 Tab → 拖中间 Tab 到首位 → 顺序变化
2. 重排后切换 Tab → 仍然激活正确会话
3. 拖动时不会误触发"切换 active"（PointerSensor 默认有 8px 距离阈值）

如果点击被拖拽劫持，加 `activationConstraint: { distance: 6 }` 到 PointerSensor 选项。

- [ ] **Step 3：commit**

```bash
git add web/src/dock/TerminalDock.tsx
git commit -m "feat(web): drag-reorder tabs in TerminalDock"
```

---

### Task 9：Tab 状态实时刷新（status 颜色点同步）

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`（小幅；通过 onDone 回调更新 status）
- Modify: `web/src/dock/TerminalDockTab.tsx`

- [ ] **Step 1：分析现状**

`AiTerminalMini` 已经在内部跟踪 `sessionStatus`（行 77-78）并在状态变化时调 `setSessionStatus`，但**没有暴露给外部**。它只在 `onDone` 时调一次回调。

为了让 Tab 颜色点实时反映会话状态，新增 prop `onStatusChange?: (status: TodoStatus) => void`。

修改 `AiTerminalMini.tsx:29-40` props 接口：

```ts
interface Props {
  sessionId: string
  todoId: string
  status: TodoStatus
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  onSessionSwitch?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
  onStatusChange?: (status: TodoStatus) => void   // 新增
  fillHeight?: boolean
}
```

在函数体最顶（54 行附近）解构加上 `onStatusChange`。然后在 `setSessionStatus` 被调用的地方（搜索 `setSessionStatus(`）后跟一行：

```ts
onStatusChange?.(nextStatus)
```

> **简化**：可以加一个 `useEffect` 监听 `sessionStatus` 变更并调 `onStatusChange`：

```ts
useEffect(() => {
  onStatusChange?.(sessionStatus)
}, [sessionStatus, onStatusChange])
```

- [ ] **Step 2：在 TerminalDockTab 接 onStatusChange → setStatus**

```tsx
// 在 AiTerminalMini props 中加：
onStatusChange={(s) => {
  // 把 TodoStatus 映射回 DockTabStatus
  const map: Record<string, DockTabStatus> = {
    'pending_confirm': 'pending_reply',
    'doing': 'running',
    'done': 'idle',
    'failed': 'closed',
    'todo': 'idle',
  }
  setStatus(tab.id, map[s] ?? 'idle')
}}
```

> import `DockTabStatus` from `terminalDockStore`。

- [ ] **Step 3：dev server 验证**

1. 启动一个会话 → Tab 上点为绿色（running）
2. 等会话进入 pending_confirm（或手动让它要求确认）→ 点变黄（pending_reply）
3. 让会话完成 → 点变灰（idle）

如果 pending_confirm 不容易复现，先用 console 手工 dispatch 验证：
```js
useTerminalDockStore.getState().setStatus('<sessionId>', 'pending_reply')
```
然后看 Tab 颜色。

- [ ] **Step 4：commit**

```bash
git add web/src/AiTerminalMini.tsx web/src/dock/TerminalDockTab.tsx
git commit -m "feat(web): sync session status to dock tab indicator"
```

---

## Stage 4：split + 浮层

### Task 10：split 双列模式

**Files:**
- Modify: `web/src/dock/TerminalDock.tsx`
- Modify: `web/src/dock/dock.css`

- [ ] **Step 1：在 dock head 加"⫶ 拆分"下拉**

```tsx
import { Dropdown } from 'antd'
import { ColumnWidthOutlined, MergeCellsOutlined } from '@ant-design/icons'

// 在 head 内活动 tab 控制区
{activeTabId && (
  <Dropdown
    menu={{
      items: openTabs
        .filter(t => t.id !== activeTabId)
        .map(t => ({ key: t.id, label: `↔ ${t.todoTitle}` })),
      onClick: ({ key }) => {
        const canSplit = widthPx >= 720 && window.innerWidth >= 1280
        if (!canSplit) {
          // 用 antd message 提示
          return
        }
        useTerminalDockStore.getState().splitWith(key as string)
      },
    }}
    trigger={['click']}
  >
    <Button type="text" size="small" icon={<ColumnWidthOutlined />} title="并排比对" />
  </Dropdown>
)}
{splitSecondaryTabId && (
  <Button
    type="text" size="small"
    icon={<MergeCellsOutlined />}
    onClick={() => useTerminalDockStore.getState().unsplit()}
    title="退出并排"
  />
)}
```

- [ ] **Step 2：body 渲染逻辑改成支持双列**

```tsx
<div className={`terminal-dock__body ${splitSecondaryTabId ? 'is-split' : ''}`}>
  {openTabs.length === 0 && (
    <div className="terminal-dock__empty">没有打开的会话</div>
  )}
  {openTabs.map(tab => {
    const isPrimaryVisible = tab.id === activeTabId
    const isSecondaryVisible = tab.id === splitSecondaryTabId
    if (!isPrimaryVisible && !isSecondaryVisible) {
      return <TerminalDockTab key={tab.id} tab={tab} visible={false} />
    }
    return (
      <div key={tab.id} className={`terminal-dock__pane ${isSecondaryVisible ? 'is-secondary' : 'is-primary'}`}>
        <TerminalDockTab tab={tab} visible={true} />
      </div>
    )
  })}
</div>
```

- [ ] **Step 3：CSS**

```css
.terminal-dock__body.is-split {
  display: flex;
  flex-direction: row;
}
.terminal-dock__pane {
  flex: 1;
  min-width: 0;
  height: 100%;
  border-left: 1px solid #f0f0f0;
}
.terminal-dock__pane:first-child { border-left: none; }
.terminal-dock__pane.is-secondary {
  border-left: 2px solid #1677ff;
}
```

- [ ] **Step 4：dev server 验证**

1. 把 Dock 拖到 ≥ 720 宽 + 浏览器窗口 ≥ 1280
2. 点"⫶ 拆分"→ 选另一个 Tab → 右侧出现第二列
3. 两个 xterm 都可输入
4. 点"合并" → 回到单列

- [ ] **Step 5：commit**

```bash
git add web/src/dock/
git commit -m "feat(web): split mode in TerminalDock for side-by-side sessions"
```

---

### Task 11：浮层 PopOutTerminalWindow（含 Portal 保活）

**Files:**
- Create: `web/src/dock/PopOutTerminalWindow.tsx`
- Modify: `web/src/dock/TerminalDock.tsx`

- [ ] **Step 1：写 PopOutTerminalWindow**

```tsx
// web/src/dock/PopOutTerminalWindow.tsx
import React, { useRef, useState, useCallback, useEffect } from 'react'
import { Button, Tooltip } from 'antd'
import {
  CloseOutlined,
  PushpinOutlined,
  MinusOutlined,
  ExpandOutlined,
} from '@ant-design/icons'
import { useTerminalDockStore } from '../store/terminalDockStore'
import './popout.css'

interface Props {
  tabId: string
  initialX?: number
  initialY?: number
  children: React.ReactNode  // 真正的 TerminalDockTab 渲染由父级（Portal 内）注入
}

export default function PopOutTerminalWindow({ tabId, initialX = 200, initialY = 120, children }: Props) {
  const dock = useTerminalDockStore(s => s.dock)
  const close = useTerminalDockStore(s => s.close)
  const tab = useTerminalDockStore(s => s.openTabs.find(t => t.id === tabId))
  const [pos, setPos] = useState({ x: initialX, y: initialY })
  const [size, setSize] = useState({ w: 720, h: 480 })
  const [chip, setChip] = useState(false)

  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y }
    const onMove = (ev: MouseEvent) => {
      const r = dragRef.current; if (!r) return
      setPos({ x: r.ox + (ev.clientX - r.startX), y: r.oy + (ev.clientY - r.startY) })
    }
    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos])

  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null)
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: size.w, oh: size.h }
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current; if (!r) return
      setSize({
        w: Math.max(360, r.ow + (ev.clientX - r.startX)),
        h: Math.max(240, r.oh + (ev.clientY - r.startY)),
      })
    }
    const onUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [size])

  if (!tab) return null

  if (chip) {
    return (
      <div
        className="popout-chip"
        onClick={() => setChip(false)}
        title={tab.todoTitle}
      >
        <span className={`terminal-dock__tab-dot status-${tab.status}`} />
        <span className="popout-chip__label">
          {tab.todoTitle.length > 18 ? tab.todoTitle.slice(0, 18) + '…' : tab.todoTitle}
        </span>
      </div>
    )
  }

  return (
    <div className="popout-window" style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}>
      <div className="popout-window__head" onMouseDown={onHeaderMouseDown}>
        <span className={`terminal-dock__tab-dot status-${tab.status}`} />
        <span className="popout-window__title">{tab.todoTitle}</span>
        <Tooltip title="收回 Dock">
          <Button type="text" size="small" icon={<PushpinOutlined />} onClick={() => dock(tabId)} />
        </Tooltip>
        <Tooltip title="缩成 chip">
          <Button type="text" size="small" icon={<MinusOutlined />} onClick={() => setChip(true)} />
        </Tooltip>
        <Tooltip title="关闭会话">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => close(tabId)} />
        </Tooltip>
      </div>
      <div className="popout-window__body">{children}</div>
      <div className="popout-window__resize" onMouseDown={onResizeMouseDown}>
        <ExpandOutlined />
      </div>
    </div>
  )
}
```

- [ ] **Step 2：CSS**

Create `web/src/dock/popout.css`：

```css
.popout-window {
  position: fixed;
  z-index: 900;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
}
.popout-window__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid #f0f0f0;
  cursor: move;
  user-select: none;
}
.popout-window__title { flex: 1; font-weight: 500; }
.popout-window__body { flex: 1; min-height: 0; overflow: hidden; }
.popout-window__resize {
  position: absolute;
  right: 0; bottom: 0;
  width: 18px; height: 18px;
  cursor: nwse-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bfbfbf;
  transform: rotate(90deg);
}
.popout-chip {
  position: fixed;
  right: 16px; bottom: 16px;
  z-index: 900;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.12);
  cursor: pointer;
  font-size: 12px;
  user-select: none;
}
.popout-chip:hover { background: #fafafa; }
.popout-chip__label { color: #595959; }
```

引入到 PopOutTerminalWindow.tsx。

- [ ] **Step 3：在 TerminalDock 添加"⤢ 弹出"按钮 + Portal 渲染**

```tsx
import { createPortal } from 'react-dom'
import PopOutTerminalWindow from './PopOutTerminalWindow'

// head 区按钮
{activeTabId && !poppedOutTabIds.includes(activeTabId) && (
  <Button
    type="text" size="small"
    icon={<ExportOutlined />}
    onClick={() => useTerminalDockStore.getState().popOut(activeTabId)}
    title="弹出浮层"
  />
)}
```

> import `ExportOutlined` from `@ant-design/icons`。

在 TerminalDock body 渲染逻辑里，把 `poppedOutTabIds` 包含的 Tab 单独 portal 出去：

```tsx
{openTabs.map(tab => {
  const isPopped = poppedOutTabIds.includes(tab.id)
  if (isPopped) {
    return createPortal(
      <PopOutTerminalWindow key={tab.id} tabId={tab.id}>
        <TerminalDockTab tab={tab} visible={true} />
      </PopOutTerminalWindow>,
      document.body
    )
  }
  // 现有 in-Dock 渲染分支
  // ...
})}
```

> Portal 的关键：同一个 `<TerminalDockTab>` React 节点，只是 DOM 父节点变了。React 不会 unmount，xterm/WebSocket 保活。

- [ ] **Step 4：状态切换不能让 active 滞留在 popped tab**

`popOut` 后，dock 内 active 切到下一个非 popped tab：

修改 `terminalDockStore.popOut`：

```ts
popOut: (tabId) => {
  const { poppedOutTabIds, openTabs, activeTabId } = get()
  if (poppedOutTabIds.includes(tabId)) return
  if (poppedOutTabIds.length >= 4) return
  let nextActive = activeTabId
  if (activeTabId === tabId) {
    const nonPopped = openTabs.filter(t => t.id !== tabId && !poppedOutTabIds.includes(t.id))
    nextActive = nonPopped[nonPopped.length - 1]?.id ?? null
  }
  set({ poppedOutTabIds: [...poppedOutTabIds, tabId], activeTabId: nextActive })
},
```

- [ ] **Step 5：dev server 验证**

1. 开两个 Tab，激活 A
2. 点"⤢ 弹出" → A 变成浮窗，dock active 切到 B
3. 拖动浮窗 header 移动位置
4. 拖动浮窗右下角 ↔ 改尺寸 → xterm 自动 fit
5. 点浮窗"—" 缩成 chip；点 chip 恢复浮窗
6. 点浮窗"📌 收回" → A 回到 dock 中（仍然在 openTabs，状态保留）
7. 重要：会话过程中 dock↔popout 来回切换，xterm scrollback 不丢、WebSocket 不断

如果 xterm 在 portal 切换时确实出现 reconnect，触发 spec 风险段的 fallback 方案：弹出时让 dock 内 tab 变成 hidden、popout 内挂同 sessionId 新 instance。MVP 先观察。

- [ ] **Step 6：commit**

```bash
git add web/src/dock/
git commit -m "feat(web): popout floating window with Portal-based session keepalive"
```

---

### Task 12：浮层 z-index + 4 个上限处理

**Files:**
- Modify: `web/src/dock/popout.css`
- Modify: `web/src/dock/TerminalDock.tsx`（4 个达到上限的提示）

- [ ] **Step 1：与 antd Drawer 协调 z-index**

Antd Drawer 默认 z-index 1000。浮层应**低于** Drawer（用户开 Settings 时浮层暂时被遮）。已设 900，确认即可。

但浮层之间应该有自己层级（最近交互的浮上来）。简化方案：保持 900 全相同，已激活/被点击的浮层用 `body.append` 顺序自然在最上层。如果需要更精细，给每个浮层维护一个 zIndex state（点 header 时 +1）。

MVP 不做 z-index 互动。

- [ ] **Step 2：达到上限的友好提示**

在 `dock.popOut` 失败（上限）时，在 TerminalDock 弹按钮处用 antd `message` 提示。修改按钮 onClick：

```tsx
onClick={() => {
  const { popOut, poppedOutTabIds } = useTerminalDockStore.getState()
  if (poppedOutTabIds.length >= 4) {
    message.warning('最多同时弹出 4 个浮层')
    return
  }
  popOut(activeTabId)
}}
```

import `message` from `antd`（首次用要 `App.useApp()` 包装才能拿到 context；如果项目已有全局 `<App>` 包，直接 `import { message } from 'antd'` 用静态版即可。检查 `web/src/main.tsx` 确认）。

- [ ] **Step 3：commit**

```bash
git add web/src/dock/
git commit -m "feat(web): popout limit guard with friendly message"
```

---

## Stage 5：AttentionRail + Pet 清理

### Task 13：AttentionRail（左侧 48px 待回应列）

**Files:**
- Create: `web/src/dock/AttentionRail.tsx`
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/src/TodoManage.css`

- [ ] **Step 1：调研现有 replyHub / AttentionHub 的数据接口**

```bash
grep -n "export\|pendingReplies\|attentionList\|hub" web/src/replyHub.ts web/src/dashboard/AttentionHub.tsx | head -40
```

确认能拿到一个"当前所有 pending_reply 会话"列表，每项含 todoId + sessionId + todoTitle。

- [ ] **Step 2：写 AttentionRail**

```tsx
// web/src/dock/AttentionRail.tsx
import React from 'react'
import { Tooltip, Badge } from 'antd'
import { useTerminalDockStore } from '../store/terminalDockStore'
import { usePendingReplies } from '../replyHub'  // 假设的 hook 名；按 Step 1 调研结果改

export default function AttentionRail() {
  const replies = usePendingReplies()  // [{ todoId, sessionId, todoTitle, ... }]
  const activate = useTerminalDockStore(s => s.activate)

  if (!replies || replies.length === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  return (
    <div className="attention-rail">
      <div className="attention-rail__count">
        <Badge count={replies.length} overflowCount={99} />
      </div>
      {replies.slice(0, 12).map(r => (
        <Tooltip key={r.sessionId} title={r.todoTitle} placement="right">
          <button
            className="attention-rail__item"
            onClick={() => activate(r.todoId, r.sessionId, r.todoTitle)}
          >
            {r.todoTitle.charAt(0) || '?'}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
```

> 如果 `usePendingReplies` 不存在，从 `replyHub.ts` 暴露一个；或退化为读 `aiSessionStore` 中 status === 'pending_confirm' 的会话。

- [ ] **Step 3：CSS**

```css
/* 追加 web/src/TodoManage.css */
.attention-rail {
  flex: 0 0 48px;
  border-right: 1px solid #f0f0f0;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 6px;
  overflow-y: auto;
}
.attention-rail--empty {
  flex: 0 0 8px;
  background: transparent;
  border-right: 1px solid #f0f0f0;
}
.attention-rail__count {
  margin-bottom: 8px;
}
.attention-rail__item {
  width: 32px; height: 32px;
  border-radius: 50%;
  border: 1px solid #faad14;
  background: #fffbe6;
  color: #d48806;
  font-weight: 600;
  cursor: pointer;
}
.attention-rail__item:hover {
  background: #fff1b8;
}
```

- [ ] **Step 4：挂到 TodoManage shell 的最左**

```tsx
<div className="todo-manage-shell">
  <AttentionRail />
  <div className="todo-manage__main">{...}</div>
  <TerminalDock />
</div>
```

import：`import AttentionRail from './dock/AttentionRail'`。

- [ ] **Step 5：dev server 验证**

1. 让某个会话进入 pending_confirm 状态
2. 期望：左侧出 48px 列，含徽章 + 圆点
3. 点圆点 → Dock 自动展开 + 切到该会话
4. 没有任何 pending → 左侧只剩 8px 细线，不抢眼

- [ ] **Step 6：检查并替换原顶栏的"红色脉冲 FAB"入口**

之前 spec 提到顶栏有红色脉冲 FAB。grep 找到并删除：

```bash
grep -n "pulse\|attention-fab\|FAB\|动画.*待回应" web/src/TodoManage.tsx web/src/TodoManage.css | head -20
```

把 FAB 相关的渲染删除（保留 AttentionHub Drawer 触发器，那个仍然有用）。

- [ ] **Step 7：commit**

```bash
git add web/src/dock/AttentionRail.tsx web/src/TodoManage.tsx web/src/TodoManage.css
git commit -m "feat(web): replace red pulse FAB with left AttentionRail"
```

---

### Task 14：删除 Pet

**Files:**
- Delete: `web/src/pet/Pet.ts`
- Delete: `web/src/pet/PetQuadrantCanvas.tsx`
- Delete: `web/src/pet/PetView.tsx`
- Delete: `web/src/pet/petAssets.ts`
- Delete: `web/src/pet/`（空目录）
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/src/api.ts`（注释更新）

- [ ] **Step 1：移除 PetView 引用**

```bash
grep -n "PetView\|pet/" web/src/TodoManage.tsx
```

定位到 `import PetView from './pet/PetView'`（约 52 行）和 `<PetView ... />` 渲染（约 1875 行）。

删除 import；删除 `<PetView onPetClick={handleDashboardOpenTerminal} />`。

**保留** `handleDashboardOpenTerminal` 函数定义，Dashboard 还在用。

- [ ] **Step 2：删除 pet 目录**

```bash
rm -rf web/src/pet/
```

- [ ] **Step 3：更新 api.ts 注释**

```bash
grep -n "PetView\|Pet 相关" web/src/api.ts
```

把 `// ─── Dashboard / PetView 相关 ───`（行 574）改成 `// ─── Dashboard 相关 ───`。

- [ ] **Step 4：搜剩余引用确保清干净**

```bash
grep -rn "PetView\|PetQuadrantCanvas\|petShape\|petAssets\|from.*'./pet" web/src/
```

期望：零命中。

- [ ] **Step 5：tsc 检查 + dev server 验证**

```bash
cd web && npx tsc -b --noEmit
```

dev server 上看四象限不再有 Pet，看板布局正常。

- [ ] **Step 6：commit**

```bash
git add -A web/src/
git commit -m "chore(web): remove unused Pet components"
```

---

## Stage 6：移动端 + 回归走查 + 视觉打磨

### Task 15：移动端整屏覆盖适配

**Files:**
- Modify: `web/src/dock/TerminalDock.tsx`
- Modify: `web/src/dock/dock.css`
- Modify: `web/src/mobile.css`
- Modify: `web/src/dock/AttentionRail.tsx`

- [ ] **Step 1：用 useIsMobile hook 控制 Dock 形态**

```tsx
import { useIsMobile } from '../hooks/useIsMobile'

// 在 TerminalDock body 渲染：
const isMobile = useIsMobile()
// ...
return (
  <div
    className={`terminal-dock ${isMobile ? 'is-mobile' : ''}`}
    style={isMobile ? undefined : { width: widthPx, minWidth: DOCK_LIMITS.MIN_W, maxWidth: DOCK_LIMITS.MAX_W }}
  >
    {/* ... */}
  </div>
)
```

移动端 collapsed 时不渲染 Dock；展开时整屏覆盖（CSS 控制）。

- [ ] **Step 2：mobile CSS**

追加 `web/src/mobile.css`（或 dock.css 内的 media query）：

```css
@media (max-width: 768px) {
  .terminal-dock.is-mobile {
    position: fixed;
    inset: 0;
    width: 100% !important;
    max-width: 100% !important;
    z-index: 800;
    border-left: none;
  }
  .terminal-dock.is-mobile .terminal-dock__divider { display: none; }
  /* 移动端隐藏 split / popout 按钮 */
  .terminal-dock.is-mobile .terminal-dock__head .pc-only { display: none !important; }
}
```

把 split 与 popout 按钮加 className `pc-only`。

- [ ] **Step 3：移动端 AttentionRail 折叠成顶栏角标**

```tsx
// AttentionRail.tsx
import { useIsMobile } from '../hooks/useIsMobile'
// ...
const isMobile = useIsMobile()
if (isMobile) return null  // 移动端不显示左侧列；改用顶栏入口（当前 Dashboard 抽屉里 AttentionHub 已经能用）
```

- [ ] **Step 4：dev server + 移动端尺寸验证**

Chrome DevTools 切到 iPhone 14 / 375 宽：
1. 看板正常单列 / 两列布局（取决于现有响应式实现）
2. 点卡片"打开 AI 终端" → Dock 整屏覆盖弹出
3. 关闭 → 回到看板
4. AttentionRail 不出现在左侧

- [ ] **Step 5：commit**

```bash
git add web/src/dock/ web/src/mobile.css
git commit -m "feat(web): mobile fullscreen overlay for TerminalDock"
```

---

### Task 16：回归 + 视觉打磨

**Files:**
- 任何在走查中发现需要调整的样式

- [ ] **Step 1：tsc + build**

```bash
cd web && npm run build
```

期望：成功，无类型错误。

- [ ] **Step 2：服务器端测试不被影响**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npm test
```

期望：通过（前端改动不应碰到任何 src/ 后端代码）。

- [ ] **Step 3：人工走查（按 spec 验收清单逐项）**

走查 spec 中"功能验收 / 回归验收 / 清理验收 / 视觉验收"4 块全部条目。每条勾掉。问题清单：

| 条目 | 通过? | 备注 |
|------|-------|------|
| 卡片"打开 AI 终端"→ Dock 展开+激活 | | |
| Dock 中 ≥3 个会话切换不掉线 | | |
| 折叠再展开历史保留 | | |
| 拖动分隔条无闪烁 | | |
| split 模式两个 xterm 都可输入 | | |
| 浮层拖动+缩放+chip 化+收回 | | |
| AttentionRail 显示并可激活 | | |
| 移动端整屏覆盖 | | |
| Dashboard / LiveSessionCard / SessionViewer 不变 | | |
| CmdPalette、各 Drawer 不受影响 | | |
| 拖拽排序 / 子待办 / 归档 不变 | | |
| 后端 API 协议未改 | | |
| `web/src/pet/` 不存在 | | |
| `grep PetView` 零命中 | | |
| `grep expandedTerminal\|sideBySideByTodo` 零命中（store 内字段除外） | | |
| TodoManage.tsx 行数 ≤ 1800 | | |
| Dock 关闭时四象限全宽 | | |
| Dock 打开时卡片不溢出 | | |
| AttentionRail 空态 8px 细线 | | |
| 浮层视觉与 antd 一致 | | |

- [ ] **Step 4：playwright MCP 抓 3 张关键截图**（可选）

如果想留视觉证据：用 playwright MCP 截 (a) 看板默认（dock 折叠）(b) Dock 展开 3 个 Tab (c) 浮层 + chip 共存。

- [ ] **Step 5：最终 commit**

```bash
git add -A
git commit -m "polish(web): visual + regression cleanup for terminal dock"
```

---

## 自检（计划完成后回顾）

**Spec coverage 核对**

| Spec 要求 | 对应 Task |
|---|---|
| dockStore + widthPx 持久化 | T1 + T2 |
| Dock 取代卡片内嵌 | T2 + T3 + T4 + T5 |
| 多 Tab + 切换 + 关闭 | T7 |
| Tab 拖动重排 | T8 |
| 状态点同步 | T9 |
| split 模式 | T10 |
| 浮层 + chip + Portal 保活 | T11 + T12 |
| AttentionRail | T13 |
| 顶栏红色 FAB 替换 | T13 Step 6 |
| Pet 删除 + handleDashboardOpenTerminal 保留 | T14 |
| 移动端整屏 | T15 |
| 验收走查 | T16 |
| `expandedTerminal` / `sideBySideByTodo` 链路下线 | T5 + T6 |

**风险/Open question 兑现**

- xterm Portal 迁移是否真无重连：T11 Step 5 有显式验证项 + spec 中的 fallback 路径
- fit 抖动：T4 Step 4 验证 + 可加节流
- z-index 协调：T12 已设 900 < antd Drawer 1000

**Placeholder scan**

- 全部步骤均给出具体代码 / 命令 / 期望输出
- Step 中的 `usePendingReplies` 在 T13 Step 1 明确要求先调研真实 hook 名，不是占位（写明了"若不存在则退化"）

**Type 一致性**

- `DockTabStatus` 在 T1 定义、T9 + T13 使用，名字一致
- `DockTab.id = sessionId` 全程保持
- `activate(todoId, sessionId, todoTitle)` 三参数签名前后一致（T1 定义、T5 / T13 调用）

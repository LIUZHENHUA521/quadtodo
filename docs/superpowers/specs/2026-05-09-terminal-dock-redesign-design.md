# Terminal Dock 重构 + Pet 移除 设计

- 日期：2026-05-09
- 范围：quadtodo web 前端（`web/src/`）
- 后端：无改动（沿用现有 `/api/ai-terminal` 与 `/ws` 协议）

## 背景

`AiTerminalMini` 当前以 `expandedTerminal: { todoId, sessionId } | null` 单点展开在 **卡片内部**。卡片宽度受四象限网格挤压，xterm 可读宽度严重受限；多会话不能并存（同时只能展开一个），`sideBySideByTodo` 仅在同一张卡片内做了一次横切作为补丁。`PetView` 装饰性强，点击作用是打开 dashboard 终端，但本身在四象限里占空间且无明确收益。

## 目标

1. AI 终端从「卡片内嵌」迁移成「右侧固定 Dock 面板」，宽度独立于看板，xterm 可读宽度由 Dock 决定
2. Dock 同时承载多个会话，顶部 Tab 切换；保留并排比对两个会话的能力
3. 任何会话可一键「弹出」为浮层窗口，恢复时回到 Dock
4. AttentionHub 升格为左侧贴边竖向徽标列，待回应会话点一下进入 Dock
5. 卡片去 `expandedTerminal` 内嵌渲染；卡片"打开 AI 终端"按钮语义改为"激活 Dock 中的对应 Tab"
6. 移除 Pet（PetView/PetQuadrantCanvas/Pet.ts/petAssets.ts/petShape），保留底层 `handleDashboardOpenTerminal` 调用路径供 Dashboard 复用

## 非目标

- 不改 xterm fit / ResizeObserver 已经稳定的尺寸协商逻辑（`AiTerminalMini` 内部 fit 重试、双 rAF、IntersectionObserver 兜底全部沿用）
- 不改 WebSocket 协议、`/api/ai-terminal/start|input|kill|sessions` 等 REST
- 不动 SettingsDrawer、StatsDrawer、ReportDrawer 等其他抽屉（属于方案 A 范围，本次不做）
- 不做移动端 Bottom Sheet 化（< 768px 走简化全屏覆盖即可）
- 不改 dnd-kit 拖拽（卡片瘦身在后续迭代再做）

## 架构总览

```
┌──────┬─────────────────────┬──────────────────────────┐
│ Att. │  四象限看板          │ TerminalDock             │
│ Hub  │  (横向被压窄)        │ ┌─Tabs──────────────┐    │
│      │                     │ │ A | B | C  ⫶ ⤢ ✕ │    │
│ 待   │ ┌──┐ ┌──┐           │ ├──────────────────┤    │
│ 回   │ └──┘ └──┘           │ │                  │    │
│ 应   │ ┌──┐ ┌──┐           │ │ AiTerminalMini   │    │
│ 列   │ └──┘ └──┘           │ │ (host = Dock)    │    │
│      │                     │ └──────────────────┘    │
└──────┴─────────────────────┴──────────────────────────┘
   48px       flex 1                widthPx (drag)
```

新增模块：

| 模块 | 作用 |
|---|---|
| `terminalDockStore` | Zustand-style store：`openTabs[]`、`activeTabId`、`splitSecondaryTabId`、`widthPx`、`popOutWindowIds[]`、`isCollapsed` |
| `<TerminalDock>` | 右侧固定面板容器；Tab 头、拖动分隔条、宽度记忆、单/双列切换、弹出按钮 |
| `<TerminalDockTab>` | 渲染一个 `AiTerminalMini`，把 host 容器尺寸传进去 |
| `<PopOutTerminalWindow>` | 浮层窗口，可拖动 + 可缩成右下角 chip |
| `<AttentionRail>` | 左侧 48px 竖条，列出 `replyHub` 待回应会话；点击 = `dock.activate(todoId, sessionId)` |

## 数据模型

```ts
type DockTab = {
  id: string                  // = sessionId
  todoId: string              // 反查 todo 标题
  todoTitle: string           // 缓存避免每次查列表
  status: 'running' | 'idle' | 'pending_reply' | 'closed'
  createdAt: number
}

type DockState = {
  openTabs: DockTab[]
  activeTabId: string | null
  splitSecondaryTabId: string | null  // 同时显示在右半的 tab，仅当宽屏且用户开了分屏
  widthPx: number             // 持久化到 localStorage：'quadtodo.dock.width'，默认 480，min 320 max 720
  isCollapsed: boolean        // Dock 折叠时整列收起
  poppedOutTabIds: Set<string>
}

type DockActions = {
  activate(todoId: string, sessionId: string): void   // 已存在则切到该 tab；不存在则 push
  close(tabId: string): void
  splitWith(tabId: string): void                      // 设置 splitSecondaryTabId
  unsplit(): void
  popOut(tabId: string): void                         // 加入 poppedOutTabIds，同时让该 tab 在 Dock 隐藏（但 xterm 实例不卸载，见下"会话保活"）
  dock(tabId: string): void                           // 反向，把浮层收回
  setWidth(px: number): void
  toggleCollapsed(): void
}
```

## 行为细则

### 打开 / 关闭

- 卡片"打开 AI 终端"按钮 → `dock.activate(todoId, sessionId)`
  - 该 sessionId 已在 `openTabs` → 切到该 Tab + 展开 Dock
  - 不在 → 新建 Tab 推入末尾、设为 active、展开 Dock
- Dock 顶部右侧 ✕ → `setIsCollapsed(true)`，**不卸载** xterm（保活，见下）
- Tab 头上 ✕ → `dock.close(tabId)`，调用现有 `terminateAiSession` 不变

### 多会话 Tab

- Tab 头：标题截断 ≤ 14 字 + 状态点（绿色 running、黄色 pending_reply、灰色 idle）
- 鼠标中键 / 长按 → 关闭该 Tab
- 拖动重排 Tab（沿用 dnd-kit 已经在用的版本，简单 Sortable 即可）

### 并排比对（split）

- 只在 `widthPx >= 720 && window.innerWidth >= 1280` 时启用
- Tab 头"⫶ 拆分"按钮 → 选第二个 Tab → Dock 内部竖切两半，左 active 右 secondary
- 两侧顶部各有一根 mini Tab 头
- 关闭分屏 = 顶部 ✕ 或重新点同一按钮
- 复用现有 `sideBySideSessionId`/`side-by-side` CSS 类的样式资产，但消费方从卡片改成 Dock

### 弹出 / 收回浮层

- Tab 头"⤢ 弹出"→ 当前 active tab 移入 `poppedOutTabIds`，Dock 自动 active 列表中下一个
- 浮层窗口默认尺寸 720×480，初始位置 viewport 中心偏右下；Header 可拖动；右下角 resize 把手
- 浮层 Header 上：「⤡ 收回 Dock」「— 缩小成 chip」「✕ 关闭会话」
- chip 状态：右下角 240×40 横条，显示 todo 标题 + 状态点；点一下展开回浮层
- 同时存在的浮层数量上限 4 个（防误开）

### 会话保活（关键）

`AiTerminalMini` 的 xterm + WebSocket 一旦卸载就要重建会话连接。要让 Tab 切换 / 折叠 Dock / 弹出浮层都不掉线：

- Dock 渲染所有 `openTabs` 对应的 `<AiTerminalMini>`，**非 active 的用 `display: none` 隐藏而非 unmount**
- `<AiTerminalMini>` 已经在 `display:none ↔ visible` 切换时用 IntersectionObserver 触发 refit，复用即可
- 弹出到浮层时：组件本体 `<TerminalDockTab>` 在 React tree 中重新挂载到 `<PopOutTerminalWindow>` 下 → 这里需要 **React Portal**，把同一个组件实例 portal 到浮层 DOM，避免 unmount。或者：xterm 实例外置（提到 store 里），由两端共享 ref。MVP 走 Portal 方案。

### 卡片侧改动

- 删除 `expandedTerminal` 相关：`SortableTodoCardProps` 里 `expandedTerminal/setExpandedTerminal/hiddenTerminalSessionId/hiddenTerminalSessionIdByTodo/onHideTerminal/onShowTerminal/terminalCollapsed/collapsedTerminalByTodo/onToggleTerminalCollapsed/sideBySideSessionId/sideBySideByTodo/onSetSideBySide` 全部下线
- 卡片底部不再渲染 `<AiTerminalMini>` 与 side-by-side 容器
- "打开 AI 终端"按钮 onClick 改为调 dock store
- "并排比对"按钮（之前 `onSetSideBySide`）改为调 `dock.splitWith(tabId)`

### AttentionRail（左侧 48px 竖条）

- 数据源：现有 `replyHub.ts` + AttentionHub 状态
- 渲染：每个待回应会话一个圆形头像/字母徽章 + 数字气泡
- 点击：`dock.activate(todoId, sessionId)`
- 视觉上替代当前在顶栏抢位置的「红色 FAB 脉冲」
- 移动端（< 768px）：AttentionRail 收成顶栏右侧一个 ⚠ 按钮，点击展开覆盖 Drawer

### 移动端（< 768px）

- Dock 不存在固定列形态；激活会话时整屏覆盖打开（取代当前 overlayTerminal）
- 不做 split / 不做浮层（按钮隐藏）
- 退出 = 顶部返回按钮回到看板

### Pet 删除

删除文件：
- `web/src/pet/Pet.ts`
- `web/src/pet/PetQuadrantCanvas.tsx`
- `web/src/pet/PetView.tsx`
- `web/src/pet/petAssets.ts`
- `web/src/pet/`（空目录一并删）

修改 `TodoManage.tsx`：
- 移除 `import PetView from './pet/PetView'`
- 移除 `<PetView onPetClick={handleDashboardOpenTerminal} />` 渲染
- `handleDashboardOpenTerminal` **保留**（Dashboard 的 LiveSessionCard 和新 AttentionRail 都会调用类似入口；具体调用方在实现阶段再核对）

`api.ts:574` 注释 "Dashboard / PetView 相关" 改成 "Dashboard 相关"。

## 状态迁移

启动时：
- 读 `localStorage['quadtodo.dock.width']` → `widthPx`，无则 480
- 读 `localStorage['quadtodo.dock.collapsed']` → `isCollapsed`，无则 true（首次默认收起，看板全宽）
- `openTabs` 从空开始（不持久化跨刷新的会话标签——和当前刷新即丢失的行为一致）

后续可加：从 `/api/ai-terminal/sessions` 拉运行中的会话，自动 restore Tab。MVP 不做。

## 依赖 / 影响面

| 文件 | 改动 |
|---|---|
| `web/src/TodoManage.tsx` | 大改；删 expandedTerminal/sideBySide 相关 props 链路；接入 Dock；移除 PetView |
| `web/src/AiTerminalMini.tsx` | 不动核心逻辑；可能需要把 host container ref 通过 prop 传入而非自己 querySelector（如已是 ref 即无改动） |
| `web/src/dashboard/AttentionHub.tsx` | 拆出 AttentionRail 用作左侧固定列 |
| `web/src/replyHub.ts` | 不变 |
| `web/src/store/aiSessionStore.ts` | 新增字段或新建 `terminalDockStore.ts`（推荐新建独立 store，职责清晰） |
| `web/src/dashboard/LiveSessionCard.tsx` | "打开会话"按钮改调 dock.activate |
| `web/src/pet/*` | 全部删除 |
| `web/src/TodoManage.css` | 删除 side-by-side / 内嵌 terminal 相关失效样式；新增 dock layout 网格 |
| 新文件 | `web/src/dock/TerminalDock.tsx`、`TerminalDockTab.tsx`、`PopOutTerminalWindow.tsx`、`AttentionRail.tsx`、`store/terminalDockStore.ts` |

## 风险 & 待解

1. **Portal 迁移导致 xterm 重新 attach**：Portal 改变 DOM 父节点但 React 实例不变。xterm 的 `term.open(container)` 是把 canvas 挂到 DOM，Portal 之后 container 还是同一个 div ref，理论上 OK。**待验证**：实操中 dock ↔ 浮层来回切是否会触发 xterm 内部 reflow。预案：Portal 失败就改用「双实例 + 序列化光标位置」的伪迁移，或者干脆"弹出 = 隐藏 Dock 的 tab + 在浮层挂同 sessionId 新实例"（旧实例保活在 Dock 隐藏状态）。
2. **fit 抖动**：Dock 宽度拖动时高频触发 ResizeObserver。`AiTerminalMini` 已有节流但要确认在拖动场景下是否需要再加 debounce。
3. **`expandedTerminal` 是 dashboard 视图也在用的状态**（TodoManage.tsx:994 注释提到 dashboard 视图也用 overlayTerminal）。删之前要扫一遍所有 reader/writer，避免删漏。
4. **快捷键**：Dock 折叠 / 切 Tab / 关闭 Tab 应该绑快捷键？MVP 不绑，但留接口给后续。CmdPalette 已占 ⌘K，避让。
5. **浮层 z-index**：和 SettingsDrawer 等 antd Drawer 的 z-index 关系要协调，浮层应高于 Drawer 还是低于？建议低于（用户开 Settings 时浮层暂时被遮）。
6. **窄屏（< 1024px）**：Dock 占 480 后看板可能挤到 4 列变 2 列。需要在 Dock 展开时动态收紧四象限到 2×2 网格自适应，或允许 Dock 设置最小看板宽度。

## 验收标准

**功能验收**

- [ ] 点击任意 todo 卡片"打开 AI 终端"按钮 → 右侧 Dock 展开 + 对应 Tab 激活，xterm 立即可输入
- [ ] 在 Dock 中至少同时挂载 3 个会话，Tab 间切换流畅，xterm 不掉线、历史不丢
- [ ] 关闭 Dock（顶部 ✕）后再展开，全部 Tab 与历史保留
- [ ] 拖动分隔条改 widthPx，xterm fit 正确不出现 cols 异常小或 1px 闪烁；刷新页面后 widthPx 持久化
- [ ] 选两个 Tab 启用 split，左右两个 xterm 同时可见可输入
- [ ] 弹出浮层后窗口可拖动可缩放；缩成 chip 后点击恢复；收回 Dock 后会话继续
- [ ] AttentionRail 显示当前所有 pending_reply 会话；点击直接打开/切换到对应 Tab
- [ ] 移动端（375 宽）激活会话整屏覆盖；返回看板时会话保活

**回归验收**

- [ ] Dashboard 视图、LiveSessionCard、SessionViewer 行为不变
- [ ] CmdPalette、所有 Drawer（Settings/Stats/Report/Template/Wiki/...) 不受影响
- [ ] 拖拽排序、子待办、批量操作、归档等卡片功能不变
- [ ] `/api/ai-terminal/*` 与 ws 协议无任何变更，后端 `src/server.js` 与 `src/routes/ai-terminal.js` 零修改

**清理验收**

- [ ] `web/src/pet/` 目录不存在
- [ ] `grep -r 'PetView\|PetQuadrantCanvas\|petShape\|petAssets'` 在 web/ 下零命中
- [ ] `grep -r 'expandedTerminal\|sideBySideByTodo\|sideBySideSessionId\|hiddenTerminalSessionId'` 在 web/ 下零命中（除迁移到 dock store 内的少量字段）
- [ ] `TodoManage.tsx` 行数显著下降（目标 ≤ 1800，从 2629）

**视觉验收**（人工走查）

- [ ] Dock 关闭时四象限恢复全宽
- [ ] Dock 打开时四象限均匀让出宽度，卡片不出现文本溢出
- [ ] AttentionRail 在没有待回应时折叠成 8px 细线，不抢眼
- [ ] 浮层有阴影、圆角，与现有 antd 视觉一致

## 实施分段建议

阶段 1：底座
- `terminalDockStore` + 空壳 `<TerminalDock>` + 拖动分隔条 + 宽度持久化

阶段 2：迁移
- 把 `<AiTerminalMini>` 接入 Dock；卡片侧拆 `expandedTerminal` 链路；保活机制

阶段 3：多会话
- Tab 切换 + 关闭 + 拖动重排

阶段 4：split + 浮层
- split 复用 side-by-side CSS；浮层 + chip + Portal

阶段 5：AttentionRail + Pet 清理
- 左侧竖条；删除 pet/* 与所有引用

阶段 6：移动端 + 回归测试 + 视觉打磨

每个阶段都可以独立提交、独立验证。

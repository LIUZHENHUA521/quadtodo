# AI 终端「近底自动吸附」+ followTail 联动 — 设计

> 防御性兜底，针对"按钮能滚到底、手动滚轮/触摸滚不到底"的不可稳定复现 bug。

## 背景与问题

`web/src/AiTerminalMini.tsx` 使用 `@xterm/xterm@5.5.0` + FitAddon + CanvasAddon 渲染 AI 终端。用户上报：

- 点击工具栏「滚到底部」按钮 → 视口能到达绝对底部（OK）。
- 鼠标滚轮 / 触摸滑动 / 拖右侧 scrollbar → 停在距底 1~2 行处，到不了真正的底（NG）。

不可稳定复现，但已确认排除：

- 非 D-pad 遮挡（按钮路径也会被遮挡，但按钮 OK）。
- 非 `followTail` 反复回弹（按钮路径同样依赖 `followTail`）。

根因高度怀疑是 xterm 两条「滚到底」路径不一致：

- **按钮路径** `term.scrollToBottom()` → 内部 `viewportYDisp = baseY`，强制 `viewport.syncScrollArea()` 把 `.xterm-viewport.scrollTop` 写到 max，无视 DOM 量出来的 `scrollHeight`。
- **手动路径** 浏览器原生滚 `.xterm-viewport.scrollTop`，上限是 `scrollHeight - clientHeight`，由 DOM 元素高度计算。

两者通常一致，但在 `box-sizing` / DPR / FitAddon `Math.floor` / `cellHeight` 浮点累计这些边角下，DOM 量出的 `scrollHeight` 可能比内部 buffer 算的少 1~2 行 → 手动路径上限差 1~2 行。

## 目标

不替换 xterm 任何核心路径、不改 WS 协议、不引入新依赖的前提下，做一个**纯前端兜底**：

- 用户手动滚到距底 ≤ N 行（N=4）→ 自动吸附到绝对底部，`followTail` 置 `true`。
- 用户主动往上翻 > N 行 → `followTail` 自动置 `false`，停留位置稳定，不被新输出拽回底部。
- 首次出现"卡在近底"时打一行 `console.warn` 携带诊断数值，方便下次真复现时定位。

## 非目标

- 不修 FitAddon 计算逻辑（猜测性根因，没有实测数据前不改）。
- 不接管 xterm 的 wheel / touch / scrollbar 任一处理路径（替换 xterm 核心路径的引入风险高于修复价值）。
- 不改后端 WS、不改 session/replay 协议、不改 localStorage schema。
- 不重做 `followTail` 持久化 key（沿用 `quadtodo.followTail`）。

## 改动范围

- **新增** `web/src/AiTerminalMini.scrollSnap.ts`（~30 行）：纯函数 `decideNearBottomAction` + `NEAR_BOTTOM_LINES` 常量。这样测试可单独 import，不依赖 React/xterm。
- **修改** `web/src/AiTerminalMini.tsx`：
  - import 上述纯函数和常量。
  - 组件内新增 1 个 `useRef` 反回声 guard、1 个模块级 `let warnedNearBottomOnce`。
  - 在 `term.open(container)` + 初始 `fit()` 完成后新增 1 处 `term.onScroll(...)` 订阅（~15 行）。
  - 现有 cleanup 链中追加 1 处 `disposable.dispose()`。
- **新增** `test/decideNearBottomAction.test.ts`：单测纯函数（与既有 `test/reply-hub.test.ts` 同位置 / 同风格）。

无新依赖。无后端 / WS / localStorage schema 变更。

## 详细设计

### 常量与状态

```ts
// 模块顶部
const NEAR_BOTTOM_LINES = 4
// 整个页面生命周期内仅 warn 一次（跨多 tab 共享）。诊断目的，不是计数器。
let warnedNearBottomOnce = false
```

```ts
// 组件内（与现有 followTailRef 等并列）
const suppressNextScrollEventRef = useRef<boolean>(false)
```

### onScroll 监听器

注册位置：现有 `await waitTerminalReady(container)` → `term.open(container)` → `fit.fit()` 之后，与现有 `attachCustomKeyEventHandler` / `registerLinkProvider` 同一块作用域。

```ts
const scrollDisposable = term.onScroll(() => {
  // 反回声：我们自己调 scrollToBottom 后 xterm 也会 fire onScroll，
  // 该次事件不应再走判定逻辑，否则会形成 setState 风暴。
  if (suppressNextScrollEventRef.current) {
    suppressNextScrollEventRef.current = false
    return
  }

  const buf = term.buffer.active
  const baseY = buf.baseY        // 活动屏第一行在整个 buffer 中的索引
  const dispY = buf.viewportY    // 视口最上一行在整个 buffer 中的索引
  // xterm 在绝对底部时 viewportY === baseY；向上每滚 1 行 viewportY 减 1。
  // 故 delta = baseY - viewportY 即为"距离绝对底部"的行数。
  const delta = Math.max(0, baseY - dispY)

  if (delta === 0) {
    if (!followTailRef.current) {
      setFollowTail(true)
      try { localStorage.setItem('quadtodo.followTail', '1') } catch {}
    }
    return
  }

  if (delta <= NEAR_BOTTOM_LINES) {
    // 近底吸附：手动路径只能停在这里，强制走 scrollToBottom 把 DOM 和 buffer 对齐。
    if (!warnedNearBottomOnce) {
      warnedNearBottomOnce = true
      try {
        const v = container.querySelector('.xterm-viewport') as HTMLElement | null
        console.warn('[AiTerminalMini] near-bottom snap engaged', {
          baseY, dispY, delta,
          rows: term.rows, cols: term.cols,
          scrollTop: v?.scrollTop, scrollH: v?.scrollHeight, clientH: v?.clientHeight,
        })
      } catch { /* console 不可用就算了 */ }
    }
    suppressNextScrollEventRef.current = true
    term.scrollToBottom()
    if (!followTailRef.current) {
      setFollowTail(true)
      try { localStorage.setItem('quadtodo.followTail', '1') } catch {}
    }
    return
  }

  // delta > NEAR_BOTTOM_LINES：用户主动往上翻历史。
  if (followTailRef.current) {
    setFollowTail(false)
    try { localStorage.setItem('quadtodo.followTail', '0') } catch {}
  }
})
```

### Cleanup

跟随既有 `termRef.current?.dispose()` 那段：在 `dispose()` 之前调 `scrollDisposable.dispose()`，或把它推到既有 disposable 集合（参考 `linkProviderRef` 的释放方式）。

### 反回声 guard 的正确性

- `term.scrollToBottom()` 会同步把 `viewportYDisp` 设为 `baseY`，并触发一次 `onScroll`。
- 这次回声里 `delta === 0`，会再次进 `if (delta === 0)` 分支。该分支只做 `setFollowTail(true)` 且做了 `followTailRef.current` 已经为 true 时的早退判定，**不会再调 `scrollToBottom`**。
- 因此 guard 严格来讲不是必需的（不会死循环），但保留它以**避免一次不必要的 `setFollowTail` 调用**和 localStorage 写入抖动，且让"我们自己引起的滚动"与"用户引起的滚动"语义清晰。

### 与既有路径的相互作用

| 既有路径 | 是否受影响 |
|---|---|
| `case 'output'` 写入回调里 `if (followTailRef.current) term.scrollToBottom()` | 不变。`followTail=false` 时不滚（用户上滚后被尊重）；`followTail=true` 时滚（与新机制一致）。 |
| `case 'replay'` 同上 | 不变。 |
| 工具栏「滚到底部」按钮 `scrollToBottom` callback | 不变。它会调 `term.scrollToBottom()` → 触发 onScroll → delta=0 分支早退。 |
| `Ctrl+End` keydown handler | 不变。同上。 |
| 键盘弹出 `wasShorter` 一次性 `term.scrollToBottom()` | 不变。同上。 |
| 工具栏 `跟随` Tag 点击 `toggleFollowTail` | 不变。它已经在置 true 时调 `scrollToBottom`。 |
| `clear()` / `clear_history` | 不变。`baseY=0` 时 delta=0，无副作用。 |

## 边界情况

| 场景 | 预期行为 |
|---|---|
| 用户从顶部一路滚到底，中间穿越 `delta=4 → 3 → 2 → 1 → 0` | 在 delta=4 那次 onScroll 就被吸到底，体感顺滑。 |
| 用户从底部往上翻 1~4 行 | 每一帧 onScroll 都判定为"近底" → 立刻吸回底。**这是设计预期，等同于 Slack/Discord 的"近底磁吸"。** |
| 用户从底部往上一次性翻 10 行 | delta=10 → followTail 置 false，停留位置稳定。 |
| `followTail=false` 期间 AI 输出新内容 | 既有 `output` 分支不滚，视口不动。新机制不参与（onScroll 不会被新数据写入触发；除非 baseY 增加导致用户的相对位置"被动"接近顶部，但 dispY 不变 → delta 仍 > 4 → 不进吸附）。 |
| Canvas 渲染器加载失败回退 DOM | xterm `onScroll` 在两个渲染器中行为一致 → 同一份代码。 |
| 全屏 / dock 嵌入 / 移动端 | 同一份代码生效，无需额外分支。 |
| 多 tab 切换、`isHiddenRef.current=true` | onScroll 仅在用户实际滚动时 fire，后台 tab 不触发。 |

## 验收标准

功能：

- ✅ 鼠标滚轮 / 触摸滑动 / 拖 scrollbar 在距底 ≤ 4 行处停手 → 自动到达绝对底部，「跟随」Tag 变绿。
- ✅ 同样三种路径在距底 ≥ 5 行处停手 → 停留位置稳定，「跟随」Tag 变灰；后续新 output 不打扰阅读。
- ✅ 工具栏「滚到底部」按钮、Ctrl+End、键盘弹出一次性吸底，行为不变。
- ✅ AI 高频 TUI 重绘期间（Claude task list 模式）无可见跳动 / 卡顿。
- ✅ 首次命中"近底吸附"时 console 出现一行 `[AiTerminalMini] near-bottom snap engaged` 带数值；后续不再打。
- ✅ Canvas / DOM 渲染器、全屏 / 嵌入 / 移动端 三种维度均通过上述用例。

代码质量：

- ✅ 单元测试覆盖 delta=0 / delta=2 / delta=10 三种典型情形对 `scrollToBottom` 和 `setFollowTail` 的调用次数 / 终态。
- ✅ 现有所有测试通过。
- ✅ 无 TypeScript 报错、ESLint clean。

## 测试策略

把判定逻辑从 onScroll 闭包中拆为纯函数：

```ts
export function decideNearBottomAction(
  baseY: number,
  dispY: number,
  followTail: boolean,
  nearBottomLines: number,
): { snap: boolean; nextFollowTail: boolean | null }
```

返回值：

- `snap: true` 表示调用方应执行 `term.scrollToBottom()`。
- `nextFollowTail: boolean | null`：`null` 表示不变；其它表示需 setState 到目标值。

单元测试（新增 `test/decideNearBottomAction.test.ts`，与既有 `test/reply-hub.test.ts` 同位置）覆盖：

| 用例 | delta | followTail in | 期望返回 |
|---|---|---|---|
| 已贴底 + 跟随中 | 0 | true | `{ snap: false, nextFollowTail: null }` |
| 已贴底 + 跟随关 | 0 | false | `{ snap: false, nextFollowTail: true }` |
| 近底 + 跟随中 | 2 | true | `{ snap: true, nextFollowTail: null }` |
| 近底 + 跟随关 | 2 | false | `{ snap: true, nextFollowTail: true }` |
| 阈值边界 | 4 | true | `{ snap: true, nextFollowTail: null }` |
| 越过阈值 + 跟随中 | 5 | true | `{ snap: false, nextFollowTail: false }` |
| 越过阈值 + 跟随关 | 10 | false | `{ snap: false, nextFollowTail: null }` |

onScroll handler 内部仅做：取 baseY/dispY → 调 `decideNearBottomAction` → 按返回值执行 `scrollToBottom` / `setFollowTail` / localStorage 写入 / 反回声 guard 设置 / 一次性 warn。

不写端到端 Playwright 测试（原始 bug 不可稳定复现，E2E 也复现不出问题；纯函数单测 + 人工脚本足够）。

人工复测脚本（PR 描述里附）：见「验收标准」中 6 条。

## 风险

| 风险 | 级别 | 缓解 |
|---|---|---|
| 阈值 4 行偏松，用户想停在最后第 1~4 行读 / 框选文字会被吸到底 | 中 | 框选（mousedown）不触发 onScroll，正常工作；只有"滚轮 / 触摸 / 拖 scrollbar 后停手"会触发吸附。用户已显式选择 N=4；若投诉再调低即可（改一个常量）。 |
| `onScroll` 触发频率过高导致 `setFollowTail` 抖动 | 低 | 每次状态翻转才调 setState，未翻转早退；且 React 18 batch render 自动合并。 |
| 反回声 guard 误吞用户事件 | 极低 | guard 是单次性 ref，下一帧自然清除；最坏情况是用户一次手动滚被忽略，下一次正常。 |
| `term.buffer.active.baseY` 在某些场景下短时为负 / undefined | 极低 | xterm 5.x 类型保证 number；额外加 `baseY - visibleBottom < 0 ? 0` 兜底。 |
| Canvas 渲染器 dirty-rect 优化使吸附后最后一行不立即重绘 | 低 | `scrollToBottom()` 内部调 `requestRefreshRows(0, rows-1)`，强制重绘整个视口。 |

## 未来可能的演进（不在本次范围内）

如果首次 `console.warn` 收集到 `scrollH - clientH < (baseY+rows) * cellHeight` 这类硬证据，确认是 FitAddon 多算 1 行，再考虑在 `doFit` 后写一个 `Math.min(proposed.rows, Math.floor(.xterm-viewport.clientHeight / cellHeight))` 的二次校正——这是根因修复路径，本 spec 不做。

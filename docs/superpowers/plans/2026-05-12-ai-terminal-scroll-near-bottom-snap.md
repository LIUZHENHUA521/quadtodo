# AI 终端「近底自动吸附」+ followTail 联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 AI 终端加一个纯前端兜底：手动滚轮 / 触摸 / 拖 scrollbar 滚到距底 ≤4 行时，自动吸附到绝对底部并把 `followTail` 置 `true`；用户主动往上翻 >4 行时把 `followTail` 置 `false`。

**Architecture:** 把判定逻辑提成纯函数 `decideNearBottomAction(baseY, dispY, followTail, nearBottomLines)` 放进新文件 `web/src/AiTerminalMini.scrollSnap.ts`，单测覆盖。在 `AiTerminalMini.tsx` 已有的 `term.open() → fit.fit()` 之后注册 `term.onScroll(...)`，调纯函数，按返回值执行 `scrollToBottom` / `setFollowTail` / localStorage 写入，并用一个 ref 做反回声 guard。整个页面生命周期内首次命中"近底吸附"时 `console.warn` 一次诊断数据。

**Tech Stack:** TypeScript, React 18, `@xterm/xterm@5.5.0`（已使用 `term.onScroll`、`term.buffer.active.{baseY, viewportY}`、`term.scrollToBottom()`），Vitest（项目根 `vitest.config.js`，测试在 `test/` 目录，跨包 import `web/src/*.ts` 已有先例如 `test/reply-hub.test.ts`）。

**Spec:** `docs/superpowers/specs/2026-05-12-ai-terminal-scroll-near-bottom-snap-design.md`

---

## File Structure

- **Create** `web/src/AiTerminalMini.scrollSnap.ts`（纯函数 + 常量，约 35 行）— 独立 ts 文件让测试不必 import 整个挂着 xterm/React 的大 tsx。
- **Create** `test/decideNearBottomAction.test.ts`（Vitest 单测，约 80 行）— 与 `test/reply-hub.test.ts` 同位置同风格。
- **Modify** `web/src/AiTerminalMini.tsx`（约 +30/−0 行）— import 纯函数；新增反回声 ref；在初始 `fit.fit()` 之后注册 `term.onScroll(...)`；cleanup 链追加 disposable.dispose()。

---

## Task 1: 纯函数 `decideNearBottomAction` 的失败测试

**Files:**
- Create: `test/decideNearBottomAction.test.ts`

- [ ] **Step 1: 写测试**

```ts
// test/decideNearBottomAction.test.ts
import { describe, expect, it } from 'vitest'
import {
  decideNearBottomAction,
  NEAR_BOTTOM_LINES,
} from '../web/src/AiTerminalMini.scrollSnap.ts'

describe('NEAR_BOTTOM_LINES', () => {
  it('exports the agreed threshold of 4 lines', () => {
    expect(NEAR_BOTTOM_LINES).toBe(4)
  })
})

describe('decideNearBottomAction', () => {
  it('已贴底 + 跟随中 → 不做任何事', () => {
    expect(decideNearBottomAction(100, 100, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('已贴底 + 跟随关 → 把跟随置 true', () => {
    expect(decideNearBottomAction(100, 100, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: true })
  })

  it('近底 (delta=2) + 跟随中 → 吸附，跟随保持', () => {
    expect(decideNearBottomAction(100, 98, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: null })
  })

  it('近底 (delta=2) + 跟随关 → 吸附并把跟随置 true', () => {
    expect(decideNearBottomAction(100, 98, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: true })
  })

  it('阈值边界 (delta=4) + 跟随中 → 仍吸附', () => {
    expect(decideNearBottomAction(100, 96, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: null })
  })

  it('越过阈值 (delta=5) + 跟随中 → 不吸附，把跟随置 false', () => {
    expect(decideNearBottomAction(100, 95, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: false })
  })

  it('远离底部 (delta=10) + 跟随关 → 什么都不做', () => {
    expect(decideNearBottomAction(100, 90, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('dispY > baseY 的异常值 → 视为已贴底（delta clamp 到 0）', () => {
    // 理论上 xterm 不应出现此情况，但纯函数自己要稳。
    expect(decideNearBottomAction(100, 105, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('自定义阈值生效：N=1 时 delta=2 不再被吸附', () => {
    expect(decideNearBottomAction(100, 98, true, 1))
      .toEqual({ snap: false, nextFollowTail: false })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- decideNearBottomAction`
Expected: 模块解析失败，错误信息类似 `Cannot find module '../web/src/AiTerminalMini.scrollSnap.ts'`。这是预期的——文件还没创建。

---

## Task 2: 实现 `decideNearBottomAction` 让测试通过

**Files:**
- Create: `web/src/AiTerminalMini.scrollSnap.ts`

- [ ] **Step 1: 创建纯函数文件**

```ts
// web/src/AiTerminalMini.scrollSnap.ts
//
// 纯函数：根据 xterm buffer 的 baseY / viewportY 和当前 followTail，
// 决定要不要程序化吸附到底部、是否更新 followTail。
//
// 拆出来单独成文件的原因：让 vitest 不必 import 整个挂着 xterm/React 的
// AiTerminalMini.tsx，测试可以保持轻量。

/**
 * 「距离绝对底部 ≤ N 行就被吸附」中的 N。
 * xterm 在绝对底部时 viewportY === baseY；向上每滚 1 行 viewportY 减 1。
 */
export const NEAR_BOTTOM_LINES = 4

export interface NearBottomAction {
  /** 调用方应执行 `term.scrollToBottom()`。 */
  snap: boolean
  /**
   * `null` = 不变；`true`/`false` = 需要 setState 到该值（并写 localStorage）。
   */
  nextFollowTail: boolean | null
}

/**
 * @param baseY  xterm `buffer.active.baseY`，活动屏第一行在整个 buffer 中的索引。
 * @param dispY  xterm `buffer.active.viewportY`，视口最上一行在整个 buffer 中的索引。
 * @param followTail 当前 followTail 状态。
 * @param nearBottomLines 吸附阈值（行），等于 `NEAR_BOTTOM_LINES`。注入便于单测。
 */
export function decideNearBottomAction(
  baseY: number,
  dispY: number,
  followTail: boolean,
  nearBottomLines: number,
): NearBottomAction {
  const delta = Math.max(0, baseY - dispY)

  if (delta === 0) {
    return { snap: false, nextFollowTail: followTail ? null : true }
  }

  if (delta <= nearBottomLines) {
    return { snap: true, nextFollowTail: followTail ? null : true }
  }

  return { snap: false, nextFollowTail: followTail ? false : null }
}
```

- [ ] **Step 2: 运行测试确认全部通过**

Run: `npm test -- decideNearBottomAction`
Expected: 9 个用例全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.scrollSnap.ts test/decideNearBottomAction.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-terminal): pure decideNearBottomAction + unit tests

Extract the snap-to-bottom decision logic from AiTerminalMini so it can
be unit-tested without an xterm/React harness. Threshold N=4 matches
spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 在 `AiTerminalMini.tsx` 中接入 onScroll 监听

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

> 上下文：当前文件结构：
> - L17~24 是其它本地模块 import 块。
> - L143 已声明 `const [followTail, setFollowTail] = useState<boolean>(...)` 和 L146 `followTailRef`，本任务复用。
> - L425 起的 `useEffect(() => { ... }, [sessionId, tryAutoRecover, showTurnDoneReminder])` 是终端初始化的主 effect，IIFE 内部 L456 创建 term、L470 `term.open(container)`、L557 调用 `fit.fit()`。我们的 `term.onScroll` 订阅插在 L557 之后。
> - L895~929 的 `cleanup = () => { ... }` 链负责释放各类资源，包含 `linkProviderRef.current?.dispose()` 等。我们在 `term.dispose()` 之前追加新 disposable 的释放。

- [ ] **Step 1: 顶部 import 块加上新模块**

在 `web/src/AiTerminalMini.tsx` 现有 `import { useTerminalDockStore } from './store/terminalDockStore'` 那一带（L15 附近）之后追加一行：

```ts
import { decideNearBottomAction, NEAR_BOTTOM_LINES } from './AiTerminalMini.scrollSnap'
```

（注意：项目 tsconfig `allowImportingTsExtensions: true`，但 import 写不带扩展名也能 resolve；现有 import 都不带 `.ts` 扩展，保持一致。）

- [ ] **Step 2: 模块级 `warnedNearBottomOnce` 标记**

在文件顶部的常量区（L73 的 `stripCursorVisibility` 函数之后、L80 的 `waitTerminalReady` 函数之前）追加：

```ts
// 整个页面生命周期内仅打印一次诊断 warn（跨多 tab 共享）。出现 = 已经被兜底吸附到底了。
// 不是计数器，仅用于排查"卡在近底"现象第一次发生时抓取数值。
let warnedNearBottomOnce = false
```

- [ ] **Step 3: 组件内新增反回声 ref**

在 L154 的 `const dragRef = useRef<{ startY: number; startH: number } | null>(null)` 之后追加：

```ts
// 反回声：我们自己调 term.scrollToBottom() 后 xterm 也会 fire onScroll，
// 该次事件不应再触发判定逻辑（否则会形成不必要的 setState 抖动）。
const suppressNextScrollEventRef = useRef<boolean>(false)
```

- [ ] **Step 4: 在初始 `fit.fit()` 之后注册 onScroll**

定位 L555~557 的代码段：

```ts
      // Synchronous fit — Task 5's waitTerminalReady already ensured the container
      // has measurable width, so we don't need rAF defensiveness anymore. Doing this
      // sync (instead of waiting for the next frame) makes `term.cols / term.rows`
      // valid before connectWs() runs — important for hidden tabs where rAF is
      // throttled and would otherwise leave term at xterm's constructor default 80×24.
      try { fit.fit() } catch (e) { console.warn('[AiTerminalMini] initial fit failed:', e) }
```

在 `try { fit.fit() } ... ` 这一行**之后**、`function connectWs() {` **之前**插入：

```ts
      // ─── 近底自动吸附 ───
      // 手动滚动（wheel / touch / 拖 scrollbar）在某些边角下停在 baseY 前 1~2 行无法
      // 到达绝对底部；这里订阅 onScroll，距底 ≤ NEAR_BOTTOM_LINES 行就主动 scrollToBottom，
      // 同时跟 followTail 状态联动：用户主动往上翻 > NEAR_BOTTOM_LINES 行则取消跟随。
      // 详细设计见 docs/superpowers/specs/2026-05-12-ai-terminal-scroll-near-bottom-snap-design.md。
      const scrollSnapDisposable = term.onScroll(() => {
        if (suppressNextScrollEventRef.current) {
          suppressNextScrollEventRef.current = false
          return
        }
        const buf = term.buffer.active
        const baseY = buf.baseY
        const dispY = buf.viewportY
        const action = decideNearBottomAction(
          baseY,
          dispY,
          followTailRef.current,
          NEAR_BOTTOM_LINES,
        )

        if (action.snap) {
          if (!warnedNearBottomOnce) {
            warnedNearBottomOnce = true
            try {
              const v = container.querySelector('.xterm-viewport') as HTMLElement | null
              console.warn('[AiTerminalMini] near-bottom snap engaged', {
                baseY, dispY, delta: baseY - dispY,
                rows: term.rows, cols: term.cols,
                scrollTop: v?.scrollTop,
                scrollH: v?.scrollHeight,
                clientH: v?.clientHeight,
              })
            } catch { /* console 不可用就算了 */ }
          }
          suppressNextScrollEventRef.current = true
          term.scrollToBottom()
        }

        if (action.nextFollowTail !== null) {
          setFollowTail(action.nextFollowTail)
          try {
            localStorage.setItem('quadtodo.followTail', action.nextFollowTail ? '1' : '0')
          } catch { /* ignore */ }
        }
      })
```

- [ ] **Step 5: 在 cleanup 链中释放 disposable**

定位 L923 附近（cleanup 函数内 `try { linkProviderRef.current?.dispose() } catch {}` 那一行），在其**之后**追加：

```ts
        try { scrollSnapDisposable.dispose() } catch {}
```

注意：`scrollSnapDisposable` 是在同一个 IIFE 闭包内的局部变量，cleanup 在同一闭包中赋值，所以可以直接引用，不需要新增 ref。

- [ ] **Step 6: TypeScript 类型检查**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误。如有 `Cannot find name 'scrollSnapDisposable'` 类型报错，检查 Step 4 的代码是否落在了正确的 IIFE 内部。

- [ ] **Step 7: 跑既有测试套**

Run: `npm test`
Expected: 全部既有用例 + Task 1 新增的 9 个用例，全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "$(cat <<'EOF'
feat(ai-terminal): near-bottom auto-snap + followTail sync

Subscribes term.onScroll and uses decideNearBottomAction to snap to the
absolute bottom when manual scroll lands within 4 lines (xterm wheel/
touch can stop short of baseY in some sub-pixel/DPR/box-sizing edge
cases). Also flips followTail off when the user actively scrolls > 4
lines above the bottom, so the toolbar tag stays in sync with reality.
One-time console.warn captures diagnostic numbers on first snap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 手动复测脚本验证

**Files:** 无代码改动；本任务在浏览器中跑通验收清单。

- [ ] **Step 1: 启动 dev 环境**

Run: `npm run start`（后端在 5677）  
另开终端：`cd web && npm run dev`（前端在 5173）  
浏览器打开 `http://localhost:5173`。

- [ ] **Step 2: 创建一个 AI 任务让终端跑起来**

随便挂一个 todo，跑 Claude/Codex，让终端产生 ≥ 3 屏内容。

- [ ] **Step 3: 验收用例 1 — 近底吸附 + Tag 联动**

操作：把鼠标放在终端上，滚轮滚到顶；缓慢滚到距底 4 行以内的位置停手。  
预期：自动跳到底；工具栏「跟随」Tag 显示绿色 + LockOutlined 图标。

- [ ] **Step 4: 验收用例 2 — 越过阈值停留稳定**

操作：从底部往上滚 > 4 行（例如 10 行），停手。  
预期：停留位置稳定；Tag 变灰 + UnlockOutlined。

- [ ] **Step 5: 验收用例 3 — followTail=true 时新输出跟随**

操作：用例 1 状态下让 AI 输出新内容（例如发一条 prompt）。  
预期：视口跟随到最新内容。

- [ ] **Step 6: 验收用例 4 — followTail=false 时新输出不干扰**

操作：用例 2 状态下让 AI 输出新内容。  
预期：视口位置不变，用户阅读不被打断。

- [ ] **Step 7: 验收用例 5 — 工具栏按钮 / Ctrl+End 行为不变**

操作：分别点击工具栏「滚到底部」按钮、按 Ctrl+End。  
预期：视口跳到底；Tag 绿。

- [ ] **Step 8: 验收用例 6 — console.warn 仅首次**

操作：打开 DevTools Console；触发一次"近底吸附"。  
预期：Console 出现一行 `[AiTerminalMini] near-bottom snap engaged { ... }`；再触发若干次不再出现新行。  
**特别注意**：把那一行的 `delta` / `scrollTop` / `scrollH` / `clientH` 几个数值贴到 PR 描述里，作为下次真出问题时的对照基线。

- [ ] **Step 9: 移动端 / 全屏 / dock 嵌入三种模式各过一遍**

- 桌面浏览器 dock 嵌入态（默认）：用例 1~6。
- 全屏（点工具栏全屏按钮）：用例 1~6。
- 移动端（DevTools 切到 iPhone 模拟器，触摸滑动）：用例 1~4（用例 5、6 桌面端已覆盖）。

- [ ] **Step 10: 如发现回归，回滚到 Task 3 之前的 commit**

```bash
git revert HEAD
```

否则进 Task 5。

---

## Task 5: 写 PR 描述

**Files:** 无代码改动。

- [ ] **Step 1: 推到远端**

```bash
git push -u origin main
```

（项目当前在 main 分支直接迭代，对照最近的提交模式 `0334016 fix(web): only show ...` —— 不走 feature branch。如果同事提到要走 PR 流程再切分支。）

- [ ] **Step 2: 写 PR / 不开 PR 时写到 CHANGELOG / 留给下次手动验证**

由项目流程决定。最少要在 PR 描述（或 commit body）附：

- 验收清单 6 条逐条勾选。
- Task 4 Step 8 抓到的 console.warn 数值（如有）。
- 链接到 spec：`docs/superpowers/specs/2026-05-12-ai-terminal-scroll-near-bottom-snap-design.md`。

---

## Self-Review

**1. Spec coverage**
- 「近底吸附」→ Task 3 Step 4 注册 onScroll + 调 `decideNearBottomAction`。
- 「followTail 跟手动滚动联动」→ Task 3 Step 4 中 `action.nextFollowTail` 分支处理。
- 「一次性 console.warn」→ Task 3 Step 2 模块级 `warnedNearBottomOnce` + Step 4 中的 warn 块。
- 「反回声 guard」→ Task 3 Step 3 ref + Step 4 中的 `suppressNextScrollEventRef.current` 检查与设置。
- 「Cleanup 释放 disposable」→ Task 3 Step 5。
- 「纯函数 + 单测」→ Task 1 + Task 2。
- 「与既有路径不冲突」→ Task 3 不修改 `output`/`replay` 写入回调、不动 `toggleFollowTail` / Ctrl+End / 键盘弹出处理；Task 4 Step 7 显式复测既有路径。
- 「Canvas / DOM 渲染器都生效」→ Task 3 使用 xterm 核心 API，无渲染器分支；Task 4 Step 9 含移动端复测可覆盖。
- 「不改后端 / WS / localStorage schema」→ Task 3 仅写 `quadtodo.followTail`（既有 key）。

**2. Placeholder scan**
- 无 TBD / TODO / implement later。
- 每个代码步骤都给了完整代码块。
- Task 4 步骤是手动复测，给了具体操作和预期；非「填空」。

**3. Type consistency**
- `decideNearBottomAction(baseY, dispY, followTail, nearBottomLines)` 在 Task 1 测试、Task 2 实现、Task 3 调用处签名完全一致。
- `NearBottomAction { snap, nextFollowTail }` 字段名在三处一致。
- `NEAR_BOTTOM_LINES` 在 Task 2 / Task 3 均以同名 import 使用。
- `suppressNextScrollEventRef` 命名在 Task 3 Step 3 / Step 4 一致。
- `scrollSnapDisposable` 在 Task 3 Step 4 / Step 5 一致。
- `warnedNearBottomOnce` 在 Task 3 Step 2 / Step 4 一致。

通过。

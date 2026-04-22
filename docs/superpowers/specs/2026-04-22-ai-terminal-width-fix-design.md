# AI 终端宽度显示不全修复 — 设计文档

- 日期：2026-04-22
- 所属项目：`quadtodo`
- 关联文件：`web/src/AiTerminalMini.tsx`、`web/src/SessionViewer.tsx`、`web/src/TodoManage.css`

## 背景 / 现象

用户报告 AI 终端宽度显示不全：终端外层面板正常占据 ~1200px 宽度，但 xterm 渲染出来的文字挤在最左侧约 40px 的窄列里（每行只有 3-4 个字符），必须靠滑动或重开才能恢复。

## 根因

xterm.js 的 `FitAddon.fit()` 依据容器 `clientWidth / clientHeight` 计算 `cols / rows`。当初次 `fit()` 被调用时，容器处于 **0 宽或 `display: none`** 状态，`fit()` 会算出 `cols ≈ 1-3`。之后即便容器变宽、`ResizeObserver` 重新触发 `fit()`，xterm 内部的行缓冲和渲染状态有时已经按错误 cols 铺好，无法完全自愈。

会触发这种"初次 0 宽 fit"的场景：

1. `SessionViewer.tsx:50-55`：Live 和 Chat 两个视图同时挂载、用 `display: none` 切换（为保留 xterm/WS 状态）。若用户先停留在 Chat 再切到 Live，Live 初次挂载时容器是 `display: none`。
2. `TodoManage.css:577`：`.todo-terminal-panel.collapsed .todo-terminal-body` 是 `display: none`。从折叠态挂载再展开会触发。
3. 内嵌终端首次渲染时父布局（flex）尚未完成，`clientWidth` 短暂为 0。
4. Modal (90vw) 开启动画期间挂载。

另外，`ResizeObserver` 在元素从 `display: none` 切回可见时，并不总会触发 `ResizeObserverEntry`（浏览器实现差异），所以不能完全依赖它兜底。

## 目标

修复后以下 4 个场景都应显示正常宽度（无 3-4 字符换行），且不回退既有功能：

1. 页面刷新后，终端**初始折叠**再展开
2. 在 Chat 续聊 tab 停留后**切回 Live 终端**
3. 用"全屏"按钮进入全屏再退出
4. 开启 / 关闭"并排视图"

不能回退：切 Chat→Live 不丢 xterm 缓冲；WS 不掉线；拖拽调高度、窗口 resize 仍能正常 fit。

## 非目标（YAGNI）

- 不改 SessionViewer 两视图同时挂载的设计（那是为了保留 xterm/WS 状态，有意为之）
- 不改 Chat 续聊的显示逻辑（Chat 文字错乱怀疑是 Live cols=3 的下游效应，本轮先修 Live，之后复验）
- 不给 xterm 做版本升级 / FitAddon 替换

## 改动范围

所有改动集中在 `web/src/AiTerminalMini.tsx`。

### 改动 1：`doFit()` 增加可见性与尺寸 guard

现状（`AiTerminalMini.tsx:112-129`）：

```ts
const doFit = useCallback(() => {
  const fit = fitRef.current
  const term = termRef.current
  const ws = wsRef.current
  if (!fit || !term) return
  try {
    fit.fit()
    const { cols, rows } = term
    // ...发送 resize
  } catch (e) { ... }
}, [])
```

改成：若容器不可见或宽度不足，直接 return，不污染 xterm 内部状态。

```ts
const doFit = useCallback(() => {
  const fit = fitRef.current
  const term = termRef.current
  const container = containerRef.current
  const ws = wsRef.current
  if (!fit || !term || !container) return
  // 容器处于 display:none 或尚未布局完成：跳过，留待可见性触发
  if (container.offsetParent === null) return
  if (container.clientWidth < 40 || container.clientHeight < 20) return
  try {
    fit.fit()
    const { cols, rows } = term
    // 结果异常小：安排重试（xterm 有时第一次 fit 会算歪）
    if (cols < 10) {
      scheduleRefitRetry()
      return
    }
    // ...发送 resize（同现状）
  } catch (e) { ... }
}, [])
```

`scheduleRefitRetry` 实现：50ms / 150ms / 400ms 三次递增重试，重试时重新进入 `doFit`；若仍 `< 10` 就放弃（不做死循环）。重试计数器在每次成功 fit 或 container 尺寸正常时清零。

### 改动 2：新增 `IntersectionObserver` 监听可见性

在原有 `ResizeObserver` 旁边（`AiTerminalMini.tsx:459-466`）新增：

```ts
const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && entry.intersectionRatio > 0) {
      // 从不可见切回可见：强制 fit
      requestAnimationFrame(() => doFit())
    }
  }
})
io.observe(containerRef.current)
```

在 `return () => { ... }` 清理块里加 `io.disconnect()`。

### 改动 3：`useEffect` 依赖 `fullscreen / height` 时，在下一帧强制重试一次

现状（`AiTerminalMini.tsx:513-515`）：

```ts
useEffect(() => {
  requestAnimationFrame(doFit)
}, [fullscreen, height, doFit])
```

改成：`fullscreen` 变化时，由于布局大幅变化，调 `doFit` 后再调一次 `scheduleRefitRetry`（防止 Modal 动画中算歪）。

## 验收标准

1. **场景 1**：刷新页面，点击 todo 的"折叠终端"按钮让它处于折叠态，然后展开 → Live 终端文字正常宽度渲染，无 3-4 字符换行
2. **场景 2**：切到 Chat 续聊停留 5 秒以上，切回 Live 终端 → xterm 缓冲保留、文字按实际面板宽度换行
3. **场景 3**：点击"全屏"进入全屏再退出 → 两种状态下文字都正常
4. **场景 4**：开启"并排视图"，两个终端左右各占一半宽度并正常渲染；关闭并排后左侧终端恢复全宽渲染
5. **不回退**：拖拽调高度、浏览器窗口 resize、新开会话、发送命令、WS 重连 都不受影响

## 风险

- `IntersectionObserver` 在 Modal 动画期间可能重复触发 → 依赖已有的 `RESIZE_DEBOUNCE_MS = 100ms` 节流，`scheduleRefitRetry` 内部也有"正在重试中"锁避免叠加
- 重试次数上限 3 次，避免死循环
- `offsetParent === null` 在某些 `position: fixed` 祖先场景下判断可能不准；作为兜底再加 `clientWidth < 40` 的下限

## 测试手段

手工按验收标准 1-4 逐个复现 + 验证；无新增单测（纯 UI 时序，测试价值低）。

# AI 终端尺寸优先握手（Size-First Handshake）— 设计

- 日期：2026-05-11
- 所属项目：`quadtodo`
- 关联文件：`web/src/AiTerminalMini.tsx`、`web/src/main.tsx`、`web/package.json`、`src/pty.js`、`src/routes/ai-terminal.js`、`test/ai-terminal.route.test.js`
- 关联历史 spec：
  - `2026-04-22-ai-terminal-width-fix-design.md`
  - `2026-05-08-ai-terminal-resize-guard-design.md`
  - `2026-05-10-multi-tab-terminal-size-isolation-design.md`

## 背景

AI 终端首屏宽度仍然会出问题，尤其是给同事在新机器上首次安装时同时出现以下四类现象：

- **A**：输出在最左侧挤成 3-4 个字符一行
- **B**：Claude/Codex 启动 banner 横线 / 框比实际终端窄一截，右侧留白；用户键入后才"对齐"
- **C**：scrollback 出现重叠、错行、残影
- **D**：中文、`├ │ ─ ╰` 等框线字符宽度对不上，整行被挤歪

历史上已经做过多次防护（容器可见性 guard、`MIN_VALID_COLS=30`、稳定性去抖、后台 tab unregister、resize 聚合 min），但这些都是"在错误尺寸已经发生后做兜底过滤"，无法消除以下两个根因：

1. **后端 PTY 永远以默认 `80×24` 启动**（`src/pty.js:486-487, 665-666`），Claude/Codex 在前端 resize 到达之前已经写完首屏 banner。
2. **前端 xterm 构造时机不与字体加载状态绑定**——CanvasAddon 在系统字体（尤其是中文 fallback）就绪前采样 glyph 宽度，后续不再重测。

## 目标

新会话首次启动时，PTY 子进程直接以前端实际容器宽度（而不是 80×24）启动；xterm 在容器布局与字体加载完成后才构造。修复后下列场景不再出现 A/B/C/D 任一现象：

1. 新机器 / 新用户首次启动 `claude` 或 `codex` 会话，全屏宽窗口
2. 同一启动场景在窄窗口 / 折叠后展开
3. 同一 session 多 tab 同时打开，一宽一窄
4. WS 重连、`resume` 续聊老 session、popout 弹出窗口
5. macOS（Menlo 可用）+ Linux（无 Menlo，需要内置字体）

不能回退：现有 resize 聚合、移动端 visibility 处理、`done/failed/stopped` 忽略 resize、multi-tab 后台 unregister 等行为。

## 非目标（YAGNI）

- 不升级 xterm / FitAddon / CanvasAddon 版本
- 不重写终端输出协议
- 不对历史 PTY 日志做 headless xterm 规范化
- 不动 `mira-proxy`、Lark/Telegram bridge、orchestrator
- 不修改 DB schema、历史 session 数据结构

## 方案：Size-First Handshake

### 协议变化

新增一种 WS 消息：

```json
{ "type": "init", "cols": 120, "rows": 30 }
```

由前端在 WS open + 容器 layout settle + 字体 ready 之后**第一时间**发出。后端收到 `init`：

- 若 session 还没 spawn：以该 cols/rows spawn PTY，并把尺寸注册进聚合表
- 若 session 已 spawn（reconnect / resume / 兜底已触发）：等价于一条 resize，注册尺寸并 `applyAggregatedResize`

### 启动时序

旧时序：

```
HTTP start → pty.spawn(80×24) 立即                      Claude 按 80 列画首屏
                                  ↑ 之后才到
WS open → 等 200ms 稳定窗口 → resize(realCols, realRows)
```

新时序：

```
HTTP start → session 占位（不 spawn）
WS open ← 前端 await fonts.ready + 容器 layout settle
       → 发 init(realCols, realRows)
后端收 init → pty.startWithSize(realCols, realRows) → write(prompt) → Claude 按真实列数画首屏
```

### 后端改动

**`src/pty.js`** — spawn 拆两步：

- 新增 `create(sessionId, options)`：构建 session 对象、初始化 `pendingPrompt`、设置 Codex 探测器需要的占位字段，但**不调** `this.ptyFactory(...)`、不挂 `onData/onExit`。
- 新增 `startWithSize(sessionId, cols, rows)`：第一次调用执行真正的 `this.ptyFactory(bin, args, { cols, rows, ... })`，挂 `onData/onExit`，调度 Codex 探测器与 `pendingPrompt` 的写入；再次调用退化为 `resize(sessionId, cols, rows)`。
- 保留 `spawn(sessionId, options)`：内部实现改为 `create(sessionId, options); startWithSize(sessionId, 80, 24)`，向后兼容现有所有调用方（含测试）。
- `resize()` 现有"首次 resize 触发 `pendingPrompt` 写入"的逻辑（`src/pty.js:723-737`）保留——`startWithSize` 内部的首次写入与之等价。

**`src/routes/ai-terminal.js`** — 新增 `init` 分支：

- 启动 session 的路径（HTTP `/start` 入口）改为调 `pty.create(...)` 而不是 `pty.spawn(...)`；在 session 记录上加 `spawned: false` 标志和 5 秒 `spawnFallbackTimer`。
- `handleBrowserMessage` 新增 `case 'init'`：
  - `isValidResizeSize(cols, rows)` 失败 → 忽略（等下一条 init 或兜底）
  - `session.spawned === false` → 清掉 `spawnFallbackTimer`，置 `spawned = true`，调 `pty.startWithSize(sessionId, cols, rows)`，写入 `ws.__quadtodoSize`，调 `applyAggregatedResize`
  - `session.spawned === true` → 等价 resize（写入 `ws.__quadtodoSize` + `applyAggregatedResize`），**不重 spawn**
- `spawnFallbackTimer` 到点（5 秒）：若 `spawned === false`，强制 `pty.startWithSize(sessionId, 80, 24)`，置 `spawned = true`，记日志 `[ai-terminal] spawn fallback fired session=...`

`resume` / 已存在 session 重连路径不走 `create`——后端检测到 session 已存在时跳过 `create`，前端 `init` 自然走 spawned===true 分支，整链路无副作用。

### 前端改动

**`web/package.json`** — 新增依赖：

```
"@fontsource/jetbrains-mono": "^5.x"
```

**`web/src/main.tsx`** — 入口加载字体 CSS：

```ts
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
```

**`web/src/AiTerminalMini.tsx`**：

1. xterm `fontFamily` 改为 `'"JetBrains Mono", Menlo, Monaco, "Courier New", monospace'`
2. 抽出 `async function waitTerminalReady(container)`：
   - 等容器 `clientWidth >= MIN_CONTAINER_WIDTH` 且 `offsetParent !== null`（用 `ResizeObserver` + `IntersectionObserver`，最长 3 秒）
   - `await document.fonts.ready`
   - `await document.fonts.load('13px "JetBrains Mono"')`（try/catch 包裹兼容 Safari < 14.1）
   - `await new Promise(r => requestAnimationFrame(r))`
3. xterm 构造与 `term.open()`、`fit.fit()`、CanvasAddon load、link provider 注册等全部延后到 `waitTerminalReady` 之后。等待期间显示纯 DOM placeholder（不写入 xterm）。
4. WS `onopen` 流程改造：
   - 不再立即 `term.writeln('--- Terminal connected ---')`
   - 不再走 `doFit → scheduleResizeSend` 的"首次发 resize"路径
   - 改为：直接读 `term.cols / term.rows`，发送 `{ type: 'init', cols, rows }`
   - 之后照常进入既有 `scheduleResizeSend` / ResizeObserver 路径
5. 后台 tab 也发 init：visibility hidden 时第一次连接照常发 init（保证后端能 spawn），发完之后立即追发一条 `{ type: 'resize', cols: 0, rows: 0 }` 走 unregister，避免后台 tab 把 PTY 钳到自身尺寸。
6. popout 窗口：`waitTerminalReady` 用 popout 自己的 `document.fonts`，不复用主窗口。

### 关键边界场景

| # | 场景 | 行为 |
|---|---|---|
| 1 | 新 session、单 tab、宽屏 | spawn 直接按真实 cols；无 80→真实尺寸 reflow |
| 2 | 新 session、窄屏 / 折叠态 | `waitTerminalReady` 等到展开或 3 秒兜底；按当时 cols 发 init |
| 3 | 永远不展开 | 前端 3 秒后按 fallback cols 发 init；若前端干脆不发，后端 5 秒兜底 spawn 80×24 |
| 4 | 已运行 session reconnect | `spawned===true`，init 走 else 分支，仅 resize，不重 spawn |
| 5 | `resume` 续聊老 native session | 同 #4 |
| 6 | 多 tab 同 session | 第一个发 init 触发 spawn；后续 init 自动降级为 resize 并参与 min 聚合 |
| 7 | 第一个 tab 在后台、第二个在前台 | 后台 tab 也发 init（保证 spawn），发完立刻追发 `0/0` unregister |
| 8 | iOS Safari 字体慢 | `waitTerminalReady` 3 秒兜底；首屏可能先 fallback 再切 JetBrains Mono，不阻断 |
| 9 | popout window | popout 走完整 `waitTerminalReady`，等自己的 `document.fonts` |
| 10 | 移动端横竖屏切换 | 仅走 resize 原路径，不重发 init |
| 11 | WS 重连 | 重连 onopen 仍发 init，后端 `spawned===true` 走 else，无副作用 |
| 12 | 后端 5 秒兜底已 spawn、之后前端 init 到达 | 走 else 分支按真实尺寸 resize 一次；首屏 80 列内容遗留——degraded 路径，不阻断 |

## 风险与缓解

- **`@fontsource/jetbrains-mono` 增加 ~120KB bundle**：可接受；如未来要瘦身可只引 woff2 subset。
- **`document.fonts.load(...)` 在老 Safari 不支持**：try/catch 包裹；fallback 走 `document.fonts.ready` 已经覆盖大部分场景。
- **3 秒前端兜底 + 5 秒后端兜底**：若两者都触发，首屏会以 80×24 spawn，等同现状（不更差）。
- **后台 tab 发 init 后立即追发 0/0**：测试覆盖单 tab 后台启动场景，验证 spawn 用的是 init 的尺寸而不是被随后 0/0 误覆盖（`isValidResizeSize(0,0)===false` 不会触发 resize）。
- **HTTP `/start` 路径里部分调用方依赖 spawn 完成的副作用**（如 Codex sidecar 注册、`nativeId` 同步通知）：这些副作用搬到 `startWithSize` 内部触发，时序由"spawn 完成"改为"init 到达后 spawn 完成"，对外接口不变；调用方不感知。

## 验收标准

### 自动化测试（`test/ai-terminal.route.test.js`）

1. WS 发 `init(120,30)` → `pty.startWithSize` 被以 `(120,30)` 调用一次
2. WS 发 `init(0,0)` → `startWithSize` 未调用，5 秒兜底计时器仍在
3. 5 秒兜底触发 → `startWithSize(80,24)` 调用一次
4. 连续两条 init → `startWithSize` 仅调一次，第二条按 resize 处理
5. 已 spawned session 新 WS 连接发 init → 仅 resize，不 spawn
6. 现有 resize 聚合、`isValidResizeSize`、`done/failed/stopped` 忽略 resize 等用例全绿（无回归）

### 手工验证

- **RED**（修复前）：macOS Chrome 全屏 1400px 启动 `claude` → 首屏 banner 横线短 ~30 列
- **GREEN**（修复后）：
  1. 同上场景：banner 一开始即铺满；scrollback 第一帧不含任何 80 列宽内容
  2. 终端面板拖到 600px → 启动 → banner 按 ~75 列画
  3. 折叠态启动 codex → 3 秒后展开 → banner 出现且按真实宽度
  4. Linux + DejaVu Sans Mono → 中文 / 框线对齐（JetBrains Mono 已下载完）
  5. 同 session 两 tab 一宽一窄，窄那个切后台 5 秒 → 宽 tab 在宽 cols 下保持
  6. WS 重连 → 不重 spawn、无错乱
  7. popout 终端窗口 → 弹出窗口走完整 init 流程，字体加载完
- **跨机器**：本机 macOS + 同事机器各跑一次手工场景

### 不在本轮验收范围

- 5 秒兜底之后 init 才到的 degraded 路径视觉不要求绝对干净，仅要求不抛错
- xterm / FitAddon 版本升级
- 历史 `dist-web` 包重发——由后续 `npm publish` 自行决定

## 测试计划

- `npm test -- --run test/ai-terminal.route.test.js` 全绿
- `npm run build` 通过（web 端 type check + bundle 成功）
- 浏览器手工跑上节"GREEN"列出的 7 个场景
- 同事机器手工跑同样 7 个场景

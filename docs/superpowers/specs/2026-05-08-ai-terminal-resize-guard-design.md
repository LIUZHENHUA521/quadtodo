# AI 终端 resize 污染防护设计

## 背景

用户截图中的 AI 终端出现内容重叠、重复、残影、错行。项目当前终端链路是：前端 `AiTerminalMini` 用 xterm FitAddon 计算 cols/rows，经 WebSocket 发送 resize；后端 `ai-terminal` 对同一 session 的多个浏览器尺寸做聚合后调用 `pty.resize()`。

本次只做方案 B：加强 resize 聚合与日志污染防护，不做 replay 前清屏。

## 目标

- 避免隐藏、折叠、布局中间态或异常小尺寸污染 PTY 尺寸。
- 避免完成态、停止态、失败态 session 继续响应 resize。
- 保持合法 resize 正常工作，不破坏手机、窄屏、全屏等场景。

## 非目标

- 不重写终端输出协议。
- 不对历史 PTY 日志做 headless xterm 规范化。
- 不在本次加入 replay 前清屏或前端清理旧 buffer 的行为。

## 方案

### 前端尺寸上报

`web/src/AiTerminalMini.tsx` 已有隐藏容器、最小宽度、最小 cols、稳定性去抖等防护。本次只做必要收紧：

- 继续使用现有 `MIN_VALID_COLS = 30` 基线。
- 完成态、过期态等非活跃状态不再向服务端发送 resize。
- 保持现有稳定性去抖，避免布局变化瞬间发送中间态尺寸。

### 后端 resize 聚合

在 `src/routes/ai-terminal.js` 中强化 `applyAggregatedResize()` 与 WS `resize` 处理：

- 定义后端最小合法 cols 为 30，与前端一致。
- 过滤非有限、非正数、低于阈值的 cols/rows。
- 对 `done`、`failed`、`stopped` 的 session 忽略 resize。
- 多浏览器聚合时忽略异常尺寸，只用合法尺寸取最小值。
- 保留 `lastAppliedCols/Rows` 去重逻辑，重复尺寸不调用 `pty.resize()`。

### 数据流

1. 前端 FitAddon 计算当前可见终端尺寸。
2. 前端在尺寸稳定且 session 活跃时发送 `{ type: 'resize', cols, rows }`。
3. 后端校验单个浏览器上报尺寸。
4. 后端聚合所有在线浏览器的合法尺寸。
5. 聚合尺寸变化且 session 仍运行时，调用 `pty.resize(sessionId, cols, rows)`。

## 风险与缓解

- 移动端/窄屏被误伤：使用 `cols < 30` 作为过滤阈值，沿用现有前端基线。
- 多窗口显示留白：聚合仍取合法尺寸的最小值，较宽窗口可能留白；这是稳定性优先的可接受取舍。
- 残影根因不只 resize：本次不做 replay 清屏；若仍有旧 buffer 叠加问题，后续单独做方案 A。
- 过度阻止 resize：只过滤异常和终止态，不锁定运行态合法尺寸。

## 验收标准

- 合法 resize 仍会调用 `pty.resize()`。
- `cols < 30` 或非法 resize 不调用 `pty.resize()`。
- 多浏览器聚合时，异常小尺寸不会拉低 PTY 尺寸。
- `done`、`failed`、`stopped` session 收到 resize 不调用 `pty.resize()`。
- 手动验证：AI 终端在切 tab、折叠展开、全屏、窗口缩放时，不再持续累积明显重叠、残影或错行。

## 测试计划

- 在 `test/ai-terminal.route.test.js` 补充 resize guard 单元/路由测试。
- 运行目标测试：`npm test -- --run test/ai-terminal.route.test.js` 或等价 vitest 命令。
- 如实现改动触及前端逻辑，运行 web build 或相应类型检查；并在浏览器中手动验证终端 resize 场景。

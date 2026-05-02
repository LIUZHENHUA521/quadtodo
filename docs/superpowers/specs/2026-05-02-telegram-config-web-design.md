# Telegram 配置 web 化设计

**日期**: 2026-05-02
**状态**: Draft
**作者**: lzh + Claude

## 背景

quadtodo 已经把 `~/.quadtodo/config.json` 暴露在 web `SettingsDrawer`（`web/src/SettingsDrawer.tsx`）。但目前 telegram 模块只暴露 2 个字段（`notificationCooldownMs` 和 `autoCreateTopic`），剩下 11+ 个字段仍只能通过 `quadtodo config set <path> <value>` CLI 修改，这意味着：

- 新用户首次接入 telegram 必须按 `docs/TELEGRAM.md` 跑 6 步 CLI（包括"群里发消息看日志 grep chatId"这种诡异操作）
- bot token 默认从 `~/.openclaw/openclaw.json` 兜底读，路径硬编码在 `src/telegram-bot.js:454`，UI 上不可见也不可改
- 改完 `telegram.enabled / supergroupId / token` 必须 `quadtodo stop && start` 才能生效
- 几个会影响 telegram 行为的常量（`pollRetryDelayMs / minRenameIntervalMs`）写死在代码里

## 目标

- 把 `~/.quadtodo/config.json` 里所有 telegram 字段（含本来硬编码的 2 个常量）暴露到 web `SettingsDrawer`
- bot token 在 web 上可读、可写、可遮罩；保留对 `~/.openclaw/openclaw.json` 的向后兼容兜底
- 新增「Setup 辅助」：连通性测试 + 自动抓 supergroup ID（替代手动 grep 日志）
- 改完 telegram 配置后 60 秒内自动热重启长轮询，不需要重启 quadtodo 进程
- offset 不丢（重启时不漏 update）

## 非目标

- **本期不动 OpenClaw**：`config.openclaw.*` schema 保留兼容，但不在 SettingsDrawer 上展示
- **不改 webhook 段**：保留现状
- **不开放** `stats / wiki / pipeline / host` 等其他模块的 web 配置（下一轮再说）
- **不做** schema 驱动的"通用 plugin settings 框架"
- **不做多租户**：仍然假设单实例 + 单 telegram bot

## 配置字段总表

按 UI 分区组织，前面 5 区在折叠面板默认展开，「高级」区默认折叠。

### 基础区（4 项 / 必配）

| 字段 | 当前位置 | 默认值 | UI 控件 |
|---|---|---|---|
| `telegram.enabled` | config.js:68 | `false` | Switch |
| `telegram.botToken` | config.js（含兜底从 openclaw.json）| `null` | `Input.Password` + 来源 Tag + 测试按钮 |
| `telegram.supergroupId` | config.js:69 | `""` | Input + 「抓 ID」按钮 |
| `telegram.allowedChatIds` | config.js:76 | `[]` | Tag 输入（多值，去空） |

### Topic 行为区（5 项）

| 字段 | 默认值 | UI 控件 |
|---|---|---|
| `telegram.useTopics` | `true` | Switch |
| `telegram.createTopicOnTaskStart` | `true` | Switch |
| `telegram.closeTopicOnSessionEnd` | `true` | Switch |
| `telegram.autoCreateTopic` | `true` | Switch（已有，移到本区） |
| `telegram.topicNameTemplate` | `#t{shortCode} {title}` | Input + 占位符提示 `{shortCode} {title}` |
| `telegram.topicNameDoneTemplate` | `✅ {originalName}` | Input + 占位符提示 `{originalName}` |

### 通知行为区（2 项）

| 字段 | 默认值 | UI 控件 |
|---|---|---|
| `telegram.notificationCooldownMs` | `600000` | InputNumber（已有） |
| `telegram.suppressNotificationEvents` | `true` | Switch |

### 安全区（1 项）

| 字段 | 默认值 | UI 控件 |
|---|---|---|
| `telegram.allowedFromUserIds` | `[]` | Tag 输入（多值，可空 = 不限制） |

### 高级区（默认折叠 / 3 项）

| 字段 | 当前位置 | 默认值 | UI 控件 | 说明 |
|---|---|---|---|---|
| `telegram.longPollTimeoutSec` | config.js:70 | `30` | InputNumber | 长轮询超时（秒）|
| `telegram.pollRetryDelayMs` | **硬编码** telegram-bot.js:28 | `5000` | InputNumber | 拉取失败后退避起点（ms）|
| `telegram.minRenameIntervalMs` | **硬编码** telegram-loading-status.js:28 | `30000` | InputNumber | Topic 重命名最小间隔（防风控）|

总计：**14 个字段**进 web UI（含 2 个常量从代码提取到 config）。

### 不进 web 的字段

| 字段 | 原因 |
|---|---|
| `telegram.apiBase`（`https://api.telegram.org`，硬编码）| 没人改 |
| `telegram.offsetFile`（`~/.quadtodo/telegram-offset.json`，硬编码）| 基础设施路径 |
| `HTTPS_PROXY / HTTP_PROXY` | 系统级 env，不进 config |

## Token 来源策略

**读取优先级**（保持 `src/telegram-bot.js:readBotToken` 现行行为，不改）：

1. `config.telegram.botToken`（quadtodo 自己的 config）
2. `~/.openclaw/openclaw.json` 的 `channels.telegram.botToken`（向后兼容）
3. 都没有 → 启动失败

**Web UI 行为**：

- `GET /api/config` 时，**永远不**回真实 token；改回 `{ botTokenMasked: "tg_***末四位", botTokenSource: "quadtodo" | "openclaw" | "missing" }` 两个新字段
- `PUT /api/config` 收到的 `telegram.botToken`：
  - 如果是「mask 字符串」`tg_***xxxx` → 服务端忽略（用户没改）
  - 如果是其他字符串 → 写到 `config.telegram.botToken`，覆盖原值
  - 如果是空字符串 `""` → 清掉 `config.telegram.botToken`，回退到 openclaw.json 兜底
- UI 上展示来源 tag：
  - 来自 quadtodo：`<Tag color="default">quadtodo 配置</Tag>`
  - 来自 OpenClaw 兜底：`<Tag color="orange">来自 ~/.openclaw/openclaw.json（兜底）</Tag>`
  - 缺失：`<Tag color="error">未配置</Tag>`

## Setup 辅助功能

### 1. Token 连通性测试

`POST /api/config/telegram/test` —— 不需要任何 body：

- 服务端从当前 config 读 token（含兜底）
- 调一次 `GET https://api.telegram.org/bot<token>/getMe`
- 返回 `{ ok, botUsername, botId, errorReason? }`

UI：token 输入框旁边一个「测试」按钮，点了之后展示 `✓ 已连接：@lzhTodoBot` 或 `✗ 401 Unauthorized`。

### 2. 自动抓 supergroup ID

`POST /api/config/telegram/probe-chat-id` —— body `{ durationSec: 60 }`（默认 60，最多 120）：

- 服务端在内存里开一个 60 秒"窗口"，设置 `probeMode = true`
- telegram-bot.js 的 `dispatch` 检测到 `probeMode` 时：除了正常处理消息（继续走白名单逻辑），还把 `(chatId, chatTitle, chatType, fromUserId, fromUsername, textPreview)` 推到一个 `probeBuffer: Array`
- 60 秒后窗口关闭
- HTTP 用 SSE（`text/event-stream`）实时把 `probeBuffer` 的新条目推给前端
- 用户在 UI 上看到一个表格，每来一行就追加一行

UI 流程：

1. 用户在群里 @bot 发条任意消息
2. quadtodo 长轮询拿到 update → probe 窗口期内 → 推到前端表格
3. 用户在表格里点选某行 → 自动写回 `supergroupId` 和 `allowedChatIds[0]` form 字段（**不立即保存**，等用户点表单底部「保存」按钮）

**安全考量**：
- probe 窗口期内**不放宽**白名单 —— 不在 `allowedChatIds` 里的消息仍然 drop（除了 probe 表格里看一眼）
- 窗口最长 120 秒，到期自动关
- 同一时刻只允许一个窗口（避免多个 web 端同时开，互相搅）
- 表格里展示 chat 标题但不缓存到磁盘，关窗口立即清空

### 3. 热重启 telegram stack

`PUT /api/config` 检测到 `telegram.*` 任一字段变化时：

1. 把 `server.js:837-870` 的 telegram stack 启动逻辑抽成一个独立函数 `startTelegramStack(cfg)` / `stopTelegramStack()`
2. PUT 处理器最后调 `restartTelegramStack(newCfg)`：
   - `await stopTelegramStack()`：停长轮询、把当前 offset 落盘
   - 重建 `telegramBot` / `loadingTracker`
   - 重新注入到 `openclawBridge.setTelegramBot()` / `openclawHookHandler` / `openclawWizard`
   - `await startTelegramStack()`
3. 整个过程内若失败：log 警告，不阻塞 PUT 响应；前端会通过 `GET /api/config` 看到当前状态
4. PUT response 增加 `telegramRestart: { applied: true, error?: string }`

**关键约束**：
- offset 文件每次 `getUpdates` 后立即落盘（不依赖关闭时刻 flush），所以崩溃也不丢消息
- wizard / hook 持有的 `telegramBot` 引用是**值引用**，重启时这些引用会变野 —— 改造方式：把 `telegramBot` 通过一个 `getter` 对象传给 wizard / hook，`getter.current` 内部指向最新实例，重启时改 `.current` 字段而不是替换 `getter` 对象本身

## API 变更

### 改动

`GET /api/config` —— 在 response 的 `config.telegram` 里：
- **去掉** `botToken` 字段（不再回明文）
- **加上** `botTokenMasked: string | null` 和 `botTokenSource: "quadtodo" | "openclaw" | "missing"`

`PUT /api/config` —— 在 request body 的 `telegram.botToken`：
- 收到 mask 字符串（正则 `^tg_\*+[a-zA-Z0-9]{4}$`）→ 跳过写入
- 收到空串或 null → 清掉 quadtodo 配置里的 botToken
- 收到其他 → 覆盖写入

### 新增

| 接口 | 用途 |
|---|---|
| `POST /api/config/telegram/test` | getMe 测试 |
| `POST /api/config/telegram/probe-chat-id` | 启动 probe 窗口（返回 SSE URL） |
| `GET /api/config/telegram/probe-chat-id/stream` | SSE 长连，实时推 probe 命中条目 |

## 数据流

```
用户在 SettingsDrawer 编辑 telegram 字段
  ↓
点保存 → PUT /api/config { telegram: {...} }
  ↓
saveConfig 落盘 ~/.quadtodo/config.json
  ↓
detectTelegramChanged(prevCfg, newCfg) ?
  ↓ yes
restartTelegramStack(newCfg)
  ├─ stopTelegramStack: bot.stop() / 落 offset / 拆 loadingTracker
  ├─ createTelegramBot(newCfg)
  ├─ 重注入 wizard / hook / bridge.setTelegramBot
  └─ telegramBot.start()
  ↓
PUT response: { ok, telegramRestart: { applied: true } }
```

## 文件改动清单

### 后端

- `src/config.js`：在 `DEFAULT_TELEGRAM_CONFIG` 加 `pollRetryDelayMs: 5000` / `minRenameIntervalMs: 30000`
- `src/telegram-bot.js`：把 `POLL_RETRY_DELAY_MS` 常量改为读 `tg.pollRetryDelayMs ?? 5000`；新增 `setProbeMode(durationSec, onHit)` 方法；新增 `stop()` 方法（停长轮询 + 落 offset）
- `src/telegram-loading-status.js`：把 `MIN_RENAME_INTERVAL_MS` 常量改为读 `tg.minRenameIntervalMs ?? 30000`
- `src/server.js`：抽 `startTelegramStack / stopTelegramStack / restartTelegramStack`；用 holder 对象包 telegramBot 引用注入给 wizard / hook
- `src/server.js`：`PUT /api/config` 末尾比对 telegram 段，触发 restart；mask token / 解 token
- `src/routes/telegram-config.js`（**新文件**）：挂 `/api/config/telegram/test` 和 `/probe-chat-id` SSE

### 前端

- `web/src/api.ts`：加 `testTelegram()` / `probeChatId()` / `streamProbeChatId(onHit)`，`AppConfig` type 加 `botTokenMasked / botTokenSource`，去掉 `botToken`
- `web/src/SettingsDrawer.tsx`：新增「Telegram」分组（Collapse），按 5 区铺字段；token 输入框带「测试」按钮；supergroupId 输入框带「抓 ID」按钮 + 弹窗表格
- `web/src/TelegramProbeModal.tsx`（**新文件**）：probe 窗口的弹窗 + SSE 表格

## 验收标准

- [ ] 新装 quadtodo（删 `~/.quadtodo/config.json` + 不预先配 `~/.openclaw/openclaw.json`）后，可以**完全在 web SettingsDrawer 里**完成首次 telegram setup（不开终端、不读 `docs/TELEGRAM.md`）
- [ ] 在 SettingsDrawer 编辑 `telegram.enabled / supergroupId / botToken / topicNameTemplate` 之一并保存后，**不重启 quadtodo 进程**，下一个起的 PTY session 立即用新值
- [ ] 把 `telegram.enabled` 切到 false → 长轮询 5 秒内停；切回 true → 5 秒内恢复，且 offset 不丢
- [ ] Token 在 GET /api/config 里**永远不**返回明文（grep response 不到 token）
- [ ] UI 上 token 来源 tag 在「来自 quadtodo」/「来自 OpenClaw 兜底」两态间切换正确
- [ ] probe-chat-id 抓到群里发的消息后，UI 表格出现该群的 chatId；点选后 form 字段自动填回；过 60 秒自动关
- [ ] probe 窗口期内，没在 `allowedChatIds` 里的群消息照样被 drop（不会因为 probe 而放行处理）
- [ ] `quadtodo config set telegram.xxx yyy` CLI 路径仍可用，且改完后**也**能触发热重启（CLI 改 config 文件 → server.js 检测变化）—— 此条**可降级为下一期**，本期 CLI 改了仍需手动重启
- [ ] 现有 `test/telegram-bot.test.js` 全部通过；新增 `test/telegram-config.test.js` 覆盖 token mask + probe 窗口生命周期 + 热重启路径

## 风险点

1. **热重启时 wizard / hook 引用悬空**：靠 holder 对象（`{ current: telegramBot }`）解决；要保证所有持有方都通过 holder 取，而不是构造时存值。需要在 server.js 仔细 review 4-5 处注入点
2. **Probe 窗口跟 telegram bot 长轮询竞争**：probe 不能起一个并行的 getUpdates（会跟主循环抢 offset）—— 设计上 probe 是**复用主循环的 dispatch hook**，只是多挂一个 listener，不开新连接
3. **多 web 端同时编辑 config**：如果 A、B 两个浏览器同时 PUT，后者覆盖前者 —— 不解决（quadtodo 单用户假设）；但 token mask 那段要保证「A 改了 token，B 没改 token 的字段，B 的 PUT 不会把 token 清掉」（mask 检测兜底）
4. **`~/.openclaw/openclaw.json` 不存在 / 损坏**：兜底读取已有 try/catch（`telegram-bot.js:453-460`），不需要改
5. **CLI 改 config 不触发热重启**（验收清单中已标降级）：本期不做 file watcher，依赖 `quadtodo stop && start`

## 兼容性

- 旧 `~/.quadtodo/config.json` 没有 `pollRetryDelayMs / minRenameIntervalMs` 字段 → `normalizeConfig` 自动加默认值，无破坏
- 旧 token 在 `~/.openclaw/openclaw.json` 的用户：UI 上看到「来自 OpenClaw 兜底」tag，可选择保持原状或在 UI 上重新填一次（迁到 quadtodo config）
- `quadtodo config set / get` CLI 仍可读所有 telegram 字段（含新加的 2 个常量字段）

## 后续

- 下一期可考虑：file watcher 让 CLI `config set` 也触发热重启
- 再下一期：`stats / wiki / pipeline / host` 字段进 web
- 再下一期：OpenClaw 段从 schema 摘除 + bridge 重命名为 `session-route.js`

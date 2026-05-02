# Telegram 直连 + Topics setup

quadtodo 自己跑 Telegram bot 长轮询，每开一个 task 自动建一个 Topic（Telegram Forum），
任务结束后 close + 标题加 `✅` 前缀，对话物理隔离。

设计稿：`docs/superpowers/specs/2026-04-30-telegram-direct-topics-design.md`

---

## 一次性 setup（在 web 上完成）

> 老的纯 CLI 步骤见文档末尾「附：CLI setup（自动化场景）」。

### 1. 在 Telegram 建一个 supergroup

- 新建 Group → 升级为 Supergroup → 启用 Topics
- 把 bot 拉进群 → 给 admin 权限 + 勾选 `Manage Topics` + `Send Messages`

### 2. 拿 bot token

跟 [@BotFather](https://t.me/BotFather) 发 `/newbot` 申请一个新 bot，记下 token（形如 `7846123456:AAH9xK_...`）。

### 3. 启动 quadtodo + 打开设置

```bash
quadtodo start
```

浏览器打开 `http://127.0.0.1:5677/` → 右上角齿轮图标 → 拉到 **Telegram** 折叠区。

### 4. 填 token + 测试

在「Telegram · 基础」区：

- 「启用 Telegram」开关 ON
- Bot Token 填 BotFather 给的串
- 点旁边的「测试」按钮 → 看到 `✓ @yourbot（来源：quadtodo 配置）` 即连通

> 注：旧用户如果 token 仍写在 `~/.openclaw/openclaw.json`，Token 输入框旁边会显示 Tag「来自 ~/.openclaw/openclaw.json（兜底）」。
> 想迁到 quadtodo 自己的 config，在 Bot Token 输入框里重新填一次再保存即可。

### 5. 抓 supergroup ID

- 点「抓 ID」按钮 → 弹出表格开始 60 秒监听
- 到 Telegram 群里随便发条消息（譬如 `hi`）
- 表格里出现该群一行 → 点选 → 自动填回 `Supergroup ID` 和 `白名单 chatIds`
- 关闭弹窗

### 6. 保存

点底部「保存」按钮 → 后端会自动重启长轮询，无需手动 `quadtodo stop && start`。

启动 log 应该看到：

```
[telegram] bot stopped
[telegram] bot started; supergroup=-1001234567890 allowedChatIds=-1001234567890
```

### 7. 验证

```bash
quadtodo doctor
```

应有：
```
✓ telegram.supergroupId — -1001234567890
✓ telegram.allowedChatIds — -1001234567890
✓ telegram bot token — ✓ found in quadtodo 配置
```

---

## 端到端跑通

### 创建任务

在 supergroup 的 **General** topic 发：

```
帮我做：写一个 nodejs hello world demo
```

应该 1-2 秒收到："📁 选个工作目录..."

走完目录/象限/模板向导后：

- General 收到："✅ todo #t42 已建 → 去 topic 「#t42 ...」 看进度"
- 同时 supergroup 多了个新 topic "#t42 写一个..."
- 切到那个 topic → 看到欢迎消息："🤖 任务「...」AI 已启动..."

### AI 回话推送

让 PTY 里的 Claude Code 跑一轮，结束时 Stop hook 触发：

- **#t42 topic**（不是 General）收到 AI 回话内容
- 内容直接来自 `~/.claude/projects/.../uuid.jsonl` 的 latest assistant turn —— 干净、无 spinner / ANSI 噪声
- 长内容（> 4000 字）→ inline 顶部 800 字 + 完整 .md 文件附件

### 用户回话

在 #t42 topic 里直接回 `c` 或任意文本：

- quadtodo 把它写进 PTY 的 stdin（静默成功，不发 ack）
- AI 处理后下一轮回话又推到 #t42

### 多任务并行

- 同时开 N 个 task → N 个 topic → 互不干扰
- 你切 topic 就切 PTY，自然路由

### 任务结束

PTY 退出（Claude Code session 自然结束）→ SessionEnd hook：

- topic 推 "✅ 任务 X 已结束" + 整段 transcript .md 附件
- topic close（锁了，不再接收新消息）
- topic 标题加 `✅ ` 前缀

---

## 故障排查

### bot 不响应

```bash
# 看 quadtodo 长轮询起来了吗
quadtodo doctor                                        # 应有 telegram 段全 ✓
tail -50 ~/.quadtodo/logs/quadtodo.log 2>/dev/null     # 启动 log
quadtodo status                                        # 进程在跑
```

```bash
# 看 OpenClaw 那边没跟你抢 token
openclaw channels list | grep telegram                 # 应该看不到 enabled
```

### 消息发了但被 drop

quadtodo log 里：
```
[telegram-bot] dropped message from unauthorized chat=-100xxx ...
```

→ 这个 `-100xxx` 没在 `telegram.allowedChatIds` 里。配进去：

```bash
quadtodo config set telegram.allowedChatIds.0 -100xxx
quadtodo stop && quadtodo start
```

### topic 没自动建

```bash
quadtodo config get telegram.useTopics                 # 应该 true
```

bot 必须有 `Manage Topics` 权限。

### Stop hook 推了但内容是 PTY 噪声

应该来自 jsonl —— 如果还是 PTY 的 spinner 内容，说明 `nativeSessionId` 没绑上。看：

```bash
# 看 hook log
tail -50 ~/.quadtodo/claude-hooks/hook.log
```

如果显示 `fired` + `sent` 但内容差，说明 `pty.findClaudeSession(nativeId)` 返回 null。
可能 native id 还没探测到 → 重启那个 PTY 会让 quadtodo 重新通过 `--session-id` 显式绑定。

---

## 配置项参考

`~/.quadtodo/config.json` 的 `telegram` 段：

```json
{
  "telegram": {
    "enabled": true,
    "supergroupId": "-1001234567890",
    "longPollTimeoutSec": 30,
    "useTopics": true,
    "createTopicOnTaskStart": true,
    "closeTopicOnSessionEnd": true,
    "topicNameTemplate": "#t{shortCode} {title}",
    "topicNameDoneTemplate": "✅ {originalName}",
    "allowedChatIds": ["-1001234567890"],
    "allowedFromUserIds": []
  }
}
```

| 字段 | 含义 |
|---|---|
| `enabled` | 启用 quadtodo 自己的 Telegram 长轮询 |
| `supergroupId` | 主 supergroup 的 chat id（负数，含 `-100` 前缀） |
| `longPollTimeoutSec` | getUpdates 长轮询超时 |
| `useTopics` | 启用 Topic 路由（任务结束/任务推送都按 thread） |
| `createTopicOnTaskStart` | 任务创建时自动建 Topic |
| `closeTopicOnSessionEnd` | SessionEnd 时 close topic + 改名 ✅ |
| `topicNameTemplate` | Topic 命名模板（变量：`{shortCode}` `{title}`） |
| `topicNameDoneTemplate` | 任务完成时的标题（变量：`{originalName}`） |
| `allowedChatIds` | 白名单：只接受这些 chat 的消息（空 = 拒所有） |
| `allowedFromUserIds` | （可选）只允许特定用户触发；空 = 不限 |
| `pollRetryDelayMs` | 长轮询失败后退避起点（默认 5000） |
| `minRenameIntervalMs` | Topic 重命名最小间隔，防风控（默认 30000） |
| `botToken` | （可选）quadtodo 自己持有的 token；缺省时从 `~/.openclaw/openclaw.json` 兜底读 |

---

## 附：CLI setup（自动化场景）

如果你需要脚本化批量配置（譬如部署到一台新机器），所有字段都可以用 `quadtodo config set` 直接写：

```bash
quadtodo config set telegram.enabled true
quadtodo config set telegram.botToken 7846123456:AAH9xK_xxx
quadtodo config set telegram.supergroupId -1001234567890
quadtodo config set telegram.allowedChatIds.0 -1001234567890
quadtodo stop && quadtodo start
```

注：CLI 改完 config 文件后**仍需 `quadtodo stop && start`** 才能让长轮询切到新值（CLI 路径不触发热重启）。Web UI 的保存按钮会自动热重启。

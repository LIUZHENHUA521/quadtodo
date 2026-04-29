# OpenClaw × quadtodo 微信双向桥接

把 quadtodo 接到 [OpenClaw](https://openclaw.ai/) 的微信渠道，实现：

- 在微信跟 OpenClaw 说"帮我做：X" → 多轮向导（目录/象限/模板）→ 自动建 todo + 启动 Claude Code
- AI 在终端里调 `ask_user` 卡到决策点 → 微信收到 `[#xxx] 选项` → 你回数字 → AI 继续

详见设计稿：`docs/superpowers/specs/2026-04-29-openclaw-quadtodo-bridge-design.md`

---

## 一次性启用（5 步）

### 1. 装好 OpenClaw + 微信渠道

参考 OpenClaw 文档：https://docs.openclaw.ai/install
+ `npx -y @tencent-weixin/openclaw-weixin-cli install`
+ `openclaw channels login --channel openclaw-weixin`（扫码登录）

确认能跑：

```bash
openclaw --version
openclaw channels list   # 看到 openclaw-weixin 状态 OK
```

### 2. 注册 quadtodo MCP 到 OpenClaw

```bash
openclaw mcp set quadtodo '{"transport":"http","url":"http://127.0.0.1:5677/mcp"}'
openclaw mcp list   # 确认 quadtodo 在列
openclaw gateway restart
```

### 3. 把 quadtodo skill 装进 OpenClaw

skill 文件在本仓库的：
- 设计稿: `docs/superpowers/specs/2026-04-29-openclaw-quadtodo-bridge-design.md`
- 已经写好的 skill: `~/.openclaw/skills/quadtodo-claw/SKILL.md`（quadtodo 仓库附带的脚本会自动放过去；如果没有，手动复制）

确认：

```bash
openclaw skills list | grep quadtodo-claw   # 应显示 ✓ ready
```

### 4. quadtodo 端配置

```bash
quadtodo config set openclaw.enabled true

# 可选：targetUserId 仅作为「没有 session 路由的 ad-hoc ask_user」兜底用。
# 主路径下 OpenClaw skill 会在 start_ai_session 时把 routeUserId 显式绑到 session 上，
# 不需要这条配置。空着也能工作。
# 想填的话，找你自己的微信 peer id（你给机器人发第一条消息后，看：
#   openclaw logs --tail 100 | grep from_user_id
# ）：
# quadtodo config set openclaw.targetUserId <你的微信 peer id>
```

> openclaw CLI 自己读 `~/.openclaw/openclaw.json`（0600 权限）的 gateway token，
> 不需要在 quadtodo 这边注入额外环境变量。

### 5. 自检

```bash
quadtodo doctor
# 应看到：
#   ✓ openclaw CLI
#   ✓ openclaw.targetUserId (fallback)
#   ✓ quadtodo-claw skill installed
```

启动 quadtodo：

```bash
quadtodo start
```

---

## 端到端验证（P0 流程）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 在微信对你的 OpenClaw 账号发：`帮我做：写一个 hello world demo` | OpenClaw 启动多轮向导，第一条返回"📁 选个工作目录：1. ..." |
| 2 | 回 `1` | 第二条返回"🎯 选象限：1. ..." |
| 3 | 回 `2` | 第三条返回"📋 选模板：1. ..." |
| 4 | 回 `5`（自由模式） | 收到"✅ todo #N 已建 + Claude Code 已启动" |
| 5 | 打开 quadtodo Web UI（http://127.0.0.1:5677）| 看到刚才创建的 todo + 终端在跑 |
| 6 | 在终端里让 AI 调 `ask_user` 测试（例：发"用 npm 还是 pnpm？调 ask_user 让我选"） | 微信收到 `[#xxx] 任务... 1. npm 2. pnpm` |
| 7 | 微信回 `1` | AI 收到 chosen=npm 并继续；微信收到"✅ 已回复 [#xxx]" |
| 8 | 同时跑 2 个会话，都触发 ask_user，分别拿到 ticket #aaa #bbb | 微信里能看到两条 |
| 9 | 回 `1`（不带 ticket） | 默认路由到最新（#bbb） |
| 10 | 回 `#aaa 2` | 显式路由到 #aaa |

---

## 调试

| 现象 | 排查 |
|---|---|
| 微信发"帮我做：X"没反应 | OpenClaw 日志 `openclaw logs --tail 100`，看 skill 是否被选中 |
| skill 选中了但 MCP 调用失败 | 看 quadtodo 日志（`tail -f ~/.quadtodo/logs/*.log`）+ 确认 `quadtodo status` |
| AI 调 ask_user 但你微信没收到 | `quadtodo doctor` + 看是否 `openclaw_disabled` / token env 缺失 |
| 推送了但回复没路由 | quadtodo Web UI → pending list 看 ticket / `submit_user_reply` 返回内容 |
| AI 等不到回复 timeout | `quadtodo config set openclaw.askUser.defaultTimeoutMs <更大的值>` |
| 风控/封号担忧 | 默认每分钟最多 6 条出站，必要时改 `openclaw.askUser.rateLimitPerMin` 减小 |

---

## 8 个新增 MCP 工具速查

| 工具 | 谁调 | 用途 |
|---|---|---|
| `list_workdir_options` | OpenClaw skill | 创建向导第 1 步：列工作目录候选 |
| `list_quadrants` | OpenClaw skill | 创建向导第 2 步：列 4 象限 |
| `list_templates` | OpenClaw skill | 创建向导第 3 步：列模板 |
| `start_ai_session` | OpenClaw skill | 启动 Claude Code/Codex PTY；可注入模板首句 |
| `ask_user` | **PTY 内 AI** | 阻塞，把决策推到微信，等用户回复 |
| `submit_user_reply` | OpenClaw skill | 把用户微信回复路由到 pending question |
| `list_pending_questions` | OpenClaw skill / 调试 | 列当前未回答 |
| `cancel_pending_question` | OpenClaw skill / 用户 | 取消一条 pending |

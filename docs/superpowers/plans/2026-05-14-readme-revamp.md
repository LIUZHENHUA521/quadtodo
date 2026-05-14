# README 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AgentQuad README 改造成「英文为主 + 中文 fallback + hero GIF + 4 张实拍截图」的版本，拉升 GitHub star 转化率。

**Architecture:** 双 README 文件（`README.md` 英文主入口，`README.zh-CN.md` 中文版本），互链；`assets/` 目录存放截图和 GIF；删除现 README 22-33、250-251、254-318 行的过期/脏内容；重排首屏为 Hero → What/Why → Screenshots → Quickstart → Features → Integrations。

**Tech Stack:** 纯 Markdown + Playwright MCP 截图 + macOS 屏幕录制 + ffmpeg 压缩。

参考设计文档：`docs/superpowers/specs/2026-05-14-readme-revamp-design.md`

---

## 文件清单

| 文件 | 操作 |
|---|---|
| `README.md` | 整体重写 |
| `README.zh-CN.md` | 新建 |
| `assets/screenshots/board.png` | 新建 |
| `assets/screenshots/ai-terminal.png` | 新建 |
| `assets/screenshots/stats.png` | 新建 |
| `assets/screenshots/cmdk.png` | 新建 |
| `assets/hero-demo.gif` | 新建（用户配合录屏） |

---

## Task 1: 创建 assets 目录结构

**Files:**
- Create: `assets/screenshots/.gitkeep`

- [ ] **Step 1: 建目录**

```bash
mkdir -p assets/screenshots
touch assets/screenshots/.gitkeep
```

- [ ] **Step 2: 验证**

```bash
ls -la assets/
```

Expected: 看到 `screenshots/` 子目录。

- [ ] **Step 3: 暂不 commit**（等 Task 3 拿到截图后一起 commit）

---

## Task 2: 检查 / 准备 demo todo 数据

**Goal:** 截图前确认看板上有 3-5 条「展示得出去」的 todo（不能有公司机密、个人隐私）。

**Files:** 无文件改动，操作通过 web UI / curl。

- [ ] **Step 1: 用 Playwright 打开看板看现状**

```bash
# Via Playwright MCP
mcp__playwright__browser_navigate → http://127.0.0.1:5677
mcp__playwright__browser_resize → 1440x900
mcp__playwright__browser_snapshot
```

Expected: 拿到当前 todo 列表的结构化 snapshot。

- [ ] **Step 2: 判断现有 todo 是否适合展示**

判断标准：
- 标题没有公司项目代号、客户名、个人邮箱、密码
- 数量 ≥ 3 条（覆盖至少 2 个象限）
- 没有过于私密的内容（医疗、感情、财务等）

如果合格 → 跳到 Task 3。
如果不合格 → 继续 Step 3。

- [ ] **Step 3: （仅在不合格时）暂存当前数据，建 demo todo**

询问用户：要么用户自己手动建几条 demo todo；要么让用户允许临时建一些假数据然后截完图删掉。

建议示范（用户决定后通过 UI 建）：
| 标题 | 象限 | 描述 |
|---|---|---|
| Refactor user auth middleware | Q1 重要紧急 | Audit logic and fix token expiry edge case |
| Write release notes for v0.4 | Q2 重要不紧急 | Cover MCP + Telegram integration |
| Bump npm deps | Q3 紧急不重要 | Audit lockfile, run `npm outdated` |
| Plan Q3 OKR review | Q2 重要不紧急 | Schedule with team, gather data |

- [ ] **Step 4: 不 commit**

---

## Task 3: 用 Playwright MCP 采集 4 张截图

**Files:**
- Create: `assets/screenshots/board.png`
- Create: `assets/screenshots/ai-terminal.png`
- Create: `assets/screenshots/stats.png`
- Create: `assets/screenshots/cmdk.png`

- [ ] **Step 1: 截图 1 — 四象限主看板**

```
mcp__playwright__browser_navigate → http://127.0.0.1:5677
mcp__playwright__browser_resize → 1440x900
mcp__playwright__browser_take_screenshot → assets/screenshots/board.png (fullPage: false)
```

Expected: PNG 文件出现在 `assets/screenshots/board.png`，能看到 4 个象限和至少 3 条 todo 卡片。

- [ ] **Step 2: 截图 2 — AI 终端**

```
# 点开第一个 todo 卡片（用 browser_click 选 todo 卡片元素）
mcp__playwright__browser_click → 第一个 todo 卡片
# 等待 todo 详情抽屉打开
mcp__playwright__browser_wait_for → todo 详情可见
# 点击「启动 AI 终端」按钮（如果没启动）
mcp__playwright__browser_click → 「启动 AI 终端」按钮
# 等 3-5 秒让 Claude 输出几行
mcp__playwright__browser_wait_for → 3 秒
mcp__playwright__browser_take_screenshot → assets/screenshots/ai-terminal.png
```

Expected: 截图里能看到 todo 详情 + 内嵌的 AI 终端，终端里有 Claude 的输出。

- [ ] **Step 3: 截图 3 — 统计抽屉**

```
# 关闭 todo 详情，回到主看板
mcp__playwright__browser_press_key → Escape
# 点击顶栏 📊 按钮
mcp__playwright__browser_click → 顶栏 📊 / 「统计」按钮
mcp__playwright__browser_wait_for → 统计抽屉打开
mcp__playwright__browser_take_screenshot → assets/screenshots/stats.png
```

Expected: 截图里能看到周/月切换、活跃时长、token 成本、Top10 任务等元素。

- [ ] **Step 4: 截图 4 — ⌘K 命令面板**

```
# 关闭统计抽屉
mcp__playwright__browser_press_key → Escape
# 触发 ⌘K
mcp__playwright__browser_press_key → Meta+k
mcp__playwright__browser_wait_for → ⌘K 面板打开
mcp__playwright__browser_take_screenshot → assets/screenshots/cmdk.png
```

Expected: 截图里能看到命令搜索框 + 命令列表（含 MCP 工具入口）。

- [ ] **Step 5: 验证 4 张截图都存在且大小合理**

```bash
ls -lh assets/screenshots/
```

Expected: 4 个 .png 文件，每个 50KB - 500KB 之间。如果某张 < 20KB 多半是空白或加载失败，重截。

- [ ] **Step 6: 暂不 commit**（等 Task 4 GIF 一起 commit）

---

## Task 4: 录制 demo GIF

**Goal:** 10-15s 的演示 GIF，演示 「建 todo → 起 AI 终端 → 看 Claude 跑」流程，< 4MB。

**Files:**
- Create: `assets/hero-demo.gif`

⚠️ **此 Task 需要用户配合**：macOS 屏幕录制需要用户在键盘上按 `Cmd+Shift+5`。Claude 无法触发。

- [ ] **Step 1: 提醒用户录屏，给出具体路径**

向用户输出以下指引：

> 请按以下步骤录屏（10-15s）：
> 1. 打开浏览器到 http://127.0.0.1:5677（确保窗口已经调到约 1440×900）
> 2. 按 `Cmd+Shift+5` → 选「录制选定区域」→ 框住浏览器 viewport
> 3. 演示动作（共 10-15s，节奏从容）：
>    - 0-3s：点「新建 todo」→ 输入「Plan release notes」→ 拖到 Q2 象限
>    - 3-7s：点开这条 todo → 点「启动 AI 终端」
>    - 7-13s：让 Claude 输出几行（可以让它说「Hi」）
>    - 13-15s：关闭 todo → 回到看板
> 4. 停止录制（点工具栏 ■ 按钮）
> 5. 录屏会落到 `~/Desktop/Screen Recording XXX.mov`，把它移到 `assets/hero-demo.mov`：
>    ```bash
>    mv ~/Desktop/Screen\ Recording*.mov assets/hero-demo.mov
>    ```
> 6. 完成后告诉我「录好了」，我接着压缩成 GIF。

- [ ] **Step 2: 等用户确认 `assets/hero-demo.mov` 已就位**

```bash
ls -lh assets/hero-demo.mov
```

Expected: 文件存在，几 MB ~ 几十 MB。

- [ ] **Step 3: 检查 ffmpeg 是否可用**

```bash
which ffmpeg && ffmpeg -version | head -1
```

Expected: 输出 ffmpeg 路径和版本号。如果没有，告诉用户跑 `brew install ffmpeg` 后继续。

- [ ] **Step 4: 转 GIF（先用调色板优化质量）**

```bash
# 生成调色板
ffmpeg -y -i assets/hero-demo.mov -vf "fps=12,scale=1200:-1:flags=lanczos,palettegen" assets/palette.png

# 用调色板生成 GIF
ffmpeg -y -i assets/hero-demo.mov -i assets/palette.png -filter_complex "fps=12,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse" assets/hero-demo.gif

# 清理临时文件
rm assets/palette.png assets/hero-demo.mov
```

Expected: `assets/hero-demo.gif` 生成。

- [ ] **Step 5: 检查 GIF 大小，必要时降帧/降分辨率**

```bash
ls -lh assets/hero-demo.gif
```

Expected: < 4MB。

如果 > 4MB：

```bash
# 降到 720px 宽 + 10fps
ffmpeg -y -i assets/hero-demo.mov -vf "fps=10,scale=900:-1:flags=lanczos,palettegen" assets/palette.png
ffmpeg -y -i assets/hero-demo.mov -i assets/palette.png -filter_complex "fps=10,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse" assets/hero-demo.gif
rm assets/palette.png
```

如果仍然 > 4MB：把演示缩短到 8-10s 重录。

- [ ] **Step 6: 暂不 commit**（等 README 写好一起 commit）

---

## Task 5: 写英文 README.md

**Files:**
- Modify: `README.md`（整体重写）

- [ ] **Step 1: 用以下完整内容覆盖 `README.md`**

```markdown
<div align="center">

# 🎯 AgentQuad

**Four-quadrant todo board where every task spawns a local Claude / Codex session.**

Local-first · MCP-ready · Telegram-friendly

[![npm version](https://img.shields.io/npm/v/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![npm downloads](https://img.shields.io/npm/dm/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![license](https://img.shields.io/npm/l/agentquad.svg?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/agentquad.svg?style=flat-square)](https://nodejs.org)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square)

[English](./README.md) · [简体中文](./README.zh-CN.md)

<img src="./assets/hero-demo.gif" alt="AgentQuad demo" width="800" />

</div>

---

## What is AgentQuad?

AgentQuad is a **local-first task scheduler** built around the Eisenhower matrix. Each todo card can spin up an embedded **Claude Code** or **Codex** terminal session, so the work and the AI assistant live side-by-side instead of in two different tools.

- ❌ **Not Linear / Todoist** — they can't host AI terminals inside cards.
- ❌ **Not Cursor / Aider** — they don't manage tasks or schedule work across projects.
- ❌ **Not raw Claude Code** — no visual board, no session history browser, no per-task isolation.

---

## Screenshots

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/board.png" width="400" /><br/><sub>Quadrant board</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-terminal.png" width="400" /><br/><sub>Embedded AI terminal</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/stats.png" width="400" /><br/><sub>Stats & weekly report</sub></td>
    <td align="center"><img src="./assets/screenshots/cmdk.png" width="400" /><br/><sub>⌘K command palette</sub></td>
  </tr>
</table>

---

## Quickstart

```bash
npm install -g agentquad
agentquad                            # opens http://127.0.0.1:5677
```

The first run walks you through installing `claude` / `codex` if you don't have them yet. Skip the wizard with `agentquad --no-wizard` or `AGENTQUAD_SKIP_WIZARD=1`.

**Requirements:** Node 20+, npm 10+, macOS or Linux (Windows planned).

If `claude` or `codex` is missing:

```bash
agentquad install-tools --all
# or manually:
npm i -g @anthropic-ai/claude-code @openai/codex
```

Check your environment any time:

```bash
agentquad doctor
```

---

## Features

- **Eisenhower quadrant board** with drag-and-drop across Q1–Q4
- **One Claude / Codex terminal per todo** — sessions persisted and resumable
- **Searchable session logs** stored locally as JSONL; no cloud upload
- **Weekly / monthly stats** with token cost estimation (model prices configurable)
- **Local-first** — SQLite + filesystem, your data never leaves your laptop
- **⌘K command palette** for fast navigation and batch operations
- **Cross-platform**: macOS and Linux

---

## Integrations

### 🔌 MCP server (17 tools)

AgentQuad ships a built-in MCP Streamable HTTP server at `POST /mcp`. External Claude Code sessions can do things like *"clean up duplicate todos"*, *"what did I work on last week"*, or *"merge these three login-related todos"* in natural language.

```bash
agentquad mcp install     # adds AgentQuad to ~/.claude/settings.json
agentquad mcp status      # health check
```

Full tool list, preview/confirm safety model, and ⌘K integration → **[docs/MCP.md](./docs/MCP.md)**.

### 💬 Telegram supergroup (a forum topic per task) ⭐

Run a Telegram bot that creates a **Forum Topic** per task — conversations physically isolated, content streamed directly from Claude's JSONL logs (no spinner / ANSI noise). Topic auto-closes and renames with ✅ when the task is done.

→ **[docs/TELEGRAM.md](./docs/TELEGRAM.md)**

### 🐱 OpenClaw (WeChat bridge)

Hook AgentQuad into [OpenClaw](https://openclaw.ai/) so you can say *"help me do: X"* in WeChat — AgentQuad creates the todo, launches Claude Code, and bounces interactive decisions back to your WeChat thread.

→ **[docs/OPENCLAW.md](./docs/OPENCLAW.md)** — 5-step enablement checklist.

### 📱 Mobile access (Tailscale)

Use AgentQuad from your phone over a private Tailscale mesh — no public exposure, ~5 min to set up.

> ⚠️ **Security note:** AgentQuad has shell and AI terminal capability. **Never expose it directly to the public internet.** Tailscale is the recommended access path.

```bash
agentquad config set host 0.0.0.0    # listen on all interfaces (Tailscale needs this)
agentquad start                       # or: agentquad start --expose
```

→ **[docs/MOBILE.md](./docs/MOBILE.md)**

---

## Configuration

Config file: `~/.agentquad/config.json`

```json
{
  "port": 5677,
  "host": "127.0.0.1",
  "defaultTool": "claude",
  "defaultCwd": "~",
  "tools": {
    "claude": { "command": "claude", "bin": "claude", "args": [] },
    "codex":  { "command": "codex",  "bin": "codex",  "args": [] }
  }
}
```

Examples:

```bash
agentquad config set port 6000
agentquad config set tools.claude.bin /opt/homebrew/bin/claude
agentquad config set tools.codex.command codex-w        # custom wrapper
```

- `tools.<tool>.command` — command name (useful for company-internal wrappers like `claude-w`)
- `tools.<tool>.bin` — absolute path override, takes precedence over `command`

---

## Commands

| Command | What it does |
|---|---|
| `agentquad` (no args) | Same as `agentquad start`; runs first-time wizard if needed |
| `agentquad start [--port 5677] [--host 0.0.0.0] [--expose] [--no-open] [--cwd <path>] [--no-wizard]` | Start the server |
| `agentquad stop` | Stop the server (SIGTERM, then SIGKILL after 3s) |
| `agentquad status` | Running state + active session count |
| `agentquad doctor` | Environment check |
| `agentquad config get/set/list` | Read/write config |
| `agentquad mcp install/status/uninstall` | Manage MCP integration |
| `agentquad hook status/install/uninstall/bootstrap` | Manage Claude Code hook |
| `agentquad telegram:setup-menu` | Refresh Telegram bot command menu |
| `agentquad openclaw bootstrap` | Re-install OpenClaw hooks |

---

## Data layout

```
~/.agentquad/
├── config.json
├── data.db                  # SQLite — todos, sessions, stats
├── agentquad.pid            # JSON pid file
└── logs/
    └── ai-*.log             # AI session JSONL logs
```

Export / migrate: the whole `~/.agentquad/` is a regular directory. `tar` it and ship it.

---

<details>
<summary><b>Architecture</b> (click to expand)</summary>

```
agentquad/
├── package.json      # backend deps: express / ws / node-pty / better-sqlite3
├── src/
│   ├── cli.js        # commander entry
│   ├── config.js     # ~/.agentquad/config.json read/write
│   ├── db.js         # better-sqlite3 wrapper
│   ├── pty.js        # PtyManager (node-pty session map)
│   ├── server.js     # Express + ws + routes
│   └── routes/
│       ├── todos.js
│       └── ai-terminal.js
└── web/
    ├── package.json  # frontend: vite + react + antd + dnd-kit + xterm
    └── src/
        ├── main.tsx
        ├── TodoManage.tsx        # quadrant board
        ├── AiTerminalMini.tsx
        ├── SettingsDrawer.tsx
        └── api.ts
```

</details>

---

## Build from source

```bash
git clone git@github.com:LIUZHENHUA521/agentquad.git
cd agentquad
npm run build:all       # installs both layers + builds the frontend into dist-web/
npm link                # link `agentquad` globally
```

Finer-grained scripts:

```bash
npm run setup           # install deps only (root + web/)
npm run build           # build frontend (requires web/node_modules)
npm run clean           # rm node_modules / dist-web / web/dist
```

---

## Troubleshooting

- **Port in use**: `agentquad config set port <new>`
- **`claude` not found**: `agentquad config set tools.claude.bin /full/path/to/claude`
- **`node-pty` install fails**: node-gyp can't find a C++ toolchain. On macOS: `xcode-select --install`
- **Terminal shows `session_not_found`**: the session timed out (30-min idle window); click "Start AI terminal" again
- **Garbled Unicode in live terminal (CJK width, status bars misaligned)**: AgentQuad injects `LANG=LC_CTYPE=en_US.UTF-8` into PTY children so wcwidth matches xterm.js (Unicode 11). To keep your shell's CJK locale, set `AGENTQUAD_KEEP_CJK_LOCALE=1` and restart.

---

## Contributing

Issues and PRs welcome. If AgentQuad saved you time, please ⭐ star the repo — it really helps.

---

## License

[MIT](./LICENSE) © LIUZHENHUA521

<sub>Project history: originally released as `quadtodo`; renamed to `agentquad` in v0.3.0. The `quadtodo` CLI alias is preserved for backwards compatibility.</sub>
```

- [ ] **Step 2: 验证 README 渲染（语法检查 + 链接检查）**

```bash
# 简单语法 sanity check：grep 看有没有未闭合的 markdown
grep -c "^---" README.md       # 应该 ≥ 6（多个分隔线）
grep -c "^##" README.md        # 应该 ≥ 8（多个二级标题）
grep -n "TODO\|TBD\|FIXME" README.md  # 应该 0 行
```

Expected: 无 TODO/TBD/FIXME。

- [ ] **Step 3: 暂不 commit**（等中文版一起 commit）

---

## Task 6: 写中文 README.zh-CN.md

**Files:**
- Create: `README.zh-CN.md`

- [ ] **Step 1: 用以下完整内容创建 `README.zh-CN.md`**

```markdown
<div align="center">

# 🎯 AgentQuad

**四象限待办看板，每条 todo 都能起一个本地 Claude / Codex 会话。**

全本地存储 · 原生支持 MCP · Telegram 远程驱动

[![npm version](https://img.shields.io/npm/v/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![npm downloads](https://img.shields.io/npm/dm/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![license](https://img.shields.io/npm/l/agentquad.svg?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/agentquad.svg?style=flat-square)](https://nodejs.org)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square)

[English](./README.md) · [简体中文](./README.zh-CN.md)

<img src="./assets/hero-demo.gif" alt="AgentQuad demo" width="800" />

</div>

---

## AgentQuad 是什么？

AgentQuad 是一个**全本地的任务调度器**，按艾森豪威尔矩阵把待办分到四个象限。每张 todo 卡片都能起一个内嵌的 **Claude Code** 或 **Codex** 终端会话，让"做事"和"AI 助手"待在一起，而不是分散在两个工具里。

- ❌ **不是 Linear / Todoist** —— 它们没法在卡片里直接跑 AI 终端
- ❌ **不是 Cursor / Aider** —— 它们没有任务管理和跨项目调度
- ❌ **不是原生 Claude Code** —— 没有可视化看板、没有会话历史浏览、没有按任务隔离

---

## 截图

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/board.png" width="400" /><br/><sub>四象限看板</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-terminal.png" width="400" /><br/><sub>内嵌 AI 终端</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/stats.png" width="400" /><br/><sub>统计与周报</sub></td>
    <td align="center"><img src="./assets/screenshots/cmdk.png" width="400" /><br/><sub>⌘K 命令面板</sub></td>
  </tr>
</table>

---

## 30 秒上手

```bash
npm install -g agentquad
agentquad                            # 打开 http://127.0.0.1:5677
```

首次启动会引导你装 `claude` / `codex`。跳过首跑向导：`agentquad --no-wizard` 或 `AGENTQUAD_SKIP_WIZARD=1`。

**环境要求：** Node 20+，npm 10+，macOS 或 Linux（Windows 计划中）。

如果 `claude` 或 `codex` 没装：

```bash
agentquad install-tools --all
# 或手动:
npm i -g @anthropic-ai/claude-code @openai/codex
```

随时自检：

```bash
agentquad doctor
```

---

## 功能特性

- **艾森豪威尔四象限看板**，支持跨象限拖拽
- **每条 todo 一个 Claude / Codex 终端**，会话持久化、可恢复
- **会话日志本地落盘**（JSONL 格式），支持搜索；不上云
- **周报 / 月报统计**，含 token 成本估算（模型单价可配置）
- **全本地** —— SQLite + 文件系统，数据从不离开你的电脑
- **⌘K 命令面板**，快速导航 + 批量操作
- **跨平台**：macOS 和 Linux

---

## 集成方式

### 🔌 MCP 服务（17 个工具）

AgentQuad 内置一个 MCP Streamable HTTP 服务（`POST /mcp`）。外部 Claude Code 会话挂上之后，可以用自然语言"帮我清理重复 todo"、"最近一周我在忙啥"、"合并这三条关于登录的 todo"。

```bash
agentquad mcp install     # 写入 ~/.claude/settings.json
agentquad mcp status      # 健康检查
```

完整工具清单 + preview/confirm 安全模型 + ⌘K 集成 → **[docs/MCP.md](./docs/MCP.md)**。

### 💬 Telegram supergroup（每任务一个 Topic）⭐

直接跑一个 Telegram bot，每开一个 task 自动建一个 **Forum Topic** —— 对话物理隔离；内容直接从 Claude 的 JSONL 日志读（干净，无 spinner / ANSI 噪声）；任务结束 close topic + 改名 ✅。

→ **[docs/TELEGRAM.md](./docs/TELEGRAM.md)**

### 🐱 OpenClaw（微信桥接）

把 AgentQuad 接到 [OpenClaw](https://openclaw.ai/) 的微信渠道：在微信里说"帮我做：X"就自动建 todo + 启动 Claude Code，AI 卡到决策点又能在微信里推给你选。

→ **[docs/OPENCLAW.md](./docs/OPENCLAW.md)** —— 5 步启用清单。

### 📱 手机访问（Tailscale）

用 Tailscale 私有 mesh VPN 让手机也能用 AgentQuad，不暴露公网，5 分钟搞定。

> ⚠️ **安全提醒：** AgentQuad 内置 shell + AI 终端能力，**绝对不要**直接暴露到公网。Tailscale 是推荐的访问方式。

```bash
agentquad config set host 0.0.0.0    # Tailscale 需要监听所有网卡
agentquad start                       # 或：agentquad start --expose
```

→ **[docs/MOBILE.md](./docs/MOBILE.md)**

---

## 配置

配置文件：`~/.agentquad/config.json`

```json
{
  "port": 5677,
  "host": "127.0.0.1",
  "defaultTool": "claude",
  "defaultCwd": "~",
  "tools": {
    "claude": { "command": "claude", "bin": "claude", "args": [] },
    "codex":  { "command": "codex",  "bin": "codex",  "args": [] }
  }
}
```

示例：

```bash
agentquad config set port 6000
agentquad config set tools.claude.bin /opt/homebrew/bin/claude
agentquad config set tools.codex.command codex-w        # 公司内自定义 wrapper
```

- `tools.<tool>.command` —— 启动命令名（适合 `claude-w` 这种公司内封装）
- `tools.<tool>.bin` —— 绝对路径覆盖，优先级高于 `command`

---

## 命令

| 命令 | 作用 |
|---|---|
| `agentquad`（无参数） | 等价于 `agentquad start`，首次启动会引导装 AI 工具 |
| `agentquad start [--port 5677] [--host 0.0.0.0] [--expose] [--no-open] [--cwd <path>] [--no-wizard]` | 启动服务 |
| `agentquad stop` | 停止服务（SIGTERM 3 秒后 SIGKILL） |
| `agentquad status` | 查看运行状态 + 活跃会话数 |
| `agentquad doctor` | 环境自检 |
| `agentquad config get/set/list` | 读/写配置 |
| `agentquad mcp install/status/uninstall` | 管理 MCP 集成 |
| `agentquad hook status/install/uninstall/bootstrap` | 管理 Claude Code hook |
| `agentquad telegram:setup-menu` | 刷新 Telegram bot 命令菜单 |
| `agentquad openclaw bootstrap` | 重装 OpenClaw 钩子 |

---

## 数据存储

```
~/.agentquad/
├── config.json
├── data.db                  # SQLite — todos / sessions / stats
├── agentquad.pid            # JSON pid 文件
└── logs/
    └── ai-*.log             # AI 会话 JSONL 日志
```

导出/迁移：整个 `~/.agentquad/` 是普通目录，tar 打包即可。

---

<details>
<summary><b>架构</b>（点开看目录树）</summary>

```
agentquad/
├── package.json      # 后端 deps: express / ws / node-pty / better-sqlite3
├── src/
│   ├── cli.js        # commander 入口
│   ├── config.js     # ~/.agentquad/config.json 读写
│   ├── db.js         # better-sqlite3 包装
│   ├── pty.js        # PtyManager（node-pty 会话 Map）
│   ├── server.js     # Express + ws + 路由组装
│   └── routes/
│       ├── todos.js
│       └── ai-terminal.js
└── web/
    ├── package.json  # 前端独立: vite + react + antd + dnd-kit + xterm
    └── src/
        ├── main.tsx
        ├── TodoManage.tsx        # 四象限看板
        ├── AiTerminalMini.tsx
        ├── SettingsDrawer.tsx
        └── api.ts
```

</details>

---

## 从源码构建

```bash
git clone git@github.com:LIUZHENHUA521/agentquad.git
cd agentquad
npm run build:all       # 一键装齐两层依赖 + 构建前端，产物在 dist-web/
npm link                # 全局链接 `agentquad` 命令
```

更细的脚本：

```bash
npm run setup           # 只装依赖：根目录 + web/
npm run build           # 只 build 前端（前提是 web/node_modules 已装好）
npm run clean           # 删除 node_modules / dist-web / web/dist
```

---

## 故障排除

- **端口占用**：`agentquad config set port <new>`
- **`claude` 找不到**：`agentquad config set tools.claude.bin /full/path/to/claude`
- **`node-pty` 安装报错**：通常是 node-gyp 找不到 C++ 工具链。macOS 装 Xcode Command Line Tools：`xcode-select --install`
- **终端显示 `session_not_found`**：会话已超时（30 分钟空闲会被清理），重新点"启动 AI 终端"
- **Live 终端排版乱（CJK 宽度、状态栏对不齐）**：AgentQuad 默认给 PTY 子进程注入 `LANG=LC_CTYPE=en_US.UTF-8`，让 wcwidth 跟 xterm.js (Unicode 11) 对齐。要保留 CJK locale，设 `AGENTQUAD_KEEP_CJK_LOCALE=1` 再重启。

---

## 贡献

欢迎提 issue / PR。如果 AgentQuad 帮到了你，麻烦点个 ⭐ —— 真的会激励维护者继续打磨。

---

## License

[MIT](./LICENSE) © LIUZHENHUA521

<sub>项目历史：最早叫 `quadtodo`，v0.3.0 改名为 `agentquad`。`quadtodo` CLI 命令作为别名保留，老脚本不受影响。</sub>
```

- [ ] **Step 2: 内容对齐检查**

```bash
# 英文 / 中文版本各自的二级标题数应该一致
grep -c "^## " README.md
grep -c "^## " README.zh-CN.md
```

Expected: 两个数字相等（约 11 个二级标题）。

```bash
# 链接对齐检查：两份文件都应该引用同样的 docs/ 路径
grep -E "docs/MCP.md|docs/TELEGRAM.md|docs/OPENCLAW.md|docs/MOBILE.md" README.md | wc -l
grep -E "docs/MCP.md|docs/TELEGRAM.md|docs/OPENCLAW.md|docs/MOBILE.md" README.zh-CN.md | wc -l
```

Expected: 两个数字相等且 ≥ 4。

- [ ] **Step 3: 暂不 commit**（等 Task 7 一起 commit）

---

## Task 7: 提交所有改动 + push

⚠️ 根据 [[feedback_auto_push]]：commit 后必须 `git push origin main`。

- [ ] **Step 1: 查看待 commit 内容**

```bash
git status
git diff --stat
```

Expected: 应该看到：
- 修改：`README.md`
- 新建：`README.zh-CN.md`
- 新建：`assets/screenshots/board.png`、`ai-terminal.png`、`stats.png`、`cmdk.png`
- 新建：`assets/hero-demo.gif`
- 新建：`assets/screenshots/.gitkeep`（如果还没被删）

- [ ] **Step 2: 检查 assets/ 目录里没有意外大文件**

```bash
du -sh assets/* | sort -h
```

Expected: GIF < 4MB，每张 PNG < 500KB。如果哪个文件 > 5MB 先压缩再提交。

- [ ] **Step 3: 检查 .gitignore**

```bash
cat .gitignore
```

如果 `.gitignore` 里有 `*.png` 或 `assets/` 之类的规则会把截图忽略掉，需要加例外。如果没有则跳过。

- [ ] **Step 4: 暂存并提交**

```bash
git add README.md README.zh-CN.md assets/
git commit -m "$(cat <<'EOF'
docs: 重写 README（英文为主 + 中文 fallback + hero GIF + 4 截图）

- 英文 README.md 作为 GitHub 默认入口，重排首屏为 Hero → What/Why → Screenshots → Quickstart
- 新增 README.zh-CN.md，结构与英文版完全对齐
- 删除「从 quadtodo 升级」段（254-318 行脏 todo 内容、Multi-agent Pipeline 过期段、0.3.0 升级提示）
- 加 assets/hero-demo.gif（10-15s 演示）+ 4 张实拍截图
- 三大集成（MCP / Telegram / OpenClaw）放到前半部分推介
- 顶部加 badges（npm version / downloads / license / node / platform）

设计文档：docs/superpowers/specs/2026-05-14-readme-revamp-design.md
实施计划：docs/superpowers/plans/2026-05-14-readme-revamp.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: push**

```bash
git push origin main
```

Expected: 看到 `main -> main` 推送成功。

- [ ] **Step 6: 验证 commit hash**

```bash
git log --oneline -3
```

Expected: 顶部是新 commit，commit message 跟上面定义的一致。

---

## Task 8: 在 GitHub 上验证渲染 + 提醒用户改名

**Goal:** 确认 README 在 GitHub web 端渲染正常，提醒用户去 Settings 改 repo 名。

⚠️ Repo 改名是 web 操作，Claude 不能代劳。

- [ ] **Step 1: 用 Playwright 打开 GitHub repo 页面**

```
mcp__playwright__browser_navigate → https://github.com/LIUZHENHUA521/quadtodo
mcp__playwright__browser_wait_for → 页面加载完成
mcp__playwright__browser_take_screenshot → 留存供用户对照
```

Expected: 看到 README 在 GitHub 上的渲染效果。

- [ ] **Step 2: 检查关键渲染点**

肉眼对照 Playwright 拿到的 snapshot：
- Hero GIF 加载出来了吗？
- 4 张截图都加载出来了吗？
- Badges 都渲染了吗？
- `English | 简体中文` 切换链接可点吗？
- 没有 broken images / broken links？

如果有问题：检查 README 里的相对路径是否正确（应该都是 `./assets/...` 不带前导斜杠）。

- [ ] **Step 3: 跨语言链接抽检**

```
mcp__playwright__browser_click → 「简体中文」链接
mcp__playwright__browser_wait_for → 页面跳到 README.zh-CN.md
mcp__playwright__browser_take_screenshot
```

Expected: 跳到中文版 README，中文渲染正常。

- [ ] **Step 4: 给用户改名 + remote 更新指引**

向用户输出：

> ✅ README 已上线渲染检查通过。
>
> **接下来需要你手动做（Claude 不能代劳）：**
>
> 1. 打开 https://github.com/LIUZHENHUA521/quadtodo/settings
> 2. 在 "Repository name" 处把 `quadtodo` 改成 `agentquad`，点 "Rename"
> 3. 改完后 GitHub 会给老地址设 301，老链接不会挂
> 4. 本地更新 remote URL：
>    ```bash
>    cd ~/Desktop/code/crazyCombo/quadtodo
>    git remote set-url origin git@github.com:LIUZHENHUA521/agentquad.git
>    git remote -v        # 验证
>    ```
> 5. （可选）把本地目录也改名：`mv ~/Desktop/code/crazyCombo/quadtodo ~/Desktop/code/crazyCombo/agentquad`

- [ ] **Step 5: 完成**

---

## 自检（执行 agent 在 close-out 时跑一遍）

- [ ] README.md 首屏（前 30 行）有 title / tagline / badges / 语言切换 / hero GIF
- [ ] README.md 和 README.zh-CN.md 二级标题数量一致
- [ ] 4 张截图 + 1 张 GIF 都在 `assets/` 下
- [ ] `grep -n "quadtodo" README.md` 仅在「Project history」一行脚注出现
- [ ] `grep -n "TODO\|TBD\|FIXME" README.md README.zh-CN.md` 输出为空
- [ ] 删除了「从 quadtodo 升级」段、Multi-agent Pipeline 过期段、0.3.0 升级提示、254-318 行脏 todo 内容
- [ ] `assets/hero-demo.gif` < 4MB
- [ ] 已 `git push origin main`
- [ ] 给用户输出了改名指引

---

## 风险与回滚

- **GitHub raw image 加载慢**：如果 GIF 太大（> 4MB）会拖慢首屏，强制压缩或缩短演示
- **截图含敏感数据**：截图前先在 Task 2 检查，必要时用 demo 数据替代
- **回滚**：纯文档变更，`git revert <commit-hash>` 即可

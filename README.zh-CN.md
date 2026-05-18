<div align="center">

# 🎯 AgentQuad

**4 列状态看板，每条 todo 都能起一个本地 Claude / Codex / Cursor 会话。**

全本地存储 · 原生支持 MCP · Telegram / 飞书 / 微信远程驱动

[![npm version](https://img.shields.io/npm/v/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![npm downloads](https://img.shields.io/npm/dm/agentquad.svg?style=flat-square)](https://www.npmjs.com/package/agentquad)
[![license](https://img.shields.io/npm/l/agentquad.svg?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/agentquad.svg?style=flat-square)](https://nodejs.org)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square)

[English](./README.md) · [简体中文](./README.zh-CN.md)

<img src="./assets/screenshots/board.png" alt="AgentQuad 状态看板" width="900" />

</div>

---

## AgentQuad 是什么？

AgentQuad 是一个**全本地的 AI 任务调度器**。一个 4 列状态看板（**待办 · 运行中 · 需确认 · 已空闲**），每条 todo 都可以分派给一个 **Agent**（也就是一段保存好的 system prompt），并在内嵌的 **Claude Code / Codex / Cursor** 终端里跑起来。"Quad"现在指 4 列，不再是艾森豪威尔的 4 象限——还是同一个 4 格调度器的脑回路，只是换了一根坐标轴。让"做事"和"AI 助手"待在一起，而不是分散在两个工具里。

你可以从任何地方驱动它——Web UI、Telegram、飞书、微信（通过 OpenClaw），所有会话和决策都流回同一个本地看板。

- ❌ **不是 Linear / Todoist** —— 它们没法在卡片里直接跑 AI 终端
- ❌ **不是 Cursor / Aider** —— 它们没有任务管理和跨项目调度
- ❌ **不是原生 Claude Code** —— 没有可视化看板、没有会话历史浏览、没有按任务隔离

---

## 截图

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/board.png" width="400" /><br/><sub>状态看板</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-terminal.png" width="400" /><br/><sub>内嵌 AI 会话</sub></td>
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

首次启动会引导你装 `claude` / `codex` / `cursor-agent`。跳过首跑向导：`agentquad --no-wizard` 或 `AGENTQUAD_SKIP_WIZARD=1`。

**环境要求：** Node 20+，npm 10+，macOS 或 Linux（Windows 计划中）。

如果 `claude` / `codex` / `cursor-agent` 没装：

```bash
agentquad install-tools --all                # 一键装 claude + codex + cursor-agent
agentquad install-tools --claude --cursor    # 只装其中几个
# 或手动:
npm i -g @anthropic-ai/claude-code @openai/codex
curl https://cursor.com/install -fsSL | bash
```

随时自检：

```bash
agentquad doctor
```

---

## 功能特性

- **状态驱动的 4 列看板** —— 待办 / 运行中 / 需确认 / 已空闲，会话自己在列之间流转
- **命名 Agent（员工档案）** —— 把可复用的 system prompt 存下来（程序员、Reviewer、研究员…），分派给任意 todo；内置 8 个角色化模板开箱即用
- **每个会话独立终端** —— Claude / Codex / Cursor 任选，会话持久化可恢复；一条 todo 可以同时跑多个会话
- **Auto-decider 监督器** —— 可选的自动循环，用本地 Claude / Codex CLI 帮你回答权限弹窗和 `ask_user`，让 AI 在你睡觉时也能继续跑
- **会话 transcript 全文检索** —— JSONL 本地落盘，支持关键词搜索、命中高亮、任意时间点 fork & resume
- **Wiki / 项目记忆** —— Markdown 笔记可绑到具体 todo 或工作目录，作为上下文喂给 AI agent
- **复发规则（Recurring）** —— 自动创建每日 / 每周 / cron 风格的 todo
- **周报 / 月报统计**，含 token 成本估算（每个模型单价可配置）
- **⌘K 命令面板**，快速导航 + 批量操作
- **全本地** —— SQLite + 文件系统，所有数据都在 `~/.agentquad/`，从不离开你的电脑
- **跨平台**：macOS 和 Linux

---

## 集成方式

### 🔌 MCP 服务（17 个工具）

AgentQuad 内置一个 MCP Streamable HTTP 服务（`POST /mcp`）。外部 Claude Code 会话挂上之后，可以用自然语言"帮我清理重复 todo"、"最近一周我在忙啥"、"合并这三条关于登录的 todo"。

```bash
agentquad mcp install     # 在 Claude Code（~/.claude/settings.json）里挂上 AgentQuad MCP
agentquad mcp status      # 健康检查
```

想一次把 MCP **+ AgentQuad skill** 一并装进 Claude Code / Codex / Cursor（这样嵌套子 agent 也能创建子 todo）：

```bash
agentquad agents install              # 默认三家都装
agentquad agents install --target cursor   # 只装一家
agentquad agents status               # 查看版本 / drift
```

完整工具清单 + preview/confirm 安全模型 + ⌘K 集成 → **[docs/MCP.md](./docs/MCP.md)**。

### 💬 Telegram supergroup（每任务一个 Topic）⭐

直接跑一个 Telegram bot，每开一个 task 自动建一个 **Forum Topic** —— 对话物理隔离；内容直接从 Claude 的 JSONL 日志读（干净，无 spinner / ANSI 噪声）；任务结束 close topic + 改名 ✅。

→ **[docs/TELEGRAM.md](./docs/TELEGRAM.md)**

### 💼 飞书 / Lark（话题群里 @bot 触发任务）

跑一个飞书自建应用（长连接，**无需公网**），在话题群里 @bot 发"帮我做：X"就自动建 todo + 拉起本地 Claude/Codex，过程实时同步到 thread。

→ **新人教程：[docs/LARK-getting-started.md](./docs/LARK-getting-started.md)** — 从装包到飞书 @bot 跑通一条完整路径
→ 配置参考：[docs/LARK.md](./docs/LARK.md)

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
    "claude": { "command": "claude",       "bin": "claude",       "args": [] },
    "codex":  { "command": "codex",        "bin": "codex",        "args": [] },
    "cursor": { "command": "cursor-agent", "bin": "cursor-agent", "args": [] }
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
| `agentquad install-tools [--claude] [--codex] [--cursor] [--all]` | 一键装缺失的 AI CLI |
| `agentquad config get/set/list` | 读/写配置 |
| `agentquad mcp install/status/uninstall` | 管理 Claude Code 里的 MCP 集成 |
| `agentquad agents install/status/uninstall [--target claude\|codex\|cursor]` | 把 AgentQuad MCP + skill 装进 Claude / Codex / Cursor（子 agent 能力） |
| `agentquad hook install/uninstall/status/bootstrap [--claude] [--codex] [--cursor]` | 管理各 CLI 的 hook 脚本 |
| `agentquad openclaw install-hook/uninstall-hook/bootstrap/hook-status` | 管理 OpenClaw 桥接钩子 |

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
        ├── TodoManage.tsx        # 4 列状态看板
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

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

<img src="./assets/screenshots/board.png" alt="AgentQuad status board" width="900" />

</div>

---

## What is AgentQuad?

AgentQuad is a **local-first AI task scheduler**. A 4-lane status board (**Backlog · In Progress · Needs Input · Idle**) where every todo can be dispatched to an **agent** — a saved system prompt — and run inside an embedded **Claude Code**, **Codex**, or **Cursor** terminal session. The "Quad" is four columns now, not four Eisenhower quadrants — same idea of a 4-cell scheduler, different axis. Work and AI live side-by-side instead of in two different tools.

Drive it from anywhere — Web UI, Telegram, 飞书 (Lark), or WeChat (via OpenClaw). All conversations and decisions stream back to the same local board.

- ❌ **Not Linear / Todoist** — they can't host AI terminals inside cards.
- ❌ **Not Cursor / Aider** — they don't manage tasks or schedule work across projects.
- ❌ **Not raw Claude Code** — no visual board, no session history browser, no per-task isolation.

---

## Screenshots

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/board.png" width="400" /><br/><sub>Quadrant board</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-terminal.png" width="400" /><br/><sub>Embedded AI session</sub></td>
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

If `claude`, `codex`, or `cursor-agent` is missing:

```bash
agentquad install-tools --all                # installs claude + codex + cursor-agent
agentquad install-tools --claude --cursor    # pick specific ones
# or manually:
npm i -g @anthropic-ai/claude-code @openai/codex
curl https://cursor.com/install -fsSL | bash
```

Check your environment any time:

```bash
agentquad doctor
```

---

## Features

- **Status-driven 4-column board** — Backlog / In Progress / Needs Input / Idle, sessions auto-flow between lanes
- **Named Agents (员工档案)** — save reusable system prompts (Coder, Reviewer, Researcher…) and dispatch them to any todo; 8 role-style built-ins out of the box
- **One terminal per session** — Claude / Codex / Cursor, persistent and resumable; multiple concurrent sessions per todo OK
- **Auto-decider supervisor** — optional loop that uses a local Claude / Codex CLI to answer permission prompts and `ask_user` calls for you while you sleep
- **Searchable session transcripts** stored locally as JSONL — keyword search, match highlighting, fork & resume any point in the past
- **Wiki / project memory** — markdown notes pinned to specific todos or workdirs; surfaced to AI agents as context
- **Recurring rules** — auto-create daily / weekly / cron-style todos
- **Weekly & monthly reports** with token cost estimation (per-model prices configurable)
- **⌘K command palette** for fast navigation and batch operations
- **Local-first** — SQLite + filesystem under `~/.agentquad/`, your data never leaves your laptop
- **Cross-platform**: macOS and Linux

---

## Integrations

### 🔌 MCP server (17 tools)

AgentQuad ships a built-in MCP Streamable HTTP server at `POST /mcp`. External Claude Code sessions can do things like *"clean up duplicate todos"*, *"what did I work on last week"*, or *"merge these three login-related todos"* in natural language.

```bash
agentquad mcp install     # add AgentQuad MCP to ~/.claude/settings.json
agentquad mcp status      # health check
```

Want to install MCP **plus** the AgentQuad skill into Claude Code, Codex, **and** Cursor in one shot (so nested sub-agents can create child todos)? Use:

```bash
agentquad agents install              # installs to all three by default
agentquad agents install --target cursor   # only one
agentquad agents status               # drift / version check
```

Full tool list, preview/confirm safety model, and ⌘K integration → **[docs/MCP.md](./docs/MCP.md)**.

### 💬 Telegram supergroup (a forum topic per task) ⭐

Run a Telegram bot that creates a **Forum Topic** per task — conversations physically isolated, content streamed directly from Claude's JSONL logs (no spinner / ANSI noise). Topic auto-closes and renames with ✅ when the task is done.

→ **[docs/TELEGRAM.md](./docs/TELEGRAM.md)**

### 🪶 飞书 / Lark (thread-per-task in a topic group)

Same idea as the Telegram bridge but for 飞书/Lark — one thread per task inside a topic group, permission-prompt cards and `ask_user` decisions bounce back as Lark interactive cards. Uses Lark's long-connection event stream, **no public callback URL required**.

→ **[docs/LARK.md](./docs/LARK.md)** — full self-built app setup walkthrough.

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
    "claude": { "command": "claude",       "bin": "claude",       "args": [] },
    "codex":  { "command": "codex",        "bin": "codex",        "args": [] },
    "cursor": { "command": "cursor-agent", "bin": "cursor-agent", "args": [] }
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
| `agentquad install-tools [--claude] [--codex] [--cursor] [--all]` | Install missing AI CLIs |
| `agentquad config get/set/list` | Read/write config |
| `agentquad mcp install/status/uninstall` | Manage MCP integration in Claude Code |
| `agentquad agents install/status/uninstall [--target claude\|codex\|cursor]` | Install AgentQuad MCP + skill into Claude / Codex / Cursor (sub-agent capability) |
| `agentquad hook install/uninstall/status/bootstrap [--claude] [--codex] [--cursor]` | Manage the per-tool hook scripts |
| `agentquad openclaw install-hook/uninstall-hook/bootstrap/hook-status` | Manage OpenClaw bridge hooks |

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
        ├── TodoManage.tsx        # 4-lane status board
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

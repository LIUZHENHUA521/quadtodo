# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AgentQuad** (npm package name; CLI bins: `agentquad` and `quadtodo`) — a local-first four-quadrant (Eisenhower) todo board where each card can spawn an embedded `claude` / `codex` / `cursor-agent` terminal session. Backend is plain Node.js (ESM, Node ≥ 20), frontend is a Vite + React + Ant Design SPA built into `dist-web/` and served by the same Express server.

The project was originally released as `quadtodo` and renamed to `agentquad` in v0.3.0; the `quadtodo` bin alias is preserved. This is the reason the working directory is still `quadtodo/` while `package.json` says `agentquad`.

## Commands

Run from the repo root.

| Command | Purpose |
|---|---|
| `npm run setup` | Install deps in both root and `web/` |
| `npm run build` | Build frontend into `dist-web/` (requires `web/node_modules`; auto-ensured) |
| `npm run build:all` | `setup` + `build` |
| `npm start` | `node src/cli.js start` — launch server on 127.0.0.1:5677 |
| `npm run stop` / `status` / `doctor` | Server lifecycle / env check via CLI |
| `npm test` | `vitest run` (one-shot) |
| `npm run test:watch` | `vitest` watch mode |
| `npm run clean` | Wipe both `node_modules` trees + `dist-web` + `web/dist` |
| `npm link` | After `build:all`, exposes the `agentquad` / `quadtodo` bins globally |

Run a single test file: `npx vitest run test/<file>.test.js`. Tests use the `vmThreads` pool (see `vitest.config.js`).

Frontend dev server (HMR, talks to a running backend): `cd web && npm run dev`. The frontend `build` runs `tsc -b && vite build` — TypeScript errors fail the build.

## Architecture

### Two-tier layout

- **Root (`src/`)** — backend, vanilla JS (ESM). No build step; `src/cli.js` is the entrypoint listed in `bin`. Ships as-is to npm.
- **`web/`** — frontend, React + TypeScript + Vite. Built ahead of `npm publish` (`prepack` → `ensure-web-deps` + `build:web`) into `dist-web/`, which Express serves statically.

`scripts/ensure-web-deps.js` lazily installs `web/node_modules` so first-time users who only run `npm install -g agentquad` still get a working build path.

### Server composition (`src/server.js`)

`src/cli.js` parses subcommands with `commander` and spawns `src/server.js`. The server wires together one Express app + one `ws` WebSocketServer (PTY streaming) + a swarm of singletons:

- `PtyManager` (`src/pty.js`) — owns all `node-pty` child terminals; one per AI session.
- `openDb` (`src/db.js`) — `better-sqlite3` handle at `~/.agentquad/data.db`. Schema is created/migrated in-process on open.
- Routers under `src/routes/*.js` are mounted at `/api/<name>` (`todos`, `ai-terminal`, `transcripts`, `templates`, `recurringRules`, `stats`, `reports`, `wiki`, `search`, `agent-supervisor`, `git`, `telegram-config`, `telegram-sync`, `openclaw-hook`, `openclaw-inbound`, `uploads`).
- `src/mcp/` exposes a Streamable HTTP MCP server at `POST /mcp` (17 tools — see `docs/MCP.md`).
- `agent-supervisor.js` is the "auto-decider" loop that shells out to local `claude -p` / `codex exec` / `cursor-agent -p` to answer permission prompts and `ask_user` MCP calls — it never hits the Anthropic API directly (see `docs/AGENT-SUPERVISOR.md`).
- `openclaw-bridge.js` + `openclaw-hook.js` + `routes/openclaw-*.js` route WeChat messages to/from tasks via the OpenClaw service.
- `telegram-bot.js`, `lark-bot.js` are optional inbound IM integrations enabled when their tokens are configured.

### Tool-CLI abstraction

`TOOL_PACKAGES` in `src/cli.js` and `tools.<tool>` in config drive how external CLIs (`claude`, `codex`, `cursor-agent`) are detected, installed, and spawned. The installer dispatcher (`agent-installer-dispatcher.js` → tool-specific `*-agent-installer.js` / `*-hook-installer.js`) writes Claude Code / Codex / Cursor hook configs so those tools call back into AgentQuad. There are matching `*-prompt-detector.js` modules that parse each CLI's permission-prompt format out of the PTY stream.

### Data layout

Everything lives under `~/.agentquad/`:
- `config.json` — server config (port, host, default tool, per-tool bin/command overrides, IM tokens). Mutated via `agentquad config set` or `PUT /api/config`. Use `withConfigLock()` from `config.js` for concurrent-safe writes.
- `data.db` — SQLite: todos, AI sessions, transcripts, stats, wiki pages, agent decisions, recurring rules.
- `agentquad.pid` — JSON pid/port/host record. `readPidFile` tolerates a legacy plain-integer format.
- `logs/ai-*.log` — per-session JSONL transcripts; the source of truth for `transcripts/` features and the Telegram/Lark streaming.

### Key conventions to respect

- ESM everywhere on the backend; use `import`/`export`, top-level `await` is fine.
- Backend code is **plain JS, not TypeScript** — keep it that way. TypeScript lives only in `web/src/`.
- New HTTP routes go in `src/routes/<name>.js` as a `createXxxRouter({ deps })` factory and are mounted from `server.js`. Keep handlers thin; put logic in sibling modules (e.g. `src/stats/`, `src/search/`, `src/wiki/`, `src/transcripts/`).
- New tests mirror the source layout under `test/` and end in `.test.js` or `.test.ts`. Async PTY tests should use `PtyManager`'s injectable spawner — see `test/pty.test.js`.
- The server must not assume a TTY (it can be launched as a detached child by the CLI). Use the logger passed into route factories rather than ad-hoc `console.log` for things that should appear in `~/.agentquad/logs/`.
- **Never expose the server on the public internet.** It has shell + AI terminal capability. The default bind is `127.0.0.1`; `--expose` / `host 0.0.0.0` is for Tailscale only — keep that warning intact in docs and UX.
- The PTY child env is force-set to `LANG=LC_CTYPE=en_US.UTF-8` so xterm.js wcwidth matches; `AGENTQUAD_KEEP_CJK_LOCALE=1` is the documented opt-out. Don't remove this without updating both `src/pty.js` and the README troubleshooting entry.

## Docs map

Per-feature deep dives live in `docs/`: `MCP.md`, `TELEGRAM.md`, `TELEGRAM-setup.md`, `OPENCLAW.md`, `LARK.md`, `MOBILE.md`, `AGENT-SUPERVISOR.md`, `RELEASE.md`. Read the relevant one before changing integration code — they describe the user-facing contract (config keys, slash commands, hook payloads) the code must keep honoring.

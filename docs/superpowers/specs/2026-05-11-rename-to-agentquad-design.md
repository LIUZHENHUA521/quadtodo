# Rename quadtodo → AgentQuad Design

## Goal

Rebrand the project from `quadtodo` to **AgentQuad**: a clearer, more attractive name that signals the core differentiator — *a four-quadrant board where every todo can drive a Claude Code / Codex agent session, fully local*. Old users keep working without any forced action.

## Final Naming

| Surface | Before | After |
|---|---|---|
| Brand / display name | quadtodo | **AgentQuad** |
| npm package | `quadtodo` | `agentquad` |
| CLI primary bin | `quadtodo` | `agentquad` |
| CLI alias bin | — | `quadtodo` (kept, same shim) |
| Data directory | `~/.quadtodo/` | `~/.agentquad/` (with one-shot migration) |
| Wiki subdir | `~/.quadtodo/wiki/` | `~/.agentquad/wiki/` |
| PID file | `~/.agentquad/quadtodo.pid` | `~/.agentquad/agentquad.pid` |
| Log file | `~/.quadtodo/logs/quadtodo.log` | `~/.agentquad/logs/agentquad.log` |
| GitHub repo | `LIUZHENHUA521/quadtodo` | `LIUZHENHUA521/agentquad` (rename, GitHub auto-redirects) |

**Tagline**: 四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话，全本地

## Scope

This is a rebrand + light-touch compatibility migration. It does **not** change feature behavior, route shapes, MCP tool schemas, DB schema, or the configuration shape — only identifiers, paths, and user-facing strings.

Out of scope: refactoring unrelated code, redesigning the UI, breaking changes to MCP tool names, changing config keys (`tools.claude` etc. stay as is).

## Data Directory Migration

The home data directory moves from `~/.quadtodo/` to `~/.agentquad/`. The migration runs at process start, **once**, fully automatic, and refuses to clobber existing state.

### Algorithm (in `src/config.js`, runs before any consumer reads the dir)

```
new = ~/.agentquad
old = ~/.quadtodo

if new exists:
    return new                      # already migrated, or fresh install
if old does not exist:
    mkdir new; return new           # fresh install, no legacy data
# old exists, new does not:
if pidfile in old is alive:
    print error to stderr:
        "AgentQuad: detected running quadtodo service.
         Please run `quadtodo stop` and start AgentQuad again."
    exit(1)
mv old → new                        # atomic rename on same fs
write new/.migrated-from-quadtodo with ISO timestamp
print one-line notice on stderr:
    "AgentQuad: migrated ~/.quadtodo → ~/.agentquad"
return new
```

Failure modes:

- **Cross-filesystem rename**: extremely unlikely (both are under `$HOME`), but if `rename(2)` fails with `EXDEV`, fall back to recursive copy + verify + remove old; log explicitly.
- **Permission errors**: abort with a clear stderr message pointing at the offending path. Do not partially migrate.
- **User has `~/.agentquad/` from a fresh install AND a stale `~/.quadtodo/`**: leave the old dir alone, don't touch it. Print a one-line hint on first run: `"AgentQuad: found legacy ~/.quadtodo/ alongside ~/.agentquad/; ignoring. Delete it manually when ready."`

The local-cwd fallback (`process.cwd()/.quadtodo` when used for project-local data) is also renamed to `.agentquad`; same migration logic applies if both directories exist in the cwd.

## CLI Surface

`bin` field in `package.json`:

```json
"bin": {
  "agentquad": "src/cli.js",
  "quadtodo":  "src/cli.js"
}
```

Both names invoke the same entry point. `commander`'s `program.name()` is set to `agentquad`. When invoked as `quadtodo …`, the program still works but `--help` and error output use the new name; this is acceptable — it's an alias, not a separate command.

Doctor output, `--help`, all error/info messages reference `agentquad` going forward. Examples in messages (e.g. `"run \`quadtodo config set host 0.0.0.0\`"`) are rewritten to use `agentquad`.

## npm Publish Strategy

- Publish new package: `agentquad@0.2.0` (bump minor to mark the rebrand).
- Old package `quadtodo@0.1.1` stays on the registry. We publish one more version `quadtodo@0.1.2` whose only change is a `deprecated` field and a README pointer:
  - `npm deprecate quadtodo "Renamed to 'agentquad'. Install with: npm i -g agentquad"`
  - README of the deprecation bump is reduced to a 5-line "moved to agentquad" notice.
- No `unpublish`. We do not remove history.

This is its own follow-up task once `agentquad` is live; it does **not** block the rename PR.

## GitHub Repo Rename

Rename `LIUZHENHUA521/quadtodo` → `LIUZHENHUA521/agentquad` via GitHub UI/API. GitHub automatically:

- redirects all old URLs (issues, PRs, files, raw, releases)
- redirects `git clone` of the old URL
- forwards web traffic

In-repo, update:

- `package.json` `repository.url`, `homepage`, `bugs.url`
- README's "GitHub 仓库" line at the top

## File Change Inventory

There are ~144 source/doc files containing `quadtodo`. They fall into four buckets, handled differently:

### Bucket 1: Identity (manual edits, careful review)

- `package.json` — `name`, `description`, `bin`, `keywords`, `repository`, `homepage`, `bugs`, `version` → `0.2.0`
- `web/package.json` — `name`
- `README.md` — title, slogan (use the chosen Tagline A), all install examples, all `quadtodo X` command examples → `agentquad X`
- `src/cli.js` — `program.name('agentquad')`, all stderr/stdout strings
- `src/config.js` — `~/.quadtodo` → `~/.agentquad`, plus the migration helper
- Top-of-file file-header comments

### Bucket 2: Documentation (`docs/*.md`, `*.md` at root)

Sweep replace `quadtodo` → `agentquad` (lowercase, e.g. CLI commands) and `Quadtodo` → `AgentQuad` (sentence start / display). Manually re-read each doc once to catch grammar drift ("the quadtodo CLI" → "the AgentQuad CLI", not "the agentquad CLI").

Files: `docs/MCP.md`, `docs/OPENCLAW.md`, `docs/RELEASE.md`, `docs/TELEGRAM.md`, `docs/TELEGRAM-setup.md`, `docs/MOBILE.md`, `docs/LARK.md`, plus root `debug-*.md` files (these are user-facing debugging notes).

### Bucket 3: Code references to the data dir / pid / log / wiki

These all go through `src/config.js`'s helpers. Replace `~/.quadtodo` string literals in source with calls to the central `getDataDir()` / `getWikiDir()` / etc. helpers — no string literal of the old path should remain in code outside of the migration helper itself.

Files with `.quadtodo` literals to audit and route through helpers: `src/cli.js`, `src/server.js`, `src/orchestrator.js`, `src/openclaw-hook.js`, `src/openclaw-hook-installer.js`, `src/codex-sidecar.js`, `src/telegram-bot.js`, `src/telegram-image.js`, `src/lark-image.js`, `src/lark-video.js`, `src/worktree.js`, `src/wiki/guide.js`, `src/mcp/audit.js`, `src/mcp/tools/read/index.js`, `src/routes/openclaw-hook.js`, `src/routes/uploads.js`, `src/routes/ai-terminal.js`, `src/templates/claude-hooks/notify.js`, `scripts/setup-telegram-commands.js`, `web/src/SettingsDrawer.tsx`, `web/src/pipeline/PipelineRunDrawer.tsx`.

Where a literal *displays* the path to the user (e.g. doctor output, help text), update the literal too.

### Bucket 4: Tests (`test/*.js`)

Tests assert against directory paths and CLI names. Update them to the new paths/names. Some tests stub `os.homedir()` to a tmp dir; those keep their relative `.quadtodo` → `.agentquad` rename.

In addition, **add `test/rename-migration.test.js`** with these cases:

1. Given a tmp HOME with `~/.quadtodo/data.db` but no `~/.agentquad/`, `getDataDir()` moves the dir, returns the new path, and writes the `.migrated-from-quadtodo` marker. Idempotent on a second call.
2. Given an alive PID recorded under the old dir, migration aborts with a clear error and does NOT move anything.
3. Given both `~/.quadtodo/` and `~/.agentquad/` present, the old dir is left untouched and a one-line hint is emitted.

## Web UI

- Top-bar / document `<title>` → `AgentQuad`
- About / footer (if any) → `AgentQuad`
- Settings drawer copy that mentions `quadtodo` → `AgentQuad`
- API responses don't include the brand name, so no API change needed.

`web/package.json` `name` field changes to `agentquad-web`.

## Telegram / MCP / OpenClaw / Lark / Tailscale Integrations

These are out-of-tree config (lives in user systems: Claude Code's `mcpServers`, OpenClaw's skills dir, Telegram bot command list, Lark bot config). They reference `quadtodo` by name today.

- **MCP**: the MCP server's announced name (`server.name`) changes to `agentquad`. Users with existing `mcpServers["quadtodo"]` entries will see it stop working; `agentquad mcp install` (new bin) writes the new entry. **Mitigation**: `agentquad mcp install` also removes any stale `quadtodo` entry it finds (best effort, only if it points at our bin path). Document this in README.
- **OpenClaw skill folder**: `~/.openclaw/skills/quadtodo-claw/` → `~/.openclaw/skills/agentquad-claw/`. The installer (`agentquad openclaw install-hook`) writes to the new path; doctor checks the new path. A one-line doctor warning if the old path still exists: "legacy openclaw skill folder at ~/.openclaw/skills/quadtodo-claw/ — safe to delete".
- **Telegram bot command menu**: re-run `agentquad telegram:setup-menu` after upgrade.

None of these block the rename PR — they're follow-up clean-ups documented in the README's UPGRADE section.

## Acceptance Criteria

- [ ] `npm view agentquad name` returns `agentquad` (post-publish)
- [ ] `agentquad start` launches the server; web UI shows "AgentQuad" in title bar
- [ ] `quadtodo start` still works (alias) on a newly installed `agentquad`
- [ ] Fresh install on a clean machine: `~/.agentquad/` is created; no `~/.quadtodo/` is created
- [ ] Upgrade install on a machine with existing `~/.quadtodo/data.db`: starting `agentquad` migrates data; all old todos visible in UI; old dir is gone; `.migrated-from-quadtodo` marker exists
- [ ] Migration aborts cleanly when an old PID is still alive — service not started, data untouched, clear error message
- [ ] `agentquad doctor` passes on both fresh and migrated installs
- [ ] No string literal of `~/.quadtodo` or `.quadtodo` remains in non-migration code (grep clean except for the migration helper and tests that exercise it)
- [ ] README header reads "AgentQuad" with the chosen tagline; all `quadtodo X` command examples updated to `agentquad X`
- [ ] `package.json` `name=agentquad`, `version=0.2.0`, `bin` has both `agentquad` and `quadtodo`, `repository.url` points at the renamed repo
- [ ] All existing tests pass; two new migration tests pass
- [ ] GitHub repo renamed; old repo URL redirects to new

## Out of Scope (Explicit Non-Goals)

- Renaming or restructuring the SQLite tables / DB schema
- Changing MCP tool names (only the server name field changes)
- Renaming config keys (`tools.claude.command` etc. stay)
- Removing or renaming the legacy `quadtodo` bin alias (we keep it indefinitely)
- Publishing the deprecated `quadtodo@0.1.2` notice — that ships as a follow-up after `agentquad@0.2.0` is live

## Risks

1. **Stale running service during upgrade** — mitigated by PID-alive check + clean abort.
2. **Cross-filesystem `~`** — extremely rare, but covered by EXDEV fallback (copy + verify + remove).
3. **MCP/OpenClaw users with hand-written config** — they see one broken integration until they re-run install commands. Documented in upgrade notes.
4. **Find/replace drift in docs** — manual re-read pass after sweep catches "the agentquad CLI" awkward phrasings.
5. **GitHub repo rename collisions** — none expected; user owns the namespace.

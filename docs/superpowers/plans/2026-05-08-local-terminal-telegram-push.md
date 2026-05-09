# Local Terminal Telegram Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make “本地继续” preserve Telegram outbound notifications by launching native Terminal resume commands with quadtodo hook context.

**Architecture:** Extend the native resume endpoint to derive trusted todo/session metadata from the database, export `QUADTODO_*` values into the native Terminal shell command for Claude resumes, and return warning codes for missing hooks or Telegram route. The frontend passes `todoId`/`sessionId`, displays warnings, and keeps native Terminal behavior unchanged.

**Tech Stack:** Node.js/Express, Vitest + Supertest, React/TypeScript, Ant Design message API, Claude Code hooks.

---

## File Structure

- Modify `src/server.js`: add helper functions for shell `export` prefix, hook inspection, DB-backed native resume context lookup, and warning generation; update `/api/system/open-native-ai-resume`.
- Modify `test/server.test.js`: add endpoint tests for env injection, warnings, route lookup, and existing no-PTY behavior.
- Modify `web/src/api.ts`: extend native resume request/response types with `todoId`, `sessionId`, and `warnings`.
- Modify `web/src/TodoManage.tsx`: pass todo/session identifiers and show warning messages after local Terminal launch.

---

### Task 1: Server native resume hook context

**Files:**
- Modify: `test/server.test.js:222-266`
- Modify: `src/server.js:116-132`
- Modify: `src/server.js:695-717`

- [ ] **Step 1: Write failing tests for env injection and warning return**

Add this test after the existing `POST /api/system/open-native-ai-resume opens local Terminal...` test in `test/server.test.js`:

```js
	it("POST /api/system/open-native-ai-resume injects quadtodo hook env for Claude sessions", async () => {
		const todo = srv.db.createTodo({ title: "Telegram task", quadrant: 1, workDir: join(workRootDir, "client") });
		srv.db.updateTodo(todo.id, {
			aiSessions: [{
				sessionId: "ai-route-1",
				tool: "claude",
				nativeSessionId: "native-telegram-1",
				cwd: join(workRootDir, "client"),
				status: "done",
				startedAt: 1,
				completedAt: 2,
				prompt: "p",
				telegramRoute: {
					targetUserId: "-100123",
					threadId: 42,
					topicName: "#t1 Telegram task",
					channel: "telegram",
				},
			}],
		});

		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-telegram-1",
				todoId: todo.id,
				sessionId: "ai-route-1",
			});

		expect(r.status).toBe(200);
		expect(r.body.warnings).toEqual(expect.arrayContaining(["hooks_not_installed", "hook_script_missing"]));
		expect(nativeTerminalCalls[0].command).toContain("export QUADTODO_SESSION_ID='ai-route-1';");
		expect(nativeTerminalCalls[0].command).toContain(`export QUADTODO_TODO_ID='${todo.id}';`);
		expect(nativeTerminalCalls[0].command).toContain("export QUADTODO_TODO_TITLE='Telegram task';");
		expect(nativeTerminalCalls[0].command).toContain("export QUADTODO_TARGET_USER='-100123';");
		expect(nativeTerminalCalls[0].command).toContain("'claude' '--resume' 'native-telegram-1'");
	});

	it("POST /api/system/open-native-ai-resume warns when Claude session has no telegram route", async () => {
		const todo = srv.db.createTodo({ title: "No route task", quadrant: 1, workDir: join(workRootDir, "client") });
		srv.db.updateTodo(todo.id, {
			aiSessions: [{
				sessionId: "ai-no-route",
				tool: "claude",
				nativeSessionId: "native-no-route",
				cwd: join(workRootDir, "client"),
				status: "done",
				startedAt: 1,
				completedAt: 2,
				prompt: "p",
			}],
		});

		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-no-route",
				todoId: todo.id,
				sessionId: "ai-no-route",
			});

		expect(r.status).toBe(200);
		expect(r.body.warnings).toContain("telegram_route_missing");
		expect(nativeTerminalCalls[0].command).toContain("export QUADTODO_SESSION_ID='ai-no-route';");
		expect(nativeTerminalCalls[0].command).not.toContain("QUADTODO_TARGET_USER");
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/server.test.js -t "open-native-ai-resume"`

Expected: FAIL because `warnings` is missing and the native command does not contain `QUADTODO_*` exports.

- [ ] **Step 3: Implement minimal server helpers and endpoint changes**

In `src/server.js`, change the import at the top:

```js
import { inspectHooks } from "./openclaw-hook-installer.js";
```

Add these helpers after `shellEscape`:

```js
function buildShellExports(env = {}) {
	const entries = Object.entries(env).filter(([, value]) => value != null && value !== "");
	if (entries.length === 0) return "";
	return `${entries.map(([key, value]) => `export ${key}=${shellEscape(value)}`).join("; ")}; `;
}

function findNativeResumeContext({ db, todoId, sessionId, nativeSessionId, tool } = {}) {
	if (!todoId) return { todo: null, aiSession: null };
	const todo = db.getTodo(todoId);
	if (!todo) return { todo: null, aiSession: null };
	const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : [];
	const aiSession = sessions.find((item) => {
		if (!item) return false;
		if (sessionId && item.sessionId === sessionId) return true;
		return item.nativeSessionId === nativeSessionId && item.tool === tool;
	}) || null;
	return { todo, aiSession };
}

function buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig } = {}) {
	if (tool !== "claude" || !todo || !aiSession) return { env: {}, warnings: [] };
	const warnings = [];
	const route = aiSession.telegramRoute || null;
	if (!route?.threadId) warnings.push("telegram_route_missing");
	let hookStatus = null;
	try {
		hookStatus = inspectHooks();
	} catch {
		hookStatus = null;
	}
	if (!hookStatus?.scriptExists) warnings.push("hook_script_missing");
	if (!hookStatus?.installed) warnings.push("hooks_not_installed");
	const port = runtimeConfig?.port || 5677;
	const env = {
		QUADTODO_SESSION_ID: aiSession.sessionId,
		QUADTODO_TODO_ID: todo.id,
		QUADTODO_TODO_TITLE: todo.title || aiSession.prompt || "",
		QUADTODO_URL: `http://127.0.0.1:${port}`,
	};
	if (route?.targetUserId) env.QUADTODO_TARGET_USER = String(route.targetUserId);
	return { env, warnings };
}
```

Update the endpoint body in `src/server.js`:

```js
		app.post("/api/system/open-native-ai-resume", async (req, res) => {
			try {
				const cwd = req.body?.cwd || runtimeConfig.defaultCwd;
				if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
					res.status(400).json({ ok: false, error: "cwd_not_found" });
					return;
				}
				const tool = req.body?.tool;
				const nativeSessionId = req.body?.nativeSessionId;
				const title = buildNativeResumeTitle(tool, nativeSessionId);
				const baseCommand = buildNativeResumeCommand(
					tool,
					nativeSessionId,
					runtimeConfig.tools,
				);
				const { todo, aiSession } = findNativeResumeContext({
					db,
					todoId: req.body?.todoId,
					sessionId: req.body?.sessionId,
					nativeSessionId,
					tool,
				});
				const hook = buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig });
				const command = `${buildShellExports(hook.env)}${baseCommand}`;
				const result = await openNativeTerminal({ cwd, command, title });
				res.json({
					ok: true,
					cwd: result?.cwd || cwd,
					title: result?.title || title,
					command: result?.command || command,
					action: result?.action || "created",
					warnings: hook.warnings,
				});
			} catch (e) {
```

- [ ] **Step 4: Run focused server tests**

Run: `npm test -- test/server.test.js -t "open-native-ai-resume|buildNativeResumeLaunch"`

Expected: PASS for native resume and launch marker tests.

- [ ] **Step 5: Commit server changes**

Run:

```bash
git add src/server.js test/server.test.js
git commit -m "$(cat <<'EOF'
Fix local resume Telegram hook context

Inject quadtodo hook metadata into native Claude resume launches so local Terminal sessions can push back to their Telegram topic.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend request context and warning display

**Files:**
- Modify: `web/src/api.ts:10-20`
- Modify: `web/src/api.ts:520-526`
- Modify: `web/src/TodoManage.tsx:1589-1606`

- [ ] **Step 1: Extend frontend API types**

In `web/src/api.ts`, extend `AiSession` with the persisted route shape used by the backend:

```ts
export interface AiSession {
  sessionId: string
  tool: AiTool
  nativeSessionId: string | null
  cwd?: string | null
  status: AiStatus
  startedAt: number
  completedAt: number | null
  prompt: string
  label?: string
  telegramRoute?: {
    targetUserId?: string | number | null
    threadId?: string | number | null
    topicName?: string | null
    channel?: string | null
  } | null
}
```

Replace `openNativeAiResume` with:

```ts
export type NativeResumeWarning = 'telegram_route_missing' | 'hook_script_missing' | 'hooks_not_installed'

export async function openNativeAiResume(input: {
  cwd: string
  tool: AiTool
  nativeSessionId: string
  todoId?: string
  sessionId?: string
}): Promise<{ cwd: string; command: string; warnings: NativeResumeWarning[] }> {
  const body = await jsonFetch<{ ok: true; cwd: string; command: string; warnings?: NativeResumeWarning[] }>('/api/system/open-native-ai-resume', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { cwd: body.cwd, command: body.command, warnings: body.warnings || [] }
}
```

- [ ] **Step 2: Update local resume UI handler**

Replace `handleOpenNativeResume` in `web/src/TodoManage.tsx` with:

```tsx
  const handleOpenNativeResume = useCallback(async (todo: Todo, session: Todo['aiSessions'][number]) => {
    const cwd = session.cwd || todo.workDir || undefined
    const nativeSessionId = session.nativeSessionId
    if (!nativeSessionId) {
      message.error('当前会话缺少原生 session ID，无法在本地继续')
      return
    }
    try {
      const result = await openNativeAiResume({
        cwd: cwd || '',
        tool: session.tool,
        nativeSessionId,
        todoId: todo.id,
        sessionId: session.sessionId,
      })
      const warnings = result.warnings || []
      if (warnings.includes('telegram_route_missing')) {
        message.warning('已在本地 Terminal 中继续；当前会话没有 Telegram topic 路由，不会推送到 Telegram')
      } else if (warnings.includes('hooks_not_installed') || warnings.includes('hook_script_missing')) {
        message.warning('已在本地 Terminal 中继续；Claude Code hooks 未安装或脚本缺失，Telegram 推送可能不可用')
      } else {
        message.success('已在本地 Terminal 中继续当前会话，Telegram 将接收后续回复')
      }
    } catch (e: any) {
      message.error(e?.message || '本地继续失败')
    }
  }, [])
```

- [ ] **Step 3: Run frontend type check/build**

Run: `npm run build`

Expected: PASS. If the repository build includes both server and web, no TypeScript errors should appear for `openNativeAiResume` or `telegramRoute`.

- [ ] **Step 4: Commit frontend changes**

Run:

```bash
git add web/src/api.ts web/src/TodoManage.tsx
git commit -m "$(cat <<'EOF'
Warn about local resume Telegram push readiness

Pass todo session context to native resume launches and surface missing hook or topic route warnings in the UI.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Verification and manual check

**Files:**
- No code changes expected.

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- test/server.test.js -t "open-native-ai-resume|buildNativeResumeLaunch"`

Expected: PASS.

- [ ] **Step 2: Run broader relevant tests**

Run: `npm test -- test/server.test.js test/openclaw-hook-installer.test.js`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Manual UI check**

Run the app, open a todo with a history session that has `nativeSessionId`, click “本地继续”, and verify that the success/warning message matches the session state. If a real Telegram-routed session is available, finish one Claude response in the native Terminal and verify the topic receives the reply.

- [ ] **Step 5: Final commit if verification required fixes**

If verification required changes, commit them with:

```bash
git add src/server.js test/server.test.js web/src/api.ts web/src/TodoManage.tsx
git commit -m "$(cat <<'EOF'
Stabilize local resume Telegram push

Address verification findings for native Terminal Telegram notification support.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Spec coverage:
- Native Terminal behavior is preserved by keeping `/api/system/open-native-ai-resume` and `openNativeTerminal` flow.
- Claude hook env injection is covered by Task 1.
- Missing hook and route warnings are covered by Tasks 1 and 2.
- General-topic leakage is handled by relying on existing route-required Telegram bridge behavior and warning on missing route.
- Telegram input control is excluded; no task adds stdin bridging.

Placeholder scan: no TBD/TODO/fill-in placeholders remain.

Type consistency:
- `todoId`, `sessionId`, `nativeSessionId`, `telegramRoute`, and `warnings` are consistently named across server tests, server endpoint, API client, and UI handler.
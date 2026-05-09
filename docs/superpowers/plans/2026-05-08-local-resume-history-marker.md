# Local Resume History Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and display a per-history-session marker after a user successfully opens “本地继续” for an AI session.

**Architecture:** Extend the existing native resume endpoint so it optionally receives `todoId` and `sessionId`; after `openNativeTerminal` succeeds, it updates the matching `todo.aiSessions[]` entry with `localResume.openedAt = Date.now()`. The web API and todo history UI pass those IDs, refresh todos on success, and render a lightweight “已本地继续 · HH:mm” marker only inside the matching history row.

**Tech Stack:** Node.js/Express, SQLite JSON field via existing `db.updateTodo`, React + TypeScript, Ant Design tags, Vitest + Supertest.

---

## File Structure

- Modify `src/server.js`
  - Keep `/api/system/open-native-ai-resume` as the single backend entry point for opening native Terminal resume.
  - Add optional persistence when request body includes `todoId` and `sessionId`.
  - Do not change todo status or spawn web PTY sessions.

- Modify `web/src/api.ts`
  - Add optional `todoId` and `sessionId` to `openNativeAiResume` input.
  - Add optional `localResume` to `AiSession`.

- Modify `web/src/TodoManage.tsx`
  - Pass `todo.id` and `session.sessionId` when opening native resume.
  - Call `refresh()` after success so persisted marker appears after reload/data refresh.
  - Render `已本地继续 · HH:mm` in the clicked history session row only.

- Modify `test/server.test.js`
  - Verify native resume marks the matching AI session after successful Terminal open.
  - Verify failure to open native Terminal does not mark the session.

- Optional modify `web/src/TodoManage.css`
  - Add one small marker class if the inline Ant Design `Tag` spacing is not enough.

---

### Task 1: Backend persistence after successful native resume

**Files:**
- Modify: `test/server.test.js:222-243`
- Modify: `src/server.js:695-729`

- [ ] **Step 1: Write the failing success-path test**

Add this test after the existing `POST /api/system/open-native-ai-resume opens local Terminal...` test in `test/server.test.js`:

```js
	it("POST /api/system/open-native-ai-resume marks the matching todo session after Terminal opens", async () => {
		const todo = srv.db.createTodo({
			title: "Resume marker",
			quadrant: 1,
			aiSessions: [
				{
					sessionId: "s1",
					tool: "claude",
					nativeSessionId: "native-123",
					status: "done",
					startedAt: 1000,
					completedAt: 2000,
					prompt: "hello",
				},
				{
					sessionId: "s2",
					tool: "claude",
					nativeSessionId: "native-456",
					status: "done",
					startedAt: 3000,
					completedAt: 4000,
					prompt: "other",
				},
			],
		});

		const before = Date.now();
		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-123",
				todoId: todo.id,
				sessionId: "s1",
			});
		const after = Date.now();

		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.todo.aiSessions[0].sessionId).toBe("s1");
		expect(r.body.todo.aiSessions[0].localResume.openedAt).toBeGreaterThanOrEqual(before);
		expect(r.body.todo.aiSessions[0].localResume.openedAt).toBeLessThanOrEqual(after);
		expect(r.body.todo.aiSessions[1].localResume).toBeUndefined();

		const updated = srv.db.getTodo(todo.id);
		expect(updated.aiSessions[0].localResume.openedAt).toBe(r.body.todo.aiSessions[0].localResume.openedAt);
		expect(updated.status).toBe("todo");
	});
```

- [ ] **Step 2: Write the failing failure-path test**

Add this test after the success-path test in `test/server.test.js`:

```js
	it("POST /api/system/open-native-ai-resume does not mark a session when Terminal open fails", async () => {
		srv.close();
		srv = createServer({
			dbFile: ":memory:",
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-srv-")),
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
			pickDirectory: async (input) => {
				pickDirectoryCalls.push(input);
				return { path: join(workRootDir, "client"), cancelled: false };
			},
			openNativeTerminal: async (input) => {
				nativeTerminalCalls.push(input);
				throw new Error("terminal failed");
			},
		});
		const todo = srv.db.createTodo({
			title: "Resume marker failure",
			quadrant: 1,
			aiSessions: [
				{
					sessionId: "s1",
					tool: "claude",
					nativeSessionId: "native-123",
					status: "done",
					startedAt: 1000,
					completedAt: 2000,
					prompt: "hello",
				},
			],
		});

		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-123",
				todoId: todo.id,
				sessionId: "s1",
			});

		expect(r.status).toBe(500);
		expect(srv.db.getTodo(todo.id).aiSessions[0].localResume).toBeUndefined();
	});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- test/server.test.js
```

Expected: the new success-path test fails because `r.body.todo` is undefined and no `localResume` is persisted. The existing tests should still compile.

- [ ] **Step 4: Implement minimal backend persistence**

Replace the `/api/system/open-native-ai-resume` route in `src/server.js:695-729` with:

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
			const command = buildNativeResumeCommand(
				tool,
				nativeSessionId,
				runtimeConfig.tools,
			);
			const result = await openNativeTerminal({ cwd, command, title });

			let todo = null;
			const todoId = typeof req.body?.todoId === "string" ? req.body.todoId : "";
			const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
			if (todoId && sessionId) {
				const existing = db.getTodo(todoId);
				if (existing) {
					const openedAt = Date.now();
					let changed = false;
					const aiSessions = (existing.aiSessions || []).map((item) => {
						if (item?.sessionId !== sessionId) return item;
						changed = true;
						return { ...item, localResume: { openedAt } };
					});
					if (changed) todo = db.updateTodo(todoId, { aiSessions });
				}
			}

			res.json({
				ok: true,
				cwd: result?.cwd || cwd,
				title: result?.title || title,
				command: result?.command || command,
				action: result?.action || "created",
				...(todo ? { todo } : {}),
			});
		} catch (e) {
			const status = [
				"native_terminal_unsupported",
				"invalid_tool",
				"missing_native_session_id",
				"tool_not_configured",
			].includes(e?.code)
				? 400
				: 500;
			res.status(status).json({ ok: false, error: e.message });
		}
	});
```

- [ ] **Step 5: Run backend tests and verify pass**

Run:

```bash
npm test -- test/server.test.js
```

Expected: all `test/server.test.js` tests pass.

- [ ] **Step 6: Commit backend change**

Run:

```bash
git add src/server.js test/server.test.js
git commit -m "feat: persist local resume markers"
```

---

### Task 2: Frontend API and history row marker

**Files:**
- Modify: `web/src/api.ts:10-20`, `web/src/api.ts:520-526`
- Modify: `web/src/TodoManage.tsx:393-409`, `web/src/TodoManage.tsx:1589-1606`

- [ ] **Step 1: Update frontend API types**

In `web/src/api.ts`, update `AiSession` to include the optional persisted marker:

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
  localResume?: {
    openedAt: number
  }
}
```

Then replace `openNativeAiResume` with:

```ts
export async function openNativeAiResume(input: {
  cwd: string
  tool: AiTool
  nativeSessionId: string
  todoId?: string
  sessionId?: string
}): Promise<{ cwd: string; command: string; todo?: Todo }> {
  const body = await jsonFetch<{ ok: true; cwd: string; command: string; todo?: Todo }>('/api/system/open-native-ai-resume', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { cwd: body.cwd, command: body.command, todo: body.todo }
}
```

- [ ] **Step 2: Render the local resume marker in the history row**

In `web/src/TodoManage.tsx`, in the history session row body after the native ID block and before the command block, add this conditional block:

```tsx
                      {session.localResume?.openedAt ? (
                        <div>
                          <Tag color="processing" style={{ margin: 0, fontSize: 11 }}>
                            已本地继续 · {dayjs(session.localResume.openedAt).format('HH:mm')}
                          </Tag>
                        </div>
                      ) : null}
```

The surrounding section should become:

```tsx
                      <div className="todo-history-native-id" title={nativeSessionId || session.sessionId}>
                        session id: {nativeSessionId || session.sessionId}
                        {!nativeSessionId && (
                          <Tooltip title="该会话未正常结束，没有拿到原生 session ID，无法 resume/fork。请在 AI 完成后在终端里按 Ctrl+D 或 /exit 正常退出。">
                            <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
                          </Tooltip>
                        )}
                      </div>
                      {session.localResume?.openedAt ? (
                        <div>
                          <Tag color="processing" style={{ margin: 0, fontSize: 11 }}>
                            已本地继续 · {dayjs(session.localResume.openedAt).format('HH:mm')}
                          </Tag>
                        </div>
                      ) : null}
                      {nativeSessionId && (
                        <div className="todo-history-command" title={terminalCommand}>
                          {terminalCommand}
                        </div>
                      )}
```

- [ ] **Step 3: Pass todo/session IDs and refresh after success**

Replace `handleOpenNativeResume` in `web/src/TodoManage.tsx:1589-1606` with:

```tsx
  const handleOpenNativeResume = useCallback(async (todo: Todo, session: Todo['aiSessions'][number]) => {
    const cwd = session.cwd || todo.workDir || undefined
    const nativeSessionId = session.nativeSessionId
    if (!nativeSessionId) {
      message.error('当前会话缺少原生 session ID，无法在本地继续')
      return
    }
    try {
      await openNativeAiResume({
        cwd: cwd || '',
        tool: session.tool,
        nativeSessionId,
        todoId: todo.id,
        sessionId: session.sessionId,
      })
      await refresh()
      message.success('已在本地 Terminal 中继续当前会话')
    } catch (e: any) {
      message.error(e?.message || '本地继续失败')
    }
  }, [refresh])
```

- [ ] **Step 4: Run frontend build**

Run:

```bash
npm run build:web
```

Expected: TypeScript build succeeds and emits the web bundle.

- [ ] **Step 5: Run full test suite**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 6: Commit frontend change**

Run:

```bash
git add web/src/api.ts web/src/TodoManage.tsx
git commit -m "feat: show local resume marker in history"
```

---

### Task 3: Manual UI verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Start the app**

Run:

```bash
npm run build:web && npm start
```

Expected: quadtodo starts and opens the web UI. If the browser does not open automatically, use the local URL printed by the CLI.

- [ ] **Step 2: Verify success path**

In the web UI:

1. Open a todo with at least one historical AI session that has a native session ID.
2. Expand “历史会话”.
3. Click “本地继续” on one session row.
4. Confirm the success toast appears.
5. Confirm only that row shows `已本地继续 · HH:mm`.
6. Refresh the browser.
7. Confirm the marker is still visible on the same row.

- [ ] **Step 3: Verify no global todo status change**

In the web UI after clicking “本地继续”:

1. Check the todo card status chip.
2. Confirm it remains its prior todo/AI status and does not become a global “本地继续” status.

- [ ] **Step 4: Verify failure path if native Terminal cannot open**

Temporarily run this only if the platform/environment can reproduce a native Terminal failure without destructive changes:

1. On a non-macOS environment, click “本地继续”.
2. Confirm an error toast appears.
3. Confirm no `已本地继续` marker appears.

On macOS, rely on the automated failure-path test from Task 1.

---

## Self-Review

- Spec coverage: The plan persists a marker only after successful native Terminal open, records the latest `openedAt`, shows it only in the history row, refreshes after success, and leaves todo status unchanged.
- Placeholder scan: No implementation placeholders remain; every code step has concrete code and commands.
- Type consistency: The marker field is consistently named `localResume.openedAt` across backend JSON, frontend API type, and UI rendering.

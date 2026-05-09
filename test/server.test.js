import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";

const larkBotMockState = vi.hoisted(() => ({
	instances: [],
	nextBot: null,
}));

vi.mock("../src/lark-bot.js", () => ({
	createLarkBot: vi.fn(() => {
		const bot = larkBotMockState.nextBot || {
			start: vi.fn(async () => ({ ok: true, action: "started" })),
			stop: vi.fn(async () => ({ ok: true })),
			replyInThread: vi.fn(async () => ({ ok: true, payload: { message_id: "om_mock" } })),
			handleEvent: vi.fn(async () => ({ ok: true })),
			describe: vi.fn(() => ({ enabled: true, running: true })),
		};
		larkBotMockState.nextBot = null;
		larkBotMockState.instances.push(bot);
		return bot;
	}),
}));

import {
	buildNativeResumeLaunch,
	buildNativeResumeMarker,
	createServer,
	resolveEditorTargetInfo,
	resolveEditorTargetPath,
} from "../src/server.js";

class FakePty extends EventEmitter {
	constructor() {
		super();
		this._has = new Set();
		this.started = [];
	}
	start(opts) {
		this._has.add(opts.sessionId);
		this.started.push(opts);
	}
	write() {}
	resize() {}
	stop(id) {
		this._has.delete(id);
		this.emit("done", {
			sessionId: id,
			exitCode: 0,
			fullLog: "",
			nativeId: null,
			stopped: true,
		});
	}
	has(id) {
		return this._has.has(id);
	}
	list() {
		return [...this._has];
	}
}

describe("server", () => {
	let srv;
	let configRootDir;
	let workRootDir;
	let pickDirectoryCalls;
	let nativeTerminalCalls;
	let hookStatus;
	beforeEach(() => {
		const logDir = mkdtempSync(join(tmpdir(), "quadtodo-srv-"));
		configRootDir = mkdtempSync(join(tmpdir(), "quadtodo-cfg-"));
		workRootDir = mkdtempSync(join(tmpdir(), "quadtodo-work-"));
		pickDirectoryCalls = [];
		nativeTerminalCalls = [];
		hookStatus = { installed: false, scriptExists: false };
		mkdirSync(join(workRootDir, "client"));
		mkdirSync(join(workRootDir, "server"));
		loadConfig({ rootDir: configRootDir });
		larkBotMockState.instances = [];
		larkBotMockState.nextBot = null;
		srv = createServer({
			dbFile: ":memory:",
			logDir,
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
			pickDirectory: async (input) => {
				pickDirectoryCalls.push(input);
				return { path: join(workRootDir, "client"), cancelled: false };
			},
			openNativeTerminal: async (input) => {
				nativeTerminalCalls.push(input);
				return { cwd: input.cwd };
			},
			inspectHooks: () => hookStatus,
		});
	});
	afterEach(async () => {
		await srv.close();
	});

	it("GET /api/status returns ok + version + activeSessions", async () => {
		const r = await request(srv.app).get("/api/status");
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(typeof r.body.version).toBe("string");
		expect(r.body.activeSessions).toEqual(0);
	});

	it("mounts /api/todos", async () => {
		const r = await request(srv.app).get("/api/todos");
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
	});

	it("mounts /api/ai-terminal", async () => {
		const todo = srv.db.createTodo({ title: "T", quadrant: 1 });
		const r = await request(srv.app)
			.post("/api/ai-terminal/exec")
			.send({ todoId: todo.id, prompt: "hi", tool: "claude" });
		expect(r.status).toBe(200);
	});

	it("GET /api/config returns current config including lark defaults", async () => {
		const r = await request(srv.app).get("/api/config");
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.config.defaultTool).toBe("claude");
		expect(r.body.config.lark).toMatchObject({
			enabled: false,
			chatId: "",
			requireThreadGroup: true,
			eventSubscribeEnabled: true,
		});
		expect(r.body.toolDiagnostics.claude.installHint).toContain(
			"@anthropic-ai/claude-code",
		);
	});

	it("PUT /api/config updates runtime config for future sessions", async () => {
		const nextDefaultCwd = join(workRootDir, "client");
		const update = await request(srv.app)
			.put("/api/config")
			.send({
				defaultCwd: nextDefaultCwd,
				tools: {
					claude: { command: "claude-w", bin: "/tmp/claude-custom", args: [] },
				},
			});
		expect(update.status).toBe(200);
		expect(update.body.runtimeApplied.larkRestart).toEqual({ applied: false });

		const todo = srv.db.createTodo({ title: "T", quadrant: 1 });
		await request(srv.app)
			.post("/api/ai-terminal/exec")
			.send({ todoId: todo.id, prompt: "hi", tool: "claude" });

		expect(update.body.runtimeApplied.defaultCwd).toBe(nextDefaultCwd);
		expect(srv.pty.started[0].cwd).toBe(nextDefaultCwd);
		expect(srv.pty.tools.claude.command).toBe("claude-w");
		expect(srv.pty.tools.claude.bin).toBe("/tmp/claude-custom");
		expect(update.body.toolDiagnostics.claude.source).toBe("config");
	});

	it("PUT /api/config clears stale bin when command changes but bin is unchanged", async () => {
		const initial = await request(srv.app).get("/api/config");
		const staleBin = initial.body.config.tools.codex.bin;

		const update = await request(srv.app)
			.put("/api/config")
			.send({
				tools: {
					codex: { command: "codex-w", bin: staleBin, args: [] },
				},
			});

		expect(update.status).toBe(200);
		expect(update.body.config.tools.codex.command).toBe("codex-w");
		expect(update.body.toolDiagnostics.codex.command).toBe("codex-w");
		expect(update.body.toolDiagnostics.codex.configuredBin).toBe(null);
		expect(update.body.toolDiagnostics.codex.bin).not.toBe(staleBin);
	});

	it("PUT /api/config persists lark edits and reports runtime restart", async () => {
		const update = await request(srv.app)
			.put("/api/config")
			.send({
				lark: {
					enabled: false,
					chatId: "oc_test_chat",
					requireThreadGroup: false,
				},
			});

		expect(update.status).toBe(200);
		expect(update.body.config.lark).toMatchObject({
			enabled: false,
			chatId: "oc_test_chat",
			requireThreadGroup: false,
			eventSubscribeEnabled: true,
		});
		expect(update.body.runtimeApplied.larkRestart).toEqual({ applied: true });
		expect(loadConfig({ rootDir: configRootDir }).lark.chatId).toBe("oc_test_chat");
	});

	it("rehydrates persisted lark session routes on startup", async () => {
		const dbFile = join(mkdtempSync(join(tmpdir(), "quadtodo-db-rehydrate-")), "db.sqlite");
		const srv1 = createServer({
			dbFile,
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-log-rehydrate1-")),
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
		});
		const t = srv1.db.createTodo({ title: "Lark routed", quadrant: 1 });
		srv1.db.updateTodo(t.id, {
			status: "ai_running",
			aiSessions: [{
				sessionId: "ai-old-lark1",
				tool: "codex",
				nativeSessionId: "native-lark-1",
				cwd: workRootDir,
				prompt: "continue",
				status: "running",
				larkRoute: {
					channel: "lark",
					targetUserId: "oc_lark_chat",
					rootMessageId: "om_root_1",
					messageAppLink: "https://example.test/message",
				},
			}],
		});
		await srv1.close();

		const srv2 = createServer({
			dbFile,
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-log-rehydrate2-")),
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
		});
		try {
			const [route] = srv2.openclawBridge.listSessionRoutes();
			expect(route).toMatchObject({
				channel: "lark",
				targetUserId: "oc_lark_chat",
				rootMessageId: "om_root_1",
				messageAppLink: "https://example.test/message",
			});
			expect(route.sessionId).not.toBe("ai-old-lark1");
		} finally {
			await srv2.close();
		}
	});

	it("returns structured lark_bot_not_running for lark routes when lark is disabled", async () => {
		saveConfig({
			...loadConfig({ rootDir: configRootDir }),
			openclaw: {
				enabled: true,
				channel: "lark",
				targetUserId: "oc_lark_chat",
			},
			lark: {
				enabled: false,
				chatId: "oc_lark_chat",
			},
		}, { rootDir: configRootDir });
		await srv.close();

		srv = createServer({
			dbFile: ":memory:",
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-log-lark-disabled-")),
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
		});
		srv.openclawBridge.registerSessionRoute("sid-disabled-lark", {
			channel: "lark",
			targetUserId: "oc_lark_chat",
			rootMessageId: "om_root_disabled",
		});

		await expect(srv.openclawBridge.postText({
			sessionId: "sid-disabled-lark",
			message: "hello",
		})).resolves.toMatchObject({
			ok: false,
			reason: "lark_bot_not_running",
		});
	});

	it("close awaits and clears the running Lark stack from OpenClaw bridge", async () => {
		const stopStarted = [];
		let releaseStop;
		const stopFinished = new Promise((resolve) => { releaseStop = resolve; });
		const larkBot = {
			start: vi.fn(async () => ({ ok: true, action: "started" })),
			stop: vi.fn(async () => {
				stopStarted.push(true);
				await stopFinished;
				return { ok: true };
			}),
			replyInThread: vi.fn(async () => ({ ok: true, payload: { message_id: "om_before_close" } })),
			handleEvent: vi.fn(async () => ({ ok: true })),
			describe: vi.fn(() => ({ enabled: true, running: true })),
		};
		larkBotMockState.nextBot = larkBot;
		saveConfig({
			...loadConfig({ rootDir: configRootDir }),
			openclaw: {
				enabled: true,
				channel: "lark",
				targetUserId: "oc_lark_chat",
			},
			lark: {
				enabled: true,
				chatId: "oc_lark_chat",
				eventSubscribeEnabled: true,
			},
		}, { rootDir: configRootDir });
		await srv.close();

		srv = createServer({
			dbFile: ":memory:",
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-log-lark-close-")),
			pty: new FakePty(),
			defaultCwd: workRootDir,
			configRootDir,
		});
		srv.openclawBridge.registerSessionRoute("sid-close-lark", {
			channel: "lark",
			targetUserId: "oc_lark_chat",
			rootMessageId: "om_root_close",
		});
		await expect(srv.openclawBridge.postText({
			sessionId: "sid-close-lark",
			message: "before close",
		})).resolves.toMatchObject({ ok: true });

		const closePromise = srv.close();
		await vi.waitFor(() => expect(stopStarted).toHaveLength(1));
		await expect(srv.openclawBridge.postText({
			sessionId: "sid-close-lark",
			message: "during close",
		})).resolves.toMatchObject({
			ok: false,
			reason: "lark_bot_not_running",
		});
		let closeResolved = false;
		closePromise.then(() => { closeResolved = true; });
		await Promise.resolve();
		expect(closeResolved).toBe(false);

		releaseStop();
		await closePromise;
		expect(larkBot.stop).toHaveBeenCalledTimes(1);
		expect(closeResolved).toBe(true);
	});

	it("PUT /api/config persists pricing edits and merges partial patches", async () => {
		// 整份 pricing 替换：支持删除模型条目并覆盖 CNY 汇率
		const full = await request(srv.app)
			.put("/api/config")
			.send({
				pricing: {
					cnyRate: 7.5,
					default: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
					models: {
						"claude-opus-4-*": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
					},
				},
			});
		expect(full.status).toBe(200);
		expect(full.body.config.pricing.cnyRate).toBe(7.5);
		expect(full.body.config.pricing.default.input).toBe(4);
		expect(full.body.config.pricing.models["claude-opus-4-*"].output).toBe(75);

		// 部分 patch：只改 cnyRate，不应清掉 default / models
		const partial = await request(srv.app)
			.put("/api/config")
			.send({ pricing: { cnyRate: 7.1 } });
		expect(partial.status).toBe(200);
		expect(partial.body.config.pricing.cnyRate).toBe(7.1);
		expect(partial.body.config.pricing.default.input).toBe(4);
		expect(partial.body.config.pricing.models["claude-opus-4-*"].output).toBe(75);

		// 根本不带 pricing：应保留上一次值
		const untouched = await request(srv.app)
			.put("/api/config")
			.send({ defaultCwd: workRootDir });
		expect(untouched.status).toBe(200);
		expect(untouched.body.config.pricing.cnyRate).toBe(7.1);
	});

	it("GET /api/config/workdirs returns default root and child directories", async () => {
		const r = await request(srv.app).get("/api/config/workdirs");
		expect(r.status).toBe(200);
		expect(r.body.root).toBe(workRootDir);
		expect(r.body.options[0].value).toBe(workRootDir);
		expect(r.body.options.map((item) => item.value)).toContain(
			join(workRootDir, "client"),
		);
		expect(r.body.options.map((item) => item.value)).toContain(
			join(workRootDir, "server"),
		);
	});

	it("POST /api/system/pick-directory proxies to native picker", async () => {
		const r = await request(srv.app)
			.post("/api/system/pick-directory")
			.send({
				defaultPath: join(workRootDir, "server"),
				prompt: "选择默认启动目录",
			});

		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.path).toBe(join(workRootDir, "client"));
		expect(r.body.cancelled).toBe(false);
		expect(pickDirectoryCalls[0]).toEqual({
			defaultPath: join(workRootDir, "server"),
			prompt: "选择默认启动目录",
		});
	});

	it("POST /api/system/open-native-ai-resume opens local Terminal with resume command and no web terminal session", async () => {
		const before = srv.pty.started.length;
		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-123",
			});

		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.cwd).toBe(join(workRootDir, "client"));
		expect(r.body.title).toBe("quadtodo:claude:native-123");
		expect(r.body.action).toBe("created");
		expect(nativeTerminalCalls).toHaveLength(1);
		expect(nativeTerminalCalls[0].cwd).toBe(join(workRootDir, "client"));
		expect(nativeTerminalCalls[0].title).toBe("quadtodo:claude:native-123");
		expect(nativeTerminalCalls[0].command).toContain("--resume");
		expect(nativeTerminalCalls[0].command).toContain("native-123");
		expect(srv.pty.started.length).toBe(before);
	});

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
		expect(nativeTerminalCalls[0].command).toContain("'--resume' 'native-telegram-1'");
		expect(srv.openclawBridge.resolveRoute("ai-route-1")).toMatchObject({
			targetUserId: "-100123",
			threadId: 42,
			channel: "telegram",
		});
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
		expect(nativeTerminalCalls[0].command).not.toContain("QUADTODO_SESSION_ID");
		expect(nativeTerminalCalls[0].command).not.toContain("QUADTODO_TARGET_USER");
	});

	it("POST /api/system/open-native-ai-resume does not register incomplete telegram topic routes", async () => {
		const todo = srv.db.createTodo({ title: "Partial route task", quadrant: 1, workDir: join(workRootDir, "client") });
		srv.db.updateTodo(todo.id, {
			aiSessions: [{
				sessionId: "ai-partial-route",
				tool: "claude",
				nativeSessionId: "native-partial-route",
				cwd: join(workRootDir, "client"),
				status: "done",
				startedAt: 1,
				completedAt: 2,
				prompt: "p",
				telegramRoute: {
					targetUserId: "-100123",
					channel: "telegram",
				},
			}],
		});

		const r = await request(srv.app)
			.post("/api/system/open-native-ai-resume")
			.send({
				cwd: join(workRootDir, "client"),
				tool: "claude",
				nativeSessionId: "native-partial-route",
				todoId: todo.id,
				sessionId: "ai-partial-route",
			});

		expect(r.status).toBe(200);
		expect(r.body.warnings).toContain("telegram_route_missing");
		expect(nativeTerminalCalls[0].command).not.toContain("QUADTODO_TARGET_USER");
		expect(srv.openclawBridge.hasExplicitRoute("ai-partial-route")).toBe(false);
	});

	it("POST /api/system/open-native-ai-resume ignores mismatched session context", async () => {
		const todo = srv.db.createTodo({ title: "Mismatch task", quadrant: 1, workDir: join(workRootDir, "client") });
		srv.db.updateTodo(todo.id, {
			aiSessions: [{
				sessionId: "ai-route-a",
				tool: "claude",
				nativeSessionId: "native-a",
				cwd: join(workRootDir, "client"),
				status: "done",
				startedAt: 1,
				completedAt: 2,
				prompt: "p",
				telegramRoute: {
					targetUserId: "-100123",
					threadId: 42,
					channel: "telegram",
				},
			}, {
				sessionId: "ai-route-b",
				tool: "claude",
				nativeSessionId: "native-b",
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
				nativeSessionId: "native-b",
				todoId: todo.id,
				sessionId: "ai-route-a",
			});

		expect(r.status).toBe(200);
		expect(nativeTerminalCalls[0].command).not.toContain("QUADTODO_SESSION_ID");
		expect(srv.openclawBridge.hasExplicitRoute("ai-route-a")).toBe(false);
	});

	it("buildNativeResumeMarker produces a stable per-session string", () => {
		const marker = buildNativeResumeMarker("quadtodo:claude:native-123");
		expect(marker).toBe("__quadtodo_resume__:quadtodo:claude:native-123");
		expect(buildNativeResumeMarker("quadtodo:claude:other")).not.toBe(marker);
	});

	it("buildNativeResumeLaunch prints the marker before cd+command so history contains it", () => {
		const { marker, launch } = buildNativeResumeLaunch({
			cwd: "/tmp/work dir",
			command: "'claude' '--resume' 'native-123'",
			title: "quadtodo:claude:native-123",
		});
		expect(marker).toBe("__quadtodo_resume__:quadtodo:claude:native-123");
		const markerIdx = launch.indexOf(marker);
		const cdIdx = launch.indexOf("cd ");
		const cmdIdx = launch.indexOf("'claude'");
		expect(markerIdx).toBeGreaterThan(-1);
		expect(markerIdx).toBeLessThan(cdIdx);
		expect(cdIdx).toBeLessThan(cmdIdx);
		// cwd must be shell-escaped so spaces do not split the `cd` argument
		expect(launch).toContain("cd '/tmp/work dir'");
	});

	it("resolveEditorTargetPath resolves repo-relative paths under cwd descendants", () => {
		const repoRoot = join(workRootDir, "quadtodo");
		const targetDir = join(repoRoot, "apps/workspace/src/context");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "WorkSpaceContext.tsx"), "export const demo = 1\n");

		const resolved = resolveEditorTargetPath(
			workRootDir,
			"apps/workspace/src/context/WorkSpaceContext.tsx:8",
		);

		expect(resolved).toBe(
			`${join(targetDir, "WorkSpaceContext.tsx")}:8`,
		);
	});

	it("resolveEditorTargetInfo prefers remembered session cwd for shorter relative paths", () => {
		const repoRoot = join(workRootDir, "quadtodo");
		const targetDir = join(repoRoot, "src/context");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "WorkSpaceContext.tsx"), "export const demo = 1\n");

		const resolved = resolveEditorTargetInfo(
			[repoRoot, workRootDir],
			"src/context/WorkSpaceContext.tsx:8",
		);

		expect(resolved).toEqual({
			resolvedPath: `${join(targetDir, "WorkSpaceContext.tsx")}:8`,
			baseDir: repoRoot,
		});
	});

	it("listen + close resolves cleanly on random port", async () => {
		await srv.listen(0);
		const addr = srv.httpServer.address();
		expect(addr.port).toBeGreaterThan(0);
		await srv.close();
	});

	it("serves web/dist/index.html at /", async () => {
		const webDist = mkdtempSync(join(tmpdir(), "quadtodo-dist-"));
		writeFileSync(
			join(webDist, "index.html"),
			"<!doctype html><title>test</title>",
		);

		const srv2 = createServer({
			dbFile: ":memory:",
			logDir: mkdtempSync(join(tmpdir(), "quadtodo-log2-")),
			pty: new FakePty(),
			webDist,
		});
		const r = await request(srv2.app).get("/");
		expect(r.status).toBe(200);
		expect(r.text).toContain("<title>test</title>");
		await srv2.close();
	});
});

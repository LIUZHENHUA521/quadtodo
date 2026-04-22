import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
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
	beforeEach(() => {
		const logDir = mkdtempSync(join(tmpdir(), "quadtodo-srv-"));
		configRootDir = mkdtempSync(join(tmpdir(), "quadtodo-cfg-"));
		workRootDir = mkdtempSync(join(tmpdir(), "quadtodo-work-"));
		pickDirectoryCalls = [];
		nativeTerminalCalls = [];
		mkdirSync(join(workRootDir, "client"));
		mkdirSync(join(workRootDir, "server"));
		loadConfig({ rootDir: configRootDir });
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
		});
	});
	afterEach(() => {
		srv.close();
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

	it("GET /api/config returns current config", async () => {
		const r = await request(srv.app).get("/api/config");
		expect(r.status).toBe(200);
		expect(r.body.ok).toBe(true);
		expect(r.body.config.defaultTool).toBe("claude");
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

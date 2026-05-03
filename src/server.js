import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import {
	inspectToolsConfig,
	loadConfig,
	resolveToolsConfig,
	saveConfig,
} from "./config.js";
import { openDb } from "./db.js";
import { PtyManager } from "./pty.js";
import { createAiTerminal } from "./routes/ai-terminal.js";
import { createTranscriptsRouter } from "./routes/transcripts.js";
import { createTranscriptsService } from "./transcripts/index.js";
import { createTodosRouter } from "./routes/todos.js";
import { createUploadsRouter } from "./routes/uploads.js";
import { createTemplatesRouter } from "./routes/templates.js";
import { createRecurringRulesRouter } from "./routes/recurringRules.js";
import { createStatsRouter } from "./routes/stats.js";
import { createReportsRouter } from "./routes/reports.js";
import { createPipelinesRouter } from "./routes/pipelines.js";
import { createOrchestrator } from "./orchestrator.js";
import { createWikiRouter } from "./routes/wiki.js";
import { createWikiService } from "./wiki/index.js";
import { createSearchRouter } from "./routes/search.js";
import { createSearchService } from "./search/index.js";
import { createMcpRouter } from "./mcp/server.js";
import { createOpenClawBridge } from "./openclaw-bridge.js";
import { createPendingQuestionCoordinator } from "./pending-questions.js";
import { createOpenClawHookHandler } from "./openclaw-hook.js";
import { createTelegramSyncRouter } from "./routes/telegram-sync.js";
import { createOpenClawHookRouter } from "./routes/openclaw-hook.js";
import { createOpenClawWizard } from "./openclaw-wizard.js";
import { createOpenClawInboundRouter } from "./routes/openclaw-inbound.js";
import { createTelegramConfigRouter } from "./routes/telegram-config.js";
import { createTelegramBot, readBotTokenWithSource } from "./telegram-bot.js";
import { createLoadingTracker } from "./telegram-loading-status.js";
import { buildTelegramCommands } from "./telegram-commands.js";
import { createProbeRegistry, isMaskedToken, maskBotToken } from "./telegram-config-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadVersion() {
	try {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "../package.json"), "utf8"),
		);
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function pickDirectoryNative({ defaultPath, prompt = "选择目录" } = {}) {
	if (process.platform !== "darwin") {
		const error = new Error("directory_picker_unsupported");
		error.code = "directory_picker_unsupported";
		throw error;
	}

	const safeDefaultPath =
		defaultPath &&
		existsSync(defaultPath) &&
		statSync(defaultPath).isDirectory()
			? defaultPath
			: "";

	const script = [
		"on run argv",
		"set promptText to item 1 of argv",
		"set startPath to item 2 of argv",
		'if startPath is not "" then',
		"  try",
		"    set pickedFolder to choose folder with prompt promptText default location (POSIX file startPath)",
		"  on error",
		"    set pickedFolder to choose folder with prompt promptText",
		"  end try",
		"else",
		"  set pickedFolder to choose folder with prompt promptText",
		"end if",
		"return POSIX path of pickedFolder",
		"end run",
	];

	return new Promise((resolve, reject) => {
		execFile(
			"osascript",
			[
				...script.flatMap((line) => ["-e", line]),
				"--",
				prompt,
				safeDefaultPath,
			],
			(error, stdout, stderr) => {
				if (error) {
					const details = `${stderr || ""} ${error.message || ""}`;
					if (details.includes("User canceled") || details.includes("(-128)")) {
						resolve({ path: null, cancelled: true });
						return;
					}
					reject(error);
					return;
				}
				resolve({ path: stdout.trim(), cancelled: false });
			},
		);
	});
}

function shellEscape(arg) {
	return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildNativeResumeTitle(tool, nativeSessionId) {
	return `quadtodo:${tool}:${nativeSessionId}`;
}

export function buildNativeResumeMarker(title) {
	return `__quadtodo_resume__:${String(title || "")}`;
}

export function buildNativeResumeLaunch({ cwd, command, title } = {}) {
	const marker = buildNativeResumeMarker(title);
	const launch = `printf '[quadtodo] session marker: %s\\n' ${shellEscape(marker)}; cd ${shellEscape(cwd)}; ${String(command || "")}`;
	return { marker, launch };
}

// Why a marker-in-scrollback instead of `custom title`:
//   macOS Terminal's `custom title` gets overwritten by OSC escape sequences that
//   Claude Code / Codex emit to display their own live status (e.g. "✳ Claude Code",
//   "⠂ Kill all Claude Code processes"). That made the original `custom title is tabTitle`
//   check always fail, so each button click spawned a new tab. We now print a unique
//   marker line into the tab's scrollback before launching the CLI, and match via
//   `history contains markerText` — the scrollback persists regardless of OSC noise.
function openNativeTerminalNative({ cwd, command, title } = {}) {
	if (process.platform !== "darwin") {
		const error = new Error("native_terminal_unsupported");
		error.code = "native_terminal_unsupported";
		throw error;
	}

	const targetCwd =
		cwd && existsSync(cwd) && statSync(cwd).isDirectory()
			? cwd
			: process.env.HOME || process.cwd();

	const { marker, launch } = buildNativeResumeLaunch({
		cwd: targetCwd,
		command,
		title,
	});

	const script = [
		"on run argv",
		"set launchCmd to item 1 of argv",
		"set markerText to item 2 of argv",
		"set tabTitle to item 3 of argv",
		'tell application "Terminal"',
		"  activate",
		"  set matchedWindow to missing value",
		"  set matchedTab to missing value",
		"  repeat with winIdx from 1 to (count of windows)",
		"    set win to window winIdx",
		"    repeat with tabIdx from 1 to (count of tabs of win)",
		"      set currentTab to tab tabIdx of win",
		"      try",
		"        set tabHistory to history of currentTab",
		"        if tabHistory contains markerText then",
		"          set matchedWindow to win",
		"          set matchedTab to currentTab",
		"          exit repeat",
		"        end if",
		"      end try",
		"    end repeat",
		"    if matchedTab is not missing value then exit repeat",
		"  end repeat",
		"  if matchedTab is not missing value then",
		"    try",
		"      set index of matchedWindow to 1",
		"    end try",
		"    set selected tab of matchedWindow to matchedTab",
		'    return "reused"',
		"  end if",
		'  do script ""',
		"  delay 0.1",
		"  set newTab to selected tab of front window",
		"  try",
		"    set custom title of newTab to tabTitle",
		"  end try",
		"  do script launchCmd in newTab",
		'  return "created"',
		"end tell",
		"end run",
	];

	return new Promise((resolve, reject) => {
		execFile(
			"osascript",
			[
				...script.flatMap((line) => ["-e", line]),
				"--",
				launch,
				marker,
				String(title || ""),
			],
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr || error.message || "open_native_terminal_failed"));
					return;
				}
				const action = stdout.trim() === "reused" ? "reused" : "created";
				resolve({
					cwd: targetCwd,
					command: String(command || ""),
					title: String(title || ""),
					action,
					output: stdout.trim(),
				});
			},
		);
	});
}

function buildNativeResumeCommand(tool, nativeSessionId, tools = {}) {
	if (!["claude", "codex"].includes(tool)) {
		const error = new Error("invalid_tool");
		error.code = "invalid_tool";
		throw error;
	}
	if (!nativeSessionId) {
		const error = new Error("missing_native_session_id");
		error.code = "missing_native_session_id";
		throw error;
	}

	const toolConfig = tools?.[tool];
	const bin = toolConfig?.bin || toolConfig?.command;
	if (!bin) {
		const error = new Error("tool_not_configured");
		error.code = "tool_not_configured";
		throw error;
	}
	const baseArgs = Array.isArray(toolConfig?.args) ? toolConfig.args : [];
	const resumeArgs = tool === "codex"
		? [...baseArgs, "resume", nativeSessionId]
		: [...baseArgs, "--resume", nativeSessionId];
	return [bin, ...resumeArgs].map(shellEscape).join(" ");
}

function mergeToolConfig(currentTool = {}, nextTool = {}) {
	const merged = {
		...currentTool,
		...nextTool,
	};
	const commandChanged =
		nextTool.command !== undefined &&
		nextTool.command !== (currentTool.command || "");
	const binUnchanged =
		nextTool.bin !== undefined && nextTool.bin === (currentTool.bin || "");

	if (commandChanged && binUnchanged) {
		merged.bin = "";
	}

	return merged;
}

function splitEditorPath(rawPath = "") {
	const trimmed = String(rawPath || "").trim();
	const match = trimmed.match(/^(.*?)(:\d+(?::\d+)?)?$/);
	return {
		fsPath: match?.[1] || trimmed,
		locationSuffix: match?.[2] || "",
	};
}

function findNestedPath(rootDir, relativePath, maxDepth = 3) {
	const normalizedRelativePath = String(relativePath || "")
		.replace(/^\.\/+/, "")
		.replace(/^\/+/, "");
	if (!normalizedRelativePath) return null;

	const seen = new Set();
	function visit(dir, depth) {
		const directCandidate = join(dir, normalizedRelativePath);
		if (existsSync(directCandidate)) return directCandidate;
		if (depth >= maxDepth) return null;

		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const nextDir = join(dir, entry.name);
			if (seen.has(nextDir)) continue;
			seen.add(nextDir);
			const result = visit(nextDir, depth + 1);
			if (result) return result;
		}
		return null;
	}

	return visit(rootDir, 0);
}

function normalizeBaseDirs(baseDirs) {
	const list = Array.isArray(baseDirs) ? baseDirs : [baseDirs];
	return [...new Set(list.filter((item) => typeof item === "string" && item.trim()))];
}

export function resolveEditorTargetInfo(baseDirs, rawPath) {
	const candidates = normalizeBaseDirs(baseDirs);
	if (!candidates.length || !rawPath) return null;
	const { fsPath, locationSuffix } = splitEditorPath(rawPath);
	if (!fsPath) return null;
	const normalizedFsPath = fsPath.replace(/^\.\/+/, "").replace(/^\/+/, "");

	if (fsPath.startsWith("/")) {
		return existsSync(fsPath)
			? { resolvedPath: `${fsPath}${locationSuffix}`, baseDir: null }
			: null;
	}

	for (const baseDir of candidates) {
		const directPath = join(baseDir, normalizedFsPath);
		if (existsSync(directPath)) {
			return { resolvedPath: `${directPath}${locationSuffix}`, baseDir };
		}
	}

	for (const baseDir of candidates) {
		const nestedPath = findNestedPath(baseDir, normalizedFsPath, 3);
		if (nestedPath) {
			return {
				resolvedPath: `${nestedPath}${locationSuffix}`,
				baseDir: nestedPath.slice(0, -normalizedFsPath.length).replace(/\/$/, "") || baseDir,
			};
		}
	}

	return null;
}

export function resolveEditorTargetPath(baseDirs, rawPath) {
	return resolveEditorTargetInfo(baseDirs, rawPath)?.resolvedPath || null;
}

/**
 * @param opts.dbFile   SQLite file path (or ':memory:')
 * @param opts.logDir   directory for ai session logs
 * @param opts.tools    tools config { claude: { bin, args }, codex: { ... } }
 * @param opts.pty      (optional) injected PtyManager — for tests
 * @param opts.webDist  (optional) directory with built frontend assets
 */
export function createServer(opts = {}) {
	const {
		dbFile = ":memory:",
		logDir,
		tools,
		defaultCwd,
		configRootDir,
		pty: injectedPty,
		webDist,
		pickDirectory = pickDirectoryNative,
		openNativeTerminal = openNativeTerminalNative,
	} = opts;

	const db = openDb(dbFile);
	const initialConfig = configRootDir
		? loadConfig({ rootDir: configRootDir })
		: null;
	const runtimeConfig = {
		defaultCwd:
			defaultCwd ||
			initialConfig?.defaultCwd ||
			process.env.HOME ||
			process.cwd(),
		tools: tools || resolveToolsConfig(initialConfig?.tools),
		defaultTool: initialConfig?.defaultTool || "claude",
		webhook: initialConfig?.webhook || null,
	};
	const pty =
		injectedPty || new PtyManager({ tools: runtimeConfig.tools || {} });
	// Telegram 自动 topic 钩子：ait 创建在前，wizard 创建在后；用 lazy ref 桥接
	const aiSessionHooks = {
		onSessionSpawned: () => null,
		onSessionEnded: () => null,
	};
	const ait = createAiTerminal({
		db,
		pty,
		logDir,
		getDefaultCwd: () => runtimeConfig.defaultCwd,
		getWebhookConfig: () => runtimeConfig.webhook,
		onSessionSpawned: (info) => aiSessionHooks.onSessionSpawned(info),
		onSessionEnded: (info) => aiSessionHooks.onSessionEnded(info),
	});

	const app = express();
	app.use(express.json({ limit: "2mb" }));

	app.get("/api/status", (_req, res) => {
		res.json({
			ok: true,
			version: loadVersion(),
			activeSessions: ait.sessions.size,
		});
	});

	app.get("/api/config", (_req, res) => {
		try {
			const cfg = loadConfig({ rootDir: configRootDir });
			const { token, source } = readBotTokenWithSource(() => cfg);
			const { botToken: _botToken, ...telegramSafe } = cfg.telegram || {};
			res.json({
				ok: true,
				config: {
					...cfg,
					tools: resolveToolsConfig(cfg.tools),
					telegram: {
						...telegramSafe,
						botTokenMasked: maskBotToken(token),
						botTokenSource: source,
					},
				},
				toolDiagnostics: inspectToolsConfig(cfg.tools),
			});
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message });
		}
	});

	app.put("/api/config", async (req, res) => {
		try {
			const current = loadConfig({ rootDir: configRootDir });
			const nextToolsPatch = req.body?.tools || {};
			const pricingPatch = req.body?.pricing;

			// Telegram token mask 处理
			const telegramPatch = { ...(req.body?.telegram || {}) };
			if ('botToken' in telegramPatch) {
				const tok = telegramPatch.botToken;
				if (isMaskedToken(tok)) {
					// 用户没改 token —— 删除该字段，保留磁盘原值
					delete telegramPatch.botToken;
				} else if (tok === '') {
					// 显式清空
					telegramPatch.botToken = null;
				}
				// 其他字符串：透传作为新值
			}
			// botTokenMasked / botTokenSource 是 GET-only，PUT 收到的不能写回
			delete telegramPatch.botTokenMasked;
			delete telegramPatch.botTokenSource;

			// 合并 telegram 段
			const mergedTelegram = { ...current.telegram, ...telegramPatch };

			// 检测 telegram 段是否变化（用于触发热重启）
			const telegramChanged = JSON.stringify(mergedTelegram) !== JSON.stringify(current.telegram);

			// 不能直接 ...req.body 因为里面可能有原始 telegramPatch（含 mask）—— 排除掉再 spread
			const { telegram: _t, ...bodyWithoutTelegram } = req.body || {};

			const next = {
				...current,
				...bodyWithoutTelegram,
				telegram: mergedTelegram,
				tools: {
					...current.tools,
					claude: mergeToolConfig(current.tools?.claude, nextToolsPatch.claude),
					codex: mergeToolConfig(current.tools?.codex, nextToolsPatch.codex),
				},
				// 深合并 pricing：允许前端只发部分字段（如仅改 cnyRate）而不清空其他。
				// models 字段整体替换，这样 UI 里删除条目才能落到磁盘。
				pricing: pricingPatch
					? {
						cnyRate: pricingPatch.cnyRate ?? current.pricing.cnyRate,
						default: pricingPatch.default ?? current.pricing.default,
						models: pricingPatch.models ?? current.pricing.models,
					}
					: current.pricing,
			};
			saveConfig(next, { rootDir: configRootDir });

			runtimeConfig.defaultCwd = next.defaultCwd || runtimeConfig.defaultCwd;
			runtimeConfig.defaultTool = next.defaultTool || runtimeConfig.defaultTool;
			runtimeConfig.tools = resolveToolsConfig(next.tools);
			runtimeConfig.webhook = next.webhook || runtimeConfig.webhook;
			pty.tools = runtimeConfig.tools;

			// 触发 telegram stack 热重启
			let telegramRestart = { applied: false };
			if (telegramChanged) {
				try {
					await restartTelegramStack();
					telegramRestart = { applied: true };
				} catch (e) {
					telegramRestart = { applied: false, error: e.message };
				}
			}

			// 返回时也走 mask 逻辑（避免 token 泄漏）
			const reloadedCfg = loadConfig({ rootDir: configRootDir });
			const { token, source } = readBotTokenWithSource(() => reloadedCfg);
			const { botToken: _drop, ...telegramSafe } = reloadedCfg.telegram || {};

			res.json({
				ok: true,
				config: {
					...reloadedCfg,
					tools: runtimeConfig.tools,
					telegram: {
						...telegramSafe,
						botTokenMasked: maskBotToken(token),
						botTokenSource: source,
					},
				},
				toolDiagnostics: inspectToolsConfig(next.tools),
				runtimeApplied: {
					defaultCwd: runtimeConfig.defaultCwd,
					defaultTool: runtimeConfig.defaultTool,
				},
				telegramRestart,
			});
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message });
		}
	});

	app.get("/api/config/workdirs", (_req, res) => {
		try {
			const root = runtimeConfig.defaultCwd;
			if (!root || !existsSync(root)) {
				res.status(400).json({ ok: false, error: "default_cwd_not_found" });
				return;
			}
			const entries = readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => {
					const absPath = join(root, entry.name);
					const st = statSync(absPath);
					return {
						label: entry.name,
						value: absPath,
						mtimeMs: st.mtimeMs || 0,
					};
				})
				.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
			res.json({
				ok: true,
				root,
				options: [
					{ label: `${basename(root) || root} (默认目录)`, value: root },
					...entries,
				],
			});
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message });
		}
	});

	const EDITOR_BINS = {
		"trae-cn": "/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn",
		"trae": "/Applications/Trae.app/Contents/Resources/app/bin/trae",
		"cursor": "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
	};

	app.post("/api/system/open-trae", (req, res) => {
		try {
			const cwd = req.body?.cwd || runtimeConfig.defaultCwd;
			if (!cwd || !existsSync(cwd)) {
				res.status(400).json({ ok: false, error: "cwd_not_found" });
				return;
			}
			const editor = req.body?.editor || "trae-cn";
			const bin = EDITOR_BINS[editor];
			if (!bin) {
				res.status(400).json({ ok: false, error: "invalid_editor" });
				return;
			}
			if (!existsSync(bin)) {
				res.status(400).json({ ok: false, error: "editor_not_installed" });
				return;
			}
			// 可选的具体打开目标（文件或目录）；支持 path:line:col 语法
			// 始终把 cwd 作为 workspace folder 传入，再附带具体文件，让编辑器默认打开这个目录
			const args = ["--new-window", cwd];
			const rawPath = req.body?.path;
			const sessionId =
				typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
			const terminalSession = sessionId ? ait.sessions.get(sessionId) : null;
			if (typeof rawPath === "string" && rawPath.trim()) {
				const resolved = resolveEditorTargetInfo(
					[
						terminalSession?.currentCwd,
						terminalSession?.cwd,
						cwd,
						runtimeConfig.defaultCwd,
					],
					rawPath,
				);
				if (!resolved) {
					res.status(400).json({ ok: false, error: "path_not_found" });
					return;
				}
				if (terminalSession && resolved.baseDir) {
					terminalSession.currentCwd = resolved.baseDir;
				}
				// VSCode 系 CLI 支持 --goto file:line:col 精确跳转
				args.push("--goto", resolved.resolvedPath);
			}
			const child = spawn(bin, args, {
				cwd,
				stdio: "ignore",
				detached: true,
			});
			child.on("error", (err) => {
				console.warn(`[open-trae] ${editor} spawn error:`, err.message);
			});
			child.unref();
			res.json({ ok: true });
		} catch (e) {
			console.error("[open-trae]", e);
			res.status(500).json({ ok: false, error: e.message });
		}
	});

	app.post("/api/system/open-terminal", (req, res) => {
		try {
			const cwd = req.body?.cwd || runtimeConfig.defaultCwd;
			if (!cwd || !existsSync(cwd)) {
				res.status(400).json({ ok: false, error: "cwd_not_found" });
				return;
			}
			const sessionId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const shell = process.env.SHELL || "/bin/zsh";
			pty.startShell({ sessionId, shell, cwd });

			const session = {
				sessionId,
				type: "shell",
				status: "running",
				startedAt: Date.now(),
				browsers: new Set(),
				outputHistory: [],
				outputSize: 0,
			};
			ait.sessions.set(sessionId, session);

			const onOutput = ({ sessionId: sid, data }) => {
				if (sid !== sessionId) return;
				session.outputHistory.push(data);
				session.outputSize += data.length;
				while (session.outputSize > 512 * 1024 && session.outputHistory.length > 1) {
					const removed = session.outputHistory.shift();
					session.outputSize -= removed.length;
				}
				const msg = JSON.stringify({ type: "output", data });
				for (const ws of session.browsers) {
					if (ws.readyState === ws.OPEN) ws.send(msg);
				}
			};
			const onDone = ({ sessionId: sid }) => {
				if (sid !== sessionId) return;
				session.status = "done";
				const msg = JSON.stringify({ type: "done", exitCode: 0, status: "done" });
				for (const ws of session.browsers) {
					if (ws.readyState === ws.OPEN) ws.send(msg);
				}
				pty.removeListener("output", onOutput);
				pty.removeListener("done", onDone);
			};
			pty.on("output", onOutput);
			pty.on("done", onDone);

			res.json({ ok: true, sessionId });
		} catch (e) {
			console.error("[open-terminal]", e);
			res.status(500).json({ ok: false, error: e.message });
		}
	});

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
			res.json({
				ok: true,
				cwd: result?.cwd || cwd,
				title: result?.title || title,
				command: result?.command || command,
				action: result?.action || "created",
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

	// 列出 Claude Code 可用 slash 命令，作为 Chat composer 的 / 自动补全来源
	// 扫描：~/.claude/{commands,skills} + <cwd>/.claude/{commands,skills} + 已安装插件的同样目录
	app.get("/api/claude-commands", (req, res) => {
		const extractDescription = (filePath) => {
			try {
				const content = readFileSync(filePath, "utf8")
				const fm = content.match(/^---\n([\s\S]*?)\n---/)
				if (fm) {
					const dm = fm[1].match(/^description:\s*(.+)$/m)
					if (dm) return dm[1].trim().replace(/^['"]|['"]$/g, "")
				}
				const body = fm ? content.slice(fm[0].length) : content
				const firstLine = body.split("\n").map(s => s.trim()).filter(Boolean)[0]
				return firstLine ? firstLine.slice(0, 200) : ""
			} catch { return "" }
		}
		// commands/*.md：name = 文件名
		const readCommandDir = (dir, scope, source) => {
			try {
				if (!existsSync(dir)) return []
				return readdirSync(dir).filter(f => f.endsWith(".md")).map(f => ({
					name: basename(f, ".md"),
					description: extractDescription(join(dir, f)),
					scope, source,
				}))
			} catch { return [] }
		}
		// skills/<name>/SKILL.md：name = 子目录名
		const readSkillDir = (dir, scope, source) => {
			try {
				if (!existsSync(dir)) return []
				return readdirSync(dir, { withFileTypes: true })
					.filter(d => d.isDirectory())
					.map(d => {
						const skillPath = join(dir, d.name, "SKILL.md")
						if (!existsSync(skillPath)) return null
						return {
							name: d.name,
							description: extractDescription(skillPath),
							scope, source,
						}
					})
					.filter(Boolean)
			} catch { return [] }
		}
		try {
			const cwd = typeof req.query.cwd === "string" && req.query.cwd.trim() ? req.query.cwd : null
			const all = []
			const home = homedir()
			// 用户级
			all.push(...readCommandDir(join(home, ".claude", "commands"), "global", "user"))
			all.push(...readSkillDir(join(home, ".claude", "skills"), "global", "user"))
			// 项目级
			if (cwd) {
				all.push(...readCommandDir(join(cwd, ".claude", "commands"), "local", "project"))
				all.push(...readSkillDir(join(cwd, ".claude", "skills"), "local", "project"))
			}
			// 已安装插件
			try {
				const pluginsFile = join(home, ".claude", "plugins", "installed_plugins.json")
				if (existsSync(pluginsFile)) {
					const cfg = JSON.parse(readFileSync(pluginsFile, "utf8"))
					for (const [pluginKey, installs] of Object.entries(cfg.plugins || {})) {
						for (const inst of installs || []) {
							if (!inst?.installPath || !existsSync(inst.installPath)) continue
							all.push(...readCommandDir(join(inst.installPath, "commands"), "global", `plugin:${pluginKey}`))
							all.push(...readSkillDir(join(inst.installPath, "skills"), "global", `plugin:${pluginKey}`))
						}
					}
				}
			} catch { /* ignore */ }
			// 同名优先级：local > user > plugin（local 最后进也会覆盖前面）
			const byName = new Map()
			const priority = (source) => source === "project" ? 3 : source === "user" ? 2 : 1
			for (const c of all) {
				const existing = byName.get(c.name)
				if (!existing || priority(c.source) >= priority(existing.source)) byName.set(c.name, c)
			}
			const commands = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
			res.json({ ok: true, commands })
		} catch (e) {
			res.status(500).json({ ok: false, error: e.message })
		}
	});

	app.post("/api/system/pick-directory", async (req, res) => {
		try {
			const result = await pickDirectory({
				defaultPath: req.body?.defaultPath || runtimeConfig.defaultCwd,
				prompt: req.body?.prompt || "选择目录",
			});
			res.json({
				ok: true,
				path: result?.path || null,
				cancelled: Boolean(result?.cancelled),
			});
		} catch (e) {
			const status = e?.code === "directory_picker_unsupported" ? 400 : 500;
			res.status(status).json({ ok: false, error: e.message });
		}
	});

	// 图片粘贴/拖拽上传：单独提一个 JSON body limit（30MB）覆盖全局 2MB 限制
	app.use("/api/uploads", express.json({ limit: "30mb" }), createUploadsRouter({ logger: console }))

	app.use("/api/todos", createTodosRouter({
		db,
		logDir,
		getPricing: () => loadConfig({ rootDir: configRootDir }).pricing,
		getTools: () => runtimeConfig.tools,
		getLiveSession: (sessionId) => ait.sessions.get(sessionId) || null,
		getPty: () => pty,
	}));
	app.use("/api/templates", createTemplatesRouter({ db }));
	app.use("/api/recurring-rules", createRecurringRulesRouter({ db }));
	app.use("/api/ai-terminal", ait.router);

	const transcriptsService = createTranscriptsService({
		db,
		listTodos: () => db.listTodos(),
		updateTodo: (id, patch) => db.updateTodo(id, patch),
	});
	app.use("/api/transcripts", createTranscriptsRouter({ service: transcriptsService }));
	app.use("/api/stats", createStatsRouter({
		db,
		getPricing: () => loadConfig({ rootDir: configRootDir }).pricing,
	}));
	app.use("/api/reports", createReportsRouter({ db }));
	// Multi-agent pipeline orchestrator
	const orchestrator = createOrchestrator({ db, pty, aiTerminal: ait, logDir });
	app.use("/api/pipelines", createPipelinesRouter({ db, orchestrator }));

	const wikiConfig = (initialConfig && initialConfig.wiki) || {
		wikiDir: join(process.env.HOME || process.cwd(), ".quadtodo", "wiki"),
		maxTailTurns: 20,
		tool: "claude",
		timeoutMs: 600_000,
		redact: true,
	};
	const wikiService = createWikiService({
		db,
		logDir,
		wikiDir: wikiConfig.wikiDir,
		getTools: () => runtimeConfig.tools || {},
		maxTailTurns: wikiConfig.maxTailTurns ?? 20,
		timeoutMs: wikiConfig.timeoutMs ?? 600_000,
		redactEnabled: wikiConfig.redact !== false,
	});
	app.use("/api/wiki", createWikiRouter({ service: wikiService }));

	// 全局搜索：给 ⌘K 面板和 MCP 共用
	const searchService = createSearchService({ db, wikiDir: wikiConfig.wikiDir });
	try {
		const initResult = searchService.init();
		if (initResult?.rebuilt?.length) {
			console.log(`[search] fts ready, rebuilt: ${initResult.rebuilt.join(", ")}`);
		}
	} catch (e) {
		console.warn(`[search] fts init failed:`, e.message);
	}
	app.use("/api/search", createSearchRouter({ searchService }));

	// OpenClaw 双向桥接：bridge（出站）+ pending-question 协调器（双向阻塞）
	const openclawBridge = createOpenClawBridge({
		getConfig: () => loadConfig({ rootDir: configRootDir }),
	});
	const pendingCoord = createPendingQuestionCoordinator({ db });
	pendingCoord.start();

	// ─── Telegram stack（可热重启）─────────────────────────────────
	// holder 模式：所有依赖方持有 holder.current 而非裸引用，重启时只换 .current
	const telegramBotHolder = { current: null }
	const loadingTrackerHolder = { current: null }
	const probeRegistry = createProbeRegistry()

	// wizard lazy ref 必须先声明，因为 createTelegramBot 需要它
	const openclawWizardLazyRef = {
		handleInbound: () => Promise.resolve({ reply: 'wizard not ready' }),
		handleCallback: () => Promise.resolve({ toast: 'wizard not ready', action: 'invalid' }),
		handleTopicEvent: () => Promise.resolve({ ok: false, reason: 'wizard not ready' }),
	};

	function startTelegramStack() {
		const cfg = loadConfig({ rootDir: configRootDir })
		const tg = cfg.telegram || {}
		if (!tg.enabled) {
			console.log('[telegram] disabled, skipping bot start')
			return
		}
		const bot = createTelegramBot({
			getConfig: () => loadConfig({ rootDir: configRootDir }),
			wizard: {
				handleInbound: (...args) => openclawWizardLazyRef.handleInbound(...args),
				handleCallback: (...args) => openclawWizardLazyRef.handleCallback(...args),
				handleTopicEvent: (...args) => openclawWizardLazyRef.handleTopicEvent(...args),
			},
			logger: { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a) },
		})
		telegramBotHolder.current = bot
		loadingTrackerHolder.current = createLoadingTracker({
			telegramBot: bot,
			openclaw: openclawBridge,
			logger: console,
			getConfig: () => loadConfig({ rootDir: configRootDir }),
		})
		openclawBridge.setTelegramBot(bot)
		bot.start()
		console.log(`[telegram] bot started; supergroup=${tg.supergroupId || '(unset)'} allowedChatIds=${(tg.allowedChatIds||[]).join(',')||'(empty—reject all)'}`)

		// 注册 Claude Code slash 命令到 supergroup（per-chat scope，不影响 bot 在别处的菜单）
		// idempotent；失败不阻塞 boot（log warn 后继续）
		const supergroupId = tg.defaultSupergroupId
			|| (Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds[0] : null)
		if (supergroupId) {
			try {
				const { commands, skipped } = buildTelegramCommands({ projectRoot: configRootDir, logger: console })
				bot.setMyCommands({ commands, scope: 'chat', chatId: supergroupId })
					.then(() => console.log(`[telegram] registered ${commands.length} slash command(s) for supergroup ${supergroupId}${skipped.length ? ` (skipped ${skipped.length})` : ''}`))
					.catch((e) => console.warn(`[telegram] setMyCommands failed: ${e.message}`))
			} catch (e) {
				console.warn(`[telegram] build commands failed: ${e.message}`)
			}
		}
	}

	async function stopTelegramStack() {
		const bot = telegramBotHolder.current
		if (!bot) return
		try { await bot.stop?.() } catch (e) { console.warn(`[telegram] stop failed: ${e.message}`) }
		telegramBotHolder.current = null
		loadingTrackerHolder.current = null
		try { openclawBridge.setTelegramBot(null) } catch { /* ignore */ }
		console.log('[telegram] bot stopped')
	}

	async function restartTelegramStack() {
		await stopTelegramStack()
		startTelegramStack()
	}

	// PTY 事件：永远走 holder.current，所以重启 bot 后还能跑
	pty.on('native-session', ({ sessionId }) => {
		loadingTrackerHolder.current?.start({ sessionId })
			.catch((e) => console.warn(`[loading-status] start failed: ${e.message}`))
	})
	pty.on('done', ({ sessionId, exitCode, stopped }) => {
		const finalStatus = stopped ? 'stopped' : (exitCode === 0 ? 'done' : 'failed')
		loadingTrackerHolder.current?.stop({ sessionId, finalStatus })
			.catch((e) => console.warn(`[loading-status] stop failed: ${e.message}`))
	})

	// holder Proxy: 让 hook / wizard 不用改源码，每次读属性都从 holder.current 拿最新实例
	function unwrapHolder(holder, kind = 'instance') {
		return new Proxy({}, {
			get(_t, prop) {
				const inst = holder.current
				if (!inst) {
					// 当 bot 未启动时，常用方法返回安全的 reject，其他属性返回 undefined
					const asyncMethods = new Set([
						'sendMessage', 'sendDocument', 'editMessageText', 'editMessageReplyMarkup',
						'answerCallbackQuery',
						'createForumTopic', 'closeForumTopic', 'reopenForumTopic', 'editForumTopic',
						'setMessageReaction', 'setMyCommands', 'deleteMyCommands', 'getMe',
					])
					if (asyncMethods.has(prop)) {
						return async () => { throw new Error(`${kind}_not_running`) }
					}
					return undefined
				}
				const v = inst[prop]
				if (typeof v === 'function') return v.bind(inst)
				return v
			},
			has(_t, prop) {
				const inst = holder.current
				return inst ? (prop in inst) : false
			},
		})
	}

	const telegramBotProxy = unwrapHolder(telegramBotHolder, 'telegram_bot')
	const loadingTrackerProxy = unwrapHolder(loadingTrackerHolder, 'loading_tracker')

	const openclawHookHandler = createOpenClawHookHandler({
		db,
		openclaw: openclawBridge,
		aiTerminal: ait,
		pty,
		telegramBot: telegramBotProxy,
		loadingTracker: loadingTrackerProxy,                  // Stop hook → 标题切 💤
		getConfig: () => loadConfig({ rootDir: configRootDir }),
	});
	app.use("/api/openclaw/hook", createOpenClawHookRouter({ hookHandler: openclawHookHandler }));

	// OpenClaw wizard 状态机：peer 维度的多轮向导，OpenClaw 是消息转发器
	const openclawWizard = createOpenClawWizard({
		db,
		aiTerminal: ait,
		openclaw: openclawBridge,
		pending: pendingCoord,
		pty,
		telegramBot: telegramBotProxy,
		loadingTracker: loadingTrackerProxy,                  // wizard stdin proxy → 标题切回 🔄
		getConfig: () => loadConfig({ rootDir: configRootDir }),
	});
	openclawWizardLazyRef.handleInbound = (...args) => openclawWizard.handleInbound(...args);
	openclawWizardLazyRef.handleCallback = (...args) => openclawWizard.handleCallback(...args);
	openclawWizardLazyRef.handleTopicEvent = (...args) => openclawWizard.handleTopicEvent(...args);
	app.use("/api/openclaw/inbound", createOpenClawInboundRouter({ wizard: openclawWizard }));

	app.use("/api/config/telegram", createTelegramConfigRouter({
		getConfig: () => loadConfig({ rootDir: configRootDir }),
		getTelegramBot: () => telegramBotHolder.current,
		probeRegistry,
	}))

	// 首次启动 telegram stack（按当前 config）
	startTelegramStack()

	// 懒检测：bridge 推送时 topic 已被删 / thread 失效 → 走关闭流程（mark done + 杀 PTY）
	openclawBridge.setTopicGoneHandler?.(({ chatId, threadId }) => {
		openclawWizard.handleTopicEvent({ type: 'closed', chatId, threadId })
			.catch((e) => console.warn(`[server] topic_gone handler failed: ${e.message}`))
	})

	// ─── Telegram 自动 topic 镜像（B 方案）─────────────────────────
	// 默认开；config.telegram.autoCreateTopic = false 可关
	const telegramConfig = (initialConfig?.telegram) || {}
	const autoCreateEnabled = telegramConfig.enabled && telegramConfig.autoCreateTopic !== false
	aiSessionHooks.onSessionSpawned = ({ sessionId, todoId }) => {
		if (!autoCreateEnabled) return null
		return openclawWizard.ensureTopicForSession({ sessionId, todoId })
			.catch((e) => console.warn(`[server] ensureTopicForSession failed: ${e.message}`))
	}
	aiSessionHooks.onSessionEnded = ({ sessionId, exitCode, startedAt, completedAt }) => {
		// 安全门槛：只对干净退出 (exitCode=0) 且寿命 ≥ 30s 的走自动关 topic。
		// 早夭 / 非零退出多半是 recovery 抽风、jsonl 失效、网络断 —— 不该改 todo 状态。
		const lifetimeMs = (completedAt || Date.now()) - (startedAt || 0)
		const cleanExit = exitCode === 0 && lifetimeMs >= 30_000
		if (!cleanExit) {
			console.log(`[server] skip auto-close: sid=${sessionId} exit=${exitCode} lifetime=${lifetimeMs}ms`)
			return null
		}
		const route = openclawBridge.resolveRoute?.(sessionId)
		if (!route?.threadId) return null
		return openclawWizard.handleTopicEvent({
			type: 'closed',
			chatId: route.targetUserId,
			threadId: route.threadId,
		}).catch((e) => console.warn(`[server] auto-close topic failed: ${e.message}`))
	}

	// 启动期 sweep：恢复后的 running PTY session 若没绑 topic（手动 web/CLI 起的）→ 补建
	if (autoCreateEnabled) {
		let swept = 0
		for (const [sid, sess] of ait.sessions) {
			if (sess.status !== 'running' && sess.status !== 'pending_confirm') continue
			const r = openclawBridge.resolveRoute?.(sid)
			if (r?.threadId) continue   // 已经有
			openclawWizard.ensureTopicForSession({ sessionId: sid, todoId: sess.todoId })
				.then((res) => res?.action === 'created' && console.log(`[server] sweep auto-bound ${sid} → thread ${res.threadId}`))
				.catch((e) => console.warn(`[server] sweep ensureTopic failed for ${sid}: ${e.message}`))
			swept++
		}
		if (swept > 0) console.log(`[server] sweep: queued ${swept} session(s) for auto-bind`)
	}

	// ─── 重启后路由 rehydration ───────────────────────────────────
	// 复活的 PTY session 用 NEW sessionId，但 DB 里 aiSessions[i].telegramRoute
	// 保留了 (chatId, threadId, topicName)。把它们重新注入 openclaw-bridge，让
	// 重启后旧 topic 的对话能继续路由到正确 PTY。
	{
		let rehydrated = 0
		for (const [sid, sess] of ait.sessions) {
			try {
				const todo = db.getTodo(sess.todoId)
				if (!todo) continue
				const aiSess = (todo.aiSessions || []).find((s) => s.sessionId === sid)
				if (aiSess?.telegramRoute) {
					openclawBridge.registerSessionRoute(sid, aiSess.telegramRoute)
					rehydrated++
				}
			} catch (e) {
				console.warn(`[server] rehydrate route failed for ${sid}: ${e.message}`)
			}
		}
		if (rehydrated > 0) console.log(`[server] rehydrated ${rehydrated} telegram session route(s)`)

		// rehydration 之后注册 tracker（仅记录 in-memory state，不调 telegram API）：
		// 这样后续 PTY done 事件能改成终态 ✅/❌/⏹。boot 时不改 🔄（topic 上一轮可能已经是终态）。
		// holder.current 可能为 null（telegram disabled 或 token 缺失） → 跳过 kick。
		const tracker = loadingTrackerHolder.current
		if (tracker) {
			let kicked = 0
			for (const [sid, sess] of ait.sessions) {
				if (sess.status !== 'running' && sess.status !== 'pending_confirm') continue
				const r = openclawBridge.resolveRoute?.(sid)
				if (!r?.threadId) continue
				if (tracker.has(sid)) continue
				tracker.start({ sessionId: sid, skipTitleRename: true })
					.catch((e) => console.warn(`[loading-status] rehydrate-kick failed sid=${sid}: ${e.message}`))
				kicked++
			}
			if (kicked > 0) console.log(`[server] loading-status: registered ${kicked} resumed session(s) (skip-rename)`)
		}
	}

	// 同步对账路由
	app.use("/api/telegram-sync", createTelegramSyncRouter({
		db, aiTerminal: ait, openclaw: openclawBridge, wizard: openclawWizard,
	}).router);

	// MCP Streamable HTTP 端点：把 quadtodo 暴露给 Claude Code 等 MCP 客户端
	try {
		const mcp = createMcpRouter({
			db,
			searchService,
			wikiDir: wikiConfig.wikiDir,
			rootDir: configRootDir,
			logDir,
			getVersion: loadVersion,
			aiTerminal: ait,
			openclaw: openclawBridge,
			pending: pendingCoord,
			getConfig: () => loadConfig({ rootDir: configRootDir }),
		});
		app.use("/mcp", mcp.router);
	} catch (e) {
		console.warn("[mcp] init failed:", e.message);
	}

	// kick off wiki init in background (non-blocking)
	Promise.resolve()
		.then(() => wikiService.init())
		.then((r) => console.log(`[wiki] init state=${r.state} dir=${r.wikiDir}`))
		.catch((e) => console.warn(`[wiki] init failed:`, e.message));

	// sweep orphan wiki_runs left over from prior crashes
	try {
		const swept = wikiService.markOrphansAsFailed();
		if (swept > 0) console.log(`[wiki] marked ${swept} orphan run(s) as failed`);
	} catch (e) {
		console.warn(`[wiki] orphan sweep failed:`, e.message);
	}

	// async startup scan (non-blocking)
	Promise.resolve().then(() => transcriptsService.scanFull())
		.then(r => console.log(`[transcripts] full scan done newFiles=${r.newFiles} indexed=${r.indexed} autoBound=${r.autoBound} unbound=${r.unbound}`))
		.catch(e => {
			if (!/database connection is not open/i.test(e?.message || '')) {
				console.warn(`[transcripts] full scan failed:`, e.message);
			}
		});

	// ─── static frontend ───
	if (webDist && existsSync(webDist)) {
		app.use(express.static(webDist));
		// SPA fallback: non-API GET falls through to index.html
		app.get(/^\/(?!api|ws).*/, (_req, res) => {
			res.sendFile(join(webDist, "index.html"));
		});
	}

	const httpServer = createHttpServer(app);
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "", "http://127.0.0.1");
		if (url.pathname.startsWith("/ws/terminal/")) {
			const sessionId = url.pathname.replace("/ws/terminal/", "");
			wss.handleUpgrade(req, socket, head, (ws) =>
				handleBrowserWs(ws, sessionId),
			);
		} else {
			socket.destroy();
		}
	});

	const HEARTBEAT_MS = 15_000;

	function handleBrowserWs(ws, sessionId) {
		ait.addBrowser(sessionId, ws);

		ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (msg.type === "ping") {
					if (ws.readyState === ws.OPEN)
						ws.send(JSON.stringify({ type: "pong" }));
					return;
				}
				if (msg.type === "pong") return;
				ait.handleBrowserMessage(sessionId, msg, ws);
			} catch {
				/* ignore */
			}
		});

		const pingTimer = setInterval(() => {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify({ type: "ping" }));
			} else {
				clearInterval(pingTimer);
			}
		}, HEARTBEAT_MS);

		ws.on("close", () => {
			clearInterval(pingTimer);
			ait.removeBrowser(sessionId, ws);
		});
	}

	function listen(port, host = "127.0.0.1") {
		return new Promise((resolve, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(port, host, () => {
				httpServer.removeListener("error", reject);
				resolve(httpServer.address());
			});
		});
	}

	function close() {
		return new Promise((resolve) => {
			try { pendingCoord.stop() } catch { /* ignore */ }
			try { telegramBotHolder.current?.stop?.() } catch { /* ignore */ }
			ait.close();
			wss.close(() => {
				httpServer.close(() => {
					try {
						db.close();
					} catch {
						/* ignore */
					}
					resolve();
				});
			});
		});
	}

	/**
	 * 启动后给 telegram 推一条"重启完成 + Resume 了哪些 session"的通知，
	 * 解决用户痛点：重启后之前的 PTY 全死了换新 sid，但用户不知道，
	 * 等下次 stdin proxy 走到 ambiguous 提示才发现"咦我之前的会话呢？"。
	 *
	 * 触发条件（缺一不可）：
	 *   - telegram bridge 已启用（token + enabled）
	 *   - 至少 resume 了 1 个 session（0 个不打扰，避免空通知）
	 *   - config.telegram.startupNotice !== false（默认开，有需要可关）
	 *
	 * 推送目标：postText 缺省 target → openclaw.targetUserId（supergroup 的话即 General）
	 */
	async function notifyStartupRecovery() {
		if (!openclawBridge.isEnabled()) return
		const cfg = loadConfig({ rootDir: configRootDir })
		if (cfg?.telegram?.startupNotice === false) return

		const active = []
		for (const [sid, sess] of ait.sessions) {
			if (sess?.status === 'running' || sess?.status === 'pending_confirm') {
				active.push({ sid, lastOutputAt: sess.lastOutputAt || sess.startedAt || 0 })
			}
		}
		if (active.length === 0) return

		// 反查 todo title
		let todos = []
		try { todos = db.listTodos({ status: 'todo' }) || [] } catch { todos = [] }
		const sidToTodo = new Map()
		for (const t of todos) {
			const sessions = t.aiSessions || (t.aiSession ? [t.aiSession] : [])
			for (const s of sessions) {
				if (s?.sessionId) sidToTodo.set(s.sessionId, t)
			}
		}

		active.sort((a, b) => b.lastOutputAt - a.lastOutputAt)
		const lines = active.slice(0, 10).map((a) => {
			const t = sidToTodo.get(a.sid)
			const rawTitle = t?.title || '(未命名)'
			const title = rawTitle.length > 32 ? rawTitle.slice(0, 32) + '…' : rawTitle
			return `• #${a.sid.slice(-4)} · ${title}`
		})
		const more = active.length > 10 ? `\n…还有 ${active.length - 10} 个` : ''
		const message = [
			'🔄 quadtodo 重启完成（之前的 PTY 都被换了新身体）',
			`Resume 了 ${active.length} 个会话：`,
			...lines,
		].join('\n') + more + '\n\n可用 /list 看详情，或直接发消息（多 session 时会让你点按钮选）。'

		try {
			const r = await openclawBridge.postText({ message })
			if (!r?.ok) {
				console.warn(`[server] startup notice not delivered: ${r?.reason || 'unknown'}`)
			}
		} catch (e) {
			console.warn(`[server] startup notice failed: ${e?.message}`)
		}
	}

	return { app, httpServer, wss, db, pty, ait, listen, close, openclawBridge, pendingCoord, notifyStartupRecovery };
}

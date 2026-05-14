import { execSync } from "node:child_process";
import { DEFAULT_PRICING } from "./pricing.js";
import {
	accessSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";

function canUseRootDir(rootDir) {
	try {
		if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
		accessSync(rootDir, constants.R_OK | constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// Auto-run legacy → ~/.agentquad migration once per process at import time.
// Must happen BEFORE DEFAULT_ROOT_DIR is computed, because canUseRootDir() has
// a mkdirSync side effect that would short-circuit the migration's
// existsSync(newDir) guard. Skipped in tests and when callers manage rootDir
// themselves via env vars.
if (
	!process.env.AGENTQUAD_SKIP_AUTO_MIGRATE &&
	!process.env.AGENTQUAD_ROOT_DIR &&
	!process.env.QUADTODO_ROOT_DIR &&
	!process.env.VITEST &&
	process.env.NODE_ENV !== "test"
) {
	const _migration = migrateLegacyHomeDirIfNeeded();
	if (_migration.action === "abort") process.exit(1);
}

function resolveDefaultRootDir() {
	const envRootDir = process.env.AGENTQUAD_ROOT_DIR || process.env.QUADTODO_ROOT_DIR;
	if (envRootDir) return resolvePath(envRootDir);

	const newHomeDir = join(homedir(), ".agentquad");
	if (canUseRootDir(newHomeDir)) return newHomeDir;

	const legacyHomeDir = join(homedir(), ".quadtodo");
	if (existsSync(legacyHomeDir) && canUseRootDir(legacyHomeDir)) return legacyHomeDir;

	const newCwdDir = resolvePath(process.cwd(), ".agentquad");
	if (canUseRootDir(newCwdDir)) return newCwdDir;

	return resolvePath(process.cwd(), ".quadtodo");
}

export const DEFAULT_ROOT_DIR = resolveDefaultRootDir();

const TOOL_INSTALL_HINTS = {
	claude: "npm install -g @anthropic-ai/claude-code",
	codex: "npm install -g @openai/codex",
	cursor: "curl https://cursor.com/install -fsSL | bash",
};

export const SUPPORTED_TOOLS = ["claude", "codex", "cursor"];

const PERMISSION_MODES = new Set(["default", "acceptEdits", "bypass"]);

function normalizePermissionMode(value, fallback = "bypass") {
	return PERMISSION_MODES.has(value) ? value : fallback;
}

const DEFAULT_WEBHOOK_CONFIG = {
	enabled: false,
	provider: "wecom",
	url: "",
	keywords: [],
	cooldownMs: 180000,
	notifyOnPendingConfirm: true,
	notifyOnKeywordMatch: true,
};

const DEFAULT_OPENCLAW_CONFIG = {
	enabled: false,
	gatewayUrl: "http://127.0.0.1:18789",
	channel: "openclaw-weixin",
	// 微信 peer id 兜底；正常情况下每个 ai-session 启动时 OpenClaw skill 会
	// 显式传 routeUserId（per-session 路由），这里仅在 ad-hoc 调用时用。
	targetUserId: "",
	askUser: {
		defaultTimeoutMs: 600_000,
		maxConcurrent: 8,
		// 出站消息每分钟上限，防风控
		rateLimitPerMin: 6,
	},
};

const DEFAULT_TELEGRAM_CONFIG = {
	enabled: false,
	supergroupId: "",
	longPollTimeoutSec: 30,
	useTopics: true,
	createTopicOnTaskStart: true,
	closeTopicOnSessionEnd: true,
	topicNameTemplate: "#t{shortCode} {title}",
	topicNameDoneTemplate: "✅ {originalName}",
	allowedChatIds: [],     // 空 = 拒所有，强制白名单
	allowedFromUserIds: [],
	defaultPermissionMode: "bypass",
	notificationCooldownMs: 600_000,    // 同 session 内 ⚠️ idle 提醒最小间隔（默认 10 分钟，0 = 关闭去重）
	suppressNotificationEvents: true,   // 默认丢弃 Claude Code 的 idle Notification（无信息量；设 false 可恢复旧 cooldown 行为）
	autoCreateTopic: true,              // 非 wizard 起的 PTY session 自动镜像到 Telegram topic
	pollRetryDelayMs: 5000,
	minRenameIntervalMs: 30_000,
	reactionEnabled: true,              // 在用户触发消息上加 ✍ reaction 表示 AI 在干活；Stop hook 时清掉
	reactionRunningEmoji: '✍',          // 用哪个 Telegram 标准 emoji；群里若限制了 Available Reactions，改成允许列表里的（譬如 👀 / 🤔）
};

const DEFAULT_LARK_CONFIG = {
	enabled: false,
	appId: "",
	appSecret: "",
	chatId: "",
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	autoCreateTopic: true,
	defaultPermissionMode: "bypass",
	notificationCooldownMs: 600_000,
};

function detectBinary(name) {
	try {
		const result = execSync(`command -v ${name}`, {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		});
		return result.trim() || name;
	} catch {
		return name;
	}
}

function splitCommandLine(input = "") {
	const tokens = [];
	let current = "";
	let quote = null;
	let escaping = false;

	for (const ch of String(input)) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (escaping) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function defaultToolCommand(name) {
	if (name === "claude") return "claude-w";
	if (name === "cursor") return "cursor-agent";
	return name;
}

function normalizeToolConfig(name, tool = {}, { applyDefaultCommand = true } = {}) {
	const rawCommand =
		typeof tool?.command === "string" ? tool.command.trim() : "";
	const parsedTokens = splitCommandLine(rawCommand);
	const parsedCommand = parsedTokens[0] || "";
	const explicitArgs = Array.isArray(tool?.args)
		? tool.args.map((item) => String(item))
		: [];

	return {
		...tool,
		command:
			parsedCommand ||
			(applyDefaultCommand ? defaultToolCommand(name) : ""),
		args: [...parsedTokens.slice(1), ...explicitArgs],
		bin:
			typeof tool?.bin === "string"
				? tool.bin.trim()
				: (tool?.bin ?? null),
	};
}

function runtimeBinOverride(name) {
	return process.env[`${name.toUpperCase()}_BIN`] || null;
}

function isStaleLegacyBin(name, configuredCommand, configuredBin, detectedBin) {
	if (!configuredCommand || !configuredBin) return false;
	if (configuredBin === detectedBin) return false;
	return basename(configuredBin) === name;
}

function getToolMetadata(name, tools = {}) {
	const normalizedTool = normalizeToolConfig(name, tools?.[name], {
		applyDefaultCommand: false,
	});
	const envBin = runtimeBinOverride(name);
	const configuredCommand = normalizedTool.command || "";
	const configuredBin = normalizedTool.bin || null;
	const effectiveCommand = configuredCommand || defaultToolCommand(name);
	const detectedBin = detectBinary(effectiveCommand);
	const staleLegacyBin = isStaleLegacyBin(
		name,
		configuredCommand,
		configuredBin,
		detectedBin,
	);
	const source = envBin
		? "env"
		: configuredBin
			? "config"
			: configuredCommand
				? "config"
				: detectedBin !== effectiveCommand
					? "auto-detected"
					: "missing";

	return {
		name,
		configuredCommand: configuredCommand || null,
		effectiveCommand,
		configuredBin,
		effectiveBin:
			envBin || (staleLegacyBin ? detectedBin : configuredBin) || detectedBin,
		args: normalizedTool.args,
		source,
		installHint: TOOL_INSTALL_HINTS[name] || null,
		missing: source === "missing",
	};
}

export function resolveToolsConfig(tools = {}) {
	const out = {};
	for (const name of SUPPORTED_TOOLS) {
		const normalized = normalizeToolConfig(name, tools[name]);
		const meta = getToolMetadata(name, { ...tools, [name]: normalized });
		out[name] = {
			...normalized,
			command: meta.effectiveCommand,
			bin: meta.effectiveBin,
			args: meta.args,
		};
	}
	return out;
}

export function inspectToolsConfig(tools = {}) {
	const resolved = resolveToolsConfig(tools);
	const out = {};
	for (const name of SUPPORTED_TOOLS) {
		out[name] = {
			...getToolMetadata(name, tools),
			command: resolved[name].command,
			bin: resolved[name].bin,
		};
	}
	return out;
}

function cloneDefaultPricing() {
	return {
		default: { ...DEFAULT_PRICING.default },
		models: Object.fromEntries(
			Object.entries(DEFAULT_PRICING.models).map(([k, v]) => [k, { ...v }]),
		),
		cnyRate: DEFAULT_PRICING.cnyRate,
		// 是否在 Telegram / 飞书推送末尾附 token + 费用 footer。默认关，需要在 Settings 抽屉打开。
		showInPush: false,
		// footer 显示时是否同时带 ¥（CNY），仅在 showInPush=true 时有意义。
		showCnyInPush: true,
	};
}

function defaultConfig() {
	return {
		port: 5677,
		// 监听地址。默认只绑定回环接口（本机安全）。
		// 要让同网段其他设备（含 Tailscale 虚拟网段 100.x.x.x）访问，可设为 "0.0.0.0"。
		// CLI 上也可以用 `agentquad start --expose` / `--host 0.0.0.0` 临时覆盖。
		host: "127.0.0.1",
		defaultTool: "claude",
		defaultCwd: homedir(),
		defaultPermissionMode: "default",
		tools: resolveToolsConfig(),
		webhook: { ...DEFAULT_WEBHOOK_CONFIG },
		openclaw: {
			...DEFAULT_OPENCLAW_CONFIG,
			askUser: { ...DEFAULT_OPENCLAW_CONFIG.askUser },
		},
		telegram: {
			...DEFAULT_TELEGRAM_CONFIG,
			allowedChatIds: [...DEFAULT_TELEGRAM_CONFIG.allowedChatIds],
			allowedFromUserIds: [...DEFAULT_TELEGRAM_CONFIG.allowedFromUserIds],
		},
		lark: { ...DEFAULT_LARK_CONFIG },
		// Clone DEFAULT_PRICING so user mutations (e.g. via setConfigValue) don't
		// leak back into the module-level constant.
		pricing: cloneDefaultPricing(),
		stats: { idleThresholdMs: 120_000 },
		wiki: {
			wikiDir: join(homedir(), ".agentquad", "wiki"),
			maxTailTurns: 20,
			tool: "claude",
			timeoutMs: 600_000,
			redact: true,
		},
};
}

function normalizeDispatch(d = {}) {
	const channels = ['lark', 'telegram', 'web'];
	const out = {};
	for (const ch of channels) {
		const src = (d && typeof d[ch] === 'object' && d[ch] !== null) ? d[ch] : {};
		out[ch] = { default: 'claude', ...src };
	}
	return out;
}

export function normalizeConfig(cfg = {}) {
	const defaults = defaultConfig();
	const mergedTools = {
		...defaults.tools,
		...(cfg.tools || {}),
	};
	const finalTools = {};
	for (const name of SUPPORTED_TOOLS) {
		mergedTools[name] = {
			...defaults.tools[name],
			...(cfg.tools?.[name] || {}),
		};
		finalTools[name] = normalizeToolConfig(name, mergedTools[name]);
	}
	return {
		...defaults,
		...cfg,
		defaultPermissionMode: normalizePermissionMode(cfg.defaultPermissionMode, "default"),
		tools: {
			...mergedTools,
			...finalTools,
		},
		webhook: {
			...DEFAULT_WEBHOOK_CONFIG,
			...(cfg.webhook || {}),
			keywords: Array.isArray(cfg.webhook?.keywords)
				? cfg.webhook.keywords
						.map((item) => String(item).trim())
						.filter(Boolean)
				: [...DEFAULT_WEBHOOK_CONFIG.keywords],
		},
		openclaw: {
			...DEFAULT_OPENCLAW_CONFIG,
			...(cfg.openclaw || {}),
			askUser: {
				...DEFAULT_OPENCLAW_CONFIG.askUser,
				...(cfg.openclaw?.askUser || {}),
			},
		},
		telegram: {
			...DEFAULT_TELEGRAM_CONFIG,
			...(cfg.telegram || {}),
			allowedChatIds: Array.isArray(cfg.telegram?.allowedChatIds)
				? cfg.telegram.allowedChatIds.map((x) => String(x).trim()).filter(Boolean)
				: [...DEFAULT_TELEGRAM_CONFIG.allowedChatIds],
			allowedFromUserIds: Array.isArray(cfg.telegram?.allowedFromUserIds)
				? cfg.telegram.allowedFromUserIds.map((x) => String(x).trim()).filter(Boolean)
				: [...DEFAULT_TELEGRAM_CONFIG.allowedFromUserIds],
			defaultPermissionMode: normalizePermissionMode(cfg.telegram?.defaultPermissionMode),
		},
		lark: {
			...DEFAULT_LARK_CONFIG,
			...(cfg.lark || {}),
			appId: typeof cfg.lark?.appId === "string"
				? cfg.lark.appId.trim()
				: DEFAULT_LARK_CONFIG.appId,
			appSecret: typeof cfg.lark?.appSecret === "string"
				? cfg.lark.appSecret.trim()
				: DEFAULT_LARK_CONFIG.appSecret,
			chatId: typeof cfg.lark?.chatId === "string"
				? cfg.lark.chatId.trim()
				: DEFAULT_LARK_CONFIG.chatId,
			defaultPermissionMode: normalizePermissionMode(cfg.lark?.defaultPermissionMode),
		},
		// Note on models merge precedence: user entries with the SAME key as a
		// default (e.g. 'claude-opus-4-*') override the default. To override
		// pricing for a default-model pattern, the user must re-use the exact
		// same glob key — adding a differently shaped glob will coexist with the
		// default, and which one wins at estimateCost time depends on iteration
		// order.
		pricing: {
			...defaults.pricing,
			...(cfg.pricing || {}),
			models: { ...defaults.pricing.models, ...(cfg.pricing?.models || {}) },
		},
		stats: { ...defaults.stats, ...(cfg.stats || {}) },
		wiki: {
			...defaults.wiki,
			...(cfg.wiki || {}),
		},
		dispatch: normalizeDispatch(cfg.dispatch),
	};
}

function ensureRoot(rootDir) {
	if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
	const logsDir = join(rootDir, "logs");
	if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
}

function backupCorruptConfig(file) {
	const backup = file + ".corrupt";
	try {
		renameSync(file, backup);
		return;
	} catch {
		// Some environments disallow rename on managed files; fall back to copying.
	}

	try {
		writeFileSync(backup, readFileSync(file, "utf8"));
	} catch {
		// Ignore backup failures and continue with a fresh default config.
	}
}

function tryWriteConfig(file, cfg) {
	try {
		writeFileSync(file, JSON.stringify(cfg, null, 2));
		return true;
	} catch {
		return false;
	}
}

export function loadConfig({ rootDir = DEFAULT_ROOT_DIR } = {}) {
	ensureRoot(rootDir);
	const file = join(rootDir, "config.json");
	if (!existsSync(file)) {
		const cfg = normalizeConfig();
		tryWriteConfig(file, cfg);
		return cfg;
	}
	try {
		const cfg = normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
		tryWriteConfig(file, cfg);
		return cfg;
	} catch {
		backupCorruptConfig(file);
		const cfg = normalizeConfig();
		tryWriteConfig(file, cfg);
		return cfg;
	}
}

export function saveConfig(cfg, { rootDir = DEFAULT_ROOT_DIR } = {}) {
	ensureRoot(rootDir);
	writeFileSync(
		join(rootDir, "config.json"),
		JSON.stringify(normalizeConfig(cfg), null, 2),
	);
}

export function getConfigValue(path, { rootDir = DEFAULT_ROOT_DIR } = {}) {
	const cfg = loadConfig({ rootDir });
	return path
		.split(".")
		.reduce((obj, key) => (obj == null ? undefined : obj[key]), cfg);
}

export function setConfigValue(
	path,
	value,
	{ rootDir = DEFAULT_ROOT_DIR } = {},
) {
	const cfg = loadConfig({ rootDir });
	const keys = path.split(".");
	let obj = cfg;
	for (let i = 0; i < keys.length - 1; i++) {
		if (obj[keys[i]] == null || typeof obj[keys[i]] !== "object")
			obj[keys[i]] = {};
		obj = obj[keys[i]];
	}
	// 尝试把字符串转成合适类型（数字、布尔）
	let v = value;
	if (typeof value === "string") {
		if (value === "true") v = true;
		else if (value === "false") v = false;
		else if (/^-?\d+(\.\d+)?$/.test(value)) v = Number(value);
	}
	obj[keys[keys.length - 1]] = v;
	saveConfig(cfg, { rootDir });
	return v;
}

function defaultIsPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function rewriteConfigPaths(configPath, oldHome, newHome) {
	if (!existsSync(configPath)) return;
	try {
		const raw = readFileSync(configPath, "utf8");
		// Boundary-aware replace: only rewrite when oldHome is followed by '/' or
		// a JSON close-quote, so /Users/u/.quadtodo-backup is not mangled.
		const rewritten = raw
			.split(oldHome + "/").join(newHome + "/")
			.split(oldHome + '"').join(newHome + '"');
		if (rewritten !== raw) writeFileSync(configPath, rewritten);
	} catch {
		// Non-fatal: caller will surface the abnormal config on next normalize.
	}
}

function rewriteClaudeSettings(home, oldDir, newDir) {
	const settingsPath = join(home, ".claude", "settings.json");
	if (!existsSync(settingsPath)) return;
	let raw;
	try {
		raw = readFileSync(settingsPath, "utf8");
	} catch {
		return;
	}
	let settings;
	try {
		settings = JSON.parse(raw);
	} catch {
		return;
	}
	let changed = false;
	const oldPrefix = oldDir + "/";
	const newPrefix = newDir + "/";

	// MCP entries
	const mcp = settings.mcpServers;
	if (mcp && typeof mcp === "object") {
		for (const key of Object.keys(mcp)) {
			const entry = mcp[key];
			if (!entry || typeof entry !== "object") continue;
			if (typeof entry.command === "string" && entry.command.includes(oldPrefix)) {
				entry.command = entry.command.split(oldPrefix).join(newPrefix);
				changed = true;
			}
			if (Array.isArray(entry.args)) {
				for (let i = 0; i < entry.args.length; i++) {
					if (typeof entry.args[i] === "string" && entry.args[i].includes(oldPrefix)) {
						entry.args[i] = entry.args[i].split(oldPrefix).join(newPrefix);
						changed = true;
					}
				}
			}
		}
	}

	// Hook entries (only ours, gated by _quadtodoManaged marker)
	const hooks = settings.hooks;
	if (hooks && typeof hooks === "object") {
		for (const eventName of Object.keys(hooks)) {
			const eventHooks = hooks[eventName];
			if (!Array.isArray(eventHooks)) continue;
			for (const matcher of eventHooks) {
				if (!matcher || !Array.isArray(matcher.hooks)) continue;
				for (const hook of matcher.hooks) {
					if (!hook || hook._quadtodoManaged !== true) continue;
					if (typeof hook.command === "string" && hook.command.includes(oldPrefix)) {
						hook.command = hook.command.split(oldPrefix).join(newPrefix);
						changed = true;
					}
				}
			}
		}
	}

	if (changed) {
		try {
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
		} catch {
			// Non-fatal: stderr will surface via migration result; user can re-bootstrap.
		}
	}
}

function moveDirectory(src, dest) {
	try {
		renameSync(src, dest);
		return;
	} catch (err) {
		if (err && err.code !== "EXDEV") throw err;
	}
	cpSync(src, dest, { recursive: true });
	rmSync(src, { recursive: true, force: true });
}

export function migrateLegacyHomeDirIfNeeded({
	home = homedir(),
	stderr = process.stderr,
	isPidAlive = defaultIsPidAlive,
} = {}) {
	const newDir = join(home, ".agentquad");
	const oldDir = join(home, ".quadtodo");

	if (existsSync(newDir)) {
		if (existsSync(oldDir)) {
			stderr.write(
				`AgentQuad: found legacy ~/.quadtodo/ alongside ~/.agentquad/; ignoring. Delete it manually when ready.\n`,
			);
		}
		return { action: "skip", reason: "new-exists" };
	}
	if (!existsSync(oldDir)) {
		return { action: "skip", reason: "no-legacy" };
	}

	const legacyPidFile = join(oldDir, "quadtodo.pid");
	if (existsSync(legacyPidFile)) {
		const pid = Number.parseInt(
			(readFileSync(legacyPidFile, "utf8") || "").trim(),
			10,
		);
		if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
			stderr.write(
				`AgentQuad: detected running quadtodo service (pid ${pid}).\n`,
			);
			stderr.write(
				`Please run \`quadtodo stop\` (or kill ${pid}) and start AgentQuad again.\n`,
			);
			return { action: "abort", reason: "pid-alive", pid };
		}
	}

	moveDirectory(oldDir, newDir);

	rewriteConfigPaths(join(newDir, "config.json"), oldDir, newDir);
	rewriteClaudeSettings(home, oldDir, newDir);

	const stalePid = join(newDir, "quadtodo.pid");
	if (existsSync(stalePid)) rmSync(stalePid, { force: true });

	const oldLog = join(newDir, "logs", "quadtodo.log");
	const newLog = join(newDir, "logs", "agentquad.log");
	if (existsSync(oldLog) && !existsSync(newLog)) {
		try {
			renameSync(oldLog, newLog);
		} catch {
			// Non-fatal.
		}
	}

	writeFileSync(
		join(newDir, ".migrated-from-quadtodo"),
		new Date().toISOString(),
	);
	stderr.write(`AgentQuad: migrated ~/.quadtodo → ~/.agentquad\n`);
	return { action: "migrated" };
}

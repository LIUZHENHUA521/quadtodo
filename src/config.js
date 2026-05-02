import { execSync } from "node:child_process";
import { DEFAULT_PRICING } from "./pricing.js";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
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

function resolveDefaultRootDir() {
	const envRootDir = process.env.QUADTODO_ROOT_DIR;
	if (envRootDir) return resolvePath(envRootDir);

	const homeRootDir = join(homedir(), ".quadtodo");
	if (canUseRootDir(homeRootDir)) return homeRootDir;

	return resolvePath(process.cwd(), ".quadtodo");
}

export const DEFAULT_ROOT_DIR = resolveDefaultRootDir();

const TOOL_INSTALL_HINTS = {
	claude: "npm install -g @anthropic-ai/claude-code",
	codex: "npm install -g @openai/codex",
};

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
	notificationCooldownMs: 600_000,    // 同 session 内 ⚠️ idle 提醒最小间隔（默认 10 分钟，0 = 关闭去重）
	suppressNotificationEvents: true,   // 默认丢弃 Claude Code 的 idle Notification（无信息量；设 false 可恢复旧 cooldown 行为）
	autoCreateTopic: true,              // 非 wizard 起的 PTY session 自动镜像到 Telegram topic
	pollRetryDelayMs: 5000,
	minRenameIntervalMs: 30_000,
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
	const normalizedClaude = normalizeToolConfig("claude", tools.claude);
	const normalizedCodex = normalizeToolConfig("codex", tools.codex);
	const claudeMeta = getToolMetadata("claude", {
		...tools,
		claude: normalizedClaude,
	});
	const codexMeta = getToolMetadata("codex", {
		...tools,
		codex: normalizedCodex,
	});
	return {
		claude: {
			...normalizedClaude,
			command: claudeMeta.effectiveCommand,
			bin: claudeMeta.effectiveBin,
			args: claudeMeta.args,
		},
		codex: {
			...normalizedCodex,
			command: codexMeta.effectiveCommand,
			bin: codexMeta.effectiveBin,
			args: codexMeta.args,
		},
	};
}

export function inspectToolsConfig(tools = {}) {
	const resolved = resolveToolsConfig(tools);
	return {
		claude: {
			...getToolMetadata("claude", tools),
			command: resolved.claude.command,
			bin: resolved.claude.bin,
		},
		codex: {
			...getToolMetadata("codex", tools),
			command: resolved.codex.command,
			bin: resolved.codex.bin,
		},
	};
}

function cloneDefaultPricing() {
	return {
		default: { ...DEFAULT_PRICING.default },
		models: Object.fromEntries(
			Object.entries(DEFAULT_PRICING.models).map(([k, v]) => [k, { ...v }]),
		),
		cnyRate: DEFAULT_PRICING.cnyRate,
	};
}

function defaultConfig() {
	return {
		port: 5677,
		// 监听地址。默认只绑定回环接口（本机安全）。
		// 要让同网段其他设备（含 Tailscale 虚拟网段 100.x.x.x）访问，可设为 "0.0.0.0"。
		// CLI 上也可以用 `quadtodo start --expose` / `--host 0.0.0.0` 临时覆盖。
		host: "127.0.0.1",
		defaultTool: "claude",
		defaultCwd: homedir(),
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
		// Clone DEFAULT_PRICING so user mutations (e.g. via setConfigValue) don't
		// leak back into the module-level constant.
		pricing: cloneDefaultPricing(),
		stats: { idleThresholdMs: 120_000 },
		wiki: {
			wikiDir: join(homedir(), ".quadtodo", "wiki"),
			maxTailTurns: 20,
			tool: "claude",
			timeoutMs: 600_000,
			redact: true,
		},
		pipeline: {
			maxAgents: 3,
		},
	};
}

function normalizeConfig(cfg = {}) {
	const defaults = defaultConfig();
	const mergedTools = {
		...defaults.tools,
		...(cfg.tools || {}),
		claude: {
			...defaults.tools.claude,
			...(cfg.tools?.claude || {}),
		},
		codex: {
			...defaults.tools.codex,
			...(cfg.tools?.codex || {}),
		},
	};
	return {
		...defaults,
		...cfg,
		tools: {
			...mergedTools,
			claude: normalizeToolConfig("claude", mergedTools.claude),
			codex: normalizeToolConfig("codex", mergedTools.codex),
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
		pipeline: { ...defaults.pipeline, ...(cfg.pipeline || {}) },
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

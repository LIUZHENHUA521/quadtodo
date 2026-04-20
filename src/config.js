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
		defaultTool: "claude",
		defaultCwd: homedir(),
		tools: resolveToolsConfig(),
		webhook: { ...DEFAULT_WEBHOOK_CONFIG },
		// Clone DEFAULT_PRICING so user mutations (e.g. via setConfigValue) don't
		// leak back into the module-level constant.
		pricing: cloneDefaultPricing(),
		stats: { idleThresholdMs: 120_000 },
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

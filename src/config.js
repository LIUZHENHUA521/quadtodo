import { execSync } from "node:child_process";
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

function defaultToolCommand(name) {
	if (name === "claude") return "claude-w";
	return name;
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
	const envBin = runtimeBinOverride(name);
	const configuredCommand = tools?.[name]?.command || "";
	const configuredBin = tools?.[name]?.bin || null;
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
		args: tools?.[name]?.args || [],
		source,
		installHint: TOOL_INSTALL_HINTS[name] || null,
		missing: source === "missing",
	};
}

export function resolveToolsConfig(tools = {}) {
	const claudeMeta = getToolMetadata("claude", tools);
	const codexMeta = getToolMetadata("codex", tools);
	return {
		claude: {
			...(tools.claude || {}),
			command: claudeMeta.effectiveCommand,
			bin: claudeMeta.effectiveBin,
			args: claudeMeta.args,
		},
		codex: {
			...(tools.codex || {}),
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

function defaultConfig() {
	return {
		port: 5677,
		defaultTool: "claude",
		defaultCwd: homedir(),
		tools: resolveToolsConfig(),
		webhook: { ...DEFAULT_WEBHOOK_CONFIG },
	};
}

function normalizeConfig(cfg = {}) {
	const defaults = defaultConfig();
	return {
		...defaults,
		...cfg,
		tools: {
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
	writeFileSync(join(rootDir, "config.json"), JSON.stringify(cfg, null, 2));
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

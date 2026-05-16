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

// Agent Supervisor（守望者）—— C 方案：替主人盯着所有 todo session，自动处理待确认 + 主动推进
// 关键：用主人本地已经买好的 claude / codex / cursor-agent CLI 做判断，不调 API（不烧 API 额度）
// Phase 1：只接 PTY 权限弹窗 + ask_user MCP；Phase 2 才上主动推进；Phase 3 才接浏览器代驾
const DEFAULT_AGENT_SUPERVISOR_CONFIG = {
	enabled: false,                            // 全局开关，默认关
	tool: "claude",                            // 用哪个本地 CLI 做判断：claude / codex / cursor
	model: "",                                 // 可选：传给 CLI 的 --model；空字符串 = 用 CLI 自己的默认
	timeoutMs: 60_000,                         // 单次决策最长等多久；超时降级回原流程
	threshold: 0.8,                            // 置信度 ≥ 这个才自动决策；否则降级原 IM 流程
	allowlist: [                               // 命中以下关键词的选项才允许自动选（小写匹配）
		"allow",
		"allow once",
		"yes",
		"continue",
		"proceed",
		"approve",
	],
	permissionAuto: true,                      // Phase 1：处理 PTY 权限弹窗
	askUserAuto: true,                         // Phase 1：处理 ask_user MCP 二选一
	activePush: {                              // Phase 2：主动推进（先占位，未启用）
		enabled: false,
		intervalMs: 180_000,                     // 每 3 分钟扫一次
		maxConsecutive: 5,                       // 同一 session 最多自动推进 N 次
		maxTokensPerTodo: 500_000,               // 同一 todo 累计 token 上限
	},
	browserControl: {                          // Phase 3：浏览器代驾（先占位，未启用）
		enabled: false,
	},
};

const SUPERVISOR_TOOLS = new Set(["claude", "codex", "cursor"]);

const DEFAULT_LARK_CONFIG = {
	enabled: false,
	appId: "",
	appSecret: "",
	chatId: "",
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	autoCreateTopic: true,
	autoCreateTodo: true,
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

function getToolMetadata(name, tools = {}) {
	const normalizedTool = normalizeToolConfig(name, tools?.[name], {
		applyDefaultCommand: false,
	});
	const envBin = runtimeBinOverride(name);
	const configuredCommand = normalizedTool.command || "";
	const configuredBin = normalizedTool.bin || null;
	const effectiveCommand = configuredCommand || defaultToolCommand(name);
	const detectedBin = detectBinary(effectiveCommand);
	// effectiveBin 与 PTY 实际启动顺序保持一致：env override > 用户字面 bin > PATH 探测兜底。
	// 不再用 basename 启发式自动改写用户的字面值（option C：用户输入即真理）。
	const effectiveBin = envBin || configuredBin || detectedBin;
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
		effectiveBin,
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
		// 不再用 `command -v` 自动填充 bin —— 用户输入即真理。
		// 仍保留 env override（<TOOL>_BIN，runtime 调试用），优先级高于配置文件，
		// 但绝不写回 config.json。
		// PTY 启动时 bin 为空会 fallback 到 command 名走 PATH 解析。
		const envBin = runtimeBinOverride(name);
		out[name] = {
			...normalized,
			command: normalized.command || defaultToolCommand(name),
			bin: envBin || normalized.bin || "",
			args: normalized.args,
		};
	}
	return out;
}

export function inspectToolsConfig(tools = {}) {
	const resolved = resolveToolsConfig(tools);
	const out = {};
	for (const name of SUPPORTED_TOOLS) {
		const meta = getToolMetadata(name, tools);
		out[name] = {
			...meta,
			command: resolved[name].command,
			// 诊断行"当前有效路径"显示的是 envBin / configuredBin / detectedBin 三路兜底的值，
			// 让用户能看到 PATH 探测会落到哪里；这里跟 resolved.bin（仅用户字面值）刻意分开。
			bin: meta.effectiveBin,
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
		defaultCwd: homedir(),
		defaultPermissionMode: "default",
		// 新建待办时是否默认勾选「创建后自动启动 AI 终端」。
		// Drawer 上的开关仍可单次覆盖；这里只是默认值。
		defaultAutoStartAi: false,
		// 新建待办时默认套用的 Prompt 模板 ID 列表（多选）。空数组 = 不预选。
		// 用户在 SettingsDrawer 里维护；创建任务时 TodoManage 读取此值作为表单初值。
		defaultAppliedTemplateIds: [],
		// 自动启动 / dispatch / 顶栏 ⌘K 等场景下使用的默认 AI 工具。
		defaultAiTool: "claude",
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
		agents: {
			autoBootstrap: 'prompt',         // 'prompt' | 'never' | 'silent'
			bootstrapDismissed: false,        // CLI 弹问时用户回 N 后置 true
			enabled: { claude: true, codex: true, cursor: true },
			warnPtyCount: 8,                  // doctor 软 warning 阈值
		},
		agentSupervisor: {
			...DEFAULT_AGENT_SUPERVISOR_CONFIG,
			allowlist: [...DEFAULT_AGENT_SUPERVISOR_CONFIG.allowlist],
			activePush: { ...DEFAULT_AGENT_SUPERVISOR_CONFIG.activePush },
			browserControl: { ...DEFAULT_AGENT_SUPERVISOR_CONFIG.browserControl },
		},
};
}

function normalizeDispatch(d = {}) {
	const channels = ['lark', 'telegram'];
	const out = {};
	for (const ch of channels) {
		const src = (d && typeof d[ch] === 'object' && d[ch] !== null) ? d[ch] : {};
		out[ch] = { default: 'claude', ...src };
	}
	return out;
}

export function normalizeConfig(cfg = {}) {
	const defaults = defaultConfig();
	// 旧 config.json 里残留的 defaultTool 字段（已废弃）。剥离后再 spread，
	// 避免 ...cfg 把死字段又拷回 normalized config。
	const { defaultTool: _ignoredDefaultTool, ...cfgRest } = cfg;
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
	const rawDefaultAiTool = typeof cfg.defaultAiTool === "string" ? cfg.defaultAiTool.trim() : "";
	const defaultAiTool = SUPPORTED_TOOLS.includes(rawDefaultAiTool) ? rawDefaultAiTool : defaults.defaultAiTool;
	return {
		...defaults,
		...cfgRest,
		defaultPermissionMode: normalizePermissionMode(cfg.defaultPermissionMode, "default"),
		defaultAutoStartAi: !!cfg.defaultAutoStartAi,
		defaultAppliedTemplateIds: Array.isArray(cfg.defaultAppliedTemplateIds)
			? cfg.defaultAppliedTemplateIds.map((x) => String(x).trim()).filter(Boolean)
			: [],
		defaultAiTool,
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
		agentSupervisor: normalizeAgentSupervisor(cfg.agentSupervisor),
	};
}

function normalizeAgentSupervisor(raw = {}) {
	const base = DEFAULT_AGENT_SUPERVISOR_CONFIG;
	const input = raw && typeof raw === "object" ? raw : {};
	const threshold = Number(input.threshold);
	const timeoutMs = Number(input.timeoutMs);
	const tool = typeof input.tool === "string" && SUPERVISOR_TOOLS.has(input.tool.trim()) ? input.tool.trim() : base.tool;
	const allowlist = Array.isArray(input.allowlist)
		? input.allowlist.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
		: [...base.allowlist];
	const activePush = input.activePush && typeof input.activePush === "object" ? input.activePush : {};
	const browserControl = input.browserControl && typeof input.browserControl === "object" ? input.browserControl : {};
	return {
		enabled: input.enabled === true,
		tool,
		model: typeof input.model === "string" ? input.model.trim() : "",
		timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 5_000 && timeoutMs <= 600_000 ? Math.floor(timeoutMs) : base.timeoutMs,
		threshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : base.threshold,
		allowlist,
		permissionAuto: input.permissionAuto !== false,
		askUserAuto: input.askUserAuto !== false,
		activePush: {
			enabled: activePush.enabled === true,
			intervalMs: Number.isFinite(Number(activePush.intervalMs)) && Number(activePush.intervalMs) >= 30_000 ? Number(activePush.intervalMs) : base.activePush.intervalMs,
			maxConsecutive: Number.isFinite(Number(activePush.maxConsecutive)) && Number(activePush.maxConsecutive) > 0 ? Math.floor(Number(activePush.maxConsecutive)) : base.activePush.maxConsecutive,
			maxTokensPerTodo: Number.isFinite(Number(activePush.maxTokensPerTodo)) && Number(activePush.maxTokensPerTodo) > 0 ? Math.floor(Number(activePush.maxTokensPerTodo)) : base.activePush.maxTokensPerTodo,
		},
		browserControl: {
			enabled: browserControl.enabled === true,
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

// Atomic write: write to a sibling tmp file then rename over the target.
// POSIX rename is atomic on the same filesystem — readers always see either
// the old or the new file, never a half-written one. Eliminates the
// truncated-write → JSON.parse-fail → reset-to-defaults loop.
function atomicWriteFile(file, contents) {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, contents);
	renameSync(tmp, file);
}

function tryWriteConfig(file, cfg) {
	try {
		atomicWriteFile(file, JSON.stringify(cfg, null, 2));
		return true;
	} catch {
		return false;
	}
}

// In-process write serialization. Concurrent PUT /api/config calls (and any
// other server-side read-modify-write sequence) used to interleave their
// load/save and lose each other's changes. withConfigLock chains operations
// onto a single Promise queue so reads + writes within `fn` are atomic
// against other queued operations. Out-of-process writers (CLI, hooks) are
// NOT protected — see design doc R2/F4 deferred scope.
let configWriteQueue = Promise.resolve();
export function withConfigLock(fn) {
	const run = configWriteQueue.then(() => fn(), () => fn());
	configWriteQueue = run.catch(() => {});
	return run;
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
		return normalizeConfig(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		backupCorruptConfig(file);
		const cfg = normalizeConfig();
		tryWriteConfig(file, cfg);
		return cfg;
	}
}

export function saveConfig(cfg, { rootDir = DEFAULT_ROOT_DIR } = {}) {
	ensureRoot(rootDir);
	atomicWriteFile(
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

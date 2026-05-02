import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("config", () => {
	let tmpRoot;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "quadtodo-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("loadConfig returns defaults on first run and creates the directory", async () => {
		const { loadConfig } = await import("../src/config.js");
		const cfg = loadConfig({ rootDir: tmpRoot });

		expect(cfg.port).toBe(5677);
		expect(cfg.defaultTool).toBe("claude");
		expect(cfg.tools.claude.command).toBe("claude-w");
		expect(cfg.tools.codex.command).toBe("codex");
		expect(cfg.tools.claude.bin).toBeDefined();
		expect(cfg.tools.codex.bin).toBeDefined();
		expect(cfg.webhook.enabled).toBe(false);
		expect(existsSync(join(tmpRoot, "config.json"))).toBe(true);
		expect(existsSync(join(tmpRoot, "logs"))).toBe(true);
	});

	it("loadConfig preserves user edits across calls", async () => {
		const { loadConfig, saveConfig } = await import("../src/config.js");
		const cfg = loadConfig({ rootDir: tmpRoot });
		cfg.port = 9999;
		saveConfig(cfg, { rootDir: tmpRoot });

		const reloaded = loadConfig({ rootDir: tmpRoot });
		expect(reloaded.port).toBe(9999);
	});

	it("loadConfig splits inline tool command into command and args", async () => {
		writeFileSync(
			join(tmpRoot, "config.json"),
			JSON.stringify({
				port: 5677,
				defaultTool: "claude",
				defaultCwd: "/tmp",
				tools: {
					claude: {
						command: "claude-w --model gpt-5.4 --debug",
						bin: "",
						args: [],
					},
				},
			}),
		);
		const { loadConfig } = await import("../src/config.js");
		const cfg = loadConfig({ rootDir: tmpRoot });
		expect(cfg.tools.claude.command).toBe("claude-w");
		expect(cfg.tools.claude.args).toEqual(["--model", "gpt-5.4", "--debug"]);
	});

	it("saveConfig normalizes inline tool command before writing", async () => {
		const { saveConfig } = await import("../src/config.js");
		saveConfig(
			{
				port: 5677,
				defaultTool: "claude",
				defaultCwd: "/tmp",
				tools: {
					claude: {
						command: 'claude-w --model "gpt 5.4"',
						bin: "",
						args: ["--dangerously-skip"],
					},
					codex: { command: "codex", bin: "", args: [] },
				},
			},
			{ rootDir: tmpRoot },
		);
		const raw = JSON.parse(readFileSync(join(tmpRoot, "config.json"), "utf8"));
		expect(raw.tools.claude.command).toBe("claude-w");
		expect(raw.tools.claude.args).toEqual([
			"--model",
			"gpt 5.4",
			"--dangerously-skip",
		]);
	});

	it("setConfigValue supports dot paths", async () => {
		const { loadConfig, setConfigValue } = await import("../src/config.js");
		loadConfig({ rootDir: tmpRoot });
		setConfigValue("tools.claude.command", "claude-w", { rootDir: tmpRoot });
		setConfigValue("tools.claude.bin", "/opt/claude", { rootDir: tmpRoot });

		const data = JSON.parse(readFileSync(join(tmpRoot, "config.json"), "utf8"));
		expect(data.tools.claude.command).toBe("claude-w");
		expect(data.tools.claude.bin).toBe("/opt/claude");
	});

	it("getConfigValue returns nested values via dot path", async () => {
		const { loadConfig, getConfigValue } = await import("../src/config.js");
		loadConfig({ rootDir: tmpRoot });
		expect(getConfigValue("port", { rootDir: tmpRoot })).toBe(5677);
		expect(
			getConfigValue("tools.claude.bin", { rootDir: tmpRoot }),
		).toBeTruthy();
	});

	it("loadConfig preserves corrupted user config by backing up instead of clobbering", async () => {
		mkdirSync(tmpRoot, { recursive: true });
		writeFileSync(join(tmpRoot, "config.json"), "{ this is not json");
		const { loadConfig } = await import("../src/config.js");
		const cfg = loadConfig({ rootDir: tmpRoot });
		expect(cfg.port).toBe(5677);
		expect(existsSync(join(tmpRoot, "config.json.corrupt"))).toBe(true);
	});

	it("resolveToolsConfig honors runtime env overrides without mutating saved config", async () => {
		process.env.CLAUDE_BIN = "/tmp/claude-env";
		process.env.CODEX_BIN = "/tmp/codex-env";
		try {
			const { resolveToolsConfig } = await import("../src/config.js");
			const tools = resolveToolsConfig({
				claude: { bin: "/tmp/claude-config", args: ["--foo"] },
				codex: { bin: "/tmp/codex-config", args: [] },
			});
			expect(tools.claude.bin).toBe("/tmp/claude-env");
			expect(tools.claude.args).toEqual(["--foo"]);
			expect(tools.codex.bin).toBe("/tmp/codex-env");
		} finally {
			delete process.env.CLAUDE_BIN;
			delete process.env.CODEX_BIN;
		}
	});

	it("inspectToolsConfig reports source and install hint", async () => {
		const { inspectToolsConfig } = await import("../src/config.js");
		const result = inspectToolsConfig({
			claude: {
				command: "claude-w",
				bin: "/tmp/claude-custom",
				args: ["--foo"],
			},
			codex: { command: "codex-w", bin: "", args: [] },
		});

		expect(result.claude.source).toBe("config");
		expect(result.claude.command).toBe("claude-w");
		expect(result.claude.bin).toBe("/tmp/claude-custom");
		expect(result.codex.command).toBe("codex-w");
		expect(result.claude.installHint).toContain("@anthropic-ai/claude-code");
		expect(result.codex.installHint).toContain("@openai/codex");
	});

	it("resolveToolsConfig ignores a stale legacy claude bin when command changed", async () => {
		const { resolveToolsConfig } = await import("../src/config.js");
		const result = resolveToolsConfig({
			claude: {
				command: "node",
				bin: "/tmp/claude",
				args: [],
			},
		});

		expect(result.claude.command).toBe("node");
		expect(result.claude.bin).not.toBe("/tmp/claude");
	});

	it("loadConfig normalizes webhook config shape", async () => {
		writeFileSync(
			join(tmpRoot, "config.json"),
			JSON.stringify({
				port: 5677,
				defaultTool: "claude",
				defaultCwd: "/tmp",
				tools: {},
				webhook: {
					enabled: true,
					provider: "feishu",
					url: "https://example.com",
					keywords: ["hello", " world "],
				},
			}),
		);
		const { loadConfig } = await import("../src/config.js");
		const cfg = loadConfig({ rootDir: tmpRoot });
		expect(cfg.webhook.enabled).toBe(true);
		expect(cfg.webhook.provider).toBe("feishu");
		expect(cfg.webhook.cooldownMs).toBeGreaterThan(0);
		expect(cfg.webhook.keywords).toEqual(["hello", "world"]);
	});
});

describe('config wiki defaults', () => {
	it('loadConfig returns wiki section with defaults', async () => {
		const { loadConfig } = await import('../src/config.js');
		const dir = mkdtempSync(join(tmpdir(), 'qt-wiki-'));
		const cfg = loadConfig({ rootDir: dir });
		expect(cfg.wiki).toBeTruthy();
		expect(cfg.wiki.wikiDir).toBeTruthy();
		expect(cfg.wiki.maxTailTurns).toBe(20);
		expect(cfg.wiki.tool).toBe('claude');
		expect(cfg.wiki.timeoutMs).toBe(600_000);
		expect(cfg.wiki.redact).toBe(true);
	});
});

describe('telegram defaults: pollRetryDelayMs / minRenameIntervalMs', () => {
	it('normalizes legacy config without these fields by injecting defaults', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-'));
		writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { enabled: true } }));
		const cfg = loadConfig({ rootDir: tmp });
		expect(cfg.telegram.pollRetryDelayMs).toBe(5000);
		expect(cfg.telegram.minRenameIntervalMs).toBe(30000);
		rmSync(tmp, { recursive: true, force: true });
	});
});

import { readFileSync, watchFile } from "node:fs";

const DEFAULT_PROVIDER = "mira";
const DEFAULT_PROXY_PORT = 8642;

function cloneRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? { ...value }
		: {};
}

function compactRecord(record) {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

function getLegacyMiraProvider(rawConfig) {
	const legacy = compactRecord({
		mira_session: rawConfig.mira_session,
		mira_base_url: rawConfig.mira_base_url,
		default_model: rawConfig.default_model,
		model_map: rawConfig.model_map,
		completion_defaults: rawConfig.completion_defaults,
		anthropic_tool_map: rawConfig.anthropic_tool_map,
		log_requests: rawConfig.log_requests,
	});

	return Object.keys(legacy).length > 0 ? legacy : null;
}

export function normalizeConfig(rawConfig = {}) {
	const raw = cloneRecord(rawConfig);
	const providers = cloneRecord(raw.providers);
	const legacyMira = getLegacyMiraProvider(raw);

	if (!providers.mira && legacyMira) {
		providers.mira = legacyMira;
	}

	const provider =
		process.env.AI_PROXY_PROVIDER || raw.provider || DEFAULT_PROVIDER;
	if (!providers[provider]) providers[provider] = {};

	return {
		...raw,
		provider,
		proxy_port: raw.proxy_port || DEFAULT_PROXY_PORT,
		providers,
	};
}

export function getActiveProviderConfig(config) {
	const providerConfig = cloneRecord(config.providers?.[config.provider]);
	return {
		...providerConfig,
		default_model:
			providerConfig.default_model ?? config.default_model ?? "gpt-5.4",
		model_map: providerConfig.model_map ?? config.model_map ?? {},
		log_requests: providerConfig.log_requests ?? config.log_requests ?? false,
	};
}

export function loadConfig(configPath) {
	return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
}

export function watchConfigFile(configPath, onReload) {
	watchFile(configPath, { interval: 2000 }, () => {
		try {
			onReload(loadConfig(configPath));
			console.log("[config] Reloaded config.json");
		} catch {
			console.warn("[config] Failed to reload, keeping old config");
		}
	});
}

import { afterEach, describe, expect, it } from "vitest";

describe("mira-proxy config loader", () => {
	afterEach(() => {
		delete process.env.AI_PROXY_PROVIDER;
	});

	it("hydrates legacy top-level mira config into providers.mira", async () => {
		const { normalizeConfig, getActiveProviderConfig } = await import(
			"../mira-proxy/config-loader.js"
		);
		const config = normalizeConfig({
			proxy_port: 8642,
			mira_session: "session-token",
			mira_base_url: "https://mira.byteintl.net",
			default_model: "re-o-46",
			model_map: {
				"claude-sonnet-4-20250514": "re-o-46",
			},
			log_requests: true,
		});

		expect(config.provider).toBe("mira");
		expect(config.providers.mira.mira_session).toBe("session-token");

		const providerConfig = getActiveProviderConfig(config);
		expect(providerConfig.mira_base_url).toBe("https://mira.byteintl.net");
		expect(providerConfig.default_model).toBe("re-o-46");
		expect(providerConfig.model_map["claude-sonnet-4-20250514"]).toBe(
			"re-o-46",
		);
		expect(providerConfig.log_requests).toBe(true);
	});

	it("lets environment override the active provider while preserving provider-scoped config", async () => {
		process.env.AI_PROXY_PROVIDER = "trae-cn";
		const { normalizeConfig, getActiveProviderConfig } = await import(
			"../mira-proxy/config-loader.js"
		);
		const config = normalizeConfig({
			provider: "mira",
			providers: {
				mira: { default_model: "re-o-46" },
				"trae-cn": {
					trae_base_url: "https://trae.bytedance.com",
					trae_session: "token",
					default_model: "trae-cn-default",
					model_map: { "claude-sonnet-4-20250514": "trae-cn-default" },
				},
			},
		});

		expect(config.provider).toBe("trae-cn");

		const providerConfig = getActiveProviderConfig(config);
		expect(providerConfig.trae_base_url).toBe("https://trae.bytedance.com");
		expect(providerConfig.default_model).toBe("trae-cn-default");
		expect(providerConfig.model_map["claude-sonnet-4-20250514"]).toBe(
			"trae-cn-default",
		);
	});
});

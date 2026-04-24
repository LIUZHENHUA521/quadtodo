function getCompletionDefaults(providerConfig, model) {
	const defaults = providerConfig.completion_defaults || {};
	const nestedConfig =
		defaults.config && typeof defaults.config === "object"
			? defaults.config
			: {};
	return {
		messageType: defaults.messageType ?? 1,
		summaryAgent: defaults.summaryAgent || model,
		dataSources: Array.isArray(defaults.dataSources)
			? defaults.dataSources
			: ["manus"],
		comprehensive: defaults.comprehensive ?? 1,
		config: {
			online: nestedConfig.online ?? true,
			mode: nestedConfig.mode || "quick",
			model: nestedConfig.model || model,
			tool_list: Array.isArray(nestedConfig.tool_list)
				? nestedConfig.tool_list
				: [],
			...(nestedConfig.updatedAt ? { updatedAt: nestedConfig.updatedAt } : {}),
		},
	};
}

function mergeToolList(baseTools, extraTools) {
	const merged = [];
	const seen = new Set();
	for (const tool of [...baseTools, ...extraTools]) {
		if (!tool || !tool.name) continue;
		const key = `${tool.name}:${tool.scope || ""}:${tool.id || ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(tool);
	}
	return merged;
}

function buildMiraToolList(providerConfig, anthropicTools = []) {
	const defaults = providerConfig.completion_defaults?.config?.tool_list || [];
	const toolMap = providerConfig.anthropic_tool_map || {};
	const mapped = [];
	for (const tool of anthropicTools) {
		const mappedTool = toolMap?.[tool.name];
		if (!mappedTool) continue;
		mapped.push(mappedTool);
	}
	return mergeToolList(defaults, mapped);
}

function getBaseUrl(providerConfig) {
	return providerConfig.mira_base_url || "https://mira.byteintl.net";
}

function miraUrl(providerConfig, path) {
	return `${getBaseUrl(providerConfig)}${path}`;
}

function miraHeaders(providerConfig, extra = {}) {
	return {
		"Content-Type": "application/json",
		Cookie: `mira_session=${providerConfig.mira_session}`,
		...extra,
	};
}

function sanitizeMiraResultText(text) {
	if (typeof text !== "string" || !text) return "";
	let next = text;
	const cisCtrlEnd = next.lastIndexOf("</cis-ctrl>");
	if (cisCtrlEnd >= 0) next = next.slice(cisCtrlEnd + "</cis-ctrl>".length);
	return next.trim();
}

function parseMiraEnvelope(payload, logger) {
	if (!payload || typeof payload !== "object") return { kind: "ignore" };
	if (payload.done === true) return { kind: "done" };

	let inner = payload;
	if (typeof payload.Message === "string") {
		try {
			inner = JSON.parse(payload.Message);
		} catch {
			return { kind: "ignore" };
		}
	}

	const eventName = inner?.event || payload?.event || null;
	if (eventName) logger?.("[mira][debug] envelope event:", eventName);

	if (
		inner?.event === "reason" &&
		inner?.data?.type === "stream_event" &&
		inner?.data?.event?.type
	) {
		return { kind: "anthropic_event", event: inner.data.event };
	}

	if (inner?.event === "content") {
		const result = sanitizeMiraResultText(inner?.data?.content?.result || "");
		const isError = inner?.data?.content?.is_error === true;
		return {
			kind: "final_result",
			text: isError ? `[Mira Error]: ${result}` : result,
		};
	}

	return { kind: "ignore" };
}

function makeLogger(providerConfig) {
	return providerConfig.log_requests ? console.log : null;
}

async function miraCreateChat(providerConfig, model) {
	const resp = await fetch(
		miraUrl(providerConfig, "/mira/api/v1/chat/create"),
		{
			method: "POST",
			headers: miraHeaders(providerConfig),
			body: JSON.stringify({ model_key: model }),
		},
	);
	const text = await resp.text();
	if (providerConfig.log_requests)
		console.log("[mira] chat/create", resp.status, text.slice(0, 500));
	if (!resp.ok)
		throw new Error(`chat/create failed: ${resp.status} ${text.slice(0, 200)}`);
	const data = JSON.parse(text);
	if (data.code && data.code !== 0)
		throw new Error(
			`chat/create: ${data.msg || "unknown error"} (code=${data.code})`,
		);
	const chatId =
		data.sessionItem?.sessionId ||
		data.data?.chat_id ||
		data.chat_id ||
		data.id ||
		data.data?.id;
	if (providerConfig.log_requests) {
		console.log(
			"[mira][debug] create parsed:",
			JSON.stringify({
				code: data.code,
				msg: data.msg,
				keys: Object.keys(data || {}),
				dataKeys:
					data?.data && typeof data.data === "object"
						? Object.keys(data.data)
						: null,
				chatId,
			}).slice(0, 500),
		);
	}
	return chatId;
}

async function miraCompleteChat(
	providerConfig,
	chatId,
	content,
	model,
	anthropicTools = [],
) {
	const completionDefaults = getCompletionDefaults(providerConfig, model);
	const payload = {
		sessionId: chatId,
		content,
		messageType: completionDefaults.messageType,
		summaryAgent: completionDefaults.summaryAgent,
		dataSources: completionDefaults.dataSources,
		comprehensive: completionDefaults.comprehensive,
		config: completionDefaults.config,
	};
	payload.config.tool_list = buildMiraToolList(providerConfig, anthropicTools);
	if (providerConfig.log_requests)
		console.log(
			"[mira] chat/completion payload:",
			JSON.stringify(payload).slice(0, 500),
		);
	const resp = await fetch(
		miraUrl(providerConfig, "/mira/api/v1/chat/completion"),
		{
			method: "POST",
			headers: miraHeaders(providerConfig, { Accept: "text/event-stream" }),
			body: JSON.stringify(payload),
		},
	);
	if (providerConfig.log_requests)
		console.log(
			"[mira] chat/completion",
			resp.status,
			resp.headers.get("content-type"),
		);
	if (!resp.ok) return resp;
	const ct = resp.headers.get("content-type") || "";
	if (ct.includes("application/json") && !ct.includes("text/event-stream")) {
		const text = await resp.text();
		if (providerConfig.log_requests)
			console.log(
				"[mira][debug] completion json response:",
				text.slice(0, 1000),
			);
		try {
			const data = JSON.parse(text);
			if (data.code && data.code !== 0)
				throw new Error(
					`chat/completion: ${data.msg || "unknown error"} (code=${data.code})`,
				);
		} catch (e) {
			if (e.message.startsWith("chat/completion:")) throw e;
		}
		return new Response(text, { status: resp.status, headers: resp.headers });
	}
	return resp;
}

async function callMira(providerConfig, context) {
	const { model, content, anthropicBody } = context;
	if (providerConfig.log_requests) {
		console.log(
			"[mira][debug] call input:",
			JSON.stringify({
				model,
				contentPreview: content.slice(0, 500),
				messageCount: Array.isArray(anthropicBody.messages)
					? anthropicBody.messages.length
					: 0,
				hasSystem: Boolean(anthropicBody.system),
			}).slice(0, 700),
		);
	}

	let chatId;
	try {
		chatId = await miraCreateChat(providerConfig, model);
		if (providerConfig.log_requests)
			console.log("[mira] created chat:", chatId);
	} catch (e) {
		console.error("[mira] chat/create error:", e.message);
		throw e;
	}

	const resp = await miraCompleteChat(
		providerConfig,
		chatId,
		content,
		model,
		anthropicBody.tools || [],
	);
	if (!resp.ok) {
		const errText = await resp.text();
		console.error(
			"[mira] chat/completion error:",
			resp.status,
			errText.slice(0, 300),
		);
		throw new Error(
			`Mira chat/completion ${resp.status}: ${errText.slice(0, 200)}`,
		);
	}
	return resp;
}

export function createMiraProvider(providerConfig) {
	return {
		name: "mira",
		listModels() {
			const models = Object.values(providerConfig.model_map || {});
			return [
				...new Set([providerConfig.default_model, ...models].filter(Boolean)),
			];
		},
		getPublicInfo() {
			const hasSession =
				providerConfig.mira_session &&
				providerConfig.mira_session !== "YOUR_MIRA_SESSION_COOKIE_HERE";
			return {
				has_session: Boolean(hasSession),
				upstream: getBaseUrl(providerConfig),
			};
		},
		async call(context) {
			return callMira(providerConfig, context);
		},
		parseEvent(rawPayload) {
			return parseMiraEnvelope(rawPayload, makeLogger(providerConfig));
		},
	};
}

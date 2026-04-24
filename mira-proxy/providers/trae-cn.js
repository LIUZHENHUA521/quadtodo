import crypto from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TRAE_BASE_URL = "https://trae.bytedance.com";
const DEFAULT_TRAE_API_BASE_URL = "https://copilot-cn.bytedance.net";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TRAE_LOG_ROOT = join(
	homedir(),
	"Library",
	"Application Support",
	"Trae CN",
	"logs",
);
const DEFAULT_CAPTURE_FILE = join(
	MODULE_DIR,
	"..",
	"..",
	"tmp",
	"trae-cn-body-capture",
	"curl",
);
const DEFAULT_CURRENT_DOCUMENT_URI =
	"file:///Users/bytedance/Desktop/code/quadtodo/package.json";
const DEFAULT_CURRENT_DOCUMENT_POSITION = { line: 0, character: 0 };
const MAX_RESPONSE_PREVIEW = 4000;

function reportDebugEvent(hypothesisId, location, msg, data = {}) {
	// #region debug-point A:trae-empty-response
	(() => {
		const envPath = join(
			MODULE_DIR,
			"..",
			"..",
			".dbg",
			"trae-empty-response.env",
		);
		let debugServerUrl = "http://127.0.0.1:7777/event";
		let debugSessionId = "trae-empty-response";
		try {
			const envText = readFileSync(envPath, "utf8");
			debugServerUrl =
				envText.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || debugServerUrl;
			debugSessionId =
				envText.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || debugSessionId;
		} catch {}
		fetch(debugServerUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: debugSessionId,
				runId: "pre-fix",
				hypothesisId,
				location,
				msg: `[DEBUG] ${msg}`,
				data,
				ts: Date.now(),
			}),
		}).catch(() => {});
	})();
	// #endregion
}

function getBaseUrl(providerConfig) {
	return providerConfig.trae_base_url || DEFAULT_TRAE_BASE_URL;
}

function getApiBaseUrl(providerConfig) {
	return providerConfig.trae_api_base_url || DEFAULT_TRAE_API_BASE_URL;
}

function getLogRoot(providerConfig) {
	return providerConfig.trae_log_root || DEFAULT_TRAE_LOG_ROOT;
}

function getCaptureFile(providerConfig) {
	return providerConfig.trae_capture_file || DEFAULT_CAPTURE_FILE;
}

function getSuperCompletionUrl(providerConfig) {
	return `${getApiBaseUrl(providerConfig)}/api/ide/v1/super_completion_query`;
}

function getSelectableModels(providerConfig) {
	const configuredModels = Array.isArray(providerConfig.trae_models)
		? providerConfig.trae_models
		: [];
	const mappedModels = Object.values(providerConfig.model_map || {});
	return [
		...new Set(
			[
				providerConfig.default_model,
				providerConfig.trae_request_model,
				...configuredModels,
				...mappedModels,
			].filter(Boolean),
		),
	];
}

function listModels(providerConfig) {
	return getSelectableModels(providerConfig);
}

function resolveRequestedModel(providerConfig, requestedModel, captureBody) {
	if (requestedModel) return requestedModel;
	return (
		providerConfig.trae_request_model ||
		captureBody.model ||
		providerConfig.default_model ||
		"default"
	);
}

function reverseLines(text) {
	return text.split(/\r?\n/).reverse();
}

function getHeaderValue(headers, headerName) {
	if (!headers || typeof headers !== "object") return undefined;
	const match = Object.entries(headers).find(
		([key]) => key.toLowerCase() === headerName.toLowerCase(),
	);
	return match?.[1];
}

function parseHeaderLine(line) {
	const marker = "request: headers: ";
	const index = line.indexOf(marker);
	if (index < 0) return null;
	try {
		return JSON.parse(line.slice(index + marker.length));
	} catch {
		return null;
	}
}

function parseCurlCapture(providerConfig) {
	const filePath = getCaptureFile(providerConfig);
	if (!existsSync(filePath)) return null;
	const text = readFileSync(filePath, "utf8");
	const lines = text.split(/\r?\n/);
	const headers = {};
	for (const line of lines) {
		const headerMatch = line.match(/^-H '([^:]+):\s*(.*)'\\?$/);
		if (!headerMatch) continue;
		headers[headerMatch[1]] = headerMatch[2];
	}

	const bodyMarker = "\nbody\n";
	const bodyIndex = text.indexOf(bodyMarker);
	if (bodyIndex < 0) return { headers, body: null };

	const bodyText = text.slice(bodyIndex + bodyMarker.length).trim();
	try {
		return {
			headers,
			body: JSON.parse(bodyText),
		};
	} catch {
		return {
			headers,
			body: null,
		};
	}
}

function getLatestSessionDir(logRoot) {
	if (!existsSync(logRoot)) return null;
	const sessions = readdirSync(logRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
		.map((entry) => ({
			path: join(logRoot, entry.name),
			mtimeMs: statSync(join(logRoot, entry.name)).mtimeMs,
		}))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return sessions[0]?.path || null;
}

function walk(dir, onFile) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const filePath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(filePath, onFile);
			continue;
		}
		onFile(filePath);
	}
}

function getLatestCompletionLogs(providerConfig) {
	const latestSessionDir = getLatestSessionDir(getLogRoot(providerConfig));
	if (!latestSessionDir) return [];
	const files = [];
	walk(latestSessionDir, (filePath) => {
		if (basename(filePath) === "completion.log") files.push(filePath);
	});
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function pickBestHeaderCandidate(headers) {
	if (!headers) return false;
	return (
		Boolean(getHeaderValue(headers, "authorization")) &&
		String(getHeaderValue(headers, "content-type") || "").includes(
			"text/event-stream",
		)
	);
}

function discoverHeadersFromLogs(providerConfig) {
	for (const filePath of getLatestCompletionLogs(providerConfig)) {
		const text = readFileSync(filePath, "utf8");
		for (const line of reverseLines(text)) {
			const headers = parseHeaderLine(line);
			if (pickBestHeaderCandidate(headers)) return headers;
		}
	}
	return null;
}

function discoverContextFromLogs(providerConfig) {
	for (const filePath of getLatestCompletionLogs(providerConfig)) {
		const text = readFileSync(filePath, "utf8");
		const sessionMatch = [
			...text.matchAll(
				/commonParams:\s*\{\s*model_name:\s*'([^']+)',\s*session_id:\s*'([^']+)'\s*\}/g,
			),
		].at(-1);
		const positionMatch = [
			...text.matchAll(
				/currentDocumentPosition:\s*\{\s*line:\s*(\d+),\s*character:\s*(\d+)\s*\}/g,
			),
		].at(-1);
		const uriMatch = [...text.matchAll(/currentDocumentUri:\s*'([^']+)'/g)].at(
			-1,
		);
		if (!sessionMatch && !positionMatch && !uriMatch) continue;
		return {
			modelName: sessionMatch?.[1] || null,
			sessionId: sessionMatch?.[2] || null,
			currentDocumentUri: uriMatch?.[1] || null,
			currentDocumentPosition: positionMatch
				? {
						line: Number(positionMatch[1]),
						character: Number(positionMatch[2]),
					}
				: null,
		};
	}
	return null;
}

function resolveAuthHeaders(providerConfig) {
	if (
		providerConfig.trae_headers &&
		typeof providerConfig.trae_headers === "object"
	) {
		return { ...providerConfig.trae_headers };
	}

	const captureHeaders = parseCurlCapture(providerConfig)?.headers || {};
	const logHeaders = discoverHeadersFromLogs(providerConfig) || {};
	const headers = {
		...captureHeaders,
		...logHeaders,
	};
	if (
		!getHeaderValue(headers, "authorization") &&
		providerConfig.trae_access_token
	) {
		headers.authorization = providerConfig.trae_access_token.startsWith(
			"Cloud-IDE-JWT ",
		)
			? providerConfig.trae_access_token
			: `Cloud-IDE-JWT ${providerConfig.trae_access_token}`;
	}

	if (
		providerConfig.trae_session &&
		!getHeaderValue(headers, "authorization")
	) {
		headers.authorization = providerConfig.trae_session.startsWith(
			"Cloud-IDE-JWT ",
		)
			? providerConfig.trae_session
			: `Cloud-IDE-JWT ${providerConfig.trae_session}`;
	}

	if (!headers["X-App-Id"] && providerConfig.trae_app_id) {
		headers["X-App-Id"] = providerConfig.trae_app_id;
	}

	if (!headers["X-Device-Id"] && providerConfig.trae_device_id) {
		headers["X-Device-Id"] = providerConfig.trae_device_id;
	}

	if (!headers["X-Machine-Id"] && providerConfig.trae_machine_id) {
		headers["X-Machine-Id"] = providerConfig.trae_machine_id;
	}

	return Object.fromEntries(
		Object.entries({
			host: getHeaderValue(headers, "host"),
			connection: getHeaderValue(headers, "connection"),
			"sec-fetch-dest": getHeaderValue(headers, "sec-fetch-dest"),
			"sec-fetch-mode": getHeaderValue(headers, "sec-fetch-mode"),
			"sec-fetch-site": getHeaderValue(headers, "sec-fetch-site"),
			"user-agent": getHeaderValue(headers, "user-agent"),
			authorization:
				getHeaderValue(headers, "authorization") || headers.Authorization,
			"content-type":
				getHeaderValue(headers, "content-type") || "application/json",
			"x-app-id": getHeaderValue(headers, "x-app-id") || headers["X-App-Id"],
			"x-custom-repo-urls":
				getHeaderValue(headers, "x-custom-repo-urls") ||
				providerConfig.trae_repo_url,
			"x-device-brand":
				getHeaderValue(headers, "x-device-brand") || headers["X-Device-Brand"],
			"x-device-cpu":
				getHeaderValue(headers, "x-device-cpu") || headers["X-Device-Cpu"],
			"x-device-id":
				getHeaderValue(headers, "x-device-id") || headers["X-Device-Id"],
			"x-device-type":
				getHeaderValue(headers, "x-device-type") || headers["X-Device-Type"],
			"x-ide-version-code":
				getHeaderValue(headers, "x-ide-version-code") ||
				headers["x-ide-version-code"],
			"x-lgw-req-sdk-type":
				getHeaderValue(headers, "x-lgw-req-sdk-type") || "3",
			"x-machine-id":
				getHeaderValue(headers, "x-machine-id") || headers["X-Machine-Id"],
			"x-os-version":
				getHeaderValue(headers, "x-os-version") || headers["X-Os-Version"],
			"package-type": getHeaderValue(headers, "package-type") || "stable_cn",
			"app-version": getHeaderValue(headers, "app-version"),
			accept: getHeaderValue(headers, "accept") || "*/*",
		}).filter(([, value]) => value !== undefined),
	);
}

function resolveContext(providerConfig, requestedModel) {
	const discovered = discoverContextFromLogs(providerConfig) || {};
	const capture = parseCurlCapture(providerConfig)?.body || {};
	return {
		modelName:
			providerConfig.trae_model_name ||
			capture.model ||
			discovered.modelName ||
			requestedModel ||
			providerConfig.default_model,
		sessionId:
			providerConfig.trae_session_id ||
			discovered.sessionId ||
			`proxy_${Date.now().toString(36)}`,
		currentDocumentUri:
			providerConfig.trae_current_document_uri ||
			discovered.currentDocumentUri ||
			DEFAULT_CURRENT_DOCUMENT_URI,
		currentDocumentPosition:
			providerConfig.trae_current_document_position ||
			discovered.currentDocumentPosition ||
			DEFAULT_CURRENT_DOCUMENT_POSITION,
		captureBody: capture,
	};
}

function getLastUserText(messages = []) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") {
			return flattenContent(messages[index].content);
		}
	}
	return "";
}

function buildTraeQueryBlocks(content) {
	if (typeof content === "string") {
		return content
			.split("\n")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => ({ type: "text", content: part }));
	}

	if (Array.isArray(content)) {
		const blocks = [];
		for (const item of content) {
			if (typeof item === "string") {
				blocks.push({ type: "text", content: item });
				continue;
			}
			if (item?.type === "text" && item.text) {
				blocks.push({ type: "text", content: item.text });
				continue;
			}
			if (item?.type === "tool_result" && item.content) {
				blocks.push({ type: "text", content: String(item.content) });
			}
		}
		return blocks;
	}

	return [];
}

function flattenContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (item?.type === "text") return item.text || "";
				if (item?.type === "tool_result") return item.content || "";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function buildHistoryQueries(messages = []) {
	const userMessages = messages.filter((message) => message?.role === "user");
	if (userMessages.length <= 1) return [];
	return userMessages
		.slice(0, -1)
		.map((message) => buildTraeQueryBlocks(message.content))
		.filter((blocks) => blocks.length > 0);
}

function buildEnvMetadata(providerConfig, headers, runtimeContext) {
	const captureEnv = runtimeContext.captureBody?.env_metadata || {};
	const ideVersionFromAgent =
		getHeaderValue(headers, "user-agent")?.match(/TraeCN\/([^\s]+)/)?.[1] ||
		null;
	return {
		ide_version:
			providerConfig.trae_ide_version ||
			captureEnv.ide_version ||
			ideVersionFromAgent ||
			"1.107.1",
		environment:
			providerConfig.trae_environment ||
			captureEnv.environment ||
			"trae_desktop_bytedance",
		extension_version:
			providerConfig.trae_extension_version ||
			captureEnv.extension_version ||
			"3.0.1-alpha.79",
		version_code: Number(
			providerConfig.trae_version_code ||
				captureEnv.version_code ||
				getHeaderValue(headers, "x-ide-version-code") ||
				20260212,
		),
		region: providerConfig.trae_region || captureEnv.region || "cn",
		channel: providerConfig.trae_channel || captureEnv.channel || "icube-ai",
		repo_url:
			providerConfig.trae_repo_url ||
			captureEnv.repo_url ||
			getHeaderValue(headers, "x-custom-repo-urls") ||
			"",
	};
}

function buildRequestPayload(providerConfig, headers, context, runtimeContext) {
	const { anthropicBody, content } = context;
	const captureBody = runtimeContext.captureBody || {};
	const userMessage =
		anthropicBody.messages.filter((message) => message?.role === "user").at(-1)
			?.content || content;
	const userQueryBlocks = buildTraeQueryBlocks(userMessage);
	const historyQueries = buildHistoryQueries(anthropicBody.messages);
	const fallbackFilePathEdit =
		runtimeContext.currentDocumentUri &&
		runtimeContext.currentDocumentUri !== DEFAULT_CURRENT_DOCUMENT_URI
			? [runtimeContext.currentDocumentUri]
			: [];

	return {
		env_metadata: buildEnvMetadata(providerConfig, headers, runtimeContext),
		model: resolveRequestedModel(providerConfig, context.model, captureBody),
		target_language:
			providerConfig.trae_target_language ||
			captureBody.target_language ||
			"text",
		user_query: JSON.stringify(
			userQueryBlocks.length > 0
				? userQueryBlocks
				: [
						{
							type: "text",
							content: getLastUserText(anthropicBody.messages) || content,
						},
					],
		),
		history_queries: JSON.stringify(historyQueries),
		file_path_edit:
			captureBody.file_path_edit ||
			captureBody.filePathEdit ||
			JSON.stringify(fallbackFilePathEdit),
		symbol: captureBody.symbol || captureBody.Symbol || "[]",
		symbols: captureBody.symbols || "{}",
	};
}

function decodeEntities(text) {
	return String(text)
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function extractJsonText(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => extractJsonText(item))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value === "object") {
		if (Array.isArray(value.choices)) {
			const choiceText = value.choices
				.map((choice) =>
					extractJsonText(choice?.text || choice?.delta || choice?.message),
				)
				.filter(Boolean)
				.join("");
			if (choiceText) return choiceText;
		}
		for (const key of [
			"text",
			"content",
			"completion",
			"response",
			"message",
			"answer",
			"delta",
			"output_text",
		]) {
			const result = extractJsonText(value[key]);
			if (result) return result;
		}
	}
	return "";
}

function extractContentAttributes(rawText) {
	const matches = [...rawText.matchAll(/content="([^"]*)"/g)];
	return matches
		.map((match) => decodeEntities(match[1]))
		.filter((value) => value && value !== "<eos>")
		.join("");
}

function sanitizeParsedText(text) {
	const normalized = String(text)
		.replaceAll(/<type="stop" content="<eos>"\s*\/>/g, "")
		.replaceAll("<eos>", "")
		.trim();
	if (!normalized || normalized === "success") return "";
	return normalized;
}

function extractSSEPayload(rawText) {
	const pieces = [];
	const errors = [];
	for (const block of rawText.split(/\n\n+/)) {
		let eventName = null;
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("event:")) {
				eventName = line.slice(6).trim();
				continue;
			}
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				const parsed = JSON.parse(payload);
				if (eventName === "error") {
					errors.push(extractJsonText(parsed) || parsed.error || payload);
					continue;
				}
				if (eventName && eventName !== "output") {
					continue;
				}
				const jsonText = extractJsonText(parsed);
				if (jsonText) pieces.push(jsonText);
				continue;
			} catch {}
			if (eventName === "error") {
				errors.push(payload);
				continue;
			}
			const attrText = extractContentAttributes(payload);
			if (attrText) pieces.push(attrText);
		}
	}
	return {
		text: sanitizeParsedText(pieces.join("")),
		error: errors.filter(Boolean).join(" | "),
	};
}

function parseTraeResponse(rawText) {
	const text = rawText.trim();
	if (!text) return { text: "", error: "" };

	const ssePayload = extractSSEPayload(text);
	if (text.includes("event:") && text.includes("data:")) return ssePayload;

	const attrText = extractContentAttributes(text);
	if (attrText) return { text: sanitizeParsedText(attrText), error: "" };

	try {
		const parsed = JSON.parse(text);
		const jsonText = extractJsonText(parsed);
		const errorText = parsed?.error || parsed?.message || "";
		if (jsonText || errorText) {
			return {
				text: sanitizeParsedText(jsonText),
				error: jsonText ? "" : String(errorText),
			};
		}
	} catch {}

	return {
		text: sanitizeParsedText(
			decodeEntities(text.slice(0, MAX_RESPONSE_PREVIEW)),
		),
		error: "",
	};
}

function makeSyntheticResponse(text, meta = {}) {
	return new Response(
		JSON.stringify({
			text,
			provider: "trae-cn",
			meta,
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function createTraceId() {
	const trace = crypto.randomUUID().replaceAll("-", "");
	return `00-${trace}${trace.slice(0, 16)}-${trace.slice(0, 16)}-01`;
}

function applyPerRequestHeaders(headers) {
	return {
		...headers,
		"x-request-id": crypto.randomUUID(),
		"x-tt-trace-id": createTraceId(),
	};
}

async function sendTraeRequest(
	providerConfig,
	headers,
	payload,
	runtimeContext,
) {
	const url = getSuperCompletionUrl(providerConfig);
	reportDebugEvent("B", "providers/trae-cn.js:sendTraeRequest:before", "sending trae request", {
		requestedModel: payload.model,
		targetLanguage: payload.target_language,
		userQueryPreview: String(payload.user_query || "").slice(0, 120),
		historyQueriesLength: String(payload.history_queries || "").length,
		filePathEditLength: String(payload.file_path_edit || "").length,
		sessionId: runtimeContext.sessionId,
	});
	const response = await fetch(url, {
		method: "POST",
		headers: applyPerRequestHeaders(headers),
		body: JSON.stringify(payload),
	});
	const rawText = await response.text();
	const parsed = parseTraeResponse(rawText);
	reportDebugEvent("C", "providers/trae-cn.js:sendTraeRequest:after", "received trae response", {
		status: response.status,
		ok: response.ok,
		rawTextPreview: rawText.slice(0, 240),
		parsedTextLength: parsed.text.length,
		parsedErrorLength: parsed.error.length,
	});

	if (providerConfig.log_requests) {
		console.log(
			"[trae-cn] candidate:",
			"super_completion_query",
			"status:",
			response.status,
			"body:",
			rawText.slice(0, 500),
		);
	}

	return {
		ok: response.ok,
		status: response.status,
		candidate: "captured-template",
		rawText,
		parsedText: parsed.text,
		parsedError: parsed.error,
		meta: {
			url,
			webBaseUrl: getBaseUrl(providerConfig),
			sessionId: runtimeContext.sessionId,
			modelName: runtimeContext.modelName,
			requestContentLength: JSON.stringify(payload).length,
		},
	};
}

async function callTrae(providerConfig, context) {
	const headers = resolveAuthHeaders(providerConfig);
	if (!getHeaderValue(headers, "authorization")) {
		throw new Error(
			"Trae CN auth headers not found. Provide `trae_access_token`/`trae_headers` in config or keep Trae CN completion logs available for auto-discovery.",
		);
	}

	const runtimeContext = resolveContext(providerConfig, context.model);
	const payload = buildRequestPayload(
		providerConfig,
		headers,
		context,
		runtimeContext,
	);
	reportDebugEvent("D", "providers/trae-cn.js:callTrae:payload", "built trae payload", {
		contextModel: context.model,
		resolvedModel: payload.model,
		contentPreview: String(context.content || "").slice(0, 120),
		currentDocumentUri: runtimeContext.currentDocumentUri,
	});

	const result = await sendTraeRequest(
		providerConfig,
		headers,
		payload,
		runtimeContext,
	);
	if (result.ok && result.parsedText && !result.parsedError) {
		return makeSyntheticResponse(result.parsedText, {
			...result.meta,
			candidate: result.candidate,
			mode: "captured-template",
		});
	}

	throw new Error(
		`Trae CN super_completion_query failed: ${result.status} ${(result.parsedError || result.rawText).slice(0, 240)}`,
	);
}

export function createTraeCnProvider(providerConfig) {
	return {
		name: "trae-cn",
		listModels() {
			return listModels(providerConfig);
		},
		getPublicInfo() {
			const headers = resolveAuthHeaders(providerConfig);
			return {
				has_session: Boolean(getHeaderValue(headers, "authorization")),
				upstream: getSuperCompletionUrl(providerConfig),
			};
		},
		async call(context) {
			return callTrae(providerConfig, context);
		},
		parseEvent() {
			return { kind: "ignore" };
		},
	};
}

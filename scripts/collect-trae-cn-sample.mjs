#!/usr/bin/env node

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DEFAULT_LOG_ROOT = join(
	homedir(),
	"Library",
	"Application Support",
	"Trae CN",
	"logs",
);
const DEFAULT_OUT_DIR = resolve(process.cwd(), "tmp", "trae-cn-sample");

const args = parseArgs(process.argv.slice(2));
const logRoot = resolve(
	args["log-root"] || process.env.TRAE_CN_LOG_ROOT || DEFAULT_LOG_ROOT,
);
const outDir = resolve(args.out || DEFAULT_OUT_DIR);
const includeSecrets = Boolean(args["include-secrets"]);
const mode = args.mode || "snapshot";
const watchSeconds = Number(args["watch-seconds"] || 180);
const pollMs = Number(args["poll-ms"] || 2000);

if (!existsSync(logRoot)) {
	console.error(`Trae CN logs not found: ${logRoot}`);
	process.exit(1);
}

if (mode === "snapshot") {
	const result = collectSnapshot(logRoot, { includeSecrets });
	writeOutputs(outDir, result);
	printSummary(result, outDir);
	process.exit(0);
}

if (mode === "watch") {
	const result = await watchForSamples(logRoot, {
		includeSecrets,
		watchSeconds,
		pollMs,
	});
	writeOutputs(outDir, result);
	printSummary(result, outDir);
	process.exit(0);
}

console.error(`Unsupported mode: ${mode}`);
process.exit(1);

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i += 1) {
		const part = argv[i];
		if (!part.startsWith("--")) continue;
		const key = part.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
			continue;
		}
		parsed[key] = next;
		i += 1;
	}
	return parsed;
}

function collectSnapshot(rootDir, options) {
	const latestSessionDir = getLatestSessionDir(rootDir);
	const files = getCandidateFiles(latestSessionDir);
	return buildResult({
		rootDir,
		latestSessionDir,
		files,
		includeSecrets: options.includeSecrets,
		mode: "snapshot",
	});
}

async function watchForSamples(rootDir, options) {
	const startedAt = Date.now();
	let latestResult = collectSnapshot(rootDir, options);
	while (Date.now() - startedAt < options.watchSeconds * 1000) {
		if (hasUsefulSamples(latestResult)) {
			return {
				...latestResult,
				mode: "watch",
				watch: { completed: true, durationMs: Date.now() - startedAt },
			};
		}
		await delay(options.pollMs);
		latestResult = collectSnapshot(rootDir, options);
	}
	return {
		...latestResult,
		mode: "watch",
		watch: { completed: false, durationMs: Date.now() - startedAt },
	};
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function getLatestSessionDir(rootDir) {
	const entries = readdirSync(rootDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
		.map((entry) => ({
			name: entry.name,
			path: join(rootDir, entry.name),
			mtimeMs: statSync(join(rootDir, entry.name)).mtimeMs,
		}))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (!entries.length) {
		throw new Error(`No Trae CN session logs found in ${rootDir}`);
	}
	return entries[0].path;
}

function getCandidateFiles(sessionDir) {
	const files = [];
	walk(sessionDir, (filePath) => {
		if (!filePath.endsWith(".log")) return;
		if (
			filePath.endsWith("renderer.log") ||
			filePath.endsWith("completion.log") ||
			filePath.endsWith("Trae AI Code Completion.log") ||
			filePath.endsWith("Trae AI Code Client.log") ||
			basename(filePath).startsWith("ai-agent_")
		) {
			files.push(filePath);
		}
	});
	return files.sort();
}

function walk(dir, onFile) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(fullPath, onFile);
			continue;
		}
		onFile(fullPath);
	}
}

function buildResult({
	rootDir,
	latestSessionDir,
	files,
	includeSecrets,
	mode,
}) {
	const evidence = {
		source: {
			mode,
			rootDir,
			latestSessionDir,
			filesScanned: files,
		},
		internalEvents: {
			createSession: [],
			sendMessage: [],
			getMessages: [],
			sessions: [],
		},
		externalRequests: [],
		externalHeaders: [],
		completions: [],
		notes: [],
	};

	for (const filePath of files) {
		const text = readFileSync(filePath, "utf8");
		const lines = text.split(/\r?\n/);
		parseFile(filePath, lines, evidence, { includeSecrets });
	}

	const summary = summarizeEvidence(evidence, { includeSecrets });
	return { summary, evidence };
}

function parseFile(filePath, lines, evidence, options) {
	for (const line of lines) {
		if (!line) continue;

		parseRendererLine(filePath, line, evidence);
		parseAIAgentLine(filePath, line, evidence);
		parseCompletionLine(filePath, line, evidence, options);
	}
}

function parseRendererLine(filePath, line, evidence) {
	if (!filePath.endsWith("renderer.log")) return;

	const transportMatch = line.match(
		/\[TransportManager\] executeRequest(?: success)?, ([^,]+) ([^,]+), ([a-f0-9-]{36}), cost: (\d+)/i,
	);
	if (transportMatch) {
		const [, service, method, requestId, cost] = transportMatch;
		const item = {
			filePath,
			service,
			method,
			requestId,
			costMs: Number(cost),
			line,
		};
		if (service === "chat" && method === "create_session")
			evidence.internalEvents.createSession.push(item);
		if (service === "chat" && method === "send_message")
			evidence.internalEvents.sendMessage.push(item);
		if (service === "chat" && method === "get_messages")
			evidence.internalEvents.getMessages.push(item);
		if (service === "chat" && /sessions/.test(method))
			evidence.internalEvents.sessions.push(item);
	}

	const triggerMatch = line.match(
		/event:\s+code_comp_trigger\s+; params:\s+(\{.+\})/,
	);
	if (triggerMatch) {
		try {
			const params = JSON.parse(triggerMatch[1]);
			evidence.completions.push({
				filePath,
				type: "trigger",
				chatModel: params.chat_model,
				sessionId: params.session_id,
				messageId: params.message_id,
				triggerMode: params.trigger_mode,
				line,
			});
		} catch {}
	}

	const completeMatch = line.match(
		/event:\s+code_comp_complete_shown\s+; params:\s+(\{.+\})/,
	);
	if (completeMatch) {
		try {
			const params = JSON.parse(completeMatch[1]);
			evidence.completions.push({
				filePath,
				type: "complete",
				chatModel: params.chat_model,
				sessionId: params.session_id,
				messageId: params.message_id,
				requestRoundCount: params.request_round_count,
				toolCount: params.tool_count,
				duration: params.duration,
				line,
			});
		} catch {}
	}
}

function parseAIAgentLine(filePath, line, evidence) {
	if (!basename(filePath).startsWith("ai-agent_")) return;

	const routeMatch = line.match(/route:\s+service:"([^"]+)", method:"([^"]+)"/);
	if (routeMatch && routeMatch[1] === "chat") {
		evidence.internalEvents.sessions.push({
			filePath,
			service: routeMatch[1],
			method: routeMatch[2],
			line,
		});
	}

	const requestUrlMatch = line.match(
		/\[HTTPClient\] request url (\S+) trace_id="([^"]+)" req=([A-Za-z0-9_]+)/,
	);
	if (requestUrlMatch) {
		evidence.externalRequests.push({
			filePath,
			url: requestUrlMatch[1],
			traceId: requestUrlMatch[2],
			requestName: requestUrlMatch[3],
			source: "http-client",
			line,
		});
	}

	const sendMatch = line.match(
		/send: calling Fetch id=([^,]+), method=([A-Z]+), url=(\S+), headers_count=(\d+), body_len=(\d+) trace_id="([^"]+)".* req=([A-Za-z0-9_]+)/,
	);
	if (sendMatch) {
		evidence.externalRequests.push({
			filePath,
			requestId: sendMatch[1],
			method: sendMatch[2],
			url: sendMatch[3],
			headersCount: Number(sendMatch[4]),
			bodyLength: Number(sendMatch[5]),
			traceId: sendMatch[6],
			requestName: sendMatch[7],
			source: "aha-fetch",
			line,
		});
	}

	const addHeaderMatch = line.match(
		/\[HTTPClient\] add_header (\{.+\}) trace_id="([^"]+)".* req=([A-Za-z0-9_]+)/,
	);
	if (addHeaderMatch) {
		try {
			const headers = JSON.parse(addHeaderMatch[1]);
			evidence.externalHeaders.push({
				filePath,
				traceId: addHeaderMatch[2],
				requestName: addHeaderMatch[3],
				source: "ai-agent",
				headers,
				line,
			});
		} catch {}
	}

	const responseMatch = line.match(
		/\[AhaNetHTTPClient\] url (\S+), response_headers: (\{.+\}) trace_id="([^"]+)".* req=([A-Za-z0-9_]+)/,
	);
	if (responseMatch) {
		try {
			const headers = JSON.parse(responseMatch[2]);
			evidence.externalRequests.push({
				filePath,
				url: responseMatch[1],
				traceId: responseMatch[3],
				requestName: responseMatch[4],
				responseHeaders: headers,
				source: "aha-response",
				line,
			});
		} catch {}
	}
}

function parseCompletionLine(filePath, line, evidence, options) {
	if (
		!filePath.endsWith("completion.log") &&
		!filePath.endsWith("Trae AI Code Completion.log")
	)
		return;

	const resolvedMatch = line.match(
		/\[ApiManager\] resolved url for ([^:]+): (\S+)/,
	);
	if (resolvedMatch) {
		evidence.externalRequests.push({
			filePath,
			endpoint: resolvedMatch[1],
			url: resolvedMatch[2],
			source: "completion-api-manager",
			line,
		});
	}

	const requestMatch = line.match(
		/request: (\S+), agent: ([^,]+), proxy: (.+)$/,
	);
	if (requestMatch) {
		evidence.externalRequests.push({
			filePath,
			url: requestMatch[1],
			agent: requestMatch[2],
			proxy: requestMatch[3],
			source: "completion-request",
			line,
		});
	}

	const headersMatch = line.match(/request: headers: (\{.+\})$/);
	if (headersMatch) {
		try {
			const headers = JSON.parse(headersMatch[1]);
			evidence.externalHeaders.push({
				filePath,
				source: "completion-log",
				headers: options.includeSecrets ? headers : redactHeaders(headers),
				rawHeaderKeys: Object.keys(headers),
				line,
			});
		} catch {}
	}
}

function summarizeEvidence(evidence, options) {
	const createSessionCount = evidence.internalEvents.createSession.length;
	const chatSendCount = evidence.internalEvents.sendMessage.length;

	const completionUrls = unique(
		evidence.externalRequests
			.filter((item) => item.url?.includes("copilot-cn.bytedance.net"))
			.map((item) => item.url),
	);

	const likelyMessageUrls = completionUrls.filter((url) =>
		/super_completion_query/.test(url),
	);
	const likelySessionUrls = completionUrls.filter((url) =>
		/session|conversation|chat\/create|create_session/.test(url),
	);

	const sampleHeaders = evidence.externalHeaders.find(
		(item) =>
			item.rawHeaderKeys?.includes("Authorization") ||
			Object.keys(item.headers || {}).includes("Authorization"),
	);

	const result = {
		latestSessionDir: evidence.source.latestSessionDir,
		filesScanned: evidence.source.filesScanned.length,
		createSession: {
			observedInternalEvent: createSessionCount > 0,
			internalEventCount: createSessionCount,
			likelyExternalUrl: likelySessionUrls[0] || null,
			note:
				createSessionCount > 0 && !likelySessionUrls.length
					? "Observed `chat create_session` only as local transport events; no external HTTP create-session URL found in logs."
					: null,
		},
		sendMessage: {
			observedInternalEvent: chatSendCount > 0,
			likelyExternalUrl: likelyMessageUrls[0] || null,
			allCandidateUrls: likelyMessageUrls,
		},
		authHeaders: sampleHeaders
			? {
					source: sampleHeaders.source,
					headers: sampleHeaders.headers,
					headerKeys:
						sampleHeaders.rawHeaderKeys ||
						Object.keys(sampleHeaders.headers || {}),
					redacted: !options.includeSecrets,
				}
			: null,
		response: {
			observedResponseHeaders: evidence.externalRequests.some(
				(item) => item.responseHeaders,
			),
			observedSSEHint:
				evidence.externalHeaders.some((item) =>
					String(item.headers?.["Content-Type"] || "").includes(
						"text/event-stream",
					),
				) ||
				evidence.externalHeaders.some((item) =>
					String(item.headers?.["content-type"] || "").includes(
						"text/event-stream",
					),
				),
			note: "Current Trae CN logs expose request URLs, headers, methods and response headers/status well; raw response body/SSE chunk payloads are not present in the scanned logs.",
		},
		completionContext: summarizeCompletions(evidence.completions),
	};

	if (!result.sendMessage.likelyExternalUrl) {
		evidence.notes.push(
			"No obvious send-message URL in ai-chat transport logs; using completion plugin URL candidates instead.",
		);
	}
	if (!result.authHeaders) {
		evidence.notes.push("No auth header block found in completion logs.");
	}

	return result;
}

function summarizeCompletions(completions) {
	const triggers = completions.filter((item) => item.type === "trigger");
	const completes = completions.filter((item) => item.type === "complete");
	return {
		triggerCount: triggers.length,
		completeCount: completes.length,
		latestTrigger: triggers.at(-1) || null,
		latestComplete: completes.at(-1) || null,
	};
}

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

function redactHeaders(headers) {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			shouldRedact(key) ? redactValue(value) : value,
		]),
	);
}

function shouldRedact(key) {
	return /authorization|token|cookie|jwt/i.test(key);
}

function redactValue(value) {
	const text = String(value);
	if (text.length <= 12) return "<redacted>";
	return `${text.slice(0, 8)}...<redacted>...${text.slice(-6)}`;
}

function hasUsefulSamples(result) {
	return Boolean(
		result.summary.createSession.observedInternalEvent ||
			result.summary.sendMessage.likelyExternalUrl ||
			result.summary.authHeaders,
	);
}

function writeOutputs(outDir, result) {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, "summary.json"),
		`${JSON.stringify(result.summary, null, 2)}\n`,
	);
	writeFileSync(
		join(outDir, "evidence.json"),
		`${JSON.stringify(result.evidence, null, 2)}\n`,
	);
}

function printSummary(result, outDir) {
	console.log(`Trae CN sample written to ${outDir}`);
	console.log(`latestSessionDir: ${result.summary.latestSessionDir}`);
	console.log(
		`createSession observed: ${result.summary.createSession.observedInternalEvent}`,
	);
	console.log(
		`message URL: ${result.summary.sendMessage.likelyExternalUrl || "not found"}`,
	);
	console.log(
		`auth headers: ${result.summary.authHeaders ? "found" : "not found"}`,
	);
	console.log(`response SSE hint: ${result.summary.response.observedSSEHint}`);
	if (result.summary.createSession.note)
		console.log(`note: ${result.summary.createSession.note}`);
	if (result.summary.response.note)
		console.log(`response note: ${result.summary.response.note}`);
}

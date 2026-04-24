#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

const DEFAULT_APP_PATH = "/Applications/Trae CN.app";
const DEFAULT_APP_NAME = "Trae CN";
const DEFAULT_DEBUG_PORT = 9229;
const DEFAULT_OUT_DIR = resolve(process.cwd(), "tmp", "trae-cn-body-capture");
const DEFAULT_URL_SUBSTRING = "super_completion_query";
const DEFAULT_START_TIMEOUT_MS = 30000;
const DEFAULT_TARGET_WAIT_TIMEOUT_MS = 20000;
const DEFAULT_TARGET_WAIT_INTERVAL_MS = 1000;

const args = parseArgs(process.argv.slice(2));
const config = createConfig(args);
const capturesFile = join(config.outDir, "captures.ndjson");
const latestFile = join(config.outDir, "latest.json");
const metaFile = join(config.outDir, "meta.json");
const debugTraceFile = join(config.outDir, "debug-trace.ndjson");

function createConfig(parsedArgs) {
	return {
		appPath:
			parsedArgs["app-path"] ||
			process.env.TRAE_CN_APP_PATH ||
			DEFAULT_APP_PATH,
		appName:
			parsedArgs["app-name"] ||
			process.env.TRAE_CN_APP_NAME ||
			DEFAULT_APP_NAME,
		debugPort: Number(
			parsedArgs.port || process.env.TRAE_CN_DEBUG_PORT || DEFAULT_DEBUG_PORT,
		),
		outDir: resolve(parsedArgs.out || DEFAULT_OUT_DIR),
		urlSubstring:
			parsedArgs["url-substring"] ||
			process.env.TRAE_CN_CAPTURE_URL_SUBSTRING ||
			DEFAULT_URL_SUBSTRING,
		includeSecrets: Boolean(parsedArgs["include-secrets"]),
		launch: Boolean(parsedArgs.launch),
		attachOnly: Boolean(parsedArgs["attach-only"]),
		once: !parsedArgs["no-once"],
		quitExisting: !parsedArgs["no-quit"],
		timeoutMs: Number(
			parsedArgs.timeout ||
				process.env.TRAE_CN_CAPTURE_TIMEOUT_MS ||
				DEFAULT_START_TIMEOUT_MS,
		),
		targetWaitTimeoutMs: Number(
			parsedArgs["target-timeout"] ||
				process.env.TRAE_CN_TARGET_TIMEOUT_MS ||
				DEFAULT_TARGET_WAIT_TIMEOUT_MS,
		),
		targetWaitIntervalMs: Number(
			parsedArgs["target-interval"] ||
				process.env.TRAE_CN_TARGET_INTERVAL_MS ||
				DEFAULT_TARGET_WAIT_INTERVAL_MS,
		),
	};
}

async function main() {
	if (args.help) {
		printHelp();
		return;
	}

	mkdirSync(config.outDir, { recursive: true });
	traceDebug("session.start", {
		debugPort: config.debugPort,
		urlSubstring: config.urlSubstring,
		launch: config.launch,
		attachOnly: config.attachOnly,
		outDir: config.outDir,
	});

	if (config.launch && config.attachOnly) {
		throw new Error("`--launch` and `--attach-only` cannot be used together.");
	}

	if (config.launch) {
		traceDebug("session.relaunch", {
			appPath: config.appPath,
			appName: config.appName,
		});
		await relaunchTrae(config);
	}

	const browserWsUrl = await waitForBrowserDebuggerUrl(
		config.debugPort,
		config.timeoutMs,
	);
	traceDebug("session.debugger-ready", { browserWsUrl });
	const capture = await captureFirstMatchingRequest(browserWsUrl, config);

	writeCapture(capture, config);
	printSummary(capture, config);
}

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current.startsWith("--")) continue;
		const key = current.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			parsed[key] = true;
			continue;
		}
		parsed[key] = next;
		index += 1;
	}
	return parsed;
}

function printHelp() {
	console.log(`Usage:
  node scripts/capture-trae-cn-body.mjs --launch
  node scripts/capture-trae-cn-body.mjs --attach-only

Options:
  --launch             Relaunch Trae CN with remote debugging enabled
  --attach-only        Attach to an already running Trae CN debug port
  --port <number>      Remote debugging port, default ${DEFAULT_DEBUG_PORT}
  --out <dir>          Output directory, default ${DEFAULT_OUT_DIR}
  --url-substring <s>  Match request URL substring, default "${DEFAULT_URL_SUBSTRING}"
  --include-secrets    Keep Authorization/Cookie headers unredacted
  --no-once            Keep listening after first matching capture
  --no-quit            Do not quit existing Trae CN before relaunch
  --timeout <ms>       Wait timeout for debugger port, default ${DEFAULT_START_TIMEOUT_MS}
`);
}

async function relaunchTrae(runtimeConfig) {
	if (!existsSync(runtimeConfig.appPath)) {
		throw new Error(`Trae CN app not found: ${runtimeConfig.appPath}`);
	}

	if (runtimeConfig.quitExisting) {
		try {
			await execFileAsync("osascript", [
				"-e",
				`tell application "${runtimeConfig.appName}" to quit`,
			]);
		} catch {}
		await delay(1500);
	}

	const openArgs = [
		"-na",
		runtimeConfig.appPath,
		"--args",
		`--remote-debugging-port=${runtimeConfig.debugPort}`,
		"--remote-allow-origins=*",
	];

	await execFileAsync("open", openArgs);
}

async function waitForBrowserDebuggerUrl(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const json = await response.json();
			if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
		} catch (error) {
			lastError = error;
		}
		await delay(500);
	}
	const attachHint = [
		`Timed out waiting for Trae CN remote debugger on port ${port}.`,
		lastError ? `Last error: ${lastError.message}` : null,
		"",
		"`--attach-only` requires Trae CN to already be started with:",
		`  --remote-debugging-port=${port}`,
		"",
		"Recommended next step:",
		"  npm run trae:capture:body",
		"",
		"If you want to keep using attach mode, first start Trae CN manually with the remote debugging port enabled, then rerun:",
		"  npm run trae:capture:attach",
	]
		.filter(Boolean)
		.join("\n");
	throw new Error(attachHint);
}

async function captureFirstMatchingRequest(browserWsUrl, runtimeConfig) {
	const client = new CDPClient(browserWsUrl);
	const networkRequests = new Map();
	const attachedSessions = new Set();

	const result = await new Promise((resolveCapture, rejectCapture) => {
		let settled = false;

		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolveCapture(value);
		};

		const fail = (error) => {
			if (settled) return;
			settled = true;
			rejectCapture(error);
		};

		client.onEvent(async (event) => {
			try {
				if (event.method === "Target.attachedToTarget") {
					const sessionId = event.params.sessionId;
					traceDebug("target.attached", {
						sessionId,
						targetType: event.params.targetInfo?.type || null,
						targetUrl: event.params.targetInfo?.url || null,
						targetTitle: event.params.targetInfo?.title || null,
					});
					if (attachedSessions.has(sessionId)) return;
					attachedSessions.add(sessionId);
					await enableCaptureForSession(
						client,
						sessionId,
						runtimeConfig.urlSubstring,
					);
					return;
				}

				if (event.method === "Target.targetCreated") {
					const targetId = event.params.targetInfo?.targetId;
					traceDebug("target.created", {
						targetId,
						targetType: event.params.targetInfo?.type || null,
						targetUrl: event.params.targetInfo?.url || null,
						targetTitle: event.params.targetInfo?.title || null,
					});
					if (!targetId) return;
					await client.send("Target.attachToTarget", {
						targetId,
						flatten: true,
					});
					return;
				}

				if (event.method === "Network.requestWillBeSent" && event.sessionId) {
					const url = event.params.request?.url || "";
					traceDebug("network.request", {
						sessionId: event.sessionId,
						requestId: event.params.requestId,
						url,
						method: event.params.request?.method || null,
						matched: url.includes(runtimeConfig.urlSubstring),
					});
					if (!url.includes(runtimeConfig.urlSubstring)) return;
					networkRequests.set(event.params.requestId, {
						url,
						method: event.params.request?.method,
						headers: event.params.request?.headers,
						postData: event.params.request?.postData || null,
						timestamp: Date.now(),
						sessionId: event.sessionId,
						type: "network",
						requestId: event.params.requestId,
						frameId: event.params.frameId,
						documentURL: event.params.documentURL,
						initiator: event.params.initiator,
					});
					return;
				}

				if (event.method !== "Fetch.requestPaused") return;
				const pausedUrl = event.params.request?.url || "";
				traceDebug("fetch.paused", {
					sessionId: event.sessionId,
					requestId: event.params.requestId,
					networkId: event.params.networkId || null,
					url: pausedUrl,
					stage: event.params.responseStatusCode ? "response" : "request",
					status: event.params.responseStatusCode || null,
					matched: pausedUrl.includes(runtimeConfig.urlSubstring),
				});
				if (!pausedUrl.includes(runtimeConfig.urlSubstring)) {
					await client.send(
						"Fetch.continueRequest",
						{ requestId: event.params.requestId },
						event.sessionId,
					);
					return;
				}

				const baseCapture = networkRequests.get(event.params.networkId) ||
					networkRequests.get(event.params.requestId) || {
						url: pausedUrl,
						method: event.params.request?.method,
						headers: event.params.request?.headers,
						postData: event.params.request?.postData || null,
						type: "fetch",
					};

				const capture = {
					capturedAt: new Date().toISOString(),
					stage: event.params.responseStatusCode ? "response" : "request",
					request: {
						url: baseCapture.url || pausedUrl,
						method: baseCapture.method || event.params.request?.method,
						headers: redactHeaders(
							baseCapture.headers || event.params.request?.headers || {},
							runtimeConfig.includeSecrets,
						),
						postData:
							baseCapture.postData || event.params.request?.postData || null,
						hasPostData: Boolean(
							baseCapture.postData || event.params.request?.postData,
						),
					},
					response: null,
					debug: {
						requestId: event.params.requestId,
						networkId: event.params.networkId,
						frameId: event.params.frameId || baseCapture.frameId || null,
						resourceType: event.params.resourceType || null,
					},
				};

				if (event.params.responseStatusCode) {
					const body = await safeGetResponseBody(
						client,
						event.sessionId,
						event.params.requestId,
					);
					traceDebug("fetch.response-match", {
						requestId: event.params.requestId,
						networkId: event.params.networkId || null,
						status: event.params.responseStatusCode,
						hasBody: Boolean(body?.body),
					});
					capture.response = {
						status: event.params.responseStatusCode,
						statusText: event.params.responseStatusText,
						headers: redactHeaders(
							event.params.responseHeaders || {},
							runtimeConfig.includeSecrets,
						),
						body: body ? decodeBody(body) : null,
					};
					await client.send(
						"Fetch.continueResponse",
						{ requestId: event.params.requestId },
						event.sessionId,
					);
					traceDebug("capture.finish", {
						requestId: event.params.requestId,
						url: capture.request.url,
						hasPostData: capture.request.hasPostData,
						responseStatus: capture.response?.status || null,
					});
					finish(capture);
					return;
				}

				await client.send(
					"Fetch.continueRequest",
					{ requestId: event.params.requestId },
					event.sessionId,
				);

				if (!runtimeConfig.once) return;
			} catch (error) {
				fail(error);
			}
		});

		client.onError(fail);
		client
			.connect()
			.then(async () => {
				try {
					traceDebug("cdp.connected", { browserWsUrl });
					await client.send("Target.setDiscoverTargets", { discover: true });
					await client.send("Target.setAutoAttach", {
						autoAttach: true,
						waitForDebuggerOnStart: false,
						flatten: true,
					});
					const targets = await waitForTargets(client, runtimeConfig);
					for (const targetInfo of targets) {
						traceDebug("target.snapshot-item", {
							targetId: targetInfo.targetId,
							targetType: targetInfo.type,
							targetUrl: targetInfo.url || null,
							targetTitle: targetInfo.title || null,
						});
						if (!isAttachableTarget(targetInfo)) continue;
						await client.send("Target.attachToTarget", {
							targetId: targetInfo.targetId,
							flatten: true,
						});
					}
				} catch (error) {
					fail(error);
				}
			})
			.catch(fail);
	});

	await client.close();
	return result;
}

function isAttachableTarget(targetInfo) {
	return ["page", "iframe", "worker", "service_worker", "webview"].includes(
		targetInfo.type,
	);
}

async function waitForTargets(client, runtimeConfig) {
	const deadline = Date.now() + runtimeConfig.targetWaitTimeoutMs;
	let attempt = 0;

	while (Date.now() < deadline) {
		attempt += 1;
		const targets = await client.send("Target.getTargets");
		const targetInfos = Array.isArray(targets.targetInfos)
			? targets.targetInfos
			: [];
		traceDebug("target.snapshot", {
			attempt,
			count: targetInfos.length,
		});

		const jsonList = await fetchJsonList(runtimeConfig.debugPort);
		traceDebug("target.json-list", {
			attempt,
			count: jsonList.length,
			items: jsonList.map((item) => ({
				id: item.id || null,
				type: item.type || null,
				title: item.title || null,
				url: item.url || null,
			})),
		});

		if (targetInfos.length > 0) {
			return targetInfos;
		}

		await delay(runtimeConfig.targetWaitIntervalMs);
	}

	return [];
}

async function fetchJsonList(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/list`);
		if (!response.ok) return [];
		const json = await response.json();
		return Array.isArray(json) ? json : [];
	} catch {
		return [];
	}
}

async function enableCaptureForSession(client, sessionId, urlSubstring) {
	await client.send("Network.enable", {}, sessionId);
	await client.send(
		"Fetch.enable",
		{
			patterns: [
				{
					urlPattern: `*${urlSubstring}*`,
					requestStage: "Request",
				},
				{
					urlPattern: `*${urlSubstring}*`,
					requestStage: "Response",
				},
			],
		},
		sessionId,
	);
}

async function safeGetResponseBody(client, sessionId, requestId) {
	try {
		return await client.send("Fetch.getResponseBody", { requestId }, sessionId);
	} catch {
		return null;
	}
}

function decodeBody(bodyResult) {
	if (!bodyResult?.body) return null;
	if (bodyResult.base64Encoded) {
		return Buffer.from(bodyResult.body, "base64").toString("utf8");
	}
	return bodyResult.body;
}

function writeCapture(capture, runtimeConfig) {
	const serialized = JSON.stringify(capture, null, 2);
	writeFileSync(latestFile, `${serialized}\n`);
	appendFileSync(capturesFile, `${JSON.stringify(capture)}\n`);
	writeFileSync(
		metaFile,
		`${JSON.stringify(
			{
				appPath: runtimeConfig.appPath,
				appName: runtimeConfig.appName,
				debugPort: runtimeConfig.debugPort,
				urlSubstring: runtimeConfig.urlSubstring,
				includeSecrets: runtimeConfig.includeSecrets,
				capturedAt: capture.capturedAt,
			},
			null,
			2,
		)}\n`,
	);
}

function traceDebug(event, payload = {}) {
	try {
		appendFileSync(
			debugTraceFile,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				event,
				...payload,
			})}\n`,
		);
	} catch {}
}

function printSummary(capture, runtimeConfig) {
	console.log(`Capture written to ${latestFile}`);
	console.log(`url: ${capture.request.url}`);
	console.log(`method: ${capture.request.method}`);
	console.log(`hasPostData: ${capture.request.hasPostData}`);
	console.log(`debugPort: ${runtimeConfig.debugPort}`);
	if (capture.response) {
		console.log(`responseStatus: ${capture.response.status}`);
	}
}

function redactHeaders(headers, includeSecrets) {
	return Object.fromEntries(
		Object.entries(headers || {}).map(([key, value]) => [
			key,
			includeSecrets || !shouldRedactHeader(key)
				? value
				: redactValue(String(value)),
		]),
	);
}

function shouldRedactHeader(key) {
	return /authorization|cookie|token|jwt/i.test(key);
}

function redactValue(value) {
	if (value.length <= 12) return "<redacted>";
	return `${value.slice(0, 8)}...<redacted>...${value.slice(-6)}`;
}

class CDPClient {
	constructor(browserWsUrl) {
		this.browserWsUrl = browserWsUrl;
		this.ws = null;
		this.nextId = 1;
		this.pending = new Map();
		this.eventHandlers = [];
		this.errorHandlers = [];
	}

	connect() {
		return new Promise((resolveConnect, rejectConnect) => {
			this.ws = new WebSocket(this.browserWsUrl);
			this.ws.once("open", resolveConnect);
			this.ws.once("error", rejectConnect);
			this.ws.on("message", (message) =>
				this.handleMessage(message.toString()),
			);
			this.ws.on("error", (error) =>
				this.errorHandlers.forEach((handler) => {
					handler(error);
				}),
			);
			this.ws.on("close", () => {
				const error = new Error("CDP websocket closed");
				for (const pending of this.pending.values()) {
					pending.reject(error);
				}
				this.pending.clear();
			});
		});
	}

	onEvent(handler) {
		this.eventHandlers.push(handler);
	}

	onError(handler) {
		this.errorHandlers.push(handler);
	}

	send(method, params = {}, sessionId) {
		const id = this.nextId++;
		const payload = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolveSend, rejectSend) => {
			this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
			this.ws.send(JSON.stringify(payload));
		});
	}

	handleMessage(rawMessage) {
		const message = JSON.parse(rawMessage);
		if (message.id) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(
					new Error(
						`${message.error.message || "CDP error"} (${message.error.code})`,
					),
				);
				return;
			}
			pending.resolve(message.result || {});
			return;
		}
		for (const handler of this.eventHandlers) {
			handler(message);
		}
	}

	async close() {
		if (!this.ws) return;
		await new Promise((resolveClose) => {
			this.ws.once("close", resolveClose);
			this.ws.close();
		});
	}
}

await main();

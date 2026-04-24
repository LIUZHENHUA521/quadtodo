#!/usr/bin/env node

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import WebSocket from "ws";

const DEFAULT_DEBUG_PORT = 9229;
const DEFAULT_OUT_DIR = resolve(
	process.cwd(),
	"tmp",
	"trae-cn-body-capture",
	"chat-payload",
);

async function main() {
	const outDir = DEFAULT_OUT_DIR;
	mkdirSync(outDir, { recursive: true });
	const latestFile = join(outDir, "latest.json");
	if (existsSync(latestFile)) {
		unlinkSync(latestFile);
	}

	const targets = await fetchJson(`http://127.0.0.1:${DEFAULT_DEBUG_PORT}/json/list`);
	const hookTargets = targets.filter(
		(target) =>
			(target.type === "page" &&
				String(target.url || "").includes("workbench.html")) ||
			target.type === "worker",
	);
	if (hookTargets.length === 0) {
		throw new Error("No Trae workbench page/worker found on remote debugger.");
	}
	const captures = [];
	const clients = [];

	for (const target of hookTargets) {
		if (!target.webSocketDebuggerUrl) continue;
		const client = new CDPClient(target.webSocketDebuggerUrl);
		await client.connect();
		if (target.type === "page") {
			await client.send("Page.enable");
		}
		await client.send("Network.enable");
		await client.send("Runtime.enable");
		if (target.type === "page") {
			await client.send("Page.reload", { ignoreCache: true });
			await delay(800);
		}
		await client.send("Runtime.evaluate", {
			expression: buildHookExpression(),
			replMode: false,
			awaitPromise: false,
			returnByValue: true,
		});
		client.onEvent((event) => {
			if (event.method !== "Network.requestWillBeSent") return;
			const request = event.params?.request;
			const url = String(request?.url || "");
			if (!/copilot-cn\.bytedance\.net/.test(url)) return;
			const payload = {
				kind: "network-request",
				payload: {
					url,
					method: request?.method,
					headers: request?.headers || {},
					postData: request?.postData || null,
				},
				textPreview: JSON.stringify({
					url,
					method: request?.method,
					hasPostData: Boolean(request?.postData),
					postDataPreview: String(request?.postData || "").slice(0, 4000),
				}),
			};
			captures.push(payload);
			writeFileSync(latestFile, `${JSON.stringify(payload, null, 2)}\n`);
			console.log("Captured network payload to", latestFile);
		});
		clients.push(client);
	}

	console.log(`Hook installed on ${clients.length} target(s). Trigger one chat send in Trae.`);
	await waitForCapture(clients, captures, outDir, 120000);
	await Promise.all(clients.map((client) => client.close()));
}

function buildHookExpression() {
	return `
(() => {
  globalThis.__TRAE_CHAT_PAYLOADS__ = [];
  globalThis.__TRAE_CHAT_HOOKED_PATHS__ = [];
  const safeClone = (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { unserializable: true, type: typeof value };
    }
  };
  const maybeReport = (kind, payload) => {
    try {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (!text) return;
      if (/mcs\.zijieapi\.com|code_comp_complete_shown|task_notif_banner_show|icube_task_monitor/i.test(text)) {
        return;
      }
      if (!/copilot-cn\.bytedance\.net|api\\/agent\\/v3\\/create_agent_task|service.?[:=].?["']?chat|method.?[:=].?["']?chat|create_agent_task|commit_toolcall_result|pending_message|raw_messages/i.test(text)) {
        return;
      }
      globalThis.__TRAE_CHAT_PAYLOADS__.push({
        kind,
        payload: safeClone(payload),
        textPreview: text.slice(0, 4000),
      });
    } catch {}
  };

  const shouldHookFunction = (fn) => {
    try {
      const source = Function.prototype.toString.call(fn);
      if (/\[native code\]/.test(source)) return false;
      return /doRequestWithStream|executeRequest|service|method|pending_message|raw_messages|create_agent_task|chatStream|chat/i.test(source);
    } catch {
      return false;
    }
  };

  const wrapFunction = (holder, key, path) => {
    const original = holder[key];
    if (typeof original !== 'function') return false;
    if (!shouldHookFunction(original)) return false;
    if (original.__traeHooked) return true;
    const wrapped = new Proxy(original, {
      apply(target, thisArg, args) {
        maybeReport('function-call', { path, args });
        return Reflect.apply(target, thisArg, args);
      }
    });
    wrapped.__traeHooked = true;
    holder[key] = wrapped;
    globalThis.__TRAE_CHAT_HOOKED_PATHS__.push(path);
    return true;
  };

  const seen = new WeakSet();
  const walk = (obj, path, depth) => {
    if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 3) return;
    seen.add(obj);
    for (const key of Object.keys(obj)) {
      const childPath = path ? path + '.' + key : key;
      try {
        wrapFunction(obj, key, childPath);
      } catch {}
      let value;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      if (value && typeof value === 'object') {
        walk(value, childPath, depth + 1);
      }
    }
  };

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args) {
        maybeReport('fetch', args);
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  if (globalThis.XMLHttpRequest && globalThis.XMLHttpRequest.prototype) {
    const originalOpen = globalThis.XMLHttpRequest.prototype.open;
    const originalSend = globalThis.XMLHttpRequest.prototype.send;
    globalThis.XMLHttpRequest.prototype.open = function(...args) {
      this.__traeOpenArgs = args;
      return originalOpen.apply(this, args);
    };
    globalThis.XMLHttpRequest.prototype.send = function(...args) {
      maybeReport('xhr', { openArgs: this.__traeOpenArgs, sendArgs: args });
      return originalSend.apply(this, args);
    };
  }

  if (globalThis.WebSocket && globalThis.WebSocket.prototype) {
    const originalWsSend = globalThis.WebSocket.prototype.send;
    globalThis.WebSocket.prototype.send = function(...args) {
      maybeReport('websocket', args);
      return originalWsSend.apply(this, args);
    };
  }

  if (globalThis.MessagePort && globalThis.MessagePort.prototype) {
    const originalPostMessage = globalThis.MessagePort.prototype.postMessage;
    globalThis.MessagePort.prototype.postMessage = function(...args) {
      maybeReport('message-port', args);
      return originalPostMessage.apply(this, args);
    };
  }

  if (globalThis.window && typeof globalThis.window.postMessage === 'function') {
    const originalWindowPostMessage = globalThis.window.postMessage;
    globalThis.window.postMessage = new Proxy(originalWindowPostMessage, {
      apply(target, thisArg, args) {
        maybeReport('window-postMessage', args);
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  walk(globalThis, 'globalThis', 0);

  'ok';
})()
`;
}

async function waitForCapture(clients, captures, outDir, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const client of clients) {
			const result = await client.send("Runtime.evaluate", {
				expression:
					"JSON.stringify(globalThis.__TRAE_CHAT_PAYLOADS__ || [])",
				returnByValue: true,
				awaitPromise: false,
			});
			const value = result.result?.value;
			if (typeof value !== "string") continue;
			try {
				const parsed = JSON.parse(value);
				if (!Array.isArray(parsed) || parsed.length === 0) continue;
				captures.push(...parsed);
				const latest = parsed.at(-1);
				writeFileSync(
					join(outDir, "latest.json"),
					`${JSON.stringify(latest, null, 2)}\n`,
				);
				console.log(
					"Captured chat payload to",
					join(outDir, "latest.json"),
				);
				return latest;
			} catch {}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error("Timed out waiting for chat payload capture.");
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
	return response.json();
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class CDPClient {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.socket = null;
		this.nextId = 1;
		this.pending = new Map();
		this.eventHandlers = new Set();
	}

	connect() {
		return new Promise((resolveConnect, rejectConnect) => {
			this.socket = new WebSocket(this.wsUrl);
			this.socket.once("open", resolveConnect);
			this.socket.once("error", rejectConnect);
			this.socket.on("message", (raw) => {
				const message = JSON.parse(String(raw));
				if (typeof message.id === "number") {
					const pending = this.pending.get(message.id);
					if (!pending) return;
					this.pending.delete(message.id);
					if (message.error) {
						pending.reject(new Error(message.error.message));
						return;
					}
					pending.resolve(message.result || {});
					return;
				}
				for (const handler of this.eventHandlers) handler(message);
			});
		});
	}

	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolveSend, rejectSend) => {
			this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	onEvent(handler) {
		this.eventHandlers.add(handler);
	}

	close() {
		return new Promise((resolveClose) => {
			if (!this.socket) {
				resolveClose();
				return;
			}
			this.socket.once("close", resolveClose);
			this.socket.close();
		});
	}
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});

import { createServer } from "node:http";
import { readFileSync, watchFile } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");

let config = loadConfig();

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error("[config] Failed to load config.json:", e.message);
    process.exit(1);
  }
}

watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    console.log("[config] Reloaded config.json");
  } catch {
    console.warn("[config] Failed to reload, keeping old config");
  }
});

function resolveModel(requested) {
  const fallback = config.default_model || "gpt-5.4";
  if (!requested) return fallback;
  if (config.model_map?.[requested]) return config.model_map[requested];
  const supported = new Set([fallback, ...Object.values(config.model_map || {})]);
  if (supported.has(requested)) return requested;
  return fallback;
}

function miraUrl(path) {
  return `${config.mira_base_url || "https://mira.byteintl.net"}${path}`;
}

function getCompletionDefaults(model) {
  const defaults = config.completion_defaults || {};
  const nestedConfig = defaults.config && typeof defaults.config === "object" ? defaults.config : {};
  return {
    messageType: defaults.messageType ?? 1,
    summaryAgent: defaults.summaryAgent || model,
    dataSources: Array.isArray(defaults.dataSources) ? defaults.dataSources : ["manus"],
    comprehensive: defaults.comprehensive ?? 1,
    config: {
      online: nestedConfig.online ?? true,
      mode: nestedConfig.mode || "quick",
      model: nestedConfig.model || model,
      tool_list: Array.isArray(nestedConfig.tool_list) ? nestedConfig.tool_list : [],
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

function buildMiraToolList(anthropicTools = []) {
  const defaults = config.completion_defaults?.config?.tool_list || [];
  const toolMap = config.anthropic_tool_map || {};
  const mapped = [];
  for (const tool of anthropicTools) {
    const mappedTool = toolMap?.[tool.name];
    if (!mappedTool) continue;
    mapped.push(mappedTool);
  }
  return mergeToolList(defaults, mapped);
}

function miraHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Cookie: `mira_session=${config.mira_session}`,
    ...extra,
  };
}

async function miraCreateChat(model) {
  const resp = await fetch(miraUrl("/mira/api/v1/chat/create"), {
    method: "POST",
    headers: miraHeaders(),
    body: JSON.stringify({ model_key: model }),
  });
  const text = await resp.text();
  if (config.log_requests) console.log("[mira] chat/create", resp.status, text.slice(0, 500));
  if (!resp.ok) throw new Error(`chat/create failed: ${resp.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.code && data.code !== 0) throw new Error(`chat/create: ${data.msg || "unknown error"} (code=${data.code})`);
  const chatId = data.sessionItem?.sessionId || data.data?.chat_id || data.chat_id || data.id || data.data?.id;
  //#region debug-point mira-create-result
  if (config.log_requests) {
    console.log("[mira][debug] create parsed:", JSON.stringify({
      code: data.code,
      msg: data.msg,
      keys: Object.keys(data || {}),
      dataKeys: data?.data && typeof data.data === "object" ? Object.keys(data.data) : null,
      chatId,
    }).slice(0, 500));
  }
  //#endregion debug-point mira-create-result
  return chatId;
}

async function miraCompleteChat(chatId, content, model, anthropicTools = []) {
  const completionDefaults = getCompletionDefaults(model);
  const payload = {
    sessionId: chatId,
    content,
    messageType: completionDefaults.messageType,
    summaryAgent: completionDefaults.summaryAgent,
    dataSources: completionDefaults.dataSources,
    comprehensive: completionDefaults.comprehensive,
    config: completionDefaults.config,
  };
  payload.config.tool_list = buildMiraToolList(anthropicTools);
  if (config.log_requests) console.log("[mira] chat/completion payload:", JSON.stringify(payload).slice(0, 500));
  const resp = await fetch(miraUrl("/mira/api/v1/chat/completion"), {
    method: "POST",
    headers: miraHeaders({ Accept: "text/event-stream" }),
    body: JSON.stringify(payload),
  });
  if (config.log_requests) console.log("[mira] chat/completion", resp.status, resp.headers.get("content-type"));
  if (!resp.ok) return resp;
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json") && !ct.includes("text/event-stream")) {
    const text = await resp.text();
    //#region debug-point mira-completion-json-response
    if (config.log_requests) {
      console.log("[mira][debug] completion json response:", text.slice(0, 1000));
    }
    //#endregion debug-point mira-completion-json-response
    try {
      const data = JSON.parse(text);
      if (data.code && data.code !== 0) throw new Error(`chat/completion: ${data.msg || "unknown error"} (code=${data.code})`);
    } catch (e) {
      if (e.message.startsWith("chat/completion:")) throw e;
    }
    return new Response(text, { status: resp.status, headers: resp.headers });
  }
  return resp;
}

function flattenMessages(messages, system) {
  let systemText = "";
  if (typeof system === "string") systemText = system;
  else if (Array.isArray(system)) systemText = system.map((b) => b.text || "").join("\n");

  const parts = [];
  if (systemText) parts.push(systemText);
  for (const msg of messages || []) {
    const role = msg.role === "assistant" ? "Assistant" : "Human";
    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n");
}

function extractText(parsed) {
  if (typeof parsed === "string") return parsed;
  for (const accessor of [
    (p) => p.content,
    (p) => p.text,
    (p) => p.delta?.content,
    (p) => p.delta?.text,
    (p) => p.choices?.[0]?.delta?.content,
    (p) => p.choices?.[0]?.message?.content,
    (p) => p.message?.content,
    (p) => p.data?.content,
    (p) => p.data?.text,
    (p) => p.answer,
    (p) => p.result,
    (p) => p.response,
  ]) {
    const v = accessor(parsed);
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function sanitizeMiraResultText(text) {
  if (typeof text !== "string" || !text) return "";
  let next = text;
  const cisCtrlEnd = next.lastIndexOf("</cis-ctrl>");
  if (cisCtrlEnd >= 0) {
    next = next.slice(cisCtrlEnd + "</cis-ctrl>".length);
  }
  return next.trim();
}

function parseMiraEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object") return { kind: "ignore" };
  if (parsed.done === true) return { kind: "done" };

  let inner = parsed;
  if (typeof parsed.Message === "string") {
    try {
      inner = JSON.parse(parsed.Message);
    } catch {
      return { kind: "ignore" };
    }
  }

  if (config.log_requests) {
    const eventName = inner?.event || parsed?.event || null;
    if (eventName) console.log("[mira][debug] envelope event:", eventName);
  }

  if (inner?.event === "reason" && inner?.data?.type === "stream_event" && inner?.data?.event?.type) {
    return { kind: "anthropic_event", event: inner.data.event };
  }

  if (inner?.event === "content") {
    const result = sanitizeMiraResultText(inner?.data?.content?.result || "");
    const isError = inner?.data?.content?.is_error === true;
    return { kind: "final_result", text: isError ? `[Mira Error]: ${result}` : result };
  }
  return { kind: "ignore" };
}

function generateId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readMiraSSE(resp, onEvent) {
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || ct.includes("text/plain")) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const parsed = JSON.parse(raw);
          if (config.log_requests) console.log("[mira] SSE:", JSON.stringify(parsed).slice(0, 200));
          onEvent(parseMiraEnvelope(parsed));
        } catch {
          if (raw.length > 0) onEvent({ kind: "raw_text", text: raw });
        }
      }
    }
  } else {
    const body = await resp.text();
    if (config.log_requests) console.log("[mira] response body:", body.slice(0, 500));
    try {
      const text = extractText(JSON.parse(body));
      if (text) onEvent({ kind: "final_result", text });
      else onEvent({ kind: "raw_text", text: body });
    } catch {
      onEvent({ kind: "raw_text", text: body });
    }
  }
}

async function callMira(anthropicBody) {
  const model = resolveModel(anthropicBody.model);
  const content = flattenMessages(anthropicBody.messages, anthropicBody.system);
  //#region debug-point mira-call-input
  if (config.log_requests) {
    console.log("[mira][debug] call input:", JSON.stringify({
      model,
      contentPreview: content.slice(0, 500),
      messageCount: Array.isArray(anthropicBody.messages) ? anthropicBody.messages.length : 0,
      hasSystem: Boolean(anthropicBody.system),
    }).slice(0, 700));
  }
  //#endregion debug-point mira-call-input

  let chatId;
  try {
    chatId = await miraCreateChat(model);
    if (config.log_requests) console.log("[mira] created chat:", chatId);
  } catch (e) {
    console.error("[mira] chat/create error:", e.message);
    throw e;
  }

  const resp = await miraCompleteChat(chatId, content, model, anthropicBody.tools || []);
  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[mira] chat/completion error:", resp.status, errText.slice(0, 300));
    throw new Error(`Mira chat/completion ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return resp;
}

async function handleStream(anthropicBody, res) {
  const model = resolveModel(anthropicBody.model);
  const mid = generateId();
  let sawAnthropicEvent = false;
  let startedSynthetic = false;
  let sawMessageStop = false;
  let forwardToolStream = false;
  let pendingMessageStart = null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const ensureSyntheticStart = () => {
    if (startedSynthetic || sawAnthropicEvent) return;
    startedSynthetic = true;
    sseWrite(res, "message_start", {
      type: "message_start",
      message: {
        id: mid, type: "message", role: "assistant", content: [],
        model, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sseWrite(res, "content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    });
  };

  try {
    const miraResp = await callMira(anthropicBody);
    await readMiraSSE(miraResp, (payload) => {
      if (!payload || payload.kind === "ignore" || payload.kind === "done") return;
      if (payload.kind === "anthropic_event") {
        const event = payload.event;
        if (!event?.type) return;
        if (event.type === "message_start") {
          pendingMessageStart = event;
          return;
        }
        if (event.type === "content_block_start") {
          if (event.content_block?.type !== "tool_use") return;
          forwardToolStream = true;
          sawAnthropicEvent = true;
          if (pendingMessageStart) {
            sseWrite(res, pendingMessageStart.type, pendingMessageStart);
          }
          sseWrite(res, event.type, event);
          return;
        }
        if (!forwardToolStream) return;
        if (event.type === "message_stop") sawMessageStop = true;
        sseWrite(res, event.type, event);
        return;
      }
      if ((payload.kind === "final_result" || payload.kind === "raw_text") && payload.text) {
        ensureSyntheticStart();
        sseWrite(res, "content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: payload.text },
        });
      }
    });
  } catch (err) {
    console.error("[proxy] stream error:", err.message);
    ensureSyntheticStart();
    sseWrite(res, "content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: `[Mira Error]: ${err.message}` },
    });
  }

  if (!sawAnthropicEvent && startedSynthetic) {
    sseWrite(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseWrite(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    sseWrite(res, "message_stop", { type: "message_stop" });
  } else if (sawAnthropicEvent && !sawMessageStop) {
    sseWrite(res, "message_stop", { type: "message_stop" });
  }
  res.end();
}

async function handleNonStream(anthropicBody, res) {
  const model = resolveModel(anthropicBody.model);
  const mid = generateId();
  let fullText = "";

  try {
    const miraResp = await callMira(anthropicBody);
    await readMiraSSE(miraResp, (payload) => {
      if (!payload || payload.kind === "ignore" || payload.kind === "done") return;
      if (payload.kind === "anthropic_event") {
        if (payload.event?.type === "content_block_delta" && payload.event?.delta?.type === "text_delta") {
          fullText += payload.event.delta.text || "";
        }
        return;
      }
      if (payload.kind === "final_result" || payload.kind === "raw_text") {
        fullText += payload.text || "";
      }
    });
  } catch (err) {
    fullText = `[Mira Error]: ${err.message}`;
  }

  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({
    id: mid, type: "message", role: "assistant",
    content: [{ type: "text", text: fullText }],
    model, stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, anthropic-version, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${config.proxy_port || 8642}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const hasSess = config.mira_session && config.mira_session !== "YOUR_MIRA_SESSION_COOKIE_HERE";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "mira-proxy", has_session: Boolean(hasSess), model: config.default_model }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const models = Object.values(config.model_map || {});
    const unique = [...new Set([config.default_model, ...models])];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: unique.map((id) => ({ id, object: "model", created: Date.now(), owned_by: "mira" })),
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    try {
      const raw = await collectBody(req);
      const body = JSON.parse(raw);
      if (config.log_requests) console.log("[proxy] /v1/messages:", JSON.stringify(body).slice(0, 300));
      if (body.stream) await handleStream(body, res);
      else await handleNonStream(body, res);
    } catch (err) {
      console.error("[proxy] error:", err);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }));
      }
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const raw = await collectBody(req);
      const body = JSON.parse(raw);
      const systemMsg = body.messages?.find((m) => m.role === "system");
      const anthropicBody = {
        model: body.model,
        messages: body.messages?.filter((m) => m.role !== "system") || [],
        system: systemMsg?.content,
        stream: body.stream,
        tools: body.tools || [],
      };
      if (body.stream) await handleStream(anthropicBody, res);
      else await handleNonStream(anthropicBody, res);
    } catch (err) {
      console.error("[proxy] error:", err);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
      }
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/probe") {
    try {
      const raw = await collectBody(req);
      const { message: testMsg } = JSON.parse(raw || "{}");
      const model = config.default_model || "gpt-5.4";
      const results = {};

      try {
        const chatId = await miraCreateChat(model);
        results.create = { ok: true, chatId };

        const resp = await miraCompleteChat(chatId, testMsg || "hi, just say ok", model);
        const ct = resp.headers.get("content-type") || "";
        let body = "";
        try { body = await resp.text(); } catch { body = "[read error]"; }
        results.completion = { ok: resp.ok, status: resp.status, contentType: ct, body: body.slice(0, 800) };
      } catch (e) {
        results.error = e.message;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", endpoints: ["GET /health", "GET /v1/models", "POST /v1/messages", "POST /v1/chat/completions", "POST /probe"] }));
});

const PORT = config.proxy_port || 8642;
server.listen(PORT, "127.0.0.1", () => {
  const hasSess = config.mira_session && config.mira_session !== "YOUR_MIRA_SESSION_COOKIE_HERE";
  console.log(`
╔════════════════════════════════════════════════════════╗
║              Mira → Anthropic API Proxy                ║
╠════════════════════════════════════════════════════════╣
║  http://127.0.0.1:${String(PORT).padEnd(37)}║
║  Session: ${hasSess ? "✅".padEnd(44) : "❌ set mira_session in config.json".padEnd(44)}║
║  Model:   ${(config.default_model || "gpt-5.4").padEnd(44)}║
║  Mira:    ${(config.mira_base_url || "https://mira.byteintl.net").padEnd(44)}║
╠════════════════════════════════════════════════════════╣
║  Usage with Claude Code:                               ║
║    ANTHROPIC_BASE_URL=http://127.0.0.1:${String(PORT).padEnd(17)}║
║    ANTHROPIC_API_KEY=dummy                             ║
║    claude                                              ║
╚════════════════════════════════════════════════════════╝
`);
});

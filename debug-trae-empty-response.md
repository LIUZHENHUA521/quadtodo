# Debug Session: trae-empty-response

Status: OPEN

## Symptom

- `claude-trae` 启动后，请求进入 Trae 代理。
- 上游 `super_completion_query` 返回 HTTP 200。
- 代理最终报错：`Trae CN super_completion_query failed`。
- 返回体里只看到 `event: meta`、`event: output` 的开头，以及 `choices[0].text` 为 `<`，没有得到完整正文。

## Hypotheses

1. `super_completion_query` 对通用聊天输入并不适配，只有在代码补全上下文足够完整时才会返回有效正文。
2. 当前请求里的 `model` 虽然被上游接受，但实际被路由到了固定的 `S-CodeFusionContext-Query`，所选模型并未真正生效。
3. 上游确实返回了完整 SSE，但代理当前的 SSE 聚合逻辑过早判空或误判为失败。
4. 请求体中的 `user_query`、`history_queries`、`file_path_edit`、`symbol/symbols` 组合仍然不符合 Trae 的真实预期，导致返回 stop sentinel。
5. Claude 的对话消息被 `flattenMessages` 或 `buildTraeQueryBlocks` 转换后，内容形态不符合该接口的预期输入。

## Evidence Log

- Proxy runtime log shows `/v1/messages` requests for `gpt-5.4`, `openrouter-2o`, `openrouter-1o`, and `openrouter-1` all reach upstream and receive HTTP 200.
- For all tested models, upstream response begins with:
  - `event: meta`
  - `data: {"model":"S-CodeFusionContext-Query", ...}`
  - `event: output`
  - `data: {"choices":[{"text":"<"...}]}`
- The upstream-reported model in SSE metadata is consistently `S-CodeFusionContext-Query`, regardless of requested model.
- Current parser only treats aggregated non-empty output text as success; when SSE contains only stop-sentinel-like fragments, `callTrae()` throws `Trae CN super_completion_query failed`.
- Debug server evidence:
  - `contextModel: "gpt-5.4"` -> `resolvedModel: "gpt-5.4"` -> upstream still reports `S-CodeFusionContext-Query`
  - `contextModel: "openrouter-2o"` -> `resolvedModel: "openrouter-2o"` -> upstream still reports `S-CodeFusionContext-Query`
  - Both runs have `status: 200`, `parsedTextLength: 0`, `parsedErrorLength: 0`
  - `userQueryPreview` is a plain text block (`你好`), `targetLanguage` is `text`, and `filePathEditLength` remains small/fixed
- Captured SSE in `tmp/trae-cn-body-capture/res` shows a different flow:
  - `event: task_created`
  - `event: model_config`
  - `event: history`
  - `event: progress_notice`
  - `event: metadata`
  - `event: timing_cost`
  - `event: thought`
- The captured task stream explicitly contains `agent_type: "builder_v3"` and `model: "gpt-5.4"`, which matches Builder-style chat/task execution rather than plain IDE completion querying.
- The same captured stream also contains tool-call lifecycle events, which supports that `commit_toolcall_result` is a follow-up callback endpoint, not the initial user-message entrypoint.
- Captured `create-agent-task` request proves the upstream entrypoint and headers, but `--data-raw` decodes only to a ~62KB high-entropy binary blob:
  - base64-decodable
  - not gzip/zlib
  - entropy ~= 7.997
  - no stable JSON/plaintext markers
- Local persistence is also opaque:
  - `ModularData/ai-chat/database.db` and `ModularData/ai-agent/database.db` are not plain sqlite files
  - `libai_agent.dylib` strings show SQLCipher support, which strongly suggests encrypted local storage
- Renderer and ai-agent logs do expose the pre-network flow:
  - renderer: `send chat` -> `doRequestWithStream start: service=chat, method=chat`
  - ai-agent: `process_ipc_request called!, service: "chat", method: "chat"`
  - ai-agent then resolves contexts (`file_diff`, `code_selection`, `code_user_message`, etc.) before calling `create_agent_task`
- Route A offline reverse-engineering findings narrow the native path further:
  - `create_agent_task` is initiated inside native Rust flow:
    - `route:chat`
    - `create_chat_turn`
    - `do_create_cloud_agent_task`
    - `call_server_generate_plan_item`
    - `start_agent_gen_plan`
  - Relevant binary strings in `libai_agent.dylib` line up with that path:
    - `apps/icube_server_rs/modules/ai-agent/src/handler/chat/mod.rs`
    - `apps/icube_server_rs/modules/ai-agent/src/domain/prompt/chat_builder.rs`
    - `apps/icube_server_rs/modules/ai-agent/src/domain/chat_turn/service.rs`
    - `apps/icube_server_rs/modules/ai-agent/src/domain/plan/simple_service_v2.rs`
    - `apps/icube_server_rs/modules/ai-agent/src/infrastructure/aha_net/transport.rs`
    - `apps/icube_server_rs/crates/ai-config/src/source/aha_ipc_source.rs`
  - The same binary also exposes native chat-related structs that strongly suggest the plaintext request object is assembled locally before encryption:
    - `ClientInfo`
    - `AgentContext`
    - `WorkspaceContext`
    - `StandardChatMessagePart::Text`
    - `HistoryEvent`
    - `TaskCreatedEvent`
  - Serialization/envelope dependencies are mixed:
    - `prost` / `tonic::codec::prost`
    - `pilota` `thrift/compact` and `thrift/binary`
    - `base64`
    - `aes-gcm`
  - This makes the most likely body shape:
    - local Rust DTO / event payload
    - serialized via an internal schema layer (possibly pilota/prost-backed)
    - encrypted in native code
    - base64-encoded for the final HTTP POST body
  - `tmp/requestBody` still looks like ciphertext rather than a plain serialized schema payload:
    - base64 length: `83504`
    - decoded length: `62628`
    - entropy: `7.997104`
    - first bytes have no recognizable JSON / protobuf / thrift magic
    - a `12-byte nonce + 16-byte tag + ciphertext` layout would leave a `62600`-byte core payload, which is consistent with AES-GCM-style framing
  - The captured SSE `history_data.messages` proves the chat history itself is available in plaintext before the HTTP layer, so the opaque part is the native serialization/encryption boundary, not the chat model protocol itself

## Next Step

- Switch investigation focus from `super_completion_query` to `agent/v3/create_agent_task` as the likely primary chat/task entrypoint for Builder mode.
- Route A next step is no longer frontend instrumentation. The next effective offline step is:
  - map the native request object around `create_chat_turn` / `simple_service_v2`
  - determine whether `query_history_state` and adjacent small-body endpoints are plain JSON helpers while `create_agent_task` is the only encrypted upload path
  - keep looking for the local encryptor / encoder boundary, especially any function that combines `ClientInfo` / `AgentContext` / chat messages with `aes-gcm` and `base64`

# [OPEN] mira-chat-messages

## Symptom

- `chat/create` 可调用。
- `chat/messages` 返回：`非常抱歉，服务开小差了，请稍后重试~ (code=-1)`。

## Scope

- Project: `quadtodo`
- Area: `mira-proxy`
- Entrypoint: `mira-proxy/server.js`

## Initial Hypotheses

1. `chat/messages` 的请求体字段不完整，除了 `chat_id` / `content` / `model_key` 还需要额外字段。
2. `chat/create` 返回的会话标识提取错了，导致后续传给 `chat/messages` 的 `chat_id` 实际无效。
3. `chat/messages` 需要特定请求头、cookie 之外的鉴权上下文，当前代理缺失。
4. `flattenMessages()` 拼出来的 `content` 不是 Mira 期望格式，服务端进入兜底错误分支。
5. `chat/create` 与 `chat/messages` 之间还需要一步额外初始化或轮询接口，当前链路缺了一跳。

## Reproduction

- 更新 `mira-proxy/config.json` 中的 `mira_session`
- 启动 `node mira-proxy/server.js`
- 执行 `./claude-mira.sh -p "say hi in one word"`

## Evidence Log

- `chat/create` 成功返回的会话标识位于 `sessionItem.sessionId`，不是 `chat_id`。
- 第一轮代理请求把 `chat_id` 作为字段发给 `chat/messages`，服务返回 `code=-1`。
- 用户补充确认：`chat/messages` 使用字段名 `sessionId`。
- 修正为 `sessionId` 后，`chat/messages` 不再报错，返回：
  `{"messages":[],"pagination":...,"baseResp":{"statusCode":0}}`
- 这说明 `chat/messages` 当前行为更像“查询会话消息列表”，而不是“提交用户消息并触发模型生成”。
- 用户提供真实抓包证据：真正触发模型生成的接口是
  `POST /mira/api/v1/chat/completion`。
- `chat/completion` 返回的是 `text/event-stream`，每条 `data:` 里有一层
  `Message` JSON 字符串，需要二次解析。
- 用户提供真实请求体字段：`messageType`、`summaryAgent`、`dataSources`、
  `comprehensive`、`config.online`、`config.mode`、`config.model`、
  `config.tool_list`。

## Next Step

- 切到 `chat/completion` 并适配双层 SSE，验证是否能正确回放到 Claude Code。

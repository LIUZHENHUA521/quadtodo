# Debug Session: trae-body-capture [OPEN]

## Problem
- Symptom: `npm run trae:capture:body` 已启动并重启 Trae CN，但在 Trae 中触发代码补全后，`tmp/trae-cn-body-capture/` 下没有生成捕获文件。
- Expected: 触发一次目标请求后生成 `latest.json` 和 `captures.ndjson`。

## Hypotheses
- H1: 脚本虽然启动了，但没有真正 attach 到任何 Trae renderer/webview target。
- H2: Trae 触发的并不是 `super_completion_query`，而是别的接口，所以过滤条件过窄。
- H3: 命中了请求，但只在 `Request` 阶段被继续放行，没有在 `Response` 阶段成功收敛并落盘。
- H4: 目标请求发生在未被 `Target.setAutoAttach` 覆盖的 target 类型里。
- H5: 代码补全实际没有走浏览器网络栈，而是走原生/TTNet 通道，CDP 的 `Fetch/Network` 拿不到请求体。

## Evidence Plan
- 检查脚本运行时是否已连接 debugger，并 attach 了 target。
- 检查 Trae 触发补全时是否存在任何目标 URL 的 `requestWillBeSent/requestPaused` 事件。
- 若没有命中 `super_completion_query`，扩大日志面看相邻请求名。
- 根据运行时证据决定是收紧/放宽过滤，还是改抓取方式。

## Status
- Waiting for runtime evidence collection.

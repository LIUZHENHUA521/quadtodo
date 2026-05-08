# Local Terminal Resume Telegram Push Design

## Problem

The web UI has a “本地继续” action that opens macOS Terminal and runs the native AI CLI with `--resume <nativeSessionId>`. That process is outside quadtodo's managed PTY, so the existing Telegram push path does not reliably know which todo/topic should receive Claude Code Stop or SessionEnd hook events. The result is that when the user continues a task locally, Telegram may not receive the AI reply or completion notification.

## Goals

- Keep the current “本地继续” behavior: open native macOS Terminal and resume the native AI session.
- Make local Terminal resumed Claude Code sessions send Stop and SessionEnd notifications back to the original Telegram topic when a Telegram route exists.
- Leave Codex local resume behavior unchanged unless a separate Codex hook path exists.
- Avoid leaking task messages to the Telegram General topic.
- Make missing hook or missing route cases visible instead of silently failing.

## Non-goals

- Do not make Telegram input control the native macOS Terminal process.
- Do not build AppleScript-based stdin bridging into Terminal.
- Do not change “本地继续” into a quadtodo-managed web PTY resume action.

## Recommended approach

Use the existing Claude Code hook path, but inject the same quadtodo environment variables into the native Terminal launch command that managed PTY sessions already receive.

When `/api/system/open-native-ai-resume` launches a native Terminal resume, it should receive enough session context from the UI to export:

- `QUADTODO_SESSION_ID`
- `QUADTODO_TODO_ID`
- `QUADTODO_TODO_TITLE`
- `QUADTODO_URL`
- `QUADTODO_TARGET_USER` when a Telegram route target is available

The resumed CLI process inherits these variables. When Claude Code fires Stop or SessionEnd hooks, `~/.quadtodo/claude-hooks/notify.js` posts to `QUADTODO_URL + /api/openclaw/hook`. The existing hook handler then uses the registered or persisted Telegram route for that session to send the AI reply or end notification to the correct topic.

## UI behavior

The existing “本地继续” button stays as-is conceptually. It can show a success message that makes the scope explicit: local Terminal opened; Telegram push will work when hooks and topic route are configured.

If the selected historical session has no Telegram route, the UI or API should make that clear. The launch may still proceed, but the user should not expect Telegram push for that local Terminal run.

## Data and routing

The native resume request should include the todo id and enough selected AI session metadata for the server to locate the existing todo/session record. Server-side code should derive trusted values from the database where possible instead of trusting client-supplied route data.

For Telegram topic safety:

- If a session route has a `threadId`, send to that topic.
- If a local resume hook has a session id but no registered/persisted route, do not fall back to Telegram General.
- If route re-registration is needed for the native resume session id, it must use the stored `telegramRoute` from the todo's AI session.

## Error handling

- If Claude Code hooks are not installed, expose a warning through the native resume response so the UI can notify the user.
- If the hook script is missing, expose a warning.
- If the historical session lacks `telegramRoute`, expose a warning but still allow native Terminal launch.
- Network or Telegram API failures should continue to be logged by the existing Telegram/openclaw bridge path.

## Testing

Automated tests should cover:

- The native resume endpoint builds a launch command that exports the required `QUADTODO_*` variables before running the resume command.
- The endpoint includes warnings when hooks are not installed or hook script is missing.
- The endpoint does not create a managed PTY session.
- Existing native Terminal reuse behavior based on the scrollback marker remains intact.
- A route-bearing historical session can provide enough context for hook events to resolve the Telegram topic.

Manual acceptance:

1. Start from a todo with a Telegram topic route and native session id.
2. Click “本地继续”.
3. macOS Terminal opens and runs `claude --resume <nativeSessionId>`.
4. After Claude Code completes a response, the corresponding Telegram topic receives the AI reply.
5. When the local session ends, the corresponding topic receives the end notification.
6. No message is sent to General for a topic-bound session.
7. If hooks or route are missing, the UI shows an explicit warning.
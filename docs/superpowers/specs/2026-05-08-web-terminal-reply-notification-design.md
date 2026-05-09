# Web Terminal Reply Notification Design

## Context

quadtodo embeds Claude Code in a PTY and streams output to the Web terminal through `src/routes/ai-terminal.js` and `web/src/AiTerminalMini.tsx`. The current Web terminal only shows a visible completion line when the entire PTY session exits. The `turn_done` WebSocket message exists on the frontend but currently does nothing, and the server does not broadcast it from the Claude Code `Stop` hook path.

Telegram/OpenClaw already treats Claude Code `Stop` as the authoritative signal for "one assistant turn finished" in `src/openclaw-hook.js`. The Web terminal should use the same event source instead of guessing from output inactivity.

## Goal

Make Claude Code reply completion obvious in the quadtodo Web/xterm terminal without breaking existing Telegram/OpenClaw behavior.

The approved direction is progressive enhancement:

1. Always show an obvious xterm completion banner.
2. Show an in-page toast/status highlight when the page is visible.
3. If the page is hidden or unfocused and browser notification permission has been granted, show a browser system notification.
4. Do not play sound by default; leave sound off unless a later setting explicitly enables it.

## Non-goals

- Do not change Telegram/OpenClaw message content or topic lifecycle.
- Do not infer completion by timing out quiet terminal output.
- Do not force browser notification permission prompts on first load.
- Do not add default sound alerts.

## Architecture

### Backend event source

`src/openclaw-hook.js` remains the authoritative handler for Claude Code hook events. After a successful `stop` event is processed, it should notify the AI terminal layer that one turn has completed.

Add a narrow optional dependency to `createOpenClawHookHandler`, for example `aiTerminal.notifyTurnDone(sessionId, payload)`, or add an equivalent method to the existing `aiTerminal` object. This method should broadcast a WebSocket message only to browsers attached to that session.

The hook handler must treat this notification as best effort. If the Web terminal broadcast fails, Telegram/OpenClaw push success should not be converted into a hook failure.

### WebSocket message

Use the existing frontend message type:

```json
{ "type": "turn_done", "status": "idle", "event": "stop" }
```

Optional fields may include `todoTitle` or `timestamp`, but the frontend should not require them for the first implementation.

### Frontend behavior

In `web/src/AiTerminalMini.tsx`, implement the currently empty `turn_done` branch.

On `turn_done`:

- set the session UI to a non-running/idle visual state if the existing status model supports it; otherwise leave the current state unchanged and only show the reminder;
- write a clear ANSI banner into xterm, e.g. `=== AI 回复完成，请验收 ===` with a green or cyan style;
- scroll to bottom when follow-tail is enabled;
- show an in-page toast or visible status highlight;
- if `document.hidden` or the window is not focused and `Notification.permission === 'granted'`, send a browser notification with concise text;
- if permission is `default` or `denied`, do not throw and do not block other reminders.

For permission request UX, expose an explicit user action in the Web UI such as an "开启浏览器通知" button near the terminal reminder/settings area. The first implementation can keep this simple: when permission is not granted, the toast may include guidance to enable notifications, but it should not automatically request permission during normal output handling.

### Completion vs session end

Keep the existing `done` message for PTY exit. Style it consistently with the new turn-completion banner, but keep wording distinct:

- turn completion: `AI 回复完成，请验收`
- session end: `AI 任务已结束` or the current success/failure wording

## Error handling

- If the hook handler cannot find a Web session, skip the Web broadcast and continue existing hook behavior.
- If a browser has disconnected, reuse current WebSocket filtering and do nothing.
- If browser notifications are unsupported, fall back to xterm banner and toast.
- If notification permission is denied, do not re-prompt automatically.
- If the Web notification code throws, catch/log on the frontend and keep the terminal banner visible.

## Risks

- Hook ordering: the Web `turn_done` broadcast should happen only after a real Claude `Stop`, not before content has streamed.
- Duplicate reminders: avoid showing both a `turn_done` banner and a `done` banner for the same final moment as if they meant the same thing. Distinct wording reduces confusion.
- Notification noise: only send browser system notifications when the page is hidden or unfocused.
- Regression risk: do not alter Telegram/OpenClaw push result semantics or topic rename behavior.

## Acceptance criteria

- After each Claude Code assistant turn completes, attached Web terminal clients receive `turn_done`.
- The Web terminal writes a prominent completion banner for `turn_done`.
- The page shows an in-page reminder for `turn_done`.
- When the page is hidden or unfocused and notification permission is granted, a browser system notification is shown.
- When notification permission is not granted or the browser API is unavailable, no error is shown and xterm/toast reminders still work.
- The existing PTY `done` flow still displays task completion/failure correctly.
- Existing Telegram/OpenClaw hook push and Telegram topic status updates continue to pass tests.
- Tests cover the backend Stop-to-`turn_done` broadcast and the frontend `turn_done` reminder behavior where practical.

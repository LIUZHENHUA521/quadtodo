# AI Terminal Scrollback Depth Design

## Background

Cursor-agent sessions can emit enough terminal output that the embedded xterm can no longer scroll back to the earliest visible context. The current frontend xterm scrollback is 5000 lines, and the backend live replay buffer is 512KB, so long sessions naturally lose early output.

## Decision

Use the small scoped "方案 A": increase the live terminal retention limits without changing the terminal protocol or adding a separate history viewer.

- Frontend xterm scrollback: raise from 5000 lines to 30000 lines.
- Backend live replay buffer: raise from 512KB to 5MB.
- Keep existing output trimming behavior: when the backend exceeds the cap, trim oldest chunks until back under the limit.

## Tradeoffs

This improves the common "cannot scroll to the top" case with minimal risk and no UI churn. It is still not infinite history; very long sessions may still need a separate log viewer later. Memory use increases for live sessions, so the frontend limit stays at 30000 rather than 50000 lines.

## Acceptance Criteria

- New cursor-agent/AI terminal sessions retain substantially more scrollback than before.
- WebSocket replay keeps up to 5MB of recent output rather than 512KB.
- Backend trimming still removes oldest chunks after the cap is exceeded.
- Existing scroll-to-bottom, follow-tail, resize, and replay behavior does not regress.
- Targeted tests and web build pass.

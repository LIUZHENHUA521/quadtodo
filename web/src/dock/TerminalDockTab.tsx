// web/src/dock/TerminalDockTab.tsx
import React from 'react'
import SessionViewer from '../SessionViewer'
import { TodoStatus, ResumeSessionInput } from '../api'
import { useTerminalDockStore, DockTab } from '../store/terminalDockStore'

interface Props {
  tab: DockTab
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  visible: boolean   // false -> display:none so xterm instance is preserved
  onSessionRecovered?: (next: string) => void
  onSessionSwitch?: (next: string) => void
  onDone?: (r: { status: string; exitCode?: number }) => void
  onFork?: () => void
}

export default function TerminalDockTab({
  tab, cwd, resumeTarget, visible,
  onSessionRecovered, onSessionSwitch, onDone, onFork,
}: Props) {
  const close = useTerminalDockStore(s => s.close)
  const setStatus = useTerminalDockStore(s => s.setStatus)

  // DockTabStatus -> TodoStatus mapping (Task 9 will wire bidirectional updates via onStatusChange)
  let todoStatus: TodoStatus
  switch (tab.status) {
    case 'pending_reply':
      todoStatus = 'ai_pending'
      break
    case 'running':
      todoStatus = 'ai_running'
      break
    case 'idle':
    case 'closed':
    default:
      todoStatus = 'ai_done'
      break
  }

  return (
    <div
      className="terminal-dock-tab"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      <SessionViewer
        sessionId={tab.id}
        todoId={tab.todoId}
        status={todoStatus}
        cwd={cwd ?? null}
        resumeTarget={resumeTarget ?? null}
        onSessionRecovered={onSessionRecovered}
        onSessionSwitch={onSessionSwitch}
        onClose={() => close(tab.id)}
        onDone={(r) => {
          setStatus(tab.id, r.exitCode === 0 ? 'idle' : 'closed')
          onDone?.(r)
        }}
        onFork={onFork ? () => onFork() : undefined}
        fillHeight
      />
    </div>
  )
}

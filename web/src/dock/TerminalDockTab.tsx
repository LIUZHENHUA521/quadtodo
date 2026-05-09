// web/src/dock/TerminalDockTab.tsx
import React from 'react'
import AiTerminalMini from '../AiTerminalMini'
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
}

export default function TerminalDockTab({
  tab, cwd, resumeTarget, visible,
  onSessionRecovered, onSessionSwitch, onDone,
}: Props) {
  const close = useTerminalDockStore(s => s.close)
  const setStatus = useTerminalDockStore(s => s.setStatus)

  // Map dock-local status back to TodoStatus expected by AiTerminalMini.
  // Stage 3 (Task 9) will refine this with onStatusChange wiring.
  const todoStatus: TodoStatus = (tab.status === 'pending_reply'
    ? 'pending_confirm'
    : 'doing') as TodoStatus

  return (
    <div
      className="terminal-dock-tab"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}
    >
      <AiTerminalMini
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
        fillHeight
      />
    </div>
  )
}

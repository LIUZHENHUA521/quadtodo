import React, { useEffect, useState } from 'react'
import { Segmented } from 'antd'
import AiTerminalMini from './AiTerminalMini'
import TranscriptView from './TranscriptView'
import type { TodoStatus, ResumeSessionInput, TranscriptTurn } from './api'

interface Props {
  sessionId: string
  todoId: string
  status: TodoStatus
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  onSessionRecovered?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
  onFork?: (turnIndex: number, upToTurns: TranscriptTurn[]) => void
}

type ViewMode = 'live' | 'transcript'

export default function SessionViewer(props: Props) {
  const { status, sessionId, todoId, onFork } = props
  const isRunning = status === 'ai_running' || status === 'ai_pending'
  const [mode, setMode] = useState<ViewMode>(isRunning ? 'live' : 'transcript')

  // 会话切换时重置默认 Tab
  useEffect(() => {
    setMode(isRunning ? 'live' : 'transcript')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as ViewMode)}
          options={[
            { label: 'Live 终端', value: 'live' },
            { label: '对话历史', value: 'transcript' },
          ]}
        />
      </div>
      {/* 两个视图都挂载，用 display 切换，避免丢失 xterm / WS 状态 */}
      <div style={{ display: mode === 'live' ? 'block' : 'none' }}>
        <AiTerminalMini {...props} />
      </div>
      <div style={{ display: mode === 'transcript' ? 'block' : 'none', height: 440 }}>
        {mode === 'transcript' && (
          <TranscriptView
            todoId={todoId}
            sessionId={sessionId}
            onFork={onFork}
            autoRefreshMs={isRunning ? 5000 : 0}
          />
        )}
      </div>
    </div>
  )
}

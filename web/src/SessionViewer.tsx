import { useEffect, useState } from 'react'
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
  fillHeight?: boolean
}

type ViewMode = 'live' | 'transcript'

export default function SessionViewer(props: Props) {
  const { status, sessionId, todoId, onFork, fillHeight } = props
  const isRunning = status === 'ai_running' || status === 'ai_pending'
  const [mode, setMode] = useState<ViewMode>('live')

  // 会话切换时重置默认 Tab
  useEffect(() => {
    setMode('live')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      ...(fillHeight ? { height: '100%', flex: 1, minHeight: 0, padding: 8 } : {}),
    }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as ViewMode)}
          options={[
            { label: 'Live 终端', value: 'live' },
            { label: 'Chat 续聊', value: 'transcript' },
          ]}
        />
      </div>
      {/* 两个视图都挂载，用 display 切换，避免丢失 xterm / WS 状态 */}
      <div style={{
        display: mode === 'live' ? 'flex' : 'none',
        ...(fillHeight ? { flex: 1, minHeight: 0, flexDirection: 'column' as const } : {}),
      }}>
        <AiTerminalMini {...props} fillHeight={fillHeight} />
      </div>
      <div style={{
        display: mode === 'transcript' ? 'flex' : 'none',
        flexDirection: 'column',
        ...(fillHeight ? { flex: 1, minHeight: 0 } : {}),
      }}>
        {mode === 'transcript' && (
          <TranscriptView
            todoId={todoId}
            sessionId={sessionId}
            onFork={onFork}
            autoRefreshMs={isRunning ? 5000 : 0}
            resumeTarget={props.resumeTarget}
            onSessionRecovered={props.onSessionRecovered}
            fillHeight={fillHeight}
          />
        )}
      </div>
    </div>
  )
}

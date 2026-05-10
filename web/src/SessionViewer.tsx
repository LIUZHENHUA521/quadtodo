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
  onSessionSwitch?: (nextSessionId: string) => void
  onClose: () => void
  onDone?: (result: { status: string; exitCode?: number }) => void
  onStatusChange?: (status: TodoStatus) => void
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
      display: 'flex', flexDirection: 'column',
      ...(fillHeight ? { height: '100%', flex: 1, minHeight: 0 } : {}),
    }}>
      {/* Live/Log 切换：紧凑独立行（避免与 AiTerminalMini 顶部工具条按钮重叠） */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0, padding: '2px 6px 0' }}>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as ViewMode)}
          options={[
            { label: 'Live 终端', value: 'live' },
            { label: 'Log 日志', value: 'transcript' },
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
      {/* Chat 视图始终挂载，仅用 display 切换，保证轮询在后台持续、输入/滚动状态不丢 */}
      <div style={{
        display: mode === 'transcript' ? 'flex' : 'none',
        flexDirection: 'column',
        ...(fillHeight ? { flex: 1, minHeight: 0 } : {}),
      }}>
        <TranscriptView
          todoId={todoId}
          sessionId={sessionId}
          onFork={onFork}
          autoRefreshMs={isRunning ? 2000 : 0}
          resumeTarget={props.resumeTarget}
          onSessionRecovered={props.onSessionRecovered}
          fillHeight={fillHeight}
          cwd={props.cwd}
          active={mode === 'transcript'}
        />
      </div>
    </div>
  )
}

import { useState } from 'react'
import { Tooltip, Button, message } from 'antd'
import { useTranslation } from 'react-i18next'
import type { SessionMeta } from '../../store/aiSessionStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import type { AiStatus, AiTool } from '../../api'
import { startAiExec, ApiError } from '../../api'
import { deriveAiState, AI_STATE_PILL_LABEL_KEY } from '../../design/aiPresentationState'
import { useUnreadStore, isSessionUnread } from '../../store/unreadStore'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  /** live session 还没出现时用 todo.aiSession.status 兜底，避免首启动闪 idle */
  fallbackStatus?: AiStatus
  /** 进程已死时，用 todo 快照填上标题/工具/cwd/nativeSessionId */
  fallbackTitle?: string
  fallbackTool?: AiTool
  fallbackNativeSessionId?: string | null
  fallbackCwd?: string | null
  /** True 表示 live SessionMeta 缺失但快照里有 AiSession——这是 Resume 按钮的显示前提 */
  liveMissing?: boolean
  /** Resume 成功（拿到新 sessionId）后通知父组件做 focus 切换 */
  onResumed?: (nextSessionId: string) => void
  onClose: () => void
}

export function FocusSubbar({
  todoId,
  session,
  fallbackStatus,
  fallbackTitle,
  fallbackTool,
  fallbackNativeSessionId,
  fallbackCwd,
  liveMissing,
  onResumed,
  onClose,
}: Props) {
  const { t } = useTranslation(['session'])
  const title = session?.todoTitle ?? fallbackTitle ?? t('session:focusSubbar.untitled')
  const tool = session?.tool ?? fallbackTool ?? 'ai'
  const fullSessionId = session?.sessionId ?? null
  const sessionShortId = fullSessionId ? fullSessionId.slice(0, 8) : '—'
  const quadrant = session?.quadrant ?? 0

  const lastSeen = useUnreadStore((s) =>
    session?.sessionId ? s.lastSeenAt.get(session.sessionId) : undefined,
  )
  const markSeen = useUnreadStore((s) => s.markSeen)
  const unread = isSessionUnread(session?.lastTurnDoneAt, lastSeen)
  const state = deriveAiState(session?.effectiveStatus ?? session?.status ?? fallbackStatus, unread, session?.awaitingReply ?? false)
  const statusLabel = t(AI_STATE_PILL_LABEL_KEY[state])

  const quadColor =
    quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'
  const canConfirm = !!session?.sessionId && state === 'pending'
  const handleConfirm = () => {
    if (!session?.sessionId) return
    markSeen(session.sessionId, session.lastTurnDoneAt || Date.now())
  }

  const [resuming, setResuming] = useState(false)
  const canShowResume = Boolean(liveMissing)
  // 仅 claude 支持原生 --resume；codex/cursor 没有 nativeSessionId 概念
  const resumeDisabledReason: string | null = !canShowResume
    ? null
    : tool !== 'claude'
      ? t('session:focusSubbar.resumeDisabledTool')
      : !fallbackNativeSessionId
        ? t('session:focusSubbar.resumeDisabledNoNative')
        : null
  const resumeEnabled = canShowResume && !resumeDisabledReason && !resuming
  const handleResume = async () => {
    if (!resumeEnabled || !fallbackNativeSessionId || tool !== 'claude') return
    setResuming(true)
    try {
      const { sessionId: nextSessionId } = await startAiExec({
        todoId,
        prompt: '',
        tool: 'claude',
        cwd: fallbackCwd || undefined,
        resumeNativeId: fallbackNativeSessionId,
      })
      // Optimistic upsert：后端 poll（每 3s）追上之前，先在 aiSessionStore 占位，
      // 避免 SessionFocus 出现"focusedSessionId 变了但 live session 还没到"的空窗 flash。
      const optimistic: SessionMeta = {
        sessionId: nextSessionId,
        todoId,
        todoTitle: fallbackTitle ?? title,
        quadrant: (session?.quadrant ?? 0) as SessionMeta['quadrant'],
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: fallbackNativeSessionId,
        cwd: fallbackCwd ?? null,
        startedAt: Date.now(),
        completedAt: null,
        lastOutputAt: null,
        outputBytesTotal: 0,
      }
      useAiSessionStore.getState().upsertSession(optimistic)
      message.success(t('session:focusSubbar.resumeOk'))
      onResumed?.(nextSessionId)
    } catch (err: any) {
      const reason = err instanceof ApiError
        ? (err.body?.message || err.body?.code || err.message)
        : (err?.message || 'unknown')
      message.error(t('session:focusSubbar.resumeFailed', { reason }))
    } finally {
      setResuming(false)
    }
  }

  return (
    <div className="focus-subbar">
      <button className="focus-back" onClick={onClose} aria-label={t('session:focusSubbar.backToGrid')}>
        <span>←</span>
        <span>{t('session:focusSubbar.grid')}</span>
      </button>
      <div className="focus-task-title">
        <span
          className="quad-dot"
          style={{ background: quadColor, boxShadow: `0 0 8px ${quadColor}` }}
        />
        <span>{title}</span>
        <span className="focus-task-id">#{sessionShortId}</span>
      </div>
      <div className="focus-actions">
        <span className={`pill-select ${state === 'pending' ? 'pending' : state === 'running' ? 'green' : 'idle'}`}>
          {tool} · {statusLabel}
        </span>
        {canConfirm && (
          <button className="focus-confirm-btn" onClick={handleConfirm}>
            {t('session:focusSubbar.confirm')}
          </button>
        )}
        {canShowResume && (
          <Tooltip title={resumeDisabledReason || t('session:focusSubbar.resumeTooltip')}>
            {/* span 包一层让 disabled button 的 tooltip 仍能触发 */}
            <span>
              <Button
                size="small"
                type="primary"
                ghost
                loading={resuming}
                disabled={!resumeEnabled}
                onClick={handleResume}
                style={{ height: 22, paddingInline: 10 }}
              >
                {t('session:focusSubbar.resume')}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={t('session:focusSubbar.closeEsc')}>
          <button className="focus-icon-btn" onClick={onClose} aria-label={t('session:focusSubbar.close')}>✕</button>
        </Tooltip>
      </div>
    </div>
  )
}

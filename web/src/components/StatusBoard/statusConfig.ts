import type { AiStatus, AiSession, Todo } from '../../api'

/**
 * 状态看板的列定义：
 *   - backlog: 渲染 TodoCard（Todo 本身），手动 Done 才离开
 *   - in_progress / needs_input / idle: 渲染 SessionCard（按 session.status 派生）
 *
 * `done` / `stopped` / `failed` 状态的 session 不在板上，仅可通过 TodoCard 的 History 入口找回。
 * `done` / `missed` 状态的 todo 默认不显示，由"显示已完成"开关控制。
 */
export type StatusColumnId = 'backlog' | 'in_progress' | 'needs_input' | 'idle'

export interface StatusColumnConfig {
  id: StatusColumnId
  labelKey: string                  // i18n: todo:column.<id>
  fallbackLabel: string             // 兜底文案（开发期无 i18n 时用）
  accentVar: string                 // CSS 变量名，用于 dot / 边框 / 计数
  matchesSession?: (s: AiSession) => boolean
}

export const STATUS_COLUMNS: StatusColumnConfig[] = [
  {
    id: 'backlog',
    labelKey: 'todo:column.backlog',
    fallbackLabel: '待办',
    accentVar: '--sb-idle',
  },
  {
    id: 'in_progress',
    labelKey: 'todo:column.inProgress',
    fallbackLabel: '运行中',
    accentVar: '--sb-running',
    matchesSession: (s) => s.status === 'running',
  },
  {
    id: 'needs_input',
    labelKey: 'todo:column.needsInput',
    fallbackLabel: '需确认',
    accentVar: '--sb-warn',
    matchesSession: (s) => s.status === 'pending_confirm',
  },
  {
    id: 'idle',
    labelKey: 'todo:column.idle',
    fallbackLabel: '已空闲',
    accentVar: '--sb-calm',
    matchesSession: (s) => s.status === 'idle',
  },
]

export function backlogTodos(todos: Todo[], showDone: boolean): Todo[] {
  return todos.filter((t) => {
    if (t.parentId) return false                          // 子待办平铺：parent_id 旧数据当成顶层
    if (t.status === 'missed') return false
    if (!showDone && t.status === 'done') return false
    return true
  })
}

export interface SessionEntry {
  session: AiSession
  todo: Todo
}

/** 把每个 todo 的所有 active sessions 拍平 + 反查 parent todo —— 方便右 3 列直接渲染 */
export function flattenSessions(todos: Todo[]): SessionEntry[] {
  const out: SessionEntry[] = []
  for (const t of todos) {
    if (!Array.isArray(t.aiSessions) || t.aiSessions.length === 0) {
      if (t.aiSession) out.push({ session: t.aiSession, todo: t })
      continue
    }
    for (const s of t.aiSessions) {
      out.push({ session: s, todo: t })
    }
  }
  return out
}

export function sessionsByColumn(entries: SessionEntry[]): Record<StatusColumnId, SessionEntry[]> {
  const out: Record<StatusColumnId, SessionEntry[]> = {
    backlog: [],
    in_progress: [],
    needs_input: [],
    idle: [],
  }
  for (const col of STATUS_COLUMNS) {
    if (!col.matchesSession) continue
    out[col.id] = entries.filter(({ session }) => col.matchesSession!(session))
  }
  // 同一列按 startedAt desc（最新在上）
  for (const k of Object.keys(out) as StatusColumnId[]) {
    out[k].sort((a, b) => (b.session.startedAt || 0) - (a.session.startedAt || 0))
  }
  return out
}

export function activeSessionCount(t: Todo): { active: number; total: number } {
  const all = Array.isArray(t.aiSessions) ? t.aiSessions : (t.aiSession ? [t.aiSession] : [])
  const active = all.filter((s) =>
    s.status === 'running' || s.status === 'pending_confirm' || s.status === 'idle',
  ).length
  return { active, total: all.length }
}

const TERMINAL_STATUSES: AiStatus[] = ['done', 'failed', 'stopped']
export function isTerminalSession(s: AiSession): boolean {
  return TERMINAL_STATUSES.includes(s.status)
}

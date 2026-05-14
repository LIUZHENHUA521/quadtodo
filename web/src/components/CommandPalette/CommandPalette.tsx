import { useState, useEffect, useMemo } from 'react'
import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { useDispatchStore } from '../../store/dispatchStore'
import { useTheme } from '../../design/ThemeProvider'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { listTodos, updateTodo, type Todo } from '../../api'
import { useAppMessages } from '../../design/useAppMessages'
import { BarChart3, BookOpen, Settings, BarChartBig, FileText, Send, Moon } from 'lucide-react'
import { AgentIcon } from '../AgentIcon'
import './CommandPalette.css'

type Page = 'default' | 'aiPicker'

interface TodoEntry {
  id: string
  sessionId: string
  title: string
  status?: string
  tool?: string
  quad?: number | string
}

const JUMP_LIST_EMPTY_LIMIT = 20

export function CommandPalette() {
  const { t } = useTranslation(['palette', 'todo', 'errors'])
  const open = useDispatchStore((s) => s.palette)
  const closePalette = useDispatchStore((s) => s.closePalette)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const { toggle: toggleTheme } = useTheme()
  const { message } = useAppMessages()

  const [page, setPage] = useState<Page>('default')
  const [aiTool, setAiTool] = useState<'claude' | 'codex' | 'cursor'>('claude')
  const [search, setSearch] = useState('')
  const [allTodos, setAllTodos] = useState<Todo[]>([])

  useEffect(() => {
    if (open) {
      setPage('default')
      setSearch('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listTodos({}).then((list) => {
      if (!cancelled) setAllTodos(list)
    }).catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [open])

  const sessions = useAiSessionStore((s) => s.sessions)

  const parentTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const todo of allTodos) if (!todo.parentId) map.set(todo.id, todo.title)
    return map
  }, [allTodos])

  const jumpListTodos = useMemo(() => {
    if (search.trim()) return allTodos
    return [...allTodos]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, JUMP_LIST_EMPTY_LIMIT)
  }, [allTodos, search])

  function jumpToTodo(todo: Todo) {
    if (todo.status === 'done') {
      useDispatchStore.getState().setBoardFilter('all')
    }
    useDispatchStore.getState().setJumpTo(todo.id)
    closePalette()
  }

  async function restoreTodo(todo: Todo) {
    closePalette()
    try {
      await updateTodo(todo.id, { status: 'todo' })
      useDispatchStore.getState().setBoardFilter('todo')
      useDispatchStore.getState().signal('refreshTodos')
      useDispatchStore.getState().setJumpTo(todo.id)
      message.success(t('todo:restoredToTodo'))
    } catch (e: any) {
      message.error(e?.message || t('errors:restoreFailed'))
    }
  }

  const seenTodoIds = new Set<string>()
  const todos: TodoEntry[] = []
  sessions.forEach((s) => {
    const id = s.todoId ?? s.sessionId
    if (!id || seenTodoIds.has(id)) return
    seenTodoIds.add(id)
    todos.push({
      id,
      sessionId: s.sessionId,
      title: s.todoTitle,
      status: s.status,
      tool: s.tool,
      quad: s.quadrant,
    })
  })

  if (!open) return null

  return (
    <div
      className="cmdk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette()
      }}
    >
      <Command
        label={t('palette:a11y.commandPalette')}
        className="cmdk-root"
        shouldFilter={page === 'default'}
      >
        <div className="cmdk-input-wrap">
          <span className="cmdk-prefix">⌘</span>
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={
              page === 'aiPicker'
                ? t('palette:placeholderAi', { tool: aiTool })
                : t('palette:placeholder')
            }
            autoFocus
          />
          <kbd>esc</kbd>
        </div>

        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">{t('palette:empty.noResults')}</Command.Empty>

          {page === 'default' && (
            <>
              <Command.Group heading={t('palette:groups.quickActions')}>
                <Command.Item onSelect={() => {
                  useDispatchStore.getState().signal('newTodo')
                  closePalette()
                }}>
                  <span className="cmdk-icon">+</span>
                  <span>{t('palette:actions.createTodo')}</span>
                  <span className="cmdk-meta">N</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('claude'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon"><AgentIcon tool="claude" size={14} /></span>
                  <span>{t('palette:actions.startAi', { tool: 'claude' })}</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('codex'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon"><AgentIcon tool="codex" size={14} /></span>
                  <span>{t('palette:actions.startAi', { tool: 'codex' })}</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('cursor'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon"><AgentIcon tool="cursor" size={14} /></span>
                  <span>{t('palette:actions.startAi', { tool: 'cursor' })}</span>
                </Command.Item>
              </Command.Group>

              {jumpListTodos.length > 0 && (
                <Command.Group heading={t('palette:groups.jumpToTodo')}>
                  {jumpListTodos.flatMap((todo) => {
                    const isDone = todo.status === 'done'
                    const parentTitle = todo.parentId ? parentTitleById.get(todo.parentId) : null
                    const label = parentTitle
                      ? t('palette:subtaskLabel', { parent: parentTitle, title: todo.title })
                      : todo.title
                    const jumpItem = (
                      <Command.Item
                        key={`todo-${todo.id}`}
                        value={`todo-${todo.id}-${label}`}
                        onSelect={() => jumpToTodo(todo)}
                      >
                        <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>
                          {isDone ? '↗' : '›'}
                        </span>
                        <span>{label}</span>
                        {isDone && <span className="cmdk-meta">{t('palette:meta.done')}</span>}
                      </Command.Item>
                    )
                    if (!isDone) return [jumpItem]
                    return [
                      jumpItem,
                      <Command.Item
                        key={`restore-${todo.id}`}
                        value={`restore-${todo.id}-${label}`}
                        onSelect={() => restoreTodo(todo)}
                      >
                        <span className="cmdk-icon">↺</span>
                        <span>{t('palette:actions.restoreToTodo', { label })}</span>
                      </Command.Item>,
                    ]
                  })}
                </Command.Group>
              )}

              {todos.length > 0 && (
                <Command.Group heading={t('palette:groups.focusSession')}>
                  {todos.map((todo) => (
                    <Command.Item
                      key={`focus-${todo.id}`}
                      value={`focus-${todo.id}-${todo.title}`}
                      onSelect={() => {
                        useDispatchStore.getState().openFocus(todo.id, todo.sessionId)
                        closePalette()
                      }}
                    >
                      <span className="cmdk-icon">⇆</span>
                      <span>{t('palette:actions.focusLabel', { title: todo.title })}</span>
                      {todo.tool && <span className="cmdk-meta">{todo.tool}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading={t('palette:groups.drawers')}>
                <Command.Item onSelect={() => { openDrawer('report'); closePalette() }}>
                  <span className="cmdk-icon"><BarChart3 size={14} /></span>
                  <span>{t('palette:actions.openStatsReports')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('wiki'); closePalette() }}>
                  <span className="cmdk-icon"><BookOpen size={14} /></span>
                  <span>{t('palette:actions.openWiki')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('settings'); closePalette() }}>
                  <span className="cmdk-icon"><Settings size={14} /></span>
                  <span>{t('palette:actions.openSettings')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('statsReports'); closePalette() }}>
                  <span className="cmdk-icon"><BarChartBig size={14} /></span>
                  <span>{t('palette:actions.openStats')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('template'); closePalette() }}>
                  <span className="cmdk-icon"><FileText size={14} /></span>
                  <span>{t('palette:actions.insertFromTemplate')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().signal('telegramSync'); closePalette() }}>
                  <span className="cmdk-icon"><Send size={14} /></span>
                  <span>{t('palette:actions.telegramSync')}</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading={t('palette:groups.view')}>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('todo'); closePalette() }}>
                  <span className="cmdk-icon">●</span>
                  <span>{t('palette:actions.showOnlyTodo')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('done'); closePalette() }}>
                  <span className="cmdk-icon">✓</span>
                  <span>{t('palette:actions.showOnlyDone')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('all'); closePalette() }}>
                  <span className="cmdk-icon">∗</span>
                  <span>{t('palette:actions.showAll')}</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading={t('palette:groups.system')}>
                <Command.Item onSelect={() => { toggleTheme(); closePalette() }}>
                  <span className="cmdk-icon"><Moon size={14} /></span>
                  <span>{t('palette:actions.toggleTheme')}</span>
                </Command.Item>
              </Command.Group>
            </>
          )}

          {page === 'aiPicker' && (() => {
            const pickable = jumpListTodos.filter((todo) => todo.status !== 'done')
            return (
              <>
                <div className="cmdk-back-row" onClick={() => setPage('default')}>
                  <span style={{ color: 'var(--accent-electric)' }}>←</span>
                  <span>{t('palette:actions.pickTodoForAi', { tool: aiTool })}</span>
                </div>
                {pickable.length === 0 && (
                  <div className="cmdk-empty">{t('palette:empty.noTodos')}</div>
                )}
                {pickable.length > 0 && (
                  <Command.Group heading={t('palette:groups.recentTodos')}>
                    {pickable.map((todo) => {
                      const parentTitle = todo.parentId ? parentTitleById.get(todo.parentId) : null
                      const label = parentTitle
                        ? t('palette:subtaskLabel', { parent: parentTitle, title: todo.title })
                        : todo.title
                      const liveStatus = todos.find((x) => x.id === todo.id)?.status
                      return (
                        <Command.Item
                          key={todo.id}
                          value={`picktodo-${todo.id}-${label}`}
                          onSelect={() => {
                            useDispatchStore.getState().startAiSession(todo.id, aiTool)
                            closePalette()
                          }}
                        >
                          <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                          <span>{label}</span>
                          {liveStatus && <span className="cmdk-meta">{liveStatus}</span>}
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                )}
              </>
            )
          })()}
        </Command.List>
      </Command>
    </div>
  )
}

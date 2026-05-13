import { useState, useEffect } from 'react'
import { Command } from 'cmdk'
import { useDispatchStore } from '../../store/dispatchStore'
import { useTheme } from '../../design/ThemeProvider'
import { useAiSessionStore } from '../../store/aiSessionStore'
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

export function CommandPalette() {
  const open = useDispatchStore((s) => s.palette)
  const closePalette = useDispatchStore((s) => s.closePalette)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const { toggle: toggleTheme } = useTheme()

  const [page, setPage] = useState<Page>('default')
  const [aiTool, setAiTool] = useState<'claude' | 'codex' | 'cursor'>('claude')
  const [search, setSearch] = useState('')

  // Reset to default page each time the palette opens
  useEffect(() => {
    if (open) {
      setPage('default')
      setSearch('')
    }
  }, [open])

  const sessions = useAiSessionStore((s) => s.sessions)

  // Build a deduplicated list of todos from active/recent sessions.
  // SessionMeta extends LiveSession so all fields are typed directly.
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
        label="Command Palette"
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
                ? `Search a todo to start AI session (${aiTool})...`
                : 'Type a command or search a todo...'
            }
            autoFocus
          />
          <kbd>esc</kbd>
        </div>

        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">No results.</Command.Empty>

          {page === 'default' && (
            <>
              <Command.Group heading="Quick actions">
                <Command.Item onSelect={() => {
                  useDispatchStore.getState().signal('newTodo')
                  closePalette()
                }}>
                  <span className="cmdk-icon">+</span>
                  <span>Create new todo</span>
                  <span className="cmdk-meta">N</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('claude'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>Start AI session (claude) →</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('codex'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>Start AI session (codex) →</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('cursor'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>Start AI session (cursor) →</span>
                </Command.Item>
              </Command.Group>

              {todos.length > 0 && (
                <Command.Group heading="Jump to todo">
                  {todos.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`todo-${t.id}-${t.title}`}
                      onSelect={() => {
                        useDispatchStore.getState().setJumpTo(t.id)
                        closePalette()
                      }}
                    >
                      <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                      <span>{t.title}</span>
                      {t.tool && <span className="cmdk-meta">{t.tool}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {todos.length > 0 && (
                <Command.Group heading="Focus session">
                  {todos.map((t) => (
                    <Command.Item
                      key={`focus-${t.id}`}
                      value={`focus-${t.id}-${t.title}`}
                      onSelect={() => {
                        useDispatchStore.getState().openFocus(t.id, t.sessionId)
                        closePalette()
                      }}
                    >
                      <span className="cmdk-icon">⇆</span>
                      <span>Focus: {t.title}</span>
                      {t.tool && <span className="cmdk-meta">{t.tool}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Drawers">
                <Command.Item onSelect={() => { openDrawer('report'); closePalette() }}>
                  <span className="cmdk-icon">📊</span>
                  <span>Open Stats &amp; Reports</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('wiki'); closePalette() }}>
                  <span className="cmdk-icon">📖</span>
                  <span>Open Wiki</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('settings'); closePalette() }}>
                  <span className="cmdk-icon">⚙</span>
                  <span>Open Settings</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('statsReports'); closePalette() }}>
                  <span className="cmdk-icon">📈</span>
                  <span>Open Stats</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('template'); closePalette() }}>
                  <span className="cmdk-icon">📋</span>
                  <span>Insert from Template…</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().signal('telegramSync'); closePalette() }}>
                  <span className="cmdk-icon">📨</span>
                  <span>Telegram sync</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading="View">
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('todo'); closePalette() }}>
                  <span className="cmdk-icon">●</span>
                  <span>Show only 待办</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('done'); closePalette() }}>
                  <span className="cmdk-icon">✓</span>
                  <span>Show only 已完成</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('all'); closePalette() }}>
                  <span className="cmdk-icon">∗</span>
                  <span>Show 全部 todos</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading="System">
                <Command.Item onSelect={() => { toggleTheme(); closePalette() }}>
                  <span className="cmdk-icon">🌙</span>
                  <span>Toggle theme (dark / light)</span>
                </Command.Item>
              </Command.Group>
            </>
          )}

          {page === 'aiPicker' && (
            <>
              <div className="cmdk-back-row" onClick={() => setPage('default')}>
                <span style={{ color: 'var(--accent-electric)' }}>←</span>
                <span>Start AI session — pick a todo ({aiTool})</span>
              </div>
              {todos.length === 0 && (
                <div className="cmdk-empty">No todos available — create one first.</div>
              )}
              {todos.length > 0 && (
                <Command.Group heading="Recent / Active todos">
                  {todos.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`picktodo-${t.id}-${t.title}`}
                      onSelect={() => {
                        // For now, jumping to the todo + setting an intent flag is enough.
                        // M3 will hook the real session start.
                        useDispatchStore.getState().setJumpTo(t.id)
                        closePalette()
                        // Surface intent for debugging / future wiring.
                        // eslint-disable-next-line no-console
                        console.info('[cmdk] start AI session intent:', { tool: aiTool, todoId: t.id })
                      }}
                    >
                      <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                      <span>{t.title}</span>
                      {t.status && <span className="cmdk-meta">{t.status}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

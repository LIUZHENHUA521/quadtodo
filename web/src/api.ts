// 同源相对路径：前端被 Express 从 /web/dist/ serve
const BASE = ''

export type Quadrant = 1 | 2 | 3 | 4
export type TodoStatus = 'todo' | 'ai_running' | 'ai_pending' | 'ai_done' | 'done'
export type AiTool = 'claude' | 'codex'
export type AiStatus = 'running' | 'done' | 'failed' | 'stopped' | 'pending_confirm'

export interface AiSession {
  sessionId: string
  tool: AiTool
  nativeSessionId: string | null
  cwd?: string | null
  status: AiStatus
  startedAt: number
  completedAt: number | null
  prompt: string
  label?: string
}

export interface Todo {
  id: string
  parentId: string | null
  title: string
  description: string
  quadrant: Quadrant
  status: TodoStatus
  dueDate: number | null
  workDir: string | null
  brainstorm: boolean
  appliedTemplateIds: string[]
  sortOrder: number
  aiSession: AiSession | null
  aiSessions: AiSession[]
  createdAt: number
  updatedAt: number
}

export interface Comment {
  id: string
  todoId: string
  content: string
  createdAt: number
}

export interface AppConfig {
  port: number
  defaultTool: AiTool
  defaultCwd: string
  tools: {
    claude: { command: string; bin: string; args: string[] }
    codex: { command: string; bin: string; args: string[] }
  }
  webhook: {
    enabled: boolean
    provider: 'wecom' | 'feishu'
    url: string
    keywords: string[]
    cooldownMs: number
    notifyOnPendingConfirm: boolean
    notifyOnKeywordMatch: boolean
  }
}

export interface ToolDiagnostic {
  name: AiTool
  configuredCommand: string | null
  effectiveCommand: string
  command: string
  configuredBin: string | null
  effectiveBin: string
  bin: string
  args: string[]
  source: 'env' | 'config' | 'auto-detected' | 'missing'
  installHint: string | null
  missing: boolean
}

export interface WorkDirOption {
  label: string
  value: string
}

export interface PickDirectoryResult {
  path: string | null
  cancelled: boolean
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await r.json()
  if (!body.ok) throw new Error(body.error || `${r.status} ${path}`)
  return body as T
}

export interface PromptTemplate {
  id: string
  name: string
  description: string
  content: string
  builtin: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export async function listTemplates(): Promise<PromptTemplate[]> {
  const body = await jsonFetch<{ ok: true; list: PromptTemplate[] }>('/api/templates')
  return body.list
}

export async function createTemplate(data: { name: string; description?: string; content: string; sortOrder?: number }): Promise<PromptTemplate> {
  const body = await jsonFetch<{ ok: true; template: PromptTemplate }>('/api/templates', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return body.template
}

export async function updateTemplate(id: string, patch: Partial<PromptTemplate>): Promise<PromptTemplate> {
  const body = await jsonFetch<{ ok: true; template: PromptTemplate }>(`/api/templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return body.template
}

export async function deleteTemplate(id: string): Promise<void> {
  await jsonFetch<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' })
}

export async function listTodos(params: {
  quadrant?: Quadrant
  status?: 'todo' | 'done'
  keyword?: string
} = {}): Promise<Todo[]> {
  const q = new URLSearchParams()
  if (params.quadrant != null) q.set('quadrant', String(params.quadrant))
  if (params.status) q.set('status', params.status)
  if (params.keyword) q.set('keyword', params.keyword)
  const qs = q.toString() ? `?${q.toString()}` : ''
  const body = await jsonFetch<{ ok: true; list: Todo[] }>(`/api/todos${qs}`)
  return body.list
}

export async function createTodo(data: {
  title: string
  description?: string
  quadrant: Quadrant
  dueDate?: number | null
  workDir?: string | null
  brainstorm?: boolean
  appliedTemplateIds?: string[]
  parentId?: string | null
}): Promise<Todo> {
  const body = await jsonFetch<{ ok: true; todo: Todo }>('/api/todos', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return body.todo
}

export async function updateTodo(id: string, patch: Partial<Todo>): Promise<Todo> {
  const body = await jsonFetch<{ ok: true; todo: Todo }>(`/api/todos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return body.todo
}

export async function deleteTodo(id: string): Promise<void> {
  await jsonFetch(`/api/todos/${id}`, { method: 'DELETE' })
}

export async function listComments(todoId: string): Promise<Comment[]> {
  const body = await jsonFetch<{ ok: true; list: Comment[] }>(`/api/todos/${todoId}/comments`)
  return body.list
}

export async function addComment(todoId: string, content: string): Promise<Comment> {
  const body = await jsonFetch<{ ok: true; comment: Comment }>(`/api/todos/${todoId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
  return body.comment
}

export async function deleteComment(todoId: string, commentId: string): Promise<void> {
  await jsonFetch(`/api/todos/${todoId}/comments/${commentId}`, { method: 'DELETE' })
}

export type TranscriptRole = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'raw'

export interface TranscriptTurn {
  role: TranscriptRole
  content: string
  toolName?: string
  toolUseId?: string
  timestamp?: number
}

export interface TranscriptResponse {
  source: 'jsonl' | 'ptylog' | 'empty'
  total: number
  offset: number
  turns: TranscriptTurn[]
  session: {
    sessionId: string
    tool: AiTool
    nativeSessionId: string | null
    status: AiStatus
    label: string
    startedAt: number
    completedAt: number | null
  }
}

export async function getTranscript(todoId: string, sessionId: string, since?: number): Promise<TranscriptResponse> {
  const qs = since ? `?since=${since}` : ''
  const body = await jsonFetch<{ ok: true } & TranscriptResponse>(`/api/todos/${todoId}/ai-sessions/${sessionId}/transcript${qs}`)
  return body
}

export interface ForkResult {
  prompt: string
  targetTodoId: string
  tool: AiTool
  cwd: string | null
  sourceSessionId: string
  summaryUsed: boolean
  tailCount: number
  headCount: number
}

export async function forkAiSession(todoId: string, sessionId: string, input: {
  targetTodoId?: string
  tool?: AiTool
  newInstruction?: string
  keepLastTurns?: number
  summarize?: boolean
}): Promise<ForkResult> {
  const body = await jsonFetch<{ ok: true } & ForkResult>(`/api/todos/${todoId}/ai-sessions/${sessionId}/fork`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body
}

export async function updateSessionLabel(todoId: string, sessionId: string, label: string): Promise<Todo> {
  const body = await jsonFetch<{ ok: true; todo: Todo }>(`/api/todos/${todoId}/ai-sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  })
  return body.todo
}

export async function deleteTodoAiSession(todoId: string, sessionId: string): Promise<Todo> {
  const body = await jsonFetch<{ ok: true; todo: Todo }>(`/api/todos/${todoId}/ai-sessions/${sessionId}`, {
    method: 'DELETE',
  })
  return body.todo
}

export async function startAiExec(input: {
  todoId: string
  prompt: string
  tool: AiTool
  cwd?: string
  resumeNativeId?: string
  permissionMode?: string | null
}): Promise<{ sessionId: string }> {
  const body = await jsonFetch<{ ok: true; sessionId: string }>('/api/ai-terminal/exec', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { sessionId: body.sessionId }
}

export interface ResumeSessionInput {
  todoId: string
  tool: AiTool
  prompt: string
  cwd?: string
  nativeSessionId: string
}

export async function stopAiExec(sessionId: string): Promise<void> {
  await jsonFetch('/api/ai-terminal/stop', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export async function getStatus(): Promise<{ version: string; activeSessions: number }> {
  return jsonFetch('/api/status')
}

export async function getConfig(): Promise<{ config: AppConfig; toolDiagnostics: Record<AiTool, ToolDiagnostic> }> {
  const body = await jsonFetch<{ ok: true; config: AppConfig; toolDiagnostics: Record<AiTool, ToolDiagnostic> }>('/api/config')
  return { config: body.config, toolDiagnostics: body.toolDiagnostics }
}

export async function updateConfig(patch: Partial<AppConfig>): Promise<{ config: AppConfig; toolDiagnostics: Record<AiTool, ToolDiagnostic>; runtimeApplied: { defaultCwd: string; defaultTool: AiTool } }> {
  const body = await jsonFetch<{ ok: true; config: AppConfig; toolDiagnostics: Record<AiTool, ToolDiagnostic>; runtimeApplied: { defaultCwd: string; defaultTool: AiTool } }>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return { config: body.config, toolDiagnostics: body.toolDiagnostics, runtimeApplied: body.runtimeApplied }
}

export async function getWorkDirOptions(): Promise<{ root: string; options: WorkDirOption[] }> {
  const body = await jsonFetch<{ ok: true; root: string; options: WorkDirOption[] }>('/api/config/workdirs')
  return { root: body.root, options: body.options }
}

export async function pickDirectory(input: {
  defaultPath?: string
  prompt?: string
} = {}): Promise<PickDirectoryResult> {
  const body = await jsonFetch<{ ok: true; path: string | null; cancelled: boolean }>('/api/system/pick-directory', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { path: body.path, cancelled: body.cancelled }
}

export type EditorKind = 'trae-cn' | 'trae' | 'cursor'

export async function openTraeCN(cwd: string, editor: EditorKind = 'trae-cn', path?: string): Promise<void> {
  await jsonFetch('/api/system/open-trae', {
    method: 'POST',
    body: JSON.stringify({ cwd, editor, path }),
  })
}

export async function openTerminal(cwd: string): Promise<{ sessionId: string }> {
  const body = await jsonFetch<{ ok: true; sessionId: string }>('/api/system/open-terminal', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  })
  return { sessionId: body.sessionId }
}

/** 浏览器 WS 地址：开发时走 vite proxy，生产同源 */
export function getTerminalWsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/terminal/${sessionId}`
}

// ─── Dashboard / PetView 相关 ───

export interface LiveSession {
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  status: AiStatus
  autoMode: string | null
  nativeSessionId: string | null
  cwd: string | null
  startedAt: number
  completedAt: number | null
  lastOutputAt: number | null
  outputBytesTotal: number
}

export interface SessionStats {
  total: number
  byStatus: { done: number; failed: number; stopped: number }
  byTool: { claude: number; codex: number }
  byQuadrant: Record<1 | 2 | 3 | 4, number>
  totalDurationMs: number
  avgDurationMs: number
  timeline: { t: number; count: number }[]
}

export interface ResourceSnapshot {
  sessionId: string
  todoId: string | null
  todoTitle: string
  tool: AiTool
  pid: number
  cpu: number
  memory: number
  elapsedMs: number
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  const body = await jsonFetch<{ ok: true; sessions: LiveSession[] }>('/api/ai-terminal/sessions')
  return body.sessions
}

export async function getSessionStats(range: 'today' | 'week' | 'month'): Promise<{ range: string; since: number; until: number; stats: SessionStats }> {
  const body = await jsonFetch<{ ok: true; range: string; since: number; until: number; stats: SessionStats }>(`/api/ai-terminal/stats?range=${range}`)
  return body
}

export async function getResourceSnapshot(): Promise<ResourceSnapshot[]> {
  const body = await jsonFetch<{ ok: true; resources: ResourceSnapshot[] }>('/api/ai-terminal/resource')
  return body.resources
}

// ─── Transcript rescue ───

export interface TranscriptFile {
  id: number
  tool: AiTool
  native_id: string | null
  cwd: string | null
  jsonl_path: string
  size: number
  mtime: number
  started_at: number | null
  ended_at: number | null
  first_user_prompt: string | null
  turn_count: number
  bound_todo_id: string | null
  indexed_at: number
  snippet?: string | null
}

export interface TranscriptSearchResult {
  total: number
  items: TranscriptFile[]
}

export async function scanTranscripts(): Promise<{ newFiles: number; indexed: number; autoBound: number; unbound: number }> {
  const body = await jsonFetch<{ ok: true; newFiles: number; indexed: number; autoBound: number; unbound: number }>('/api/transcripts/scan', { method: 'POST' })
  return body
}

export async function getTranscriptStats(): Promise<{ unboundCount: number }> {
  const body = await jsonFetch<{ ok: true; unboundCount: number }>('/api/transcripts/stats')
  return { unboundCount: body.unboundCount }
}

export async function searchTranscripts(params: {
  q?: string
  tool?: AiTool
  cwd?: string
  since?: number
  unboundOnly?: boolean
  limit?: number
  offset?: number
}): Promise<TranscriptSearchResult> {
  const qs = new URLSearchParams()
  if (params.q) qs.set('q', params.q)
  if (params.tool) qs.set('tool', params.tool)
  if (params.cwd) qs.set('cwd', params.cwd)
  if (params.since) qs.set('since', String(params.since))
  if (params.unboundOnly) qs.set('unboundOnly', '1')
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.offset) qs.set('offset', String(params.offset))
  const body = await jsonFetch<{ ok: true; total: number; items: TranscriptFile[] }>(`/api/transcripts/search?${qs.toString()}`)
  return { total: body.total, items: body.items }
}

export async function previewTranscript(fileId: number, offset = 0, limit = 200): Promise<{ file: TranscriptFile; turns: { role: string; content: string }[]; totalTurns: number }> {
  const body = await jsonFetch<{ ok: true; file: TranscriptFile; turns: { role: string; content: string }[]; totalTurns: number }>(`/api/transcripts/${fileId}/preview?offset=${offset}&limit=${limit}`)
  return { file: body.file, turns: body.turns, totalTurns: body.totalTurns }
}

export async function bindTranscript(fileId: number, todoId: string, force = false): Promise<{ ok: boolean; currentTodoId?: string | null; conflict?: boolean }> {
  const r = await fetch(BASE + `/api/transcripts/${fileId}/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ todoId, force }),
  })
  const body = await r.json()
  if (r.status === 409) return { ok: false, conflict: true, currentTodoId: body.currentTodoId || null }
  if (!body.ok) throw new Error(body.error || `${r.status}`)
  return { ok: true }
}

export async function unbindTranscript(fileId: number): Promise<void> {
  await jsonFetch(`/api/transcripts/${fileId}/unbind`, { method: 'POST' })
}

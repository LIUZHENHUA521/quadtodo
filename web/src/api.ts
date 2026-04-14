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
  title: string
  description: string
  quadrant: Quadrant
  status: TodoStatus
  dueDate: number | null
  workDir: string | null
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

export async function openTraeCN(cwd: string): Promise<void> {
  await jsonFetch('/api/system/open-trae', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
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

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
  status: AiStatus
  startedAt: number
  completedAt: number | null
  prompt: string
}

export interface Todo {
  id: string
  title: string
  description: string
  quadrant: Quadrant
  status: TodoStatus
  dueDate: number | null
  sortOrder: number
  aiSession: AiSession | null
  createdAt: number
  updatedAt: number
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

export async function stopAiExec(sessionId: string): Promise<void> {
  await jsonFetch('/api/ai-terminal/stop', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export async function getStatus(): Promise<{ version: string; activeSessions: number }> {
  return jsonFetch('/api/status')
}

/** 浏览器 WS 地址：开发时走 vite proxy，生产同源 */
export function getTerminalWsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/terminal/${sessionId}`
}

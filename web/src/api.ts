// 同源相对路径：前端被 Express 从 /web/dist/ serve
const BASE = ''

export type Quadrant = 1 | 2 | 3 | 4
export type TodoStatus = 'todo' | 'ai_running' | 'ai_pending' | 'ai_done' | 'done' | 'missed'
export type StageTag = 'dev' | 'review' | 'test' | 'release' | 'blocked'
export type RecurringFrequency = 'daily' | 'weekly' | 'monthly'
export type AiTool = 'claude' | 'codex' | 'cursor'
export type AiStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped' | 'pending_confirm'

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
  /** 服务端记录的最近一次 turn_done 时间戳；客户端用本地 lastSeenAt 比对判断未读 */
  lastTurnDoneAt?: number | null
  telegramRoute?: {
    targetUserId?: string | number | null
    threadId?: string | number | null
    topicName?: string | null
    channel?: string | null
  } | null
  localResume?: { openedAt: number }
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
  recurringRuleId: string | null
  instanceDate: string | null
  completedAt: number | null
  stageTag: StageTag | null
  createdAt: number
  updatedAt: number
}

export interface RecurringSubtodoTemplate {
  title: string
  description?: string
}

export interface RecurringRule {
  id: string
  title: string
  description: string
  quadrant: Quadrant
  workDir: string | null
  brainstorm: boolean
  appliedTemplateIds: string[]
  subtodos: RecurringSubtodoTemplate[]
  frequency: RecurringFrequency
  weekdays: number[]
  monthDays: number[]
  active: boolean
  lastGeneratedDate: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateRecurringRuleInput {
  title: string
  description?: string
  quadrant: Quadrant
  workDir?: string | null
  brainstorm?: boolean
  appliedTemplateIds?: string[]
  subtodos?: RecurringSubtodoTemplate[]
  frequency: RecurringFrequency
  weekdays?: number[]
  monthDays?: number[]
}

export interface Comment {
  id: string
  todoId: string
  content: string
  createdAt: number
}

export interface PricingRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PricingConfig {
  default: PricingRate
  models: Record<string, PricingRate>
  cnyRate: number
  showInPush?: boolean
  showCnyInPush?: boolean
}

export interface AppConfig {
  port: number
  defaultTool: AiTool
  defaultCwd: string
  tools: {
    claude: { command: string; bin: string; args: string[] }
    codex: { command: string; bin: string; args: string[] }
    cursor: { command: string; bin: string; args: string[] }
  }
  webhook?: {
    enabled: boolean
    provider: 'wecom' | 'feishu'
    url: string
    keywords: string[]
    cooldownMs: number
    notifyOnPendingConfirm: boolean
    notifyOnKeywordMatch: boolean
  }
  telegram?: {
    enabled?: boolean
    supergroupId?: string
    longPollTimeoutSec?: number
    useTopics?: boolean
    createTopicOnTaskStart?: boolean
    closeTopicOnSessionEnd?: boolean
    topicNameTemplate?: string
    topicNameDoneTemplate?: string
    allowedChatIds?: string[]
    allowedFromUserIds?: string[]
    notificationCooldownMs?: number
    suppressNotificationEvents?: boolean
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'bypass'
    autoCreateTopic?: boolean
    pollRetryDelayMs?: number
    minRenameIntervalMs?: number
    botToken?: string                                          // PUT only; GET 永远不返回明文
    botTokenMasked?: string | null                              // GET 时返回
    botTokenSource?: 'agentquad' | 'missing'                    // GET 时返回
    defaultSupergroupId?: string                                // legacy
    [key: string]: unknown
  }
  lark?: {
    enabled?: boolean
    appId?: string
    appSecret?: string
    appSecretMasked?: string | null
    appSecretSource?: 'agentquad' | 'missing'
    chatId?: string
    requireThreadGroup?: boolean
    eventSubscribeEnabled?: boolean
    autoCreateTopic?: boolean
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'bypass'
    notificationCooldownMs?: number
    [key: string]: unknown
  }
  pricing: PricingConfig
  dispatch?: {
    lark?: DispatchChannelConfig
    telegram?: DispatchChannelConfig
    web?: DispatchChannelConfig
    [key: string]: DispatchChannelConfig | undefined
  }
}

export interface DispatchChannelConfig {
  default?: AiTool
  perUser?: Record<string, AiTool>
  perChat?: Record<string, AiTool>
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

// API 错误：保留 HTTP status 和原始响应 body，便于调用方按 code 走分支
// （例如 424 tool_missing 渲染安装提示卡片，而不是单纯弹一条 toast）。
export class ApiError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body: any) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await r.json().catch(() => null)
  if (!body || !body.ok) {
    const msg = (body && body.error) || `${r.status} ${path}`
    throw new ApiError(msg, r.status, body)
  }
  return body as T
}

/**
 * 把粘贴/拖拽的 File 上传到后端，返回保存路径。
 * Claude Code 用 `@<path>` 语法 attach 这个文件。
 */
export async function uploadImage(file: File): Promise<{ path: string; fileSize: number }> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // 去掉 "data:image/png;base64," 前缀，只留纯 base64
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
  const body = await jsonFetch<{ ok: true; path: string; fileSize: number }>('/api/uploads/image', {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name || 'paste.png',
      mime: file.type || 'application/octet-stream',
      dataBase64,
    }),
  })
  return { path: body.path, fileSize: body.fileSize }
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

export async function createRecurringRule(data: CreateRecurringRuleInput): Promise<{ rule: RecurringRule; firstInstance: Todo | null }> {
  const body = await jsonFetch<{ ok: true; rule: RecurringRule; firstInstance: Todo | null }>('/api/recurring-rules', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return { rule: body.rule, firstInstance: body.firstInstance }
}

export async function getRecurringRule(id: string): Promise<RecurringRule> {
  const body = await jsonFetch<{ ok: true; rule: RecurringRule }>(`/api/recurring-rules/${id}`)
  return body.rule
}

export async function updateRecurringRule(id: string, patch: Partial<CreateRecurringRuleInput>): Promise<RecurringRule> {
  const body = await jsonFetch<{ ok: true; rule: RecurringRule }>(`/api/recurring-rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return body.rule
}

export async function deactivateRecurringRule(id: string): Promise<RecurringRule> {
  const body = await jsonFetch<{ ok: true; rule: RecurringRule }>(`/api/recurring-rules/${id}/deactivate`, {
    method: 'POST',
  })
  return body.rule
}

export async function deleteRecurringRule(id: string): Promise<void> {
  await jsonFetch(`/api/recurring-rules/${id}`, { method: 'DELETE' })
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

export async function sendAiInput(sessionId: string, data: string): Promise<void> {
  await jsonFetch('/api/ai-terminal/input', {
    method: 'POST',
    body: JSON.stringify({ sessionId, data }),
  })
}

export async function getStatus(): Promise<{ version: string; activeSessions: number }> {
  return jsonFetch('/api/status')
}

export type SyncActionType = 'open_topic' | 'close_topic' | 'open_thread' | 'close_thread' | 'clear_route'
export interface SyncAction {
  type: SyncActionType
  channel?: 'telegram' | 'lark' | null
  todoId?: string
  todoTitle?: string
  sessionId?: string
  chatId?: string
  threadId?: number | null
  rootMessageId?: string | null
  reason: string
  result?: { ok: boolean; action?: string; reason?: string; error?: string }
}
export interface SyncResponse {
  ok: boolean
  dryRun: boolean
  summary: {
    total: number
    open_topic: number
    close_topic: number
    open_thread: number
    close_thread: number
    clear_route: number
    succeeded?: number
    failed?: number
  }
  actions: SyncAction[]
}
// 旧名字保留为 type alias，避免外部 import 断
export type TelegramSyncAction = SyncAction
export type TelegramSyncResponse = SyncResponse
export async function syncChannels(dryRun: boolean): Promise<SyncResponse> {
  return jsonFetch('/api/sync', {
    method: 'POST',
    body: JSON.stringify({ dryRun }),
  })
}
// 兼容老导出
export const telegramSync = syncChannels

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

export async function openTraeCN(cwd: string, editor: EditorKind = 'trae-cn', path?: string, sessionId?: string): Promise<void> {
  await jsonFetch('/api/system/open-trae', {
    method: 'POST',
    body: JSON.stringify({ cwd, editor, path, sessionId }),
  })
}

export async function openTerminal(cwd: string): Promise<{ sessionId: string }> {
  const body = await jsonFetch<{ ok: true; sessionId: string }>('/api/system/open-terminal', {
    method: 'POST',
    body: JSON.stringify({ cwd }),
  })
  return { sessionId: body.sessionId }
}

export type NativeResumeWarning = 'route_missing' | 'hook_script_missing' | 'hooks_not_installed'

export async function openNativeAiResume(input: {
  cwd: string
  tool: AiTool
  nativeSessionId: string
  todoId?: string
  sessionId?: string
}): Promise<{ cwd: string; command: string; warnings: NativeResumeWarning[]; todo?: Todo }> {
  const body = await jsonFetch<{ ok: true; cwd: string; command: string; warnings?: NativeResumeWarning[]; todo?: Todo }>('/api/system/open-native-ai-resume', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return { cwd: body.cwd, command: body.command, warnings: body.warnings || [], todo: body.todo }
}

/** 浏览器 WS 地址：开发时走 vite proxy，生产同源 */
export function getTerminalWsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/terminal/${sessionId}`
}

// ─── Dashboard 相关 ───

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
  lastTurnDoneAt?: number | null
  outputBytesTotal: number
  awaitingReply?: boolean
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

// ─── Wiki ───

export interface WikiRun {
  id: number
  started_at: number
  completed_at: number | null
  todo_count: number
  dry_run: 0 | 1
  exit_code: number | null
  error: string | null
  note: string | null
}

export interface WikiStatus {
  wikiDir: string
  initState: 'ready' | 'exists-not-git' | 'git-failed' | 'unknown'
  lastRun: WikiRun | null
  pendingTodoCount: number
  running: boolean
}

export interface WikiPendingTodo {
  id: string
  title: string
  workDir: string | null
  quadrant: Quadrant
  completedAt: number
}

export interface WikiFile {
  path: string
  type: 'file' | 'dir'
  size?: number
}

export async function getWikiStatus(): Promise<WikiStatus> {
  const body = await jsonFetch<{ ok: true; status: WikiStatus }>('/api/wiki/status')
  return body.status
}

export async function getWikiPending(): Promise<WikiPendingTodo[]> {
  const body = await jsonFetch<{ ok: true; list: WikiPendingTodo[] }>('/api/wiki/pending')
  return body.list
}

export async function getWikiTree(): Promise<WikiFile[]> {
  const body = await jsonFetch<{ ok: true; files: WikiFile[] }>('/api/wiki/tree')
  return body.files
}

export async function getWikiFile(path: string): Promise<string> {
  const qs = new URLSearchParams({ path })
  const body = await jsonFetch<{ ok: true; content: string }>(`/api/wiki/file?${qs.toString()}`)
  return body.content
}

export async function listWikiRuns(limit = 20): Promise<WikiRun[]> {
  const body = await jsonFetch<{ ok: true; list: WikiRun[] }>(`/api/wiki/runs?limit=${limit}`)
  return body.list
}

export interface WikiRunResult {
  dryRun: boolean
  runId: number
  sourcesWritten: number
  exitCode: number
}

export async function runWiki(input: { todoIds: string[]; dryRun?: boolean }): Promise<WikiRunResult> {
  const body = await jsonFetch<{ ok: true } & WikiRunResult>('/api/wiki/run', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return body
}

export async function initWiki(): Promise<{ state: string; wikiDir: string; error?: string }> {
  const body = await jsonFetch<{ ok: true; state: string; wikiDir: string; error?: string }>('/api/wiki/init', {
    method: 'POST',
  })
  return body
}

// ─── Report (每日完成) ───

export interface DoneReport {
  range: { since: number; until: number }
  list: Todo[]
  dailyCounts: { date: string; count: number }[]
  missedCount: number
  total: number
}

export async function getDoneReport(since: number, until: number): Promise<DoneReport> {
  const body = await jsonFetch<{ ok: true } & DoneReport>(
    `/api/reports/done?since=${since}&until=${until}`,
  )
  return body
}

// ─── 全局搜索（⌘K 面板 + MCP 复用同一端点） ───

export type SearchScope = 'todos' | 'comments' | 'wiki' | 'ai_sessions'

export interface SearchResultItem {
  scope: SearchScope
  todoId: string
  todoTitle?: string
  snippet: string
  score: number
  archived?: boolean
  commentId?: string
  sessionId?: string
}

export interface SearchResponse {
  total: number
  results: SearchResultItem[]
}

export async function searchAll(params: {
  query: string
  scopes?: SearchScope[]
  limit?: number
  includeArchived?: boolean
}): Promise<SearchResponse> {
  const q = new URLSearchParams()
  q.set('q', params.query)
  if (params.scopes?.length) q.set('scopes', params.scopes.join(','))
  if (params.limit) q.set('limit', String(params.limit))
  if (params.includeArchived) q.set('includeArchived', 'true')
  const body = await jsonFetch<{ ok: true } & SearchResponse>(`/api/search?${q.toString()}`)
  return { total: body.total, results: body.results }
}

// ─── Telegram config helpers ─────────────────────────────────

export interface TelegramTestResult {
  ok: boolean
  botId?: number
  botUsername?: string | null
  botFirstName?: string | null
  source: 'agentquad' | 'missing' | 'input'
  errorReason?: string
}

export async function testTelegram(input: { botToken?: string } = {}): Promise<TelegramTestResult> {
  // 这个端点的 ok=false 是合法业务回包（不是 HTTP 错误），所以绕过 jsonFetch 的 .ok 抛错
  const r = await fetch(BASE + '/api/config/telegram/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return await r.json() as TelegramTestResult
}

export interface LarkTestResult {
  ok: boolean
  source: 'agentquad' | 'missing' | 'input'
  errorReason?: string
  detail?: string
}

export async function testLark(input: { appId?: string; appSecret?: string } = {}): Promise<LarkTestResult> {
  const r = await fetch(BASE + '/api/config/lark/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return await r.json() as LarkTestResult
}

export interface ProbeStartResult {
  ok: boolean
  durationSec?: number
  expiresAt?: number
  reason?: string
}

export async function startProbeChatId(durationSec = 60): Promise<ProbeStartResult> {
  const r = await fetch(BASE + '/api/config/telegram/probe-chat-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationSec }),
  })
  return await r.json() as ProbeStartResult
}

export async function stopProbeChatId(): Promise<void> {
  await fetch(BASE + '/api/config/telegram/probe-chat-id/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

export interface ProbeHit {
  chatId: string
  chatTitle?: string | null
  chatType?: string | null
  fromUserId?: string | null
  fromUsername?: string | null
  textPreview?: string | null
  at: number
}

/**
 * 订阅 probe SSE。返回 close 函数。
 * onHit 收到每个命中条目；onDone 收到「probe 结束」事件。
 */
export function subscribeProbeChatId(callbacks: {
  onHit: (hit: ProbeHit) => void
  onDone?: () => void
  onError?: (err: Event) => void
}): () => void {
  const url = BASE + '/api/config/telegram/probe-chat-id/stream'
  const es = new EventSource(url)
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      callbacks.onHit(data)
    } catch {}
  }
  es.addEventListener('done', () => {
    callbacks.onDone?.()
    es.close()
  })
  es.onerror = (e) => callbacks.onError?.(e)
  return () => es.close()
}

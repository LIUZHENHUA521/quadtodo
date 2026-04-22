/**
 * Multi-agent Pipeline Orchestrator (Phase C)
 *
 * Subscribes to PtyManager `done` events. For sessions that belong to an
 * active pipeline run, parses the last assistant turn for a `<handoff/>`
 * tag and transitions to the next role per the template's edge rules.
 *
 * Key decisions (from spec 2026-04-23):
 * - Handoff via XML tag `<handoff to="..." verdict="approved|rejected" feedback="..." />`
 * - Coder rejection: REUSE the coder session (inject feedback via stdin), round++
 * - Writer roles get their own git worktree; readers attach to writer's worktree
 * - Artifact auto-attached to next agent: git diff baseSha..HEAD + agent's own summary
 */

import {
  createWorktree, getDiffSinceBase, getLogSinceBase, getHead, ensureGitignore, getRepoRoot,
  listWorktrees, removeWorktree, mergeWorktreeBranch,
} from './worktree.js'
import { loadTranscript } from './transcript.js'

const DONE_KEY = '__done__'

function parseHandoff(text) {
  if (!text) return null
  // Match last <handoff .../> tag (self-closing or open-close). Use non-greedy attribute capture.
  const re = /<handoff\b([^>]*?)\/?\s*>(?:<\/handoff>)?/gi
  let match, last = null
  while ((match = re.exec(text)) !== null) last = match
  if (!last) return null
  const attrs = last[1]
  const get = (name) => {
    const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
    return m ? m[1] : undefined
  }
  return {
    to: get('to') || null,
    verdict: get('verdict') || null,
    feedback: get('feedback') || null,
    summary: get('summary') || null,
    rationale: get('rationale') || null,
  }
}

function matchEdge(edges, { from, event, verdict }) {
  // Prefer rules with verdict match; fall back to verdict-agnostic
  const exact = edges.find(e => e.from === from && e.event === event && e.verdict === verdict)
  if (exact) return exact
  const loose = edges.find(e => e.from === from && e.event === event && !e.verdict)
  return loose || null
}

export function createOrchestrator({ db, pty, aiTerminal, logDir }) {
  // Memoize active runs in-memory (source of truth is db; this is just a
  // sessionId → runId index to react fast on `done` events).
  const sessionToRun = new Map()

  function rehydrate() {
    const active = db.listActivePipelineRuns()
    for (const run of active) {
      for (const agent of (run.agents || [])) {
        if (agent.sessionId && (agent.status === 'running' || agent.status === 'idle')) {
          sessionToRun.set(agent.sessionId, run.id)
        }
      }
    }
  }
  rehydrate()

  function getRun(runId) { return db.getPipelineRun(runId) }

  function persistRun(run) { return db.updatePipelineRun(run.id, run) }

  function appendMessage(run, msg) {
    run.messages = [...(run.messages || []), { at: Date.now(), ...msg }]
    persistRun(run)
  }

  function updateAgent(run, sessionId, patch) {
    run.agents = run.agents.map(a => a.sessionId === sessionId ? { ...a, ...patch } : a)
    persistRun(run)
  }

  function findAgent(run, sessionId) {
    return (run.agents || []).find(a => a.sessionId === sessionId)
  }

  function findLastAgentForRole(run, roleKey) {
    const list = (run.agents || []).filter(a => a.role === roleKey)
    return list.length ? list[list.length - 1] : null
  }

  async function startRun({ todoId, templateId }) {
    const todo = db.getTodo(todoId)
    if (!todo) throw new Error('todo_not_found')
    const template = db.getPipelineTemplate(templateId)
    if (!template) throw new Error('template_not_found')

    const existing = db.findActivePipelineRunForTodo(todoId)
    if (existing) throw new Error('pipeline_already_running')

    const baseCwd = todo.workDir
    if (!baseCwd) throw new Error('todo_missing_workDir')

    // Capture base branch + sha
    let baseBranch = null, baseSha = null
    try {
      const head = await getHead(baseCwd)
      baseBranch = head.branch
      baseSha = head.sha
      const repoRoot = await getRepoRoot(baseCwd)
      ensureGitignore(repoRoot)
    } catch (e) {
      throw new Error(`todo workDir 不是 git 仓库: ${e.message}`)
    }

    const run = db.createPipelineRun({
      todoId,
      templateId,
      status: 'running',
      startedAt: Date.now(),
      iterationCount: 0,
      baseBranch,
      baseSha,
      agents: [],
      messages: [],
    })
    appendMessage(run, { from: 'orchestrator', to: '__run__', kind: 'started', reason: `template=${template.name}` })

    // First role is the first `roles[]` entry
    const firstRole = template.roles[0]
    if (!firstRole) throw new Error('template_has_no_roles')
    await spawnRoleAgent({ run, template, role: firstRole, round: 1, artifact: null, feedback: null, baseCwd })
    return db.getPipelineRun(run.id)
  }

  async function spawnRoleAgent({ run, template, role, round, artifact, feedback, baseCwd }) {
    // Writer: own worktree. Reader: attach to latest writer worktree.
    let worktreePath
    let branch = null
    if (role.writeAccess) {
      const res = await createWorktree({
        cwd: baseCwd, runId: run.id, roleKey: role.key, round, baseSha: run.baseSha,
      })
      worktreePath = res.path
      branch = res.branch
    } else {
      // Find latest writer agent's worktree
      const writer = [...(run.agents || [])].reverse().find(a => a.worktreePath && a.branch)
      if (!writer) {
        // No writer yet (impossible under built-in template, but defensive)
        worktreePath = baseCwd
      } else {
        worktreePath = writer.worktreePath
      }
    }

    const initialPrompt = buildInitialPrompt({
      role, template, run, round, artifact, feedback,
    })

    const { sessionId } = aiTerminal.spawnSession({
      todoId: run.todoId,
      prompt: initialPrompt,
      tool: role.tool || 'claude',
      cwd: worktreePath,
      permissionMode: 'bypass',  // agents run autonomously
      label: `[Pipeline] ${role.name} · 第 ${round} 轮`,
    })

    const agent = {
      role: role.key,
      round,
      sessionId,
      worktreePath,
      branch,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      artifactSha: null,
    }
    run.agents = [...(run.agents || []), agent]
    persistRun(run)
    sessionToRun.set(sessionId, run.id)
    appendMessage(run, { from: 'orchestrator', to: role.key, kind: 'spawn', reason: `round ${round}` })
  }

  function buildInitialPrompt({ role, template, run, round, artifact, feedback }) {
    const parts = []
    parts.push(role.systemPrompt)
    parts.push('')
    parts.push('───────────── pipeline context ─────────────')
    parts.push(`- 流水线模板：${template.name}`)
    parts.push(`- 当前角色：${role.name} (key=${role.key})`)
    parts.push(`- 当前轮次：第 ${round} 轮 / 上限 ${template.maxIterations} 轮`)
    parts.push(`- base commit：${(run.baseSha || '').slice(0, 12)}`)
    if (run.baseBranch) parts.push(`- base branch：${run.baseBranch}`)
    parts.push('')
    // Inject user's original ask from the todo
    const todo = db.getTodo(run.todoId)
    if (todo) {
      parts.push('───────────── 任务需求 ─────────────')
      parts.push(`标题：${todo.title}`)
      if (todo.description) parts.push(`描述：${todo.description}`)
    }
    if (feedback) {
      parts.push('')
      parts.push('───────────── 审阅员的上一轮反馈（必须逐条处理）─────────────')
      parts.push(feedback)
    }
    if (artifact) {
      parts.push('')
      parts.push('───────────── 上一个角色的产出 ─────────────')
      if (artifact.summary) {
        parts.push(`【摘要】${artifact.summary}`)
      }
      if (artifact.diff) {
        parts.push(`【git diff (${artifact.truncated ? '已截断' : '完整'})】`)
        parts.push('```diff')
        parts.push(artifact.diff)
        parts.push('```')
      }
      if (artifact.log) {
        parts.push(`【提交日志】`)
        parts.push(artifact.log)
      }
    }
    return parts.join('\n')
  }

  async function collectArtifact(agent) {
    if (!agent?.worktreePath || !agent.branch) return null
    try {
      const run = getRun(sessionToRun.get(agent.sessionId))
      if (!run?.baseSha) return null
      const { diff, truncated } = await getDiffSinceBase({
        worktreePath: agent.worktreePath, baseSha: run.baseSha,
      })
      const log = await getLogSinceBase({
        worktreePath: agent.worktreePath, baseSha: run.baseSha,
      })
      return { diff, truncated, log }
    } catch (e) {
      console.warn('[orchestrator] collectArtifact failed:', e.message)
      return null
    }
  }

  async function loadLastAssistantText(agent) {
    const run = getRun(sessionToRun.get(agent.sessionId))
    if (!run) return ''
    const todo = db.getTodo(run.todoId)
    if (!todo) return ''
    const session = (todo.aiSessions || []).find(s => s.sessionId === agent.sessionId)
    try {
      const parsed = await loadTranscript({
        tool: session?.tool || 'claude',
        nativeSessionId: session?.nativeSessionId || null,
        cwd: agent.worktreePath,
        sessionId: agent.sessionId,
        logDir,
      })
      const asst = [...(parsed.turns || [])].reverse().find(t => t.role === 'assistant')
      return asst?.content || parsed.turns?.[parsed.turns.length - 1]?.content || ''
    } catch (e) {
      console.warn('[orchestrator] loadLastAssistantText failed:', e.message)
      return ''
    }
  }

  async function onSessionDone({ sessionId, exitCode, stopped }) {
    const runId = sessionToRun.get(sessionId)
    if (!runId) return
    const run = getRun(runId)
    if (!run || run.status !== 'running') { sessionToRun.delete(sessionId); return }
    const agent = findAgent(run, sessionId)
    if (!agent) return

    // Mark this agent completed
    updateAgent(run, sessionId, {
      status: stopped ? 'stopped' : (exitCode === 0 ? 'done' : 'failed'),
      completedAt: Date.now(),
    })
    const refreshed = getRun(runId)

    if (stopped || exitCode !== 0) {
      await finalizeRun(refreshed, { status: 'stopped', reason: 'agent_stopped_or_failed' })
      return
    }

    // Parse handoff from agent's last assistant turn
    const text = await loadLastAssistantText(agent)
    const handoff = parseHandoff(text)
    const template = db.getPipelineTemplate(refreshed.templateId)
    if (!template) {
      await finalizeRun(refreshed, { status: 'failed', reason: 'template_missing' })
      return
    }
    const role = template.roles.find(r => r.key === agent.role)
    const rule = matchEdge(template.edges, {
      from: agent.role,
      event: handoff ? 'handoff' : 'done',
      verdict: handoff?.verdict,
    })

    appendMessage(refreshed, {
      from: agent.role, to: rule?.to || '?',
      kind: handoff ? 'handoff' : 'done',
      verdict: handoff?.verdict || null,
      reason: handoff?.rationale || handoff?.summary || handoff?.feedback || null,
    })

    if (!rule) {
      await finalizeRun(refreshed, { status: 'stopped', reason: 'no_matching_edge' })
      return
    }
    if (rule.to === DONE_KEY) {
      await finalizeRun(refreshed, { status: 'done', reason: handoff?.rationale || 'approved' })
      return
    }

    // Iteration check: if rule leads to a role that has already run, count as a new round
    const nextRole = template.roles.find(r => r.key === rule.to)
    if (!nextRole) {
      await finalizeRun(refreshed, { status: 'failed', reason: `next_role_not_found: ${rule.to}` })
      return
    }
    const prevSameRole = findLastAgentForRole(refreshed, rule.to)
    const isLoopback = !!prevSameRole
    let nextRound = isLoopback ? (prevSameRole.round + 1) : 1
    if (isLoopback) {
      const newIterCount = (refreshed.iterationCount || 0) + 1
      if (newIterCount > template.maxIterations) {
        appendMessage(refreshed, {
          from: 'orchestrator', to: '__run__', kind: 'limit',
          reason: `hit maxIterations=${template.maxIterations}`,
        })
        refreshed.status = 'stopped'
        persistRun({ ...refreshed, endedAt: Date.now() })
        sessionToRun.delete(sessionId)
        return
      }
      refreshed.iterationCount = newIterCount
      persistRun(refreshed)
    }

    // Collect artifact from the current agent (diff + log from its worktree)
    const artifact = await collectArtifact(agent)
    const artifactSummary = handoff?.summary || null
    if (artifact && artifactSummary) artifact.summary = artifactSummary

    // Decision #6: if next role is coder and we have a previous coder, try to RESUME its Claude
    // native session via `--resume`（一条新的 PTY，但 Claude 端看到的是同一对话）
    // 早先版本用 pty.write 往 stdin 注入，那条路径只在 PTY 还活着时成立 —— 已 done 会静默失败。
    const feedback = handoff?.verdict === 'rejected' ? (handoff.feedback || '（审阅员驳回但未提供具体反馈）') : null
    const todo = db.getTodo(refreshed.todoId)
    const baseCwd = todo?.workDir
    await transitionToRole({
      run: refreshed, template, nextRole, nextRound,
      artifact, feedback, baseCwd, prevSameRole,
    })
    sessionToRun.delete(sessionId)
  }

  /** Spawn next agent, resuming Claude native session when possible (coder loopback). */
  async function transitionToRole({ run, template, nextRole, nextRound, artifact, feedback, baseCwd, prevSameRole }) {
    const todo = db.getTodo(run.todoId)
    const prevAiSess = prevSameRole
      ? (todo?.aiSessions || []).find(s => s.sessionId === prevSameRole.sessionId)
      : null
    const canResume = nextRole.key === 'coder' && prevSameRole && prevAiSess?.nativeSessionId

    if (canResume) {
      const feedbackPrompt = buildReuseFeedbackText({
        artifact, feedback, round: nextRound, maxIterations: template.maxIterations,
      })
      try {
        const spawned = aiTerminal.spawnSession({
          todoId: run.todoId,
          prompt: feedbackPrompt,
          tool: nextRole.tool || 'claude',
          cwd: prevSameRole.worktreePath,
          resumeNativeId: prevAiSess.nativeSessionId,
          permissionMode: 'bypass',
          label: `[Pipeline] ${nextRole.name} · 第 ${nextRound} 轮（resumed）`,
        })
        run.agents = [...run.agents, {
          role: nextRole.key, round: nextRound, sessionId: spawned.sessionId,
          worktreePath: prevSameRole.worktreePath, branch: prevSameRole.branch,
          status: 'running', startedAt: Date.now(), completedAt: null, artifactSha: null,
        }]
        persistRun(run)
        sessionToRun.set(spawned.sessionId, run.id)
        appendMessage(run, {
          from: 'orchestrator', to: nextRole.key, kind: 'resume',
          reason: `round ${nextRound}, resume native=${prevAiSess.nativeSessionId.slice(0, 8)}`,
        })
        return
      } catch (e) {
        console.warn('[orchestrator] --resume failed, fallback to fresh spawn:', e.message)
      }
    }
    await spawnRoleAgent({ run, template, role: nextRole, round: nextRound, artifact, feedback, baseCwd })
  }

  function buildReuseFeedbackText({ artifact, feedback, round, maxIterations }) {
    const parts = []
    parts.push('')
    parts.push('───────────── 审阅员反馈（请按此修改）─────────────')
    parts.push(`现在是第 ${round} 轮 / 上限 ${maxIterations} 轮。`)
    if (feedback) {
      parts.push('')
      parts.push(feedback)
    }
    parts.push('')
    parts.push('请根据反馈在当前 worktree 修改并重新 commit，然后结束对话等待审阅员。')
    return parts.join('\n')
  }

  async function finalizeRun(run, { status, reason }) {
    const updated = db.updatePipelineRun(run.id, {
      status,
      endedAt: Date.now(),
      agents: run.agents,
      messages: [...(run.messages || []), { at: Date.now(), from: 'orchestrator', to: '__run__', kind: 'finalize', verdict: status, reason }],
    })
    // Clear from index
    for (const a of (run.agents || [])) sessionToRun.delete(a.sessionId)
    return updated
  }

  async function stopRun(runId) {
    const run = getRun(runId)
    if (!run) throw new Error('not_found')
    if (run.status !== 'running') return run
    // Stop all active agent sessions
    for (const a of (run.agents || [])) {
      if (a.status === 'running') {
        try { pty.stop(a.sessionId) } catch { /* ignore */ }
      }
    }
    return finalizeRun(run, { status: 'stopped', reason: 'user_requested' })
  }

  /** Find the latest writer agent in a run — used by merge endpoint. */
  function findLatestWriterAgent(run) {
    const writers = (run.agents || []).filter(a => a.branch)
    if (!writers.length) return null
    return writers.reduce((best, a) => (a.round > (best?.round ?? -1) ? a : best), null)
  }

  /**
   * Merge the latest writer's branch back into the base branch.
   * strategy: 'squash' | 'merge'
   */
  async function mergeRun(runId, { strategy = 'squash' } = {}) {
    const run = getRun(runId)
    if (!run) throw new Error('not_found')
    if (run.status !== 'done') throw new Error('run_not_done')
    const writer = findLatestWriterAgent(run)
    if (!writer) throw new Error('no_writer_to_merge')
    const todo = db.getTodo(run.todoId)
    if (!todo?.workDir) throw new Error('todo_missing_workDir')
    await mergeWorktreeBranch({
      cwd: todo.workDir,
      branch: writer.branch,
      strategy,
      commitMessage: `quadtodo pipeline: ${strategy}-merge ${writer.branch} (run ${run.id})`,
    })
    appendMessage(run, {
      from: 'orchestrator', to: '__run__', kind: 'finalize',
      verdict: 'merged', reason: `${strategy} merge ${writer.branch}`,
    })
    return getRun(runId)
  }

  /** Remove all worktrees + branches owned by this run. */
  async function cleanupRunWorktrees(runId) {
    const run = getRun(runId)
    if (!run) throw new Error('not_found')
    const todo = db.getTodo(run.todoId)
    if (!todo?.workDir) throw new Error('todo_missing_workDir')
    const all = await listWorktrees(todo.workDir)
    const mine = all.filter(w => w.path.includes(`/.quadtodo-worktrees/${runId}/`))
    let removed = 0
    for (const w of mine) {
      try {
        await removeWorktree({ cwd: todo.workDir, path: w.path, force: true })
        removed++
      } catch (e) {
        console.warn('[orchestrator] cleanup worktree failed:', w.path, e.message)
      }
    }
    appendMessage(run, {
      from: 'orchestrator', to: '__run__', kind: 'finalize',
      verdict: 'cleanup', reason: `removed ${removed} worktree(s)`,
    })
    return { removed }
  }

  /** Manually mark a run as done — used when user accepts current state despite limit. */
  async function acceptRun(runId) {
    const run = getRun(runId)
    if (!run) throw new Error('not_found')
    if (run.status === 'done') return run
    return finalizeRun(run, { status: 'done', reason: 'user_accepted_current' })
  }

  /**
   * When a run was stopped by iteration limit, user can +1 轮 and continue.
   * Re-runs the last handoff transition, bumping iterations allowance.
   */
  async function extendRun(runId) {
    const run = getRun(runId)
    if (!run) throw new Error('not_found')
    if (run.status !== 'stopped') throw new Error('run_not_stopped')
    const msgs = run.messages || []
    const lastLimitIdxFromEnd = [...msgs].reverse().findIndex(m => m.kind === 'limit')
    if (lastLimitIdxFromEnd === -1) throw new Error('no_limit_to_extend')
    const limitIdx = msgs.length - 1 - lastLimitIdxFromEnd
    // handoff right before the limit has the feedback
    const priorHandoff = [...msgs.slice(0, limitIdx)].reverse().find(m => m.kind === 'handoff')
    if (!priorHandoff) throw new Error('no_prior_handoff')

    const template = db.getPipelineTemplate(run.templateId)
    if (!template) throw new Error('template_missing')
    const nextRole = template.roles.find(r => r.key === priorHandoff.to)
    if (!nextRole) throw new Error('next_role_not_found')
    const fromAgent = findLastAgentForRole(run, priorHandoff.from)
    if (!fromAgent) throw new Error('from_agent_not_found')
    const prevSame = findLastAgentForRole(run, priorHandoff.to)
    const nextRound = prevSame ? (prevSame.round + 1) : 1

    // Bump allowance: decrement iterationCount so the check passes once more
    const resumed = db.updatePipelineRun(run.id, {
      status: 'running',
      endedAt: null,
      iterationCount: Math.max(0, (run.iterationCount || 0) - 1),
    })
    appendMessage(resumed, {
      from: 'orchestrator', to: '__run__', kind: 'resume',
      reason: `user extended +1 iteration`,
    })

    const artifact = await collectArtifact(fromAgent)
    const feedback = priorHandoff.verdict === 'rejected'
      ? (priorHandoff.reason || '用户要求再给一轮改进')
      : null
    const todo = db.getTodo(resumed.todoId)
    await transitionToRole({
      run: resumed, template, nextRole, nextRound,
      artifact, feedback, baseCwd: todo?.workDir, prevSameRole: prevSame,
    })
    return getRun(runId)
  }

  // Subscribe to PTY done events
  pty.on('done', (payload) => {
    // Non-pipeline sessions: ignore. onSessionDone also early-returns safely.
    if (!sessionToRun.has(payload.sessionId)) return
    onSessionDone(payload).catch(e => console.error('[orchestrator] onSessionDone error:', e))
  })

  return {
    startRun,
    stopRun,
    mergeRun,
    cleanupRunWorktrees,
    acceptRun,
    extendRun,
    // exposed for debugging / tests
    _parseHandoff: parseHandoff,
    _matchEdge: matchEdge,
    _sessionToRun: sessionToRun,
  }
}

export { parseHandoff, matchEdge }

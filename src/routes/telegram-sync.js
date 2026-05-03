/**
 * POST /api/telegram-sync
 *   body: { dryRun?: boolean }
 *
 * 把 Telegram topic、bridge 内存路由、ai-terminal sessions、DB todos 四方对齐。
 *
 * 检测的不一致：
 *   1. open_topic   ← todo 'ai_running' + PTY 真活着 + 没绑 topic
 *   2. close_topic  ← 绑了 topic 但 PTY 已死 (todo 还没 done)
 *   3. clear_route  ← bridge 路由的 sessionId 已不在 ait.sessions（孤儿）
 *
 * dryRun=true 只返回计划，不动手；false 实际执行并返回每一步的结果。
 */
import { Router } from 'express'

export function createTelegramSyncRouter({ db, aiTerminal, openclaw, wizard }) {
  if (!db || !aiTerminal || !openclaw || !wizard) {
    throw new Error('telegram-sync: missing deps')
  }
  const router = Router()

  function isAlive(sess) {
    return sess && (sess.status === 'running' || sess.status === 'pending_confirm')
  }

  function planSync() {
    const actions = []

    // 1) 遍历 todos：找 (todo 活 + 没 topic) / (有 topic + PTY 死)
    const todos = db.listTodos({ status: 'all', archived: 'all' }) || []
    for (const t of todos) {
      const sessions = (t.aiSessions || []).filter(Boolean)
      if (!sessions.length) continue
      // 取最近一条
      const aiSess = sessions[0]
      const sid = aiSess.sessionId
      if (!sid) continue
      const liveSess = aiTerminal.sessions.get(sid)
      const dbHasRoute = !!aiSess.telegramRoute?.threadId
      const bridgeRoute = openclaw.resolveRoute?.(sid)
      const bridgeHasRoute = !!bridgeRoute?.threadId

      if (isAlive(liveSess)) {
        if (!dbHasRoute && !bridgeHasRoute) {
          actions.push({
            type: 'open_topic',
            todoId: t.id,
            todoTitle: t.title,
            sessionId: sid,
            reason: 'live_session_no_topic',
          })
        }
      } else {
        // PTY 不活
        if (dbHasRoute || bridgeHasRoute) {
          if (t.status !== 'done') {
            const route = aiSess.telegramRoute || bridgeRoute
            actions.push({
              type: 'close_topic',
              todoId: t.id,
              todoTitle: t.title,
              sessionId: sid,
              chatId: String(route.targetUserId),
              threadId: Number(route.threadId),
              reason: 'session_dead_topic_open',
            })
          }
        }
      }
    }

    // 2) 遍历 bridge 内存路由：找孤儿（sessionId 已不存在于 ait.sessions）
    const routes = openclaw.listSessionRoutes?.() || []
    for (const r of routes) {
      if (!aiTerminal.sessions.has(r.sessionId)) {
        // 已经在上面 close_topic 列表里的就不重复（避免双触发）
        const dup = actions.find((a) => a.sessionId === r.sessionId && a.type === 'close_topic')
        if (dup) continue
        actions.push({
          type: 'clear_route',
          sessionId: r.sessionId,
          chatId: r.targetUserId,
          threadId: r.threadId,
          reason: 'orphan_route',
        })
      }
    }

    return actions
  }

  async function executeSync(plan) {
    const results = []
    for (const a of plan) {
      try {
        if (a.type === 'open_topic') {
          const r = await wizard.ensureTopicForSession({
            sessionId: a.sessionId,
            todoId: a.todoId,
          })
          results.push({ ...a, result: r })
        } else if (a.type === 'close_topic') {
          const r = await wizard.handleTopicEvent({
            type: 'closed',
            chatId: a.chatId,
            threadId: a.threadId,
          })
          results.push({ ...a, result: r })
        } else if (a.type === 'clear_route') {
          openclaw.clearSessionRoute?.(a.sessionId, 'sync-clear')
          results.push({ ...a, result: { ok: true, action: 'cleared' } })
        } else {
          results.push({ ...a, result: { ok: false, reason: 'unknown_action' } })
        }
      } catch (e) {
        results.push({ ...a, result: { ok: false, error: e?.message || 'unknown' } })
      }
    }
    return results
  }

  router.post('/', async (req, res) => {
    try {
      const dryRun = !!(req.body && req.body.dryRun)
      const plan = planSync()
      const summary = {
        total: plan.length,
        open_topic: plan.filter((a) => a.type === 'open_topic').length,
        close_topic: plan.filter((a) => a.type === 'close_topic').length,
        clear_route: plan.filter((a) => a.type === 'clear_route').length,
      }
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, summary, actions: plan })
      }
      const results = await executeSync(plan)
      const okCount = results.filter((r) => r.result?.ok).length
      return res.json({
        ok: true,
        dryRun: false,
        summary: { ...summary, succeeded: okCount, failed: results.length - okCount },
        actions: results,
      })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'sync_failed' })
    }
  })

  return { router, __test__: { planSync, executeSync } }
}

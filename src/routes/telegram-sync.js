/**
 * POST /api/telegram-sync   （别名：POST /api/sync）
 *   body: { dryRun?: boolean }
 *
 * 把 Telegram topic / Lark thread、bridge 内存路由、ai-terminal sessions、DB todos 多方对齐。
 *
 * 检测的不一致（每条 action 带 channel：'telegram' | 'lark' | null）：
 *   1. open_topic    ← (telegram) todo 'ai_running' + PTY 真活着 + 没绑 telegram topic
 *   2. close_topic   ← (telegram) 绑了 telegram topic 但 PTY 已死 (todo 还没 done)
 *   3. open_thread   ← (lark) PTY 真活着 + 没绑 lark thread
 *   4. close_thread  ← (lark) 绑了 lark thread 但 PTY 已死 (todo 还没 done)
 *   5. clear_route   ← bridge 路由的 sessionId 已不在 ait.sessions（孤儿，channel 无关）
 *
 * dryRun=true 只返回计划，不动手；false 实际执行并返回每一步的结果。
 */
import { Router } from 'express'

export function createTelegramSyncRouter({ db, aiTerminal, openclaw, wizard, getConfig } = {}) {
  if (!db || !aiTerminal || !openclaw || !wizard) {
    throw new Error('telegram-sync: missing deps')
  }
  const router = Router()

  function isAlive(sess) {
    return sess && (sess.status === 'running' || sess.status === 'idle' || sess.status === 'pending_confirm')
  }

  // 默认两个 channel 都启用；配置里显式 enabled === false 才视为禁用
  function readChannelFlags() {
    const cfg = (typeof getConfig === 'function' ? getConfig() : null) || {}
    return {
      telegramEnabled: cfg.telegram?.enabled !== false,
      larkEnabled: cfg.lark?.enabled !== false,
    }
  }

  function bridgeIsLark(route) {
    return route?.channel === 'lark' && !!route?.rootMessageId
  }
  // bridge route 没显式 channel 字段时按老语义当 telegram（向后兼容）
  function bridgeIsTelegram(route) {
    return !!route?.threadId && route?.channel !== 'lark'
  }

  function planSync() {
    const actions = []
    const { telegramEnabled, larkEnabled } = readChannelFlags()

    // 1) 遍历 todos：分别对 telegram 和 lark 路由独立判断（一个 session 可能两边都绑）
    const todos = db.listTodos({ status: 'all', archived: 'all' }) || []
    for (const t of todos) {
      const sessions = (t.aiSessions || []).filter(Boolean)
      if (!sessions.length) continue
      // 取最近一条
      const aiSess = sessions[0]
      const sid = aiSess.sessionId
      if (!sid) continue
      const liveSess = aiTerminal.sessions.get(sid)
      const bridgeRoute = openclaw.resolveRoute?.(sid) || null

      // ── Telegram 分支 ──
      if (telegramEnabled) {
        const dbHasTgRoute = !!aiSess.telegramRoute?.threadId
        const bridgeHasTgRoute = bridgeIsTelegram(bridgeRoute)
        if (isAlive(liveSess)) {
          if (!dbHasTgRoute && !bridgeHasTgRoute) {
            actions.push({
              type: 'open_topic',
              channel: 'telegram',
              todoId: t.id,
              todoTitle: t.title,
              sessionId: sid,
              reason: 'live_session_no_topic',
            })
          }
        } else if ((dbHasTgRoute || bridgeHasTgRoute) && t.status !== 'done') {
          const tgRoute = aiSess.telegramRoute || (bridgeHasTgRoute ? bridgeRoute : null)
          if (tgRoute) {
            actions.push({
              type: 'close_topic',
              channel: 'telegram',
              todoId: t.id,
              todoTitle: t.title,
              sessionId: sid,
              chatId: String(tgRoute.targetUserId),
              threadId: Number(tgRoute.threadId),
              reason: 'session_dead_topic_open',
            })
          }
        }
      }

      // ── Lark 分支 ──
      if (larkEnabled) {
        const dbHasLarkRoute = !!aiSess.larkRoute?.rootMessageId
        const bridgeHasLarkRoute = bridgeIsLark(bridgeRoute)
        if (isAlive(liveSess)) {
          if (!dbHasLarkRoute && !bridgeHasLarkRoute) {
            actions.push({
              type: 'open_thread',
              channel: 'lark',
              todoId: t.id,
              todoTitle: t.title,
              sessionId: sid,
              reason: 'live_session_no_lark_thread',
            })
          }
        } else if ((dbHasLarkRoute || bridgeHasLarkRoute) && t.status !== 'done') {
          const larkRoute = aiSess.larkRoute || (bridgeHasLarkRoute ? bridgeRoute : null)
          if (larkRoute) {
            actions.push({
              type: 'close_thread',
              channel: 'lark',
              todoId: t.id,
              todoTitle: t.title,
              sessionId: sid,
              chatId: String(larkRoute.targetUserId),
              rootMessageId: String(larkRoute.rootMessageId),
              reason: 'session_dead_lark_thread_open',
            })
          }
        }
      }
    }

    // 2) 遍历 bridge 内存路由：找孤儿（sessionId 已不存在于 ait.sessions）
    const routes = openclaw.listSessionRoutes?.() || []
    for (const r of routes) {
      if (!aiTerminal.sessions.has(r.sessionId)) {
        // 已经在上面 close 列表里的就不重复（避免双触发）
        const dup = actions.find((a) =>
          a.sessionId === r.sessionId && (a.type === 'close_topic' || a.type === 'close_thread'),
        )
        if (dup) continue
        actions.push({
          type: 'clear_route',
          channel: r.channel === 'lark' ? 'lark' : (r.channel || null),
          sessionId: r.sessionId,
          chatId: r.targetUserId,
          threadId: r.threadId || null,
          rootMessageId: r.rootMessageId || null,
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
        } else if (a.type === 'open_thread') {
          const r = await wizard.ensureLarkThreadForSession({
            sessionId: a.sessionId,
            todoId: a.todoId,
          })
          results.push({ ...a, result: r })
        } else if (a.type === 'close_thread') {
          const r = await wizard.handleLarkThreadClose({
            chatId: a.chatId,
            rootMessageId: a.rootMessageId,
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
        open_thread: plan.filter((a) => a.type === 'open_thread').length,
        close_thread: plan.filter((a) => a.type === 'close_thread').length,
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

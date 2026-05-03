import { describe, it, expect, vi } from 'vitest'
import { createLoadingTracker } from '../src/telegram-loading-status.js'

function makeHarness({ route = null, mockTime = null } = {}) {
  const editedTopics = []
  const telegramBot = {
    editForumTopic: vi.fn(async (args) => {
      editedTopics.push(args)
      return { ok: true }
    }),
  }
  const defaultRoute = {
    targetUserId: '-1001234',
    threadId: 42,
    topicName: '#t42 修复 login bug',
  }
  const resolvedRoute = route === null ? defaultRoute : route
  const openclaw = {
    resolveRoute: vi.fn((sid) => sid === 'sess-x' ? resolvedRoute : null),
  }
  let _now = Date.now()
  const tracker = createLoadingTracker({
    telegramBot, openclaw,
    logger: { info() {}, warn() {} },
    now: mockTime ? () => _now : undefined,
  })
  return {
    tracker, editedTopics, telegramBot, openclaw,
    advanceTime: (ms) => { _now += ms },
  }
}

describe('createLoadingTracker — title rename only', () => {
  it('renames topic to "🔄 <name>" on start', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toEqual([{
      chatId: '-1001234',
      threadId: 42,
      name: '🔄 #t42 修复 login bug',
    }])
    expect(h.tracker.has('sess-x')).toBe(true)
  })

  it('renames topic to "✅ <name>" on done', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    const final = h.editedTopics[h.editedTopics.length - 1]
    expect(final.name).toBe('✅ #t42 修复 login bug')
    expect(h.tracker.has('sess-x')).toBe(false)
  })

  it('renames to "❌ <name>" on failed', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'failed' })
    expect(h.editedTopics[h.editedTopics.length - 1].name).toBe('❌ #t42 修复 login bug')
  })

  it('renames to "⏹ <name>" on stopped', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'stopped' })
    expect(h.editedTopics[h.editedTopics.length - 1].name).toBe('⏹ #t42 修复 login bug')
  })

  it('skips when no telegram route', async () => {
    const h = makeHarness({ route: null })  // openclaw.resolveRoute → null
    await h.tracker.start({ sessionId: 'no-route' })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.size()).toBe(0)
  })

  it('skips when route has no topicName', async () => {
    const h = makeHarness({ route: { targetUserId: '-1', threadId: 1, topicName: null } })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('skipTitleRename=true skips running rename but terminal still renames', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x', skipTitleRename: true })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.has('sess-x')).toBe(true)
    // 终态仍然改名（终态比 running 重要，boot resume 的 skip 标志只针对启动 🔄）
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(1)
    expect(h.editedTopics[0].name).toBe('✅ #t42 修复 login bug')
  })

  it('does not throw when telegramBot lacks editForumTopic', async () => {
    const tracker = createLoadingTracker({
      telegramBot: {},
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() {} },
    })
    await expect(tracker.start({ sessionId: 'sess-x' })).resolves.not.toThrow()
    await expect(tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })).resolves.not.toThrow()
  })

  it('idempotent: starting same sessionId twice is no-op', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(1)
  })

  it('stop on unknown sessionId is no-op', async () => {
    const h = makeHarness()
    await h.tracker.stop({ sessionId: 'unknown', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markIdle renames to "💤 <name>"', async () => {
    const h = makeHarness({ mockTime: true })
    await h.tracker.start({ sessionId: 'sess-x' })
    h.advanceTime(60_000)  // 越过 30s 节流
    await h.tracker.markIdle('sess-x')
    expect(h.editedTopics).toHaveLength(2)
    expect(h.editedTopics[1].name).toBe('💤 #t42 修复 login bug')
  })

  it('markRunning renames back to "🔄 <name>"', async () => {
    const h = makeHarness({ mockTime: true })
    await h.tracker.start({ sessionId: 'sess-x' })
    h.advanceTime(60_000)
    await h.tracker.markIdle('sess-x')
    h.advanceTime(60_000)
    await h.tracker.markRunning('sess-x')
    expect(h.editedTopics).toHaveLength(3)
    expect(h.editedTopics[2].name).toBe('🔄 #t42 修复 login bug')
  })

  it('markIdle / markRunning on unknown sessionId is no-op', async () => {
    const h = makeHarness()
    await h.tracker.markIdle('unknown')
    await h.tracker.markRunning('unknown')
    expect(h.editedTopics).toHaveLength(0)
  })

  it('idle works after skipTitleRename start (boot resume can transition to 💤)', async () => {
    const h = makeHarness({ mockTime: true })
    await h.tracker.start({ sessionId: 'sess-x', skipTitleRename: true })
    expect(h.editedTopics).toHaveLength(0)  // start 不改名
    h.advanceTime(60_000)
    await h.tracker.markIdle('sess-x')
    expect(h.editedTopics).toHaveLength(1)
    expect(h.editedTopics[0].name).toBe('💤 #t42 修复 login bug')
  })
})

describe('createLoadingTracker — rate limit defenses', () => {
  it('per-chat 30s throttle: 2nd running rename within window is dropped', async () => {
    const h = makeHarness({ mockTime: true })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(1)

    // 第二个 session 同 chat 同 30s 内启动 → 应该被节流跳过
    h.openclaw.resolveRoute = (sid) => sid === 'sess-y'
      ? { targetUserId: '-1001234', threadId: 99, topicName: '#t99 别的任务' }
      : null
    h.advanceTime(5_000)  // 才过 5s
    await h.tracker.start({ sessionId: 'sess-y' })
    expect(h.editedTopics).toHaveLength(1)  // 第 2 个被节流跳过

    // 等 30s 之后再 start 第 3 个 → 通过
    h.openclaw.resolveRoute = (sid) => sid === 'sess-z'
      ? { targetUserId: '-1001234', threadId: 100, topicName: '#t100 又一任务' }
      : null
    h.advanceTime(30_000)
    await h.tracker.start({ sessionId: 'sess-z' })
    expect(h.editedTopics).toHaveLength(2)
    expect(h.editedTopics[1].name).toBe('🔄 #t100 又一任务')
  })

  it('terminal phase rename bypasses 30s throttle', async () => {
    const h = makeHarness({ mockTime: true })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(1)
    // 立刻终态 rename → 应该通过（不受节流）
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(2)
    expect(h.editedTopics[1].name).toBe('✅ #t42 修复 login bug')
  })

  it('429 from telegram triggers global backoff blocking subsequent renames', async () => {
    const editedTopics = []
    let callCount = 0
    const telegramBot = {
      editForumTopic: vi.fn(async (args) => {
        callCount++
        if (callCount === 1) {
          const err = new Error('429')
          err.description = 'Too Many Requests: retry after 5'
          throw err
        }
        editedTopics.push(args)
        return { ok: true }
      }),
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: {
        resolveRoute: (sid) => ({
          targetUserId: '-1', threadId: sid === 'sess-x' ? 1 : 2, topicName: `t-${sid}`,
        }),
      },
      logger: { info() {}, warn() {} },
    })
    await tracker.start({ sessionId: 'sess-x' })  // 撞 429，进 backoff
    expect(callCount).toBe(1)
    expect(editedTopics).toHaveLength(0)

    // 立即 start 另一个 → 应该被 backoff 跳过（API 不再被调）
    await tracker.start({ sessionId: 'sess-y' })
    expect(callCount).toBe(1)  // 没新调用
  })

  it('terminal rename bypasses global backoff (✅/❌/⏹ must show)', async () => {
    let callCount = 0
    const editsAfterBackoff = []
    const telegramBot = {
      editForumTopic: vi.fn(async (args) => {
        callCount++
        if (callCount === 1) {
          // 第一次 running rename 撞 429
          const err = new Error('429')
          err.description = 'Too Many Requests: retry after 30'
          throw err
        }
        // 第二次（终态 rename）应该照样过
        editsAfterBackoff.push(args)
        return { ok: true }
      }),
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: {
        resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 'mytopic' }),
      },
      logger: { info() {}, warn() {} },
    })
    await tracker.start({ sessionId: 'sess-x' })
    expect(callCount).toBe(1)               // running rename 命中 429
    expect(editsAfterBackoff).toHaveLength(0)
    // backoff 仍然激活 → stop 应该硬上 rename ✅
    await tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(callCount).toBe(2)
    expect(editsAfterBackoff[0].name).toBe('✅ mytopic')
  })

  it('terminal rename bypasses skipTitleRename (boot resume sessions still get ✅ at end)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x', skipTitleRename: true })
    expect(h.editedTopics).toHaveLength(0)
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(1)
    expect(h.editedTopics[0].name).toBe('✅ #t42 修复 login bug')
  })

  it('parses retry_after from error description', async () => {
    let backoffMsLogged = 0
    const telegramBot = {
      editForumTopic: async () => {
        const err = new Error('429')
        err.description = 'Too Many Requests: retry after 17'
        throw err
      },
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: {
        info() {},
        warn(msg) {
          const m = String(msg).match(/backoff for (\d+)ms/)
          if (m) backoffMsLogged = Number(m[1])
        },
      },
    })
    await tracker.start({ sessionId: 'sess-x' })
    expect(backoffMsLogged).toBe(17_000)
  })

  it('treats "TOPIC_NOT_MODIFIED" as success (no warn)', async () => {
    let warned = false
    const telegramBot = {
      editForumTopic: async () => {
        const err = new Error('400')
        err.description = 'Bad Request: TOPIC_NOT_MODIFIED'
        throw err
      },
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() { warned = true } },
    })
    await expect(tracker.start({ sessionId: 'sess-x' })).resolves.not.toThrow()
    expect(warned).toBe(false)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createReactionTracker } from '../src/telegram-reaction-tracker.js'

function makeBot() {
  const calls = []
  return {
    calls,
    setMessageReaction: vi.fn(async (args) => {
      calls.push(args)
      return { ok: true }
    }),
  }
}

function makeTracker({ bot = makeBot(), config = { telegram: { reactionEnabled: true, reactionRunningEmoji: '✍' } } } = {}) {
  const tracker = createReactionTracker({
    telegramBot: bot,
    getConfig: () => config,
    logger: { info() {}, warn() {} },
  })
  return { tracker, bot }
}

describe('createReactionTracker — noteUserMessage', () => {
  it('calls setMessageReaction with running emoji and records (chatId, messageId)', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    expect(bot.setMessageReaction).toHaveBeenCalledWith({ chatId: '-100', messageId: 42, emoji: '✍' })
    expect(tracker.has('sid-1')).toBe(true)
    expect(tracker.size()).toBe(1)
  })

  it('multiple noteUserMessage on same sessionId records all messages', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 43 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 44 })
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(3)
    expect(tracker.size()).toBe(1)
  })
})

describe('createReactionTracker — clearReactionsForSession', () => {
  it('calls setMessageReaction({emoji:null}) for every recorded message and clears the session', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 43 })
    bot.setMessageReaction.mockClear()
    const r = await tracker.clearReactionsForSession('sid-1')
    expect(r).toEqual({ ok: true, removed: 2, total: 2 })
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(2)
    expect(bot.setMessageReaction).toHaveBeenNthCalledWith(1, { chatId: '-100', messageId: 42, emoji: null })
    expect(bot.setMessageReaction).toHaveBeenNthCalledWith(2, { chatId: '-100', messageId: 43, emoji: null })
    expect(tracker.has('sid-1')).toBe(false)
  })

  it('clearReactionsForSession on unknown sessionId is a no-op', async () => {
    const { tracker, bot } = makeTracker()
    const r = await tracker.clearReactionsForSession('unknown')
    expect(r).toEqual({ ok: true, removed: 0 })
    expect(bot.setMessageReaction).not.toHaveBeenCalled()
  })

  it('isolates sessions: clearing one does not affect the other', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-A', chatId: '-100', messageId: 1 })
    await tracker.noteUserMessage({ sessionId: 'sid-B', chatId: '-100', messageId: 2 })
    bot.setMessageReaction.mockClear()
    await tracker.clearReactionsForSession('sid-A')
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(1)
    expect(bot.setMessageReaction).toHaveBeenCalledWith({ chatId: '-100', messageId: 1, emoji: null })
    expect(tracker.has('sid-A')).toBe(false)
    expect(tracker.has('sid-B')).toBe(true)
  })
})

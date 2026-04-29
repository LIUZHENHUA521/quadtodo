import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawWizard, __test__ as internals } from '../src/openclaw-wizard.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'

function makeFakeAi() {
  const sessions = []
  return {
    sessions,
    spawnSession({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv }) {
      sessions.push({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv })
      return { sessionId, reused: false }
    },
  }
}

function makeFakeBridge() {
  const routes = new Map()
  return {
    routes,
    isEnabled: () => true,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: vi.fn(async () => ({ ok: true })),
  }
}

describe('openclaw-wizard parsers', () => {
  it('extractTitle peels triggers and suffix hints', () => {
    expect(internals.extractTitle('帮我做 修复 login bug')).toContain('修复 login bug')
    expect(internals.extractTitle('在 quadtodo 里新建任务: 写一个 demo')).toBe('写一个 demo')
    expect(internals.extractTitle('新建任务: 重构 X，目录 ~/foo, 象限 1, bug 模板')).toBe('重构 X')
    expect(internals.extractTitle('任务：实现 Y')).toBe('实现 Y')
  })

  it('tryExtractWorkdir picks paths after 目录/路径/cwd', () => {
    expect(internals.tryExtractWorkdir('帮我做 X 目录 ~/foo')).toBe('~/foo')
    expect(internals.tryExtractWorkdir('cwd: /tmp/y')).toBe('/tmp/y')
    expect(internals.tryExtractWorkdir('帮我做 X')).toBeNull()
  })

  it('tryExtractQuadrant picks 1-4', () => {
    expect(internals.tryExtractQuadrant('象限 1')).toBe(1)
    expect(internals.tryExtractQuadrant('Q3')).toBe(3)
    expect(internals.tryExtractQuadrant('帮我做 X')).toBeNull()
    expect(internals.tryExtractQuadrant('象限 9')).toBeNull()
  })

  it('parseNumericChoice within range', () => {
    expect(internals.parseNumericChoice('1', 5)).toBe(0)
    expect(internals.parseNumericChoice('5', 5)).toBe(4)
    expect(internals.parseNumericChoice('6', 5)).toBeNull()
    expect(internals.parseNumericChoice('hi', 5)).toBeNull()
  })
})

describe('openclaw-wizard state machine', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    db.createTodo({ title: 'seed2', quadrant: 1, workDir: '/tmp/foo' })
    db.createTodo({ title: 'seed3', quadrant: 1, workDir: '/tmp/bar' })
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })
  })

  it('starts wizard on "帮我做 X" and prompts for workdir', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo' })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('📁 选个工作目录')
    expect(r.reply).toContain('/tmp/foo')
  })

  it('full wizard flow: workdir → quadrant → template → done', async () => {
    let r
    r = await wizard.handleInbound({ peer: 'u1', text: '帮我做 写个 demo' })
    expect(r.reply).toContain('📁')

    r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.reply).toContain('🎯 选象限')

    r = await wizard.handleInbound({ peer: 'u1', text: '2' })
    expect(r.reply).toContain('📋 选模板')

    r = await wizard.handleInbound({ peer: 'u1', text: '6' }) // 自由模式
    expect(r.action).toBe('wizard_done')
    expect(r.reply).toContain('✅ todo')
    expect(r.reply).toContain('Q2')
    expect(ai.sessions).toHaveLength(1)
    expect(bridge.routes.size).toBe(1)
  })

  it('one-shot create skips all wizard steps', async () => {
    const r = await wizard.handleInbound({
      peer: 'u1',
      text: '帮我做 修复 login，目录 /tmp/foo, 象限 1, Bug 修复 模板',
    })
    expect(r.action).toBe('wizard_done')
    expect(r.reply).toContain('Q1')
    expect(r.reply).toContain('/tmp/foo')
    expect(r.reply).toContain('Bug 修复')
    expect(ai.sessions).toHaveLength(1)
    expect(ai.sessions[0].permissionMode).toBe('bypass')
    expect(ai.sessions[0].extraEnv.QUADTODO_TARGET_USER).toBe('u1')
  })

  it('cancel mid-wizard aborts cleanly', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '取消' })
    expect(r.action).toBe('wizard_cancelled')
    expect(wizard._peek('u1')).toBeNull()
  })

  it('invalid choice in workdir step re-prompts', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: 'hello' })
    expect(r.action).toBe('wizard_step')
    expect(r.reply).toContain('🤔')
    expect(r.reply).toContain('📁')
  })

  it('custom path in workdir step accepted', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '/some/where' })
    expect(r.reply).toContain('🎯')
    expect(wizard._peek('u1').chosenWorkdir).toBe('/some/where')
  })

  it('quadrant default keyword resolves to Q2', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    await wizard.handleInbound({ peer: 'u1', text: '1' })
    const r = await wizard.handleInbound({ peer: 'u1', text: '默认' })
    expect(r.reply).toContain('📋')
    expect(wizard._peek('u1').chosenQuadrant).toBe(2)
  })

  it('routes ask_user reply when no wizard active', async () => {
    pending.ask({ sessionId: 's1', question: 'q', options: ['a', 'b'] })
    const r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.action).toBe('ask_user_replied')
    expect(r.reply).toContain('✓ 已回复')
  })

  it('wizard takes priority over ask_user when both apply', async () => {
    pending.ask({ sessionId: 's1', question: 'q', options: ['a', 'b'] })
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    // Now reply "1" — should advance wizard, NOT route to pending
    const r = await wizard.handleInbound({ peer: 'u1', text: '1' })
    expect(r.action).toBe('wizard_step')
  })

  it('fallback when text matches nothing and no state', async () => {
    const r = await wizard.handleInbound({ peer: 'u1', text: 'random unrelated' })
    expect(r.action).toBe('fallback')
    expect(r.reply).toContain('🤔')
  })

  it('peers are isolated', async () => {
    await wizard.handleInbound({ peer: 'u1', text: '帮我做 X' })
    expect(wizard._peek('u1')).toBeTruthy()
    expect(wizard._peek('u2')).toBeNull()
    const r = await wizard.handleInbound({ peer: 'u2', text: '1' })
    // u2 has no wizard, no pending → fallback
    expect(r.action).toBe('fallback')
  })
})

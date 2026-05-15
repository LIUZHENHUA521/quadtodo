import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openDb } from '../src/db.js'
import { createAiTerminal } from '../src/routes/ai-terminal.js'
import { setConfigValue, loadConfig } from '../src/config.js'

// FakePty 捕获 pty.create 的调用参数，不 spawn 真进程
class FakePty extends EventEmitter {
  constructor() {
    super()
    this.created = []
    this._nativeIds = new Map()
    this._has = new Set()
  }
  create(opts) {
    this.created.push(opts)
    this._has.add(opts.sessionId)
    if (opts.resumeNativeId) {
      this._nativeIds.set(opts.sessionId, opts.resumeNativeId)
    } else if (opts.tool === 'claude') {
      this._nativeIds.set(opts.sessionId, `claude-preset-${this.created.length}`)
    } else {
      this._nativeIds.set(opts.sessionId, null)
    }
  }
  async startWithSize(sessionId, cols, rows) {}
  write(id, data) {}
  resize(id, cols, rows) {}
  stop(id) {
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  getNativeId(id) { return this._nativeIds.get(id) ?? null }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
  getPids() { return [] }
}

function makeAit(dir) {
  const db = openDb(':memory:')
  const pty = new FakePty()
  // 指向 /bin/sh 让 checkToolAvailable 通过，不依赖真实工具
  loadConfig({ rootDir: dir })
  setConfigValue('tools.claude.bin', '/bin/sh', { rootDir: dir })
  setConfigValue('tools.codex.bin', '/bin/sh', { rootDir: dir })
  const ait = createAiTerminal({
    db,
    pty,
    defaultCwd: dir,
    rootDir: dir,
    sendNotification: () => {},
  })
  // 插入测试用 todo（使用 db.createTodo 保证 NOT NULL 字段合法）
  const parent = db.createTodo({ title: 'parent', quadrant: 1 })
  const child = db.createTodo({ title: 'child', quadrant: 1 })
  return { ait, pty, parentId: parent.id, childId: child.id }
}

describe('spawnSession env injection', () => {
  let dir, origEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-spawn-env-'))
    // 保存并清空 QUADTODO_* env，确保从干净状态测试
    origEnv = {}
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('QUADTODO_')) {
        origEnv[k] = process.env[k]
        delete process.env[k]
      }
    }
  })

  afterEach(() => {
    // 清掉本轮测试可能设置的 QUADTODO_* env
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('QUADTODO_')) delete process.env[k]
    }
    // 还原
    Object.assign(process.env, origEnv)
    rmSync(dir, { recursive: true, force: true })
  })

  it('QUADTODO_DEPTH = 0 when no parent context', () => {
    const { ait, pty, parentId } = makeAit(dir)
    ait.spawnSession({ todoId: parentId, tool: 'claude', prompt: 'hi', skipTelegram: true })
    expect(pty.created).toHaveLength(1)
    const env = pty.created[0].extraEnv
    expect(env.QUADTODO_DEPTH).toBe('0')
    expect(env.QUADTODO_PARENT_TODO_ID).toBe('')
  })

  it('QUADTODO_DEPTH increments when process.env.QUADTODO_DEPTH set', () => {
    process.env.QUADTODO_DEPTH = '1'
    process.env.QUADTODO_TODO_ID = 'grandparent-id'
    const { ait, pty, parentId } = makeAit(dir)
    ait.spawnSession({ todoId: parentId, tool: 'claude', prompt: 'hi', skipTelegram: true })
    expect(pty.created).toHaveLength(1)
    const env = pty.created[0].extraEnv
    expect(env.QUADTODO_DEPTH).toBe('2')
    expect(env.QUADTODO_PARENT_TODO_ID).toBe('grandparent-id')
  })

  it('explicit parentTodoId overrides process.env.QUADTODO_TODO_ID', () => {
    process.env.QUADTODO_TODO_ID = 'from-env'
    const { ait, pty, parentId } = makeAit(dir)
    ait.spawnSession({ todoId: parentId, tool: 'claude', prompt: 'hi', skipTelegram: true, parentTodoId: 'explicit-parent' })
    expect(pty.created).toHaveLength(1)
    const env = pty.created[0].extraEnv
    expect(env.QUADTODO_PARENT_TODO_ID).toBe('explicit-parent')
  })

  it('parentTodoId = 0 (falsy number) is preserved as "0", not replaced by env', () => {
    process.env.QUADTODO_TODO_ID = 'from-env'
    const { ait, pty, parentId } = makeAit(dir)
    ait.spawnSession({ todoId: parentId, tool: 'claude', prompt: 'hi', skipTelegram: true, parentTodoId: 0 })
    expect(pty.created).toHaveLength(1)
    const env = pty.created[0].extraEnv
    // 修复前：0 || process.env.QUADTODO_TODO_ID → 'from-env'
    // 修复后：0 != null → String(0) = '0'
    expect(env.QUADTODO_PARENT_TODO_ID).toBe('0')
  })
})

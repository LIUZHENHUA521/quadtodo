import { describe, it, expect } from 'vitest'
import { buildSourceMarkdown, sourceFileName } from '../src/wiki/sources.js'

function makeTodo(overrides = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    parentId: null,
    title: '修 CloudBase 云函数部署',
    description: '部署时报 403，怀疑是权限配置',
    quadrant: 1,
    status: 'done',
    dueDate: null,
    workDir: '/Users/foo/project',
    createdAt: Date.parse('2026-04-18T09:00:00Z'),
    updatedAt: Date.parse('2026-04-20T12:30:00Z'),
    aiSessions: [],
    ...overrides,
  }
}

describe('wiki/sources', () => {
  it('sourceFileName uses YYYY-MM-DD prefix and shortened todo id', () => {
    const todo = makeTodo()
    const name = sourceFileName(todo, Date.parse('2026-04-20T12:30:00Z'))
    expect(name).toBe('2026-04-20-aaaaaaaa.md')
  })

  it('produces markdown with frontmatter + title + description', async () => {
    const todo = makeTodo()
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'empty', turns: [] }),
      summarize: async () => '',
      redact: (s) => s,
      maxTailTurns: 20,
    })
    expect(md).toMatch(/^---\ntodoId: aaaaaaaa/m)
    expect(md).toMatch(/title: 修 CloudBase 云函数部署/)
    expect(md).toMatch(/^# 修 CloudBase 云函数部署$/m)
    expect(md).toMatch(/## 描述\n部署时报 403/)
  })

  it('includes comments section when present', async () => {
    const todo = makeTodo()
    const comments = [
      { id: 'c1', todoId: todo.id, content: '怀疑是 role 没加', createdAt: Date.parse('2026-04-19T10:00:00Z') },
      { id: 'c2', todoId: todo.id, content: '加了就好了', createdAt: Date.parse('2026-04-19T11:00:00Z') },
    ]
    const md = await buildSourceMarkdown({
      todo, comments,
      loadTranscript: () => ({ source: 'empty', turns: [] }),
      summarize: async () => '',
      redact: (s) => s,
      maxTailTurns: 20,
    })
    expect(md).toMatch(/## 评论（2）/)
    expect(md).toMatch(/怀疑是 role 没加/)
    expect(md).toMatch(/加了就好了/)
  })

  it('includes session summary and last N turns', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1',
        tool: 'claude',
        nativeSessionId: 'native-1',
        cwd: '/x',
        status: 'done',
        startedAt: Date.parse('2026-04-20T10:00:00Z'),
        completedAt: Date.parse('2026-04-20T11:00:00Z'),
        prompt: '',
      }],
    })
    const turns = []
    for (let i = 0; i < 30; i++) {
      turns.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` })
    }
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns }),
      summarize: async () => '摘要：修好了',
      redact: (s) => s,
      maxTailTurns: 5,
    })
    expect(md).toMatch(/### Session 1 — claude/)
    expect(md).toMatch(/\*\*摘要\*\*：摘要：修好了/)
    expect(md).toMatch(/turn 29/)
    expect(md).not.toMatch(/turn 0\b/)
    expect(md).not.toMatch(/turn 24\b/)
  })

  it('applies redact to transcript content', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1', tool: 'claude', nativeSessionId: 'n1',
        cwd: '/x', status: 'done',
        startedAt: 0, completedAt: 0, prompt: '',
      }],
    })
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns: [
        { role: 'user', content: 'my key is sk-abcdefghij1234567890XYZ' },
      ]}),
      summarize: async () => '',
      redact: (s) => s.replace(/sk-\w+/g, '[REDACTED]'),
      maxTailTurns: 5,
    })
    expect(md).toContain('[REDACTED]')
    expect(md).not.toContain('sk-abcdefghij1234567890XYZ')
  })

  it('truncates output at maxBytes and notes truncation', async () => {
    const todo = makeTodo({
      aiSessions: [{
        sessionId: 'sess-1', tool: 'claude', nativeSessionId: 'n1',
        cwd: '/x', status: 'done',
        startedAt: 0, completedAt: 0, prompt: '',
      }],
    })
    const big = 'x'.repeat(200_000)
    const md = await buildSourceMarkdown({
      todo,
      comments: [],
      loadTranscript: () => ({ source: 'jsonl', turns: [{ role: 'user', content: big }] }),
      summarize: async () => 'ok',
      redact: (s) => s,
      maxTailTurns: 5,
      maxBytes: 10_000,
    })
    expect(md.length).toBeLessThan(11_000)
    expect(md).toMatch(/截断/)
  })
})

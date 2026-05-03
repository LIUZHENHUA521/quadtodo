import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLatestAssistantTurn, readLatestAssistantTurnFresh, readLatestUserTimestamp, buildFullTranscript, __test__ } from '../src/claude-transcript.js'

function jsonl(...lines) { return lines.map((l) => JSON.stringify(l)).join('\n') }

describe('claude-transcript helpers', () => {
  it('normalizeContent: string → single text block', () => {
    const r = __test__.normalizeContent('hello')
    expect(r).toEqual([{ type: 'text', text: 'hello' }])
  })
  it('normalizeContent: array passthrough', () => {
    const arr = [{ type: 'text', text: 'a' }, { type: 'tool_use' }]
    expect(__test__.normalizeContent(arr)).toBe(arr)
  })

  it('blockToText: text → text', () => {
    expect(__test__.blockToText({ type: 'text', text: 'foo' })).toBe('foo')
  })
  it('blockToText: tool_use Bash → 🔧 Bash: <cmd>', () => {
    expect(__test__.blockToText({
      type: 'tool_use', name: 'Bash', input: { command: 'ls /tmp' },
    })).toBe('🔧 Bash: ls /tmp')
  })
  it('blockToText: tool_use Edit → 🔧 Edit: <file_path>', () => {
    expect(__test__.blockToText({
      type: 'tool_use', name: 'Edit', input: { file_path: '/x.js' },
    })).toBe('🔧 Edit: /x.js')
  })
  it('blockToText: thinking returns empty (hidden by default)', () => {
    expect(__test__.blockToText({ type: 'thinking', thinking: 'i think...' })).toBe('')
  })
})

describe('readLatestAssistantTurn', () => {
  let tmp, file

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tx-'))
    file = join(tmp, 'session.jsonl')
  })

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns null when file does not exist', () => {
    expect(readLatestAssistantTurn('/no/such/file.jsonl')).toBeNull()
  })

  it('returns null when no assistant messages', () => {
    writeFileSync(file, jsonl(
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ))
    expect(readLatestAssistantTurn(file)).toBeNull()
  })

  it('extracts text content from latest assistant', () => {
    writeFileSync(file, jsonl(
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] }, timestamp: '2026-04-30T12:00:00Z' },
    ))
    const r = readLatestAssistantTurn(file)
    expect(r.text).toBe('hello back')
    expect(r.hasToolUse).toBe(false)
    expect(r.timestamp).toBe('2026-04-30T12:00:00Z')
  })

  it('returns LATEST when multiple assistant messages', () => {
    writeFileSync(file, jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { type: 'user', message: { role: 'user', content: 'next' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ))
    expect(readLatestAssistantTurn(file).text).toBe('second')
  })

  it('combines text + tool_use into one turn', () => {
    writeFileSync(file, jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'pwd' } },
        { type: 'text', text: 'Done.' },
      ] } },
    ))
    const r = readLatestAssistantTurn(file)
    expect(r.text).toContain('Let me check')
    expect(r.text).toContain('🔧 Bash: pwd')
    expect(r.text).toContain('Done.')
    expect(r.hasToolUse).toBe(true)
  })

  it('skips invalid JSON lines without crashing', () => {
    writeFileSync(file, [
      'not json at all',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'real' }] } }),
      '{"broken json',
    ].join('\n'))
    const r = readLatestAssistantTurn(file)
    expect(r.text).toBe('real')
  })
})

describe('readLatestUserTimestamp', () => {
  let tmp, file
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tx-'))
    file = join(tmp, 'session.jsonl')
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns timestamp of most recent user message (skipping meta)', () => {
    writeFileSync(file, jsonl(
      { type: 'user', message: { role: 'user', content: 'first' }, timestamp: '2026-04-30T10:00:00Z' },
      { type: 'user', isMeta: true, message: { content: 'meta' }, timestamp: '2026-04-30T10:01:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, timestamp: '2026-04-30T10:02:00Z' },
      { type: 'user', message: { role: 'user', content: 'second' }, timestamp: '2026-04-30T10:03:00Z' },
    ))
    expect(readLatestUserTimestamp(file)).toBe('2026-04-30T10:03:00Z')
  })

  it('returns null if no user messages', () => {
    writeFileSync(file, jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, timestamp: '2026-04-30T10:00:00Z' },
    ))
    expect(readLatestUserTimestamp(file)).toBeNull()
  })
})

describe('readLatestAssistantTurnFresh', () => {
  let tmp, file
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tx-'))
    file = join(tmp, 'session.jsonl')
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns fresh:true when assistant timestamp > user timestamp', async () => {
    writeFileSync(file, jsonl(
      { type: 'user', message: { role: 'user', content: 'q' }, timestamp: '2026-04-30T10:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, timestamp: '2026-04-30T10:00:01Z' },
    ))
    const r = await readLatestAssistantTurnFresh(file, { maxRetries: 0, delayMs: 10 })
    expect(r.fresh).toBe(true)
    expect(r.text).toBe('a')
  })

  it('returns fresh:false (stale) when assistant ≤ user after retries exhausted', async () => {
    writeFileSync(file, jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] }, timestamp: '2026-04-30T10:00:00Z' },
      { type: 'user', message: { role: 'user', content: 'new question' }, timestamp: '2026-04-30T10:00:30Z' },
    ))
    const r = await readLatestAssistantTurnFresh(file, { maxRetries: 1, delayMs: 5 })
    expect(r.fresh).toBe(false)
    expect(r.text).toBe('old')
    expect(r.attempts).toBeGreaterThanOrEqual(1)
  })

  it('returns fresh:true if no user messages (degenerate case)', async () => {
    writeFileSync(file, jsonl(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'standalone' }] }, timestamp: '2026-04-30T10:00:00Z' },
    ))
    const r = await readLatestAssistantTurnFresh(file, { maxRetries: 0 })
    expect(r.fresh).toBe(true)
    expect(r.text).toBe('standalone')
  })
})

describe('buildFullTranscript', () => {
  let tmp, file

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-tx-'))
    file = join(tmp, 'session.jsonl')
  })

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('renders user + assistant turns into markdown', () => {
    writeFileSync(file, jsonl(
      { type: 'user', message: { role: 'user', content: '帮我做 X' }, timestamp: '2026-04-30T12:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK 我开始' }] }, timestamp: '2026-04-30T12:00:01Z' },
      { type: 'user', message: { role: 'user', content: 'next step' } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'Running...' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] } },
    ))
    const r = buildFullTranscript(file)
    expect(r.turnCount).toBe(4)
    expect(r.markdown).toContain('# Claude Code Session Transcript')
    expect(r.markdown).toContain('### 👤 User')
    expect(r.markdown).toContain('### 🤖 Assistant')
    expect(r.markdown).toContain('帮我做 X')
    expect(r.markdown).toContain('🔧 Bash: ls')
  })

  it('skips meta and sidechain lines', () => {
    writeFileSync(file, jsonl(
      { type: 'user', isMeta: true, message: { role: 'user', content: '<meta>' } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: '<sidechain>' } },
      { type: 'user', message: { role: 'user', content: 'real' } },
    ))
    const r = buildFullTranscript(file)
    expect(r.markdown).toContain('real')
    expect(r.markdown).not.toContain('<meta>')
    expect(r.markdown).not.toContain('<sidechain>')
  })

  it('handles empty file gracefully', () => {
    writeFileSync(file, '')
    const r = buildFullTranscript(file)
    expect(r.turnCount).toBe(0)
    expect(r.markdown).toBe('')
  })

  it('truncates very long tool_result with marker', () => {
    const big = 'a'.repeat(2000)
    writeFileSync(file, jsonl(
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'x', content: big },
      ] } },
    ))
    const r = buildFullTranscript(file, { toolResultMaxChars: 100 })
    expect(r.markdown).toContain('more chars')
    expect(r.markdown).not.toContain(big)
  })
})

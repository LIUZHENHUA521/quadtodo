import { describe, it, expect } from 'vitest'
import path from 'node:path'
import readline from 'node:readline'
import fs from 'node:fs'
import { extractUsage } from '../src/usage-parser.js'

async function rawLines(file) {
  const out = []
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const l of rl) out.push(l)
  return out
}

describe('extractUsage', () => {
  it('claude：累加 usage、算 activeMs、归一化 primaryModel', async () => {
    const lines = await rawLines(path.resolve(__dirname, 'fixtures/claude-usage.jsonl'))
    const out = extractUsage('claude', lines, { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(160)
    expect(out.outputTokens).toBe(35)
    expect(out.cacheReadTokens).toBe(5)
    expect(out.cacheCreationTokens).toBe(2)
    expect(out.primaryModel).toBe('claude-sonnet-4-6')
    expect(out.activeMs).toBe(40000)
    expect(out.parseErrorCount).toBe(1)
  })

  it('codex：读 token_usage', async () => {
    const lines = await rawLines(path.resolve(__dirname, 'fixtures/codex-usage.jsonl'))
    const out = extractUsage('codex', lines, { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(30)
    expect(out.outputTokens).toBe(8)
    expect(out.primaryModel).toBe('gpt-5-codex')
  })

  it('空输入不炸', () => {
    const out = extractUsage('claude', [], { idleThresholdMs: 120000 })
    expect(out.inputTokens).toBe(0)
    expect(out.primaryModel).toBeNull()
    expect(out.activeMs).toBe(0)
  })
})

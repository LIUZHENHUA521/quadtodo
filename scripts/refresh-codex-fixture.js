#!/usr/bin/env node
/**
 * Copy the largest recent Codex rollout into test/fixtures/codex-real-token-count.jsonl.
 * Run after upgrading codex CLI to refresh fixture.
 */
import { readdirSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = join(homedir(), '.codex', 'sessions')
const out = join(process.cwd(), 'test', 'fixtures', 'codex-real-token-count.jsonl')

function findLargest() {
  let best = { size: 0, path: null }
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl') && st.size > best.size) best = { size: st.size, path: p }
    }
  }
  walk(root)
  return best
}

const { path } = findLargest()
if (!path) throw new Error('no codex rollout found')
copyFileSync(path, out)
console.log(`refreshed ${out} from ${path}`)

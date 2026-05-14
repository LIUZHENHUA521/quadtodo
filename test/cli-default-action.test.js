import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

describe('default action', () => {
  it('bare `agentquad` does NOT print commander help when no args', () => {
    const r = spawnSync(process.execPath, [CLI], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQUAD_DRY_RUN: '1', AGENTQUAD_SKIP_WIZARD: '1', NO_UPDATE_NOTIFIER: '1' },
      timeout: 5000,
    })
    expect(r.stdout || r.stderr).not.toMatch(/Usage: agentquad \[options\] \[command\]/)
    expect(r.status).toBe(0)
  })

  it('unknown subcommand exits non-zero with helpful error', () => {
    const r = spawnSync(process.execPath, [CLI, 'strat'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQUAD_DRY_RUN: '1', AGENTQUAD_SKIP_WIZARD: '1', NO_UPDATE_NOTIFIER: '1' },
      timeout: 5000,
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/Unknown command: strat/)
  })

  it('`agentquad --help` still prints help', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 5000 })
    expect(r.stdout).toMatch(/Usage: agentquad/)
    expect(r.stdout).toMatch(/start/)
    expect(r.stdout).toMatch(/install-tools/)
  })
})

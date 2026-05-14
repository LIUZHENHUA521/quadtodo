import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline'

export function shouldRunWizard({ rootDir, isTTY, env, flags }) {
  if (env.AGENTQUAD_SKIP_WIZARD === '1' || env.AGENTQUAD_SKIP_WIZARD === 'true') return false
  if (flags?.wizard === false) return false
  if (!isTTY) return false
  if (existsSync(join(rootDir, 'config.json'))) return false
  if (existsSync(join(rootDir, 'data.db'))) return false
  return true
}

export function defaultAsk(stdin = process.stdin, stdout = process.stdout) {
  return (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout })
    rl.question(question, (ans) => { rl.close(); resolve(ans) })
  })
}

export function defaultChecks() {
  const has = (bin) => spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: '/bin/sh' }).status === 0
  return { claude: () => has('claude'), codex: () => has('codex') }
}

export async function defaultInstallTools(tools) {
  const r = spawnSync(process.execPath, [
    new URL('./cli.js', import.meta.url).pathname,
    'install-tools',
    ...tools.map((t) => `--${t}`),
    '-y',
  ], { stdio: 'inherit' })
  return r.status ?? 1
}

export async function runFirstRunWizard({
  checks = defaultChecks(),
  installTools = defaultInstallTools,
  ask = defaultAsk(),
  log = console.log,
} = {}) {
  log('\n👋 第一次启动 AgentQuad。\n')

  const claudeOK = checks.claude()
  const codexOK = checks.codex()
  const missing = []
  if (!claudeOK) missing.push('claude')
  if (!codexOK) missing.push('codex')

  let installedTools = []
  let skippedInstall = false

  if (missing.length > 0) {
    log(`[1/1] 检测到未安装：${missing.join(', ')}（AI 终端必需）`)
    const ans = (await ask(`      运行 'agentquad install-tools --all' 自动安装？(Y/n) `)).trim().toLowerCase()
    if (ans === '' || ans === 'y' || ans === 'yes') {
      try {
        const code = await installTools(missing)
        if (code === 0) installedTools = [...missing]
        else log('\n⚠ 工具安装失败，AI 终端将不可用。修复后跑 agentquad install-tools --all\n')
      } catch (e) {
        log(`\n⚠ 工具安装异常（${e?.message || e}），AI 终端将不可用。\n`)
      }
    } else {
      skippedInstall = true
    }
  }

  return { skipped: false, installedTools, skippedInstall }
}

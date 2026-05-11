#!/usr/bin/env node
// Run from repo root via `npm run ensure-web-deps`.
// Only intended for the publishing flow (`prepack`); not for end-user install.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const cwd = process.cwd()
const webDir = resolve(cwd, 'web')
const webPkg = resolve(webDir, 'package.json')
const webModules = resolve(webDir, 'node_modules')

if (!existsSync(webPkg)) {
  process.stderr.write(`ensure-web-deps: web/package.json not found at ${webPkg}\n`)
  process.stderr.write('Run this script from the AgentQuad repo root.\n')
  process.exit(1)
}

if (existsSync(webModules)) {
  process.exit(0) // already installed; nothing to do
}

process.stdout.write('ensure-web-deps: installing web/ deps for prepack...\n')
const r = spawnSync('npm', ['ci'], { cwd: webDir, stdio: 'inherit' })
process.exit(r.status ?? 1)

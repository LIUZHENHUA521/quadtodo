# Lark No-Prefix Todo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书侧任意非命令文本（且未匹配续聊路径）自动启动新建任务向导，免去 `帮我做` 前缀；受 `config.lark.autoCreateTodo` 开关控制，默认开启。

**Architecture:** 在 `src/openclaw-wizard.js` 的 `handleInbound` 加两个插入点 —— 改写 step 5 内 `targetSid.notFound` 的早返回（覆盖未绑定 lark thread）+ 在 step 5 块之后/step 6 fallback 之前补一段（覆盖 P2P/无活跃 session/pty 未注入）。`shouldLarkAutoCreate(...)` 局部 helper 统一守门。其它 channel/路由完全不动。

**Tech Stack:** Node.js (ESM)，Vitest，better-sqlite3，`createOpenClawWizard` 工厂闭包。

**Spec:** `docs/superpowers/specs/2026-05-15-lark-no-prefix-todo-design.md`

---

## File Structure

- **Modify**: `src/config.js`
  - `DEFAULT_LARK_CONFIG`（line 121-131）新增 `autoCreateTodo: true`
- **Modify**: `src/openclaw-wizard.js`
  - `handleInbound` 内新增局部 helper `shouldLarkAutoCreate`
  - 改写 `targetSid?.notFound` 分支（line 1568-1573）
  - 在 PTY proxy 块结束后、step 6 fallback 之前插入 auto-create 分支
- **Create**: `test/lark-auto-create.test.js`
  - 12 个场景，覆盖 spec 验收表

---

## Task 1: Config 默认值

**Files:**
- Modify: `src/config.js:121-131`
- Test: `test/lark-auto-create.test.js` (create file)

- [ ] **Step 1.1: 写第一个失败测试 —— 默认 config 含 autoCreateTodo=true**

Create `test/lark-auto-create.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { normalizeConfig } from '../src/config.js'

describe('lark auto-create config', () => {
  it('DEFAULT_LARK_CONFIG sets autoCreateTodo to true', () => {
    const cfg = normalizeConfig({})
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })

  it('user can opt out via explicit false', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: false } })
    expect(cfg.lark.autoCreateTodo).toBe(false)
  })

  it('any truthy value normalizes to retained', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: true } })
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })
})
```

- [ ] **Step 1.2: 跑测试验证失败**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npx vitest run test/lark-auto-create.test.js
```

Expected: FAIL with `expected undefined to be true`（field 还不存在）

- [ ] **Step 1.3: 给 DEFAULT_LARK_CONFIG 加字段**

Modify `src/config.js`, replace the block at lines 121-131:

```js
const DEFAULT_LARK_CONFIG = {
	enabled: false,
	appId: "",
	appSecret: "",
	chatId: "",
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	autoCreateTopic: true,
	autoCreateTodo: true,
	defaultPermissionMode: "bypass",
	notificationCooldownMs: 600_000,
};
```

- [ ] **Step 1.4: 跑测试验证通过**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected: 3 passed

- [ ] **Step 1.5: 提交**

```bash
git add src/config.js test/lark-auto-create.test.js
git commit -m "$(cat <<'EOF'
feat(config): add lark.autoCreateTodo flag (default true)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 2: Auto-create 兜底分支（fallback 边界）

**Files:**
- Modify: `src/openclaw-wizard.js:1255-1745` (`handleInbound` 函数)
- Test: `test/lark-auto-create.test.js`

这一步覆盖 spec 测试 #1, #6, #7, #8, #9, #11, #12（fallback-boundary 路径）+ 引入 `shouldLarkAutoCreate` helper。

- [ ] **Step 2.1: 在测试文件追加 fixture + 第一组 7 个测试**

Append to `test/lark-auto-create.test.js`:

```js
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe as describe2, it as it2, expect as expect2, beforeEach, afterEach } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawWizard } from '../src/openclaw-wizard.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'

function makeAi() {
  return { sessions: [], spawnSession(x) { this.sessions.push(x); return { sessionId: x.sessionId, reused: false } } }
}
function makeBridge() {
  const routes = new Map()
  return {
    routes,
    isEnabled: () => true,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: async () => ({ ok: true }),
    findSessionByRoute: () => null,           // 默认 lark thread 反查不到 → notFound
    getLastPushedSession: () => null,         // 默认 lastPush 未命中
    setLastPushedSession: () => true,
    clearLastPushForPeer: () => false,
  }
}
function makeWizard({ autoCreateTodo = true, withPty = true } = {}) {
  const db = openDb(':memory:')
  db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
  const ai = makeAi()
  const bridge = makeBridge()
  const pending = createPendingQuestionCoordinator({ db })
  const pty = withPty ? { has: () => false, write: () => {} } : undefined
  const wizard = createOpenClawWizard({
    db, aiTerminal: ai, openclaw: bridge, pending, pty,
    getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo } }),
  })
  return { db, ai, bridge, wizard }
}

describe('lark no-prefix auto-create — fallback boundary', () => {
  it('#1 lark P2P 普通文本 → 起 wizard，title=原文', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '修一下登录 bug',
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('修一下登录 bug')
    expect(r.reply).toContain('📁')
  })

  it('#6 lark P2P /help → fallback（slash 守门）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '/help',
    })
    expect(r.action).toBe('fallback')
  })

  it('#7 lark P2P /wat（未知 slash）→ fallback', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '/wat',
    })
    expect(r.action).toBe('fallback')
  })

  it('#8 autoCreateTodo=false → fallback', async () => {
    const { wizard } = makeWizard({ autoCreateTodo: false })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '修 X',
    })
    expect(r.action).toBe('fallback')
  })

  it('#9 telegram P2P 普通文本 → fallback（channel 隔离）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'telegram', chatId: '12345', threadId: null,
      text: '修 X',
    })
    expect(r.action).toBe('fallback')
  })

  it('#11 lark P2P + 多活跃 PTY → ambiguous（不起 wizard）', async () => {
    const { wizard, db, bridge } = makeWizard()
    // 注：通过 ai-terminal mock 注入"多活跃 session"。makeAi 没暴露 sessions Map，
    // 我们直接 hack 一个 aiTerminal.sessions 双 session。
    const ai2 = {
      sessions: new Map([
        ['s1', { sessionId: 's1', todoId: 1, status: 'running', startedAt: Date.now() }],
        ['s2', { sessionId: 's2', todoId: 1, status: 'running', startedAt: Date.now() - 1000 }],
      ]),
      spawnSession() { return { sessionId: 'x', reused: false } },
    }
    const pending = createPendingQuestionCoordinator({ db })
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: bridge, pending,
      pty: { has: () => true, write: () => {} },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await w2.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '做 X',
    })
    expect(r.action).toBe('stdin_proxy_ambiguous')
  })

  it('#12 纯图消息（text 为空）→ fallback（不起 wizard）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '', imagePaths: ['/tmp/fake.jpg'],
    })
    expect(r.action).toBe('fallback')
  })
})
```

- [ ] **Step 2.2: 跑测试验证失败**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected: 测试 #1 FAIL（"修一下登录 bug" 现在落 fallback 不起 wizard）。#6/#7/#8/#9/#11/#12 部分可能已 PASS（因为新逻辑还没加，仍走旧 fallback）。

记下哪些 fail。

- [ ] **Step 2.3: 在 handleInbound 引入 helper + 兜底分支**

Modify `src/openclaw-wizard.js`. 找到 `async function handleInbound(args = {}) {` 块（约 line 1255）。

**先在函数顶部、参数解析之后**（约 line 1273 `const routeKey = makeRouteKey(...)` 之后）加 helper（不依赖 `targetSid`）：

```js
    // 飞书无前缀建任务守门：只在 lark + autoCreateTodo + 非命令 + newTaskGateOpen 时返回 true
    // 调用方需自行确认 step 5 没找到 PTY 目标（targetSid null 或 notFound）
    function shouldLarkAutoCreate() {
      if (channel !== 'lark') return false
      if (getConfig?.()?.lark?.autoCreateTodo === false) return false
      if (!trimmed) return false
      if (/^\/[a-z][a-z0-9_]*\b/i.test(trimmed)) return false
      return true
    }
```

> 注意：`newTaskGateOpen` 在 line 1443 定义；helper 引用时它必须已在闭包内可见 —— 因为 helper 是函数声明，hoist 到 handleInbound 顶部，但 `newTaskGateOpen` 在 line 1443 才赋值，调用 helper 在 1443 之后调用是安全的。**调用前先确认 `newTaskGateOpen` 已定义**：本任务两个调用点（step 5.5 fallback、step 5 notFound 改写）都在 line 1443 之后。如担心顺序，把 `newTaskGateOpen` 的引用从 helper 内部挪到调用点的判断里。本 plan 采用调用点判断方案，helper 不引用 `newTaskGateOpen`：

修正后的 helper 改成：

```js
    // 飞书无前缀建任务守门：channel + 配置 + 文本 + slash 守门
    // 调用方需自行加 newTaskGateOpen + targetSid 缺失等额外条件
    function shouldLarkAutoCreate() {
      if (channel !== 'lark') return false
      if (getConfig?.()?.lark?.autoCreateTodo === false) return false
      if (!trimmed) return false
      if (/^\/[a-z][a-z0-9_]*\b/i.test(trimmed)) return false
      return true
    }
```

**然后**：找到 PTY proxy 整段结束、step 6 fallback 之前的位置（约 line 1720-1722）。当前代码：

```js
    }

    // 6. fallback
    // General 频道里专门提示：保护 PTY 上下文不被污染
    if (isInGeneralOfSupergroup) {
```

在 `}`（PTY 块闭合，line 1720）之后、`// 6. fallback` 之前插入：

```js
    }

    // 5.5 飞书无前缀建任务兜底：lark + autoCreateTodo + step 5 没匹配任何 PTY target →
    // 把消息原文当 title 起 wizard。Telegram/微信/openclaw 不受影响（channel 守门）。
    if (newTaskGateOpen && shouldLarkAutoCreate()) {
      logger.info?.(`[wizard] lark auto-create from non-prefix text: chatId=${chatId} thread=${threadId || '-'} title="${trimmed.slice(0, 80)}"`)
      const w = startWizard({ channel, chatId, threadId, text: trimmed, messageId, rootMessageId, imagePaths, userId: fromUserId })
      if (w.step === STEP_DONE) return await finalizeWizard(w)
      if (w.step === STEP_QUADRANT) {
        const p = buildQuadrantPrompt()
        return {
          reply: `任务: ${w.title}\n（目录已识别为 ${w.chosenWorkdir}）\n\n${p.text}`,
          replyMarkup: p.replyMarkup,
          action: 'wizard_started',
        }
      }
      if (w.step === STEP_TEMPLATE) {
        const tpls = db.listTemplates()
        w.cachedTemplates = tpls
        const p = buildTemplatePrompt(tpls)
        return {
          reply: `任务: ${w.title}\n（目录+象限已识别）\n\n${p.text}`,
          replyMarkup: p.replyMarkup,
          action: 'wizard_started',
        }
      }
      const p = buildWorkdirPrompt(w.workdirOptions)
      return {
        reply: `任务: ${w.title}\n\n${p.text}`,
        replyMarkup: p.replyMarkup,
        action: 'wizard_started',
      }
    }

    // 6. fallback
```

> 这段 reply 构造逻辑跟 step 3（line 1481-1505）完全同款 —— 复用以保持行为一致。

- [ ] **Step 2.4: 跑测试验证 7 个全部通过**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected: 3（config）+ 7（auto-create boundary）= 10 passed

如果 #11 没通过（仍走 auto-create 而不是 ambiguous），说明 helper 在 step 5 之前被调用了；检查插入位置。如果 #12 没通过（trimmed 空触发了 auto-create），检查 `if (!trimmed)` 守门。

- [ ] **Step 2.5: 跑全量测试确认没回归**

```bash
npx vitest run test/openclaw-wizard.test.js
```

Expected: all green

- [ ] **Step 2.6: 提交**

```bash
git add src/openclaw-wizard.js test/lark-auto-create.test.js
git commit -m "$(cat <<'EOF'
feat(wizard): lark no-prefix auto-create (fallback boundary)

handleInbound 加 shouldLarkAutoCreate 守门 + step 5 → step 6
之间插入飞书侧任意非命令文本自动起 wizard 的兜底分支。

未绑定 lark thread 的 notFound 早返回分支留给下一个 commit。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 3: Auto-create 改写未绑定 thread 的 notFound 早返回

**Files:**
- Modify: `src/openclaw-wizard.js:1568-1573`
- Test: `test/lark-auto-create.test.js`

这一步覆盖 spec 测试 #2（unbound thread auto-create）。

- [ ] **Step 3.1: 在测试文件追加 #2 的两个测试**

Append to `test/lark-auto-create.test.js`:

```js
describe('lark no-prefix auto-create — unbound thread (notFound branch)', () => {
  it('#2a lark 群里未绑 session 的 thread 首条消息 → 起 wizard', async () => {
    // bridge.findSessionByRoute 默认返回 null（makeBridge fixture），
    // pty 注入但 has() 永远返 false → step 5 走 thread 路径 → notFound
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_new', rootMessageId: null,
      messageId: 'm1', text: '重构 X',
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('重构 X')
  })

  it('#2b 同上但 autoCreateTodo=false → 保留原 "没有找到对应运行中的任务"', async () => {
    const { wizard } = makeWizard({ autoCreateTodo: false })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_new', rootMessageId: null,
      messageId: 'm1', text: '重构 X',
    })
    expect(r.action).toBe('session_not_found')
    expect(r.reply).toContain('没有找到对应运行中的任务')
  })
})
```

- [ ] **Step 3.2: 跑测试验证 #2a fail / #2b pass**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected:
- #2a FAIL（当前 notFound 早返回 "没有找到..."，不起 wizard）
- #2b PASS（autoCreateTodo=false 时 helper 返回 false，但仍走原 notFound 逻辑 —— 等改写后才能确认）

- [ ] **Step 3.3: 改写 notFound 分支**

Modify `src/openclaw-wizard.js`. 找到 line 1568-1573：

```js
      if (targetSid && typeof targetSid === 'object' && targetSid.notFound) {
        return {
          reply: '没有找到对应运行中的任务',
          action: 'session_not_found',
        }
      }
```

替换为：

```js
      if (targetSid && typeof targetSid === 'object' && targetSid.notFound) {
        // 未绑定 lark thread 的首条消息：默认起新建任务向导（受 autoCreateTodo 控制）
        if (newTaskGateOpen && shouldLarkAutoCreate()) {
          logger.info?.(`[wizard] lark auto-create from non-prefix text (unbound thread): chatId=${chatId} thread=${threadId || '-'} title="${trimmed.slice(0, 80)}"`)
          const w = startWizard({ channel, chatId, threadId, text: trimmed, messageId, rootMessageId, imagePaths, userId: fromUserId })
          if (w.step === STEP_DONE) return await finalizeWizard(w)
          if (w.step === STEP_QUADRANT) {
            const p = buildQuadrantPrompt()
            return {
              reply: `任务: ${w.title}\n（目录已识别为 ${w.chosenWorkdir}）\n\n${p.text}`,
              replyMarkup: p.replyMarkup,
              action: 'wizard_started',
            }
          }
          if (w.step === STEP_TEMPLATE) {
            const tpls = db.listTemplates()
            w.cachedTemplates = tpls
            const p = buildTemplatePrompt(tpls)
            return {
              reply: `任务: ${w.title}\n（目录+象限已识别）\n\n${p.text}`,
              replyMarkup: p.replyMarkup,
              action: 'wizard_started',
            }
          }
          const p = buildWorkdirPrompt(w.workdirOptions)
          return {
            reply: `任务: ${w.title}\n\n${p.text}`,
            replyMarkup: p.replyMarkup,
            action: 'wizard_started',
          }
        }
        return {
          reply: '没有找到对应运行中的任务',
          action: 'session_not_found',
        }
      }
```

- [ ] **Step 3.4: 跑测试验证 #2a 和 #2b 全部通过**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected: 12 passed total

- [ ] **Step 3.5: 跑全量测试确认没回归**

```bash
npx vitest run
```

Expected: all green。重点关注：
- `test/openclaw-wizard.test.js`（核心 wizard 行为）
- `test/openclaw-hook.lark-followup.integration.test.js`（lark 续聊路径）
- `test/settings-drawer-lark-config.test.js`（Web Settings 不能因为新增字段炸）

如果有 fail，停下来看 spec 是不是漏写了某种 case；不要随便改测试。

- [ ] **Step 3.6: 提交**

```bash
git add src/openclaw-wizard.js test/lark-auto-create.test.js
git commit -m "$(cat <<'EOF'
feat(wizard): lark no-prefix auto-create (unbound thread)

改写 step 5 内 targetSid.notFound 早返回：autoCreateTodo 打开时
未绑定 lark thread 的首条消息也起 wizard，不再回 "没有找到对应
运行中的任务"。autoCreateTodo=false 保留原 notFound 提示。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 4: 回归测试（已有路径仍正确，不需新代码）

**Files:**
- Test: `test/lark-auto-create.test.js`

这一步覆盖 spec 测试 #3, #4, #5, #10 —— 验证现有路径仍优先于新逻辑，没被无前缀分支抢走。

- [ ] **Step 4.1: 追加回归测试**

Append to `test/lark-auto-create.test.js`:

```js
describe('lark no-prefix auto-create — precedence guards', () => {
  it('#3 旧 "帮我做" 前缀仍走 step 3 NEW_TASK_TRIGGERS', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '帮我做 写个 demo',
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('写个 demo')
  })

  it('#4 lastPush 命中 → 走 step 5 PTY，不起 wizard', async () => {
    const db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    const ai = makeAi()
    const bridge = makeBridge()
    bridge.getLastPushedSession = () => 'sid_recent'
    const writes = []
    const pty = { has: (sid) => sid === 'sid_recent', write: (sid, d) => writes.push({ sid, d }) }
    const pending = createPendingQuestionCoordinator({ db })
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '继续看一下',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes.length).toBeGreaterThan(0)
  })

  it('#5 绑定 alive lark thread → 走 step 0 stdin proxy', async () => {
    const db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    const ai = makeAi()
    const bridge = makeBridge()
    bridge.findSessionByRoute = ({ chatId, threadId }) =>
      (chatId === 'oc_grp' && threadId === 'omt_alive') ? 'sid_alive' : null
    const writes = []
    const pty = { has: (sid) => sid === 'sid_alive', write: (sid, d) => writes.push({ sid, d }) }
    const pending = createPendingQuestionCoordinator({ db })
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_alive', rootMessageId: 'm_root',
      messageId: 'm1', text: '改一下',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes.length).toBeGreaterThan(0)
  })

  it('#10 auto-create 起 wizard 后回 "取消" → wizard 被中止', async () => {
    const { wizard } = makeWizard()
    const r1 = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '修复 X',
    })
    expect(r1.action).toBe('wizard_started')
    const r2 = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm2',
      text: '取消',
    })
    expect(r2.action).toBe('wizard_cancelled')
  })
})
```

- [ ] **Step 4.2: 跑测试**

```bash
npx vitest run test/lark-auto-create.test.js
```

Expected: 16 passed total（3 + 7 + 2 + 4）

如有 fail：
- #3 fail：说明新分支抢走了 step 3 —— 检查插入点是否在 step 3 之前
- #4 fail：说明 lastPush 路径被破坏 —— 不应该，检查 bridge mock
- #5 fail：说明 larkBoundThreadSid 路径被破坏
- #10 fail：说明 cancel 路径被新分支抢 —— 检查 step 1 顺序

- [ ] **Step 4.3: 跑全量回归**

```bash
npx vitest run
```

Expected: all green

- [ ] **Step 4.4: 提交**

```bash
git add test/lark-auto-create.test.js
git commit -m "$(cat <<'EOF'
test(wizard): lark auto-create precedence regression tests

验证 帮我做 前缀、lastPush 命中、绑定 thread、取消语等已有路径
仍优先于新加的飞书无前缀 auto-create 分支。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 5: 人工验收清单

**Files:** —— 不改代码

- [ ] **Step 5.1: 飞书 P2P 默认行为**

在飞书私聊跟 bot 发：`做个签到打卡功能`
Expected: bot 回复 `📁 选个工作目录：` 起 wizard

- [ ] **Step 5.2: 飞书 P2P 续聊不被误吃**

跟 bot 走完一个 wizard 起 PTY → bot 推过消息 → 再发短消息 `嗯` 或 `好`
Expected: 消息被转给 PTY（lastPush 命中），bot 不回 `任务: 嗯`

- [ ] **Step 5.3: 未绑定 lark 群话题**

在群里新建一个话题（bot 没参与过），首条消息发：`重构 X`
Expected: bot 回 `任务: 重构 X` 起 wizard，**不**回 `没有找到对应运行中的任务`

- [ ] **Step 5.4: 关闭开关回滚**

编辑 `~/.config/agentquad/config.json`（或 `quadtodo/config.json`），把 `lark.autoCreateTodo` 设为 `false`，重启服务。再在飞书 P2P 发 `修 X`
Expected: bot 回 `🤔 我没看懂这条消息` 这种 fallback；改回 true 后恢复。

- [ ] **Step 5.5: 误触可恢复**

故意触发误触：服务重启后，发 `嗯` 一句 → wizard 起来了 → 回 `取消`
Expected: bot 回 `✓ 已取消向导`，无数据残留（`db.listTodos()` 没有 title=`嗯` 的 todo）

---

## Self-Review Checklist（已自查）

- ✅ **Spec coverage**：12 个 spec 测试场景已分布到 Task 2 (#1, #6, #7, #8, #9, #11, #12)、Task 3 (#2)、Task 4 (#3, #4, #5, #10)
- ✅ **No placeholders**：所有代码块都是可执行的完整内容
- ✅ **Type consistency**：`shouldLarkAutoCreate` 在 Task 2 引入，Task 3 复用；`startWizard` 参数签名一致；`action` 字符串值（`wizard_started` / `fallback` / `session_not_found` / `stdin_proxy` / `stdin_proxy_ambiguous` / `wizard_cancelled`）与 `src/openclaw-wizard.js` 现有定义一致
- ✅ **TDD 顺序**：每个 task 都是 写测试 → 跑 → 看 FAIL → 实现 → 跑 → 看 PASS → commit
- ✅ **回滚路径**：`autoCreateTodo: false` 显式关闭；Task 3 显式保留原 notFound 行为

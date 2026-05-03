/**
 * 启动 AI session 时自动 prepend 到 prompt 的"工程纪律"。
 *
 * 这一段会出现在每条 task 的 prompt 顶部，强化 AI 行为：
 *   - 拍板必走 ask_user MCP 工具（保证 telegram 端是按钮交互）
 *   - 不要在 chat 文本里堆"我有 N 个问题"列表（这种格式在 telegram 没按钮，体验差）
 *
 * 默认不注入，避免把 Claude Code 推进交互式 TUI。
 * 想启用：config.aiSession.enforceAskUserRule = true
 */

const ASK_USER_RULE = `# 工程纪律 · 拍板必须用 ask_user MCP 工具

任何需要用户拍板、确认方向、做选择的场景（包括但不限于：
"请确认"、"用 X 还是 Y"、"OK 吗"、"哪个方案对"、"我有 N 个问题想问你"），
必须调用 ask_user MCP 工具，而不是在 chat 文本里写
✅/✏️、(a)/(b)/(c)、1./2./3. 让用户在 chat 里数字回复。

理由：用户的 chat 客户端（Telegram）会把 ask_user 自动渲染成 inline 按钮，
一键点选 + 可选 ✏️ 补充细节；而你直接写在文本里的"问题列表"是纯文本，
用户得手敲数字回，体验差且容易记错。

ask_user 用法：
  question: 一句话精炼问题（不要堆原因/上下文，那些放在 PTY 输出即可）
  options:  2-8 个互斥选项（每个 ≤ 30 字，越短越好）

多个独立决策 → 多次调 ask_user（每次一个问题，AI 拿到答案后再问下一个）。
不要把多个问题塞进一次 ask_user 的 question 里。
`

export function getAskUserSystemRule() {
  return ASK_USER_RULE
}

/**
 * 拼最终 prompt：
 *   [system rule]
 *   ---
 *   [original prompt：来自 template / user 的内容]
 *
 * 入参：
 *   - originalPrompt: caller 已经拼好的 prompt（template + 任务描述）
 *   - enforce: 是否启用规则；缺省 false
 *
 * 返回：拼装后的 prompt 字符串。enforce=false 时原样返回 originalPrompt。
 */
export function applySystemRules(originalPrompt, { enforce = false } = {}) {
  const orig = String(originalPrompt || '').trim()
  if (!enforce) return orig
  if (!orig) return ASK_USER_RULE.trim()
  return `${ASK_USER_RULE.trim()}\n\n---\n\n${orig}`
}

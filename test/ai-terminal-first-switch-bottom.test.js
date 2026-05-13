import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Live 终端首次切换不应有"滚动下去"的动画 —— Focus view 默认在 Conversation tab，
// AiTerminalMini 挂载时父容器 display:none，xterm WriteBuffer 持续积压 replay + live-output。
// 用户点 Live tab 后若直接按 rAF 计时 reveal，xterm 还在解析积压，opacity:0→1
// 那一刻起的几帧里 auto-scroll 把视口往下推，被肉眼读成滚动动画。
// 修法是把 reveal 挂在 term.write('', cb) 上 —— xterm 保证 cb 在 WriteBuffer
// 全部解析进 buffer 后才 fire，配合 scrollToBottom 就能保证揭开那一刻已经在最底部。
describe('AiTerminalMini first-switch bottom-snap', () => {
  const source = readFileSync('web/src/AiTerminalMini.tsx', 'utf8')

  it('reveal path waits for xterm WriteBuffer to drain via term.write("", cb)', () => {
    // 必须有用空字符串 + 回调形式的 write 出现在 doFit / 揭开路径里
    expect(source).toMatch(/term\.write\(\s*['"]{2}\s*,\s*\(\s*\)\s*=>/)
  })

  it('scrollToBottom is invoked inside the drain callback (not just before reveal)', () => {
    // 抓出从 term.write('', () => { 到匹配的 }) 之间的回调体，断言里面有 scrollToBottom
    const match = source.match(/term\.write\(\s*['"]{2}\s*,\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\)/)
    expect(match).toBeTruthy()
    expect(match[1]).toMatch(/scrollToBottom\(\)/)
  })
})

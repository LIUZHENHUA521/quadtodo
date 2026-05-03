import { describe, it, expect } from 'vitest'
import {
  buildAskUserReplyMarkup,
  parseCallbackData,
  buildAnswerReplyText,
  buildExtendedReplyText,
  CB_PREFIX,
  CB_KIND_ANSWER,
  CB_KIND_EXTEND,
} from '../src/ask-user-buttons.js'

describe('buildAskUserReplyMarkup', () => {
  it('短文本 ≤4 选项 → 2 列布局', () => {
    const mk = buildAskUserReplyMarkup('abc', ['北京时间', '自定义'])
    // 2 列：第一行选项行（2 个按钮），第二行 ✏️ 行（2 个按钮）
    expect(mk.inline_keyboard).toHaveLength(2)
    expect(mk.inline_keyboard[0]).toHaveLength(2)
    expect(mk.inline_keyboard[1]).toHaveLength(2)
    // 选项按钮文本和 callback_data
    expect(mk.inline_keyboard[0][0].text).toBe('1. 北京时间')
    expect(mk.inline_keyboard[0][0].callback_data).toBe('qt:ans:abc:0')
    expect(mk.inline_keyboard[0][1].callback_data).toBe('qt:ans:abc:1')
    // ✏️ 行
    expect(mk.inline_keyboard[1][0].text).toContain('✏️')
    expect(mk.inline_keyboard[1][0].callback_data).toBe('qt:ext:abc:0')
    expect(mk.inline_keyboard[1][1].callback_data).toBe('qt:ext:abc:1')
  })

  it('长文本 → 1 列布局，主按钮 + 行尾 ✏️', () => {
    const mk = buildAskUserReplyMarkup('xyz', [
      '使用北京时间作为统一时区',
      '让用户每条手动设置时区',
    ])
    expect(mk.inline_keyboard).toHaveLength(2)
    // 每行 2 个按钮：主按钮 + ✏️
    expect(mk.inline_keyboard[0]).toHaveLength(2)
    expect(mk.inline_keyboard[0][0].callback_data).toBe('qt:ans:xyz:0')
    expect(mk.inline_keyboard[0][1].text).toBe('✏️')
    expect(mk.inline_keyboard[0][1].callback_data).toBe('qt:ext:xyz:0')
  })

  it('选项数 > 4 → 强制 1 列', () => {
    const mk = buildAskUserReplyMarkup('def', ['a', 'b', 'c', 'd', 'e'])
    expect(mk.inline_keyboard).toHaveLength(5)
    for (const row of mk.inline_keyboard) {
      expect(row).toHaveLength(2)        // 1 主 + 1 ✏️
      expect(row[1].text).toBe('✏️')
    }
  })

  it('callback_data ≤ 64 字节', () => {
    const mk = buildAskUserReplyMarkup('a3f', ['北京时间', 'UTC'])
    for (const row of mk.inline_keyboard) {
      for (const btn of row) {
        const bytes = Buffer.byteLength(btn.callback_data, 'utf8')
        expect(bytes).toBeLessThanOrEqual(64)
      }
    }
  })

  it('按钮文本超长被截断到 24 字符 + …', () => {
    const longOpt = '这是一个非常非常非常非常非常长的选项文字应该被截断'
    const mk = buildAskUserReplyMarkup('xyz', [longOpt, 'short'])
    // 长选项 → 走 1 列布局；主按钮文本 ≤ 25（24 + 省略号）
    expect(mk.inline_keyboard[0][0].text.length).toBeLessThanOrEqual(25)
    expect(mk.inline_keyboard[0][0].text).toContain('…')
  })

  it('坏入参抛错', () => {
    expect(() => buildAskUserReplyMarkup('', ['a', 'b'])).toThrow('ticket')
    expect(() => buildAskUserReplyMarkup('abc', [])).toThrow('options')
    expect(() => buildAskUserReplyMarkup('abc', null)).toThrow('options')
  })

  it('单个选项也能渲染（不走 2 列）', () => {
    const mk = buildAskUserReplyMarkup('abc', ['only_choice'])
    expect(mk.inline_keyboard).toHaveLength(1)
    expect(mk.inline_keyboard[0]).toHaveLength(2)   // 主 + ✏️
  })
})

describe('parseCallbackData', () => {
  it('解析 qt:ans:<ticket>:<idx>', () => {
    expect(parseCallbackData('qt:ans:abc:0')).toEqual({ kind: CB_KIND_ANSWER, ticket: 'abc', idx: 0 })
    expect(parseCallbackData('qt:ans:xyz:5')).toEqual({ kind: CB_KIND_ANSWER, ticket: 'xyz', idx: 5 })
  })

  it('解析 qt:ext:<ticket>:<idx>', () => {
    expect(parseCallbackData('qt:ext:abc:2')).toEqual({ kind: CB_KIND_EXTEND, ticket: 'abc', idx: 2 })
  })

  it('未知 prefix → null', () => {
    expect(parseCallbackData('xx:ans:abc:0')).toBeNull()
    expect(parseCallbackData('')).toBeNull()
    expect(parseCallbackData(null)).toBeNull()
  })

  it('wizard 老 prefix qt:wd / qt:q / qt:t → null（让 wizard 自己处理）', () => {
    expect(parseCallbackData('qt:wd:0')).toBeNull()
    expect(parseCallbackData('qt:q:1')).toBeNull()
    expect(parseCallbackData('qt:t:none')).toBeNull()
  })

  it('坏 idx → null', () => {
    expect(parseCallbackData('qt:ans:abc:not-a-number')).toBeNull()
    expect(parseCallbackData('qt:ans:abc:-1')).toBeNull()
    expect(parseCallbackData('qt:ans:abc:100')).toBeNull()    // > 99
  })

  it('字段数量错误 → null', () => {
    expect(parseCallbackData('qt:ans')).toBeNull()
    expect(parseCallbackData('qt:ans:abc')).toBeNull()
    expect(parseCallbackData('qt:ans:abc:0:extra')).toBeNull()
  })
})

describe('buildAnswerReplyText', () => {
  it('idx → 1-based 数字字符串', () => {
    expect(buildAnswerReplyText(0)).toBe('1')
    expect(buildAnswerReplyText(1)).toBe('2')
    expect(buildAnswerReplyText(7)).toBe('8')
  })
})

describe('buildExtendedReplyText', () => {
  it('option + extra 用 · 分隔', () => {
    expect(buildExtendedReplyText('北京时间', '不要 +08:00 用 +0800')).toBe('北京时间 · 不要 +08:00 用 +0800')
  })
  it('extra 缺省 → 只保留 option', () => {
    expect(buildExtendedReplyText('北京时间', '')).toBe('北京时间')
    expect(buildExtendedReplyText('北京时间', null)).toBe('北京时间')
  })
  it('option 缺省 → 只保留 extra', () => {
    expect(buildExtendedReplyText('', 'free text')).toBe('free text')
  })
  it('两者都空 → 空串', () => {
    expect(buildExtendedReplyText('', '')).toBe('')
  })
  it('两端 trim', () => {
    expect(buildExtendedReplyText('  opt  ', '  ex  ')).toBe('opt · ex')
  })
})

describe('常量 sanity', () => {
  it('prefix / kind 常量都是非空字符串', () => {
    expect(CB_PREFIX).toBe('qt')
    expect(CB_KIND_ANSWER).toBe('ans')
    expect(CB_KIND_EXTEND).toBe('ext')
  })
})

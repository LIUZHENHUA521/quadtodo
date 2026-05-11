import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve('web/src/transcripts/TranscriptSearchDrawer.tsx'), 'utf8')

describe('TranscriptSearchDrawer layout regression', () => {
  it('keeps long bound todo tags from overflowing the drawer', () => {
    expect(source).toContain('Tooltip')
    expect(source).toContain('const ellipsisTagStyle')
    expect(source).toContain("maxWidth: '100%'")
    expect(source).toContain("overflow: 'hidden'")
    expect(source).toContain("textOverflow: 'ellipsis'")
    expect(source).toContain("whiteSpace: 'nowrap'")
    expect(source).toContain("minWidth: 0")
    expect(source).toContain('title={boundTodoTitle}')
    expect(source).toContain('style={ellipsisTagStyle}')
  })

  it('allows the result card header row to shrink before long tags are ellipsized', () => {
    expect(source).toContain('const resultHeaderStyle')
    expect(source).toContain("display: 'flex'")
    expect(source).toContain("flexWrap: 'wrap'")
    expect(source).toContain('const boundTagSlotStyle')
    expect(source).toContain("flex: '1 1 180px'")
    expect(source).toContain("maxWidth: '100%'")
    expect(source).toContain('style={resultHeaderStyle}')
    expect(source).toContain('style={boundTagSlotStyle}')
  })
})

describe('TranscriptSearchDrawer preview modal empty / error fallback', () => {
  it('shows <Empty/> when preview returns zero turns', () => {
    // 兜底分支：!previewLoading && previewTurns.length === 0 → 渲染 Empty
    expect(source).toMatch(/previewTurns\.length === 0[\s\S]*?<Empty/)
    expect(source).toContain('该会话暂无可展示内容')
  })

  it('closes preview modal when handlePreview throws', () => {
    // 在 handlePreview 的 catch 块里同步把 previewFile 置空，避免 API 失败后留白壳 modal。
    const handlePreviewMatch = source.match(/async function handlePreview[\s\S]*?\n  \}\n/)
    expect(handlePreviewMatch, 'handlePreview function not found').toBeTruthy()
    expect(handlePreviewMatch[0]).toMatch(/catch[\s\S]*?setPreviewFile\(null\)/)
  })
})

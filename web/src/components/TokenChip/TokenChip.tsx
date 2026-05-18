import { useTranslation } from 'react-i18next'
import { ContainerOutlined } from '@ant-design/icons'
import type { AiTool, SessionUsage } from '../../api'
import './TokenChip.css'

// Context window 默认值。Claude 4.x 加 [1m] flag 才到 1M，没法从 JSONL 反查，
// 全员按 200K 估算 —— 用 [1m] 的会看到 %偏高但能用，绝大多数场景准确。
function contextWindowFor(tool: AiTool): number {
  if (tool === 'codex') return 400_000  // GPT-5 默认
  return 200_000                          // Claude / 其他兜底
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k'
  if (n < 1_000_000) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}

export interface TokenChipProps {
  tool: AiTool
  usage: SessionUsage | null
}

export function TokenChip({ tool, usage }: TokenChipProps) {
  const { t } = useTranslation(['todo'])
  if (tool === 'cursor') {
    return <span className="token-chip token-chip-na">{t('todo:card.tokenNA')}</span>
  }
  if (!usage) return null
  // Claude TUI 显示的"当前 context size" = input + cache_read + cache_creation
  const contextTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheCreation || 0)
  if (contextTokens === 0) return null
  const window = contextWindowFor(tool)
  const pct = (contextTokens / window) * 100
  const title = `input ${usage.input.toLocaleString()} · cache ${(usage.cacheRead + usage.cacheCreation).toLocaleString()} · output ${usage.output.toLocaleString()}${usage.model ? ` · ${usage.model}` : ''} · ${Math.round(pct)}% of ${window / 1000}k window`
  return (
    <span className={pct >= 80 ? 'token-chip token-chip-tag is-warn' : 'token-chip token-chip-tag'} title={title}>
      <ContainerOutlined className="token-chip-icon" />
      {formatTokens(contextTokens)}
    </span>
  )
}

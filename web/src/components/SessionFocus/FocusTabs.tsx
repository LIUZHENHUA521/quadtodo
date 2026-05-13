import type { FocusTab } from '../../store/focusStore'

interface Props {
  value: FocusTab
  onChange: (tab: FocusTab) => void
}

const TABS: { key: FocusTab; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'live', label: 'Live 终端' },
  { key: 'log', label: 'Log 日志' },
]

export function FocusTabs({ value, onChange }: Props) {
  return (
    <div className="focus-tabs">
      {TABS.map((t) => (
        <button
          key={t.key}
          className={`focus-tab${value === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

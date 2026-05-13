import { Dropdown } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { StageTag } from '../../api'
import { STAGE_TAGS, STAGE_TAG_META } from '../../stageTags'

export interface StageTagChipProps {
  value: StageTag | null
  onChange: (next: StageTag | null) => void
  disabled?: boolean
}

export function StageTagChip({ value, onChange, disabled }: StageTagChipProps) {
  const items = [
    ...STAGE_TAGS.map(tag => {
      const meta = STAGE_TAG_META[tag]
      return { key: tag, label: `${meta.emoji} ${meta.label}` }
    }),
    { type: 'divider' as const },
    { key: '__clear__', label: '清除', disabled: value == null },
  ]

  const handleClick = ({ key }: { key: string }) => {
    if (key === '__clear__') onChange(null)
    else onChange(key as StageTag)
  }

  const meta = value != null ? STAGE_TAG_META[value] : null

  const trigger = meta == null
    ? (
      <button type="button" className="stage-tag-chip stage-tag-chip--empty" disabled={disabled}>
        <PlusOutlined />
        <span>加阶段</span>
      </button>
    )
    : (
      <button type="button" className={`stage-tag-chip ${meta.className}`} disabled={disabled}>
        <span>{meta.emoji}</span>
        <span>{meta.label}</span>
      </button>
    )

  return (
    <Dropdown
      menu={{ items, onClick: handleClick }}
      trigger={['click']}
      disabled={disabled}
    >
      <span onClick={(e) => e.stopPropagation()}>{trigger}</span>
    </Dropdown>
  )
}

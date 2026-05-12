import type { Quadrant } from '../../api'

export const QUADRANT_CONFIG = [
  { q: 1 as Quadrant, label: '重要且紧急', priority: 'P0', color: '#ff4d4f', bgBadge: 'count-badge-1' },
  { q: 2 as Quadrant, label: '重要不紧急', priority: 'P1', color: '#faad14', bgBadge: 'count-badge-2' },
  { q: 3 as Quadrant, label: '紧急不重要', priority: 'P2', color: '#1677ff', bgBadge: 'count-badge-3' },
  { q: 4 as Quadrant, label: '不重要不紧急', priority: 'P3', color: '#52c41a', bgBadge: 'count-badge-4' },
]

export type QuadrantConfigItem = typeof QUADRANT_CONFIG[number]

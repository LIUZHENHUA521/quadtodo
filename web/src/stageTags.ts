import type { StageTag } from './api'

export const STAGE_TAGS: readonly StageTag[] = ['dev', 'review', 'test', 'release', 'blocked'] as const

export const STAGE_TAG_META: Record<StageTag, { label: string; emoji: string; className: string }> = {
  dev:     { label: '待开发', emoji: '🔧', className: 'stage-tag-dev' },
  review:  { label: '待评审', emoji: '👀', className: 'stage-tag-review' },
  test:    { label: '待测试', emoji: '🧪', className: 'stage-tag-test' },
  release: { label: '待发布', emoji: '🚀', className: 'stage-tag-release' },
  blocked: { label: '阻塞中', emoji: '⛔', className: 'stage-tag-blocked' },
}

import type { ReactNode } from 'react'
import { createElement } from 'react'
import { Wrench, MessageSquare, FlaskConical, Rocket, Ban } from 'lucide-react'
import type { StageTag } from './api'

export const STAGE_TAGS: readonly StageTag[] = ['dev', 'review', 'test', 'release', 'blocked'] as const

export const STAGE_TAG_META: Record<StageTag, { label: string; icon: () => ReactNode; className: string }> = {
  dev:     { label: '待开发', icon: () => createElement(Wrench, { size: 12 }),          className: 'stage-tag-dev' },
  review:  { label: '待评审', icon: () => createElement(MessageSquare, { size: 12 }),   className: 'stage-tag-review' },
  test:    { label: '待测试', icon: () => createElement(FlaskConical, { size: 12 }),     className: 'stage-tag-test' },
  release: { label: '待发布', icon: () => createElement(Rocket, { size: 12 }),           className: 'stage-tag-release' },
  blocked: { label: '阻塞中', icon: () => createElement(Ban, { size: 12 }),              className: 'stage-tag-blocked' },
}

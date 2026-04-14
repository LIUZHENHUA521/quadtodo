import type { PetState } from '../store/aiSessionStore'
import type { AiTool, Quadrant } from '../api'

export const QUADRANT_TINT: Record<Quadrant, number> = {
  1: 0xff4d4f,
  2: 0xfaad14,
  3: 0x1677ff,
  4: 0x8c8c8c,
}

export const STATE_EMOJI: Record<PetState, string> = {
  idle: '😌',
  working: '⚡',
  thinking: '🤔',
  calling: '🙋',
  celebrating: '🎉',
  fallen: '💤',
  statue: '🗿',
  disconnected: '⚠️',
}

export function petShape(tool: AiTool): 'round' | 'box' {
  return tool === 'claude' ? 'round' : 'box'
}

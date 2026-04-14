import React from 'react'
import PetQuadrantCanvas from './PetQuadrantCanvas'
import type { Quadrant } from '../api'

const QUADRANT_META: { q: Quadrant; label: string; priority: string; color: string }[] = [
  { q: 1, label: '重要且紧急', priority: 'P0', color: '#ff4d4f' },
  { q: 2, label: '重要不紧急', priority: 'P1', color: '#faad14' },
  { q: 3, label: '紧急不重要', priority: 'P2', color: '#1677ff' },
  { q: 4, label: '不重要不紧急', priority: 'P3', color: '#8c8c8c' },
]

export default function PetView({
  onPetClick,
}: {
  onPetClick?: (sessionId: string, todoId: string) => void
}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      gap: 8,
      height: 'calc(100vh - 140px)',
    }}>
      {QUADRANT_META.map(m => (
        <div key={m.q} style={{
          position: 'relative',
          border: `2px solid ${m.color}`,
          borderRadius: 8,
          overflow: 'hidden',
          background: '#fff',
        }}>
          <div style={{
            position: 'absolute', top: 6, left: 8, zIndex: 2,
            fontSize: 12, color: m.color, fontWeight: 600,
          }}>
            {m.priority} · {m.label}
          </div>
          <PetQuadrantCanvas quadrant={m.q} onPetClick={onPetClick} />
        </div>
      ))}
    </div>
  )
}

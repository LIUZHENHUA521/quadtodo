import React, { useEffect, useRef } from 'react'
import { Application } from 'pixi.js'
import { Pet } from './Pet'
import { useAiSessionStore, derivePetState, rateMultiplier, type SessionMeta } from '../store/aiSessionStore'
import type { Quadrant } from '../api'

const STATUE_MS = 5 * 60 * 1000

export default function PetQuadrantCanvas({
  quadrant,
  onPetClick,
}: {
  quadrant: Quadrant
  onPetClick?: (sessionId: string, todoId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const petsRef = useRef<Map<string, Pet>>(new Map())
  const sessions = useAiSessionStore(s => s.sessions)
  const rates = useAiSessionStore(s => s.outputRates)

  useEffect(() => {
    let mounted = true
    const el = containerRef.current
    if (!el) return
    const app = new Application()
    app.init({
      resizeTo: el,
      background: 0xfafafa,
      antialias: true,
    }).then(() => {
      if (!mounted) { app.destroy(true); return }
      el.appendChild(app.canvas)
      appRef.current = app
    })
    return () => {
      mounted = false
      petsRef.current.clear()
      if (appRef.current) {
        try { appRef.current.destroy(true, { children: true }) } catch (e) { console.warn('[Pet] destroy error:', e) }
        appRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const app = appRef.current
    if (!app) return

    const now = Date.now()
    const relevant: SessionMeta[] = []
    for (const s of sessions.values()) {
      if (s.quadrant !== quadrant) continue
      if (s.status === 'done' || s.status === 'failed' || s.status === 'stopped') {
        if (s.completedAt && now - s.completedAt > STATUE_MS) continue
      }
      relevant.push(s)
    }

    const seen = new Set<string>()
    for (const s of relevant) {
      seen.add(s.sessionId)
      let pet = petsRef.current.get(s.sessionId)
      if (!pet) {
        pet = new Pet(s)
        pet.on('pointertap', () => onPetClick?.(s.sessionId, s.todoId))
        app.stage.addChild(pet)
        petsRef.current.set(s.sessionId, pet)
      } else {
        pet.drawBody(s)
      }
    }

    for (const [id, pet] of petsRef.current) {
      if (!seen.has(id)) {
        app.stage.removeChild(pet)
        pet.destroy()
        petsRef.current.delete(id)
      }
    }

    const w = app.renderer.width
    const h = app.renderer.height
    const count = relevant.length
    relevant.forEach((s, i) => {
      const pet = petsRef.current.get(s.sessionId)
      if (!pet) return
      const col = count <= 1 ? 0 : (i / (count - 1)) * 0.7 + 0.15
      pet.setAnchor(w * col + (count <= 1 ? w / 2 : 0), h * 0.7)
    })
  }, [sessions, quadrant, onPetClick])

  useEffect(() => {
    const app = appRef.current
    if (!app || !app.ticker) return
    const tick = (ticker: any) => {
      const now = Date.now()
      const dt = ticker.deltaMS ?? 16
      for (const [id, pet] of petsRef.current) {
        const s = sessions.get(id)
        if (!s) continue
        const rate = rates.get(id) || 0
        let state
        if (s.status === 'done' || s.status === 'failed' || s.status === 'stopped') {
          if (s.completedAt && now - s.completedAt > 30_000) {
            state = 'statue' as const
          } else {
            state = derivePetState(s, rate, now)
          }
        } else {
          state = derivePetState(s, rate, now)
        }
        pet.update(state, rateMultiplier(rate), dt)
      }
    }
    app.ticker.add(tick)
    return () => {
      try { app.ticker?.remove(tick) } catch {}
    }
  }, [sessions, rates])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 120 }} />
  )
}

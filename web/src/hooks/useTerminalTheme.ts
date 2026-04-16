import { useCallback, useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'
import {
  TERMINAL_PRESETS,
  TerminalPresetName,
  isPresetName,
  isValidColor,
} from '../terminalThemes'

const STORAGE_KEY = 'quadtodo.terminalTheme'
const EVENT_NAME = 'quadtodo:terminalTheme'

export interface ThemeOverride {
  background?: string
  foreground?: string
}

interface StoredTheme {
  preset: TerminalPresetName
  override: ThemeOverride
}

const DEFAULT_STORED: StoredTheme = { preset: 'default', override: {} }

function readStored(): StoredTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STORED
    const parsed = JSON.parse(raw)
    const preset: TerminalPresetName = isPresetName(parsed?.preset) ? parsed.preset : 'default'
    const override: ThemeOverride = {}
    if (parsed?.override && typeof parsed.override === 'object') {
      if (isValidColor(parsed.override.background)) override.background = parsed.override.background
      if (isValidColor(parsed.override.foreground)) override.foreground = parsed.override.foreground
    }
    return { preset, override }
  } catch {
    return DEFAULT_STORED
  }
}

function writeStored(next: StoredTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME))
  } catch { /* ignore */ }
}

function subscribe(callback: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) callback()
  }
  const onCustom = () => callback()
  window.addEventListener('storage', onStorage)
  window.addEventListener(EVENT_NAME, onCustom as EventListener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(EVENT_NAME, onCustom as EventListener)
  }
}

let snapshotCache: { raw: string; value: StoredTheme } | null = null

function getStoredSnapshot(): StoredTheme {
  let raw: string
  try { raw = localStorage.getItem(STORAGE_KEY) || '' } catch { raw = '' }
  if (snapshotCache && snapshotCache.raw === raw) return snapshotCache.value
  const value = readStored()
  snapshotCache = { raw, value }
  return value
}

function mergeTheme(stored: StoredTheme): ITheme {
  const base = TERMINAL_PRESETS[stored.preset] || TERMINAL_PRESETS.default
  if (!stored.override.background && !stored.override.foreground) return base
  return {
    ...base,
    ...(stored.override.background ? { background: stored.override.background } : {}),
    ...(stored.override.foreground ? { foreground: stored.override.foreground } : {}),
  }
}

export interface UseTerminalTheme {
  theme: ITheme
  preset: TerminalPresetName
  override: ThemeOverride
  setPreset: (name: TerminalPresetName) => void
  setOverride: (patch: ThemeOverride) => void
  resetOverride: () => void
}

export function useTerminalTheme(): UseTerminalTheme {
  const stored = useSyncExternalStore(subscribe, getStoredSnapshot, getStoredSnapshot)

  const setPreset = useCallback((name: TerminalPresetName) => {
    if (!isPresetName(name)) return
    writeStored({ preset: name, override: {} })
  }, [])

  const setOverride = useCallback((patch: ThemeOverride) => {
    const current = readStored()
    const next: ThemeOverride = { ...current.override }
    if (patch.background !== undefined) {
      if (isValidColor(patch.background)) next.background = patch.background
      else delete next.background
    }
    if (patch.foreground !== undefined) {
      if (isValidColor(patch.foreground)) next.foreground = patch.foreground
      else delete next.foreground
    }
    writeStored({ preset: current.preset, override: next })
  }, [])

  const resetOverride = useCallback(() => {
    const current = readStored()
    writeStored({ preset: current.preset, override: {} })
  }, [])

  return {
    theme: mergeTheme(stored),
    preset: stored.preset,
    override: stored.override,
    setPreset,
    setOverride,
    resetOverride,
  }
}

export const __internal = { STORAGE_KEY, EVENT_NAME, readStored, writeStored, mergeTheme }

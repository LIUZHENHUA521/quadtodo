import { useCallback, useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'
import {
  TERMINAL_PRESETS,
  TerminalPresetName,
  isPresetName,
  isValidColor,
} from '../terminalThemes'

const STORAGE_KEY = 'quadtodo.terminalTheme'
const CUSTOM_PRESETS_KEY = 'quadtodo.customTerminalPresets'
const EVENT_NAME = 'quadtodo:terminalTheme'
export const CUSTOM_PREFIX = 'custom:'

export interface ThemeOverride {
  background?: string
  foreground?: string
}

/** preset 字段在 storage 中可能是 built-in key（'default' / 'light' / ...）或 `custom:<name>` */
interface StoredTheme {
  preset: string
  override: ThemeOverride
}

const DEFAULT_STORED: StoredTheme = { preset: 'default', override: {} }

function readStored(): StoredTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STORED
    const parsed = JSON.parse(raw)
    const presetCandidate: string = typeof parsed?.preset === 'string' ? parsed.preset : 'default'
    const preset = (isPresetName(presetCandidate) || presetCandidate.startsWith(CUSTOM_PREFIX))
      ? presetCandidate : 'default'
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

function readCustomPresets(): Record<string, ITheme> {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, ITheme> = {}
    for (const [name, theme] of Object.entries(parsed)) {
      if (theme && typeof theme === 'object'
        && isValidColor((theme as ITheme).background)
        && isValidColor((theme as ITheme).foreground)) {
        out[name] = theme as ITheme
      }
    }
    return out
  } catch { return {} }
}

function writeStored(next: StoredTheme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME))
  } catch { /* ignore */ }
}

function writeCustomPresets(next: Record<string, ITheme>) {
  try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(EVENT_NAME)) } catch { /* ignore */ }
}

function subscribe(callback: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === CUSTOM_PRESETS_KEY || e.key === null) callback()
  }
  const onCustom = () => callback()
  window.addEventListener('storage', onStorage)
  window.addEventListener(EVENT_NAME, onCustom as EventListener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(EVENT_NAME, onCustom as EventListener)
  }
}

interface CombinedSnapshot {
  stored: StoredTheme
  customPresets: Record<string, ITheme>
}

let combinedCache: { storedRaw: string; customRaw: string; value: CombinedSnapshot } | null = null

function getCombinedSnapshot(): CombinedSnapshot {
  let storedRaw: string, customRaw: string
  try { storedRaw = localStorage.getItem(STORAGE_KEY) || '' } catch { storedRaw = '' }
  try { customRaw = localStorage.getItem(CUSTOM_PRESETS_KEY) || '' } catch { customRaw = '' }
  if (combinedCache && combinedCache.storedRaw === storedRaw && combinedCache.customRaw === customRaw) {
    return combinedCache.value
  }
  const value: CombinedSnapshot = { stored: readStored(), customPresets: readCustomPresets() }
  combinedCache = { storedRaw, customRaw, value }
  return value
}

function mergeTheme(stored: StoredTheme, customPresets: Record<string, ITheme>): ITheme {
  let base: ITheme = TERMINAL_PRESETS.default
  if (stored.preset.startsWith(CUSTOM_PREFIX)) {
    const name = stored.preset.slice(CUSTOM_PREFIX.length)
    base = customPresets[name] || TERMINAL_PRESETS.default
  } else if (isPresetName(stored.preset)) {
    base = TERMINAL_PRESETS[stored.preset]
  }
  if (!stored.override.background && !stored.override.foreground) return base
  return {
    ...base,
    ...(stored.override.background ? { background: stored.override.background } : {}),
    ...(stored.override.foreground ? { foreground: stored.override.foreground } : {}),
  }
}

export interface UseTerminalTheme {
  theme: ITheme
  preset: string
  override: ThemeOverride
  customPresets: Record<string, ITheme>
  setPreset: (name: string) => void
  setOverride: (patch: ThemeOverride) => void
  resetOverride: () => void
  /** 将当前有效主题（base + override）存为一份命名自定义预设，并立即切到它（override 清空） */
  saveCustomPreset: (name: string, theme: ITheme) => void
  deleteCustomPreset: (name: string) => void
}

export function useTerminalTheme(): UseTerminalTheme {
  const { stored, customPresets } = useSyncExternalStore(subscribe, getCombinedSnapshot, getCombinedSnapshot)

  const setPreset = useCallback((name: string) => {
    if (!isPresetName(name) && !name.startsWith(CUSTOM_PREFIX)) return
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

  const saveCustomPreset = useCallback((name: string, theme: ITheme) => {
    const clean = name.trim()
    if (!clean) return
    // 防止覆盖内置名
    if (isPresetName(clean)) return
    const current = readCustomPresets()
    writeCustomPresets({ ...current, [clean]: theme })
    writeStored({ preset: `${CUSTOM_PREFIX}${clean}`, override: {} })
  }, [])

  const deleteCustomPreset = useCallback((name: string) => {
    const current = readCustomPresets()
    if (!(name in current)) return
    const next = { ...current }
    delete next[name]
    writeCustomPresets(next)
    // 若当前选中被删，退回 default
    const storedNow = readStored()
    if (storedNow.preset === `${CUSTOM_PREFIX}${name}`) {
      writeStored({ preset: 'default', override: {} })
    }
  }, [])

  return {
    theme: mergeTheme(stored, customPresets),
    preset: stored.preset,
    override: stored.override,
    customPresets,
    setPreset,
    setOverride,
    resetOverride,
    saveCustomPreset,
    deleteCustomPreset,
  }
}

export const __internal = { STORAGE_KEY, CUSTOM_PRESETS_KEY, EVENT_NAME, readStored, writeStored, readCustomPresets, writeCustomPresets, mergeTheme }

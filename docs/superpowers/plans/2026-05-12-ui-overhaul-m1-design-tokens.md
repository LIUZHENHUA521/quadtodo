# UI Overhaul — M1: Design Tokens + Theme Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the design-token foundation, dark-default theme infrastructure, and AntD ConfigProvider integration that all later milestones build on. After this milestone, the existing UI works exactly as before but is driven by tokens and switches between dark/light correctly.

**Architecture:** Tokens defined once in `web/src/design/tokens.ts`, mirrored to `tokens.css` as CSS variables under `:root` (dark default) and `[data-theme="light"]`. AntD's ConfigProvider is fed a `theme` object derived from the same token source. A React Context (`ThemeProvider`) owns the active theme, persists to localStorage, and toggles `data-theme` on `<html>`. AntD's static APIs (`message.*`, `notification.*`, `Modal.confirm`) are migrated to the `App.useApp()` hook so toasts/dialogs pick up the theme.

**Tech Stack:** React 18 + TypeScript + Vite + AntD 5 + xterm.js + @fontsource/inter (new) + @fontsource/jetbrains-mono (existing).

**Spec reference:** `docs/superpowers/specs/2026-05-12-ui-overhaul-ai-first-design.md` (sections 3, 4, 7, M1)
**Visual reference:** `mockups/ui-overhaul-preview.html`

---

## File Structure

**New files:**
- `web/src/design/tokens.ts` — single source of truth for token names + values (TypeScript)
- `web/src/design/tokens.css` — CSS variables for `:root` (dark) and `[data-theme="light"]`
- `web/src/design/antd-theme.ts` — `getAntdTheme(mode)` → AntD `ThemeConfig` derived from tokens
- `web/src/design/ThemeProvider.tsx` — React Context + localStorage + `data-theme` attribute
- `web/src/design/useAppMessages.ts` — re-export wrapper around AntD `App.useApp()` for ergonomic imports
- `web/src/components/ThemeToggle/ThemeToggle.tsx` — button that toggles light/dark
- `web/src/components/ThemeToggle/index.ts` — barrel
- `web/src/components/ThemeToggle/ThemeToggle.css` — minimal local styles

**Modified files:**
- `web/src/main.tsx` — wrap in `ThemeProvider` + dynamic `ConfigProvider theme` + `<App>` component
- `web/src/AiTerminalMini.tsx:997` area — derive xterm theme from active design tokens; refresh on switch
- `web/src/terminalThemes.ts` — add a `default` preset variant that sources colors from tokens
- `web/src/TodoManage.tsx` — temporary mount point for `<ThemeToggle />` (will move in M2)
- 14 files using AntD static APIs (`message.*` / `notification.*` / `Modal.confirm`) — migrate to `useAppMessages()` hook
- All CSS files with hex literals — replace with `var(--token-name)` (target: 294 → ≤ 10 hex literals total, only inside tokens.css)

**Files we do NOT touch in M1:** TodoCard appearance, QuadrantBoard structure, topbar layout, drawers (those are M2/M3/M4).

---

## Conventions for this milestone

- **Token naming:** kebab-case CSS variables (`--surface-1`); camelCase TS constants (`surface1`). Both maps live in `tokens.ts`.
- **Theme detection:** start from localStorage if present, otherwise `prefers-color-scheme`, otherwise `'dark'`.
- **Commits:** one commit per task. Use `feat(design):` / `chore(theme):` / `refactor(antd):` prefixes.
- **Verification:** after each substantive task, run `npm run build` in `web/` to confirm no TS errors. Visual check happens at the end of each task that has visible impact.

---

## Task 1: Add Inter font + scaffold design directory

**Files:**
- Create: `web/src/design/.gitkeep` (placeholder until other files land)
- Modify: `web/package.json` (add @fontsource/inter)
- Modify: `web/src/main.tsx` (import Inter weights)

- [ ] **Step 1: Install Inter font**

```bash
cd web && npm install @fontsource/inter@^5.0.0
```

Expected: package added to dependencies, no errors.

- [ ] **Step 2: Create the design directory**

```bash
mkdir -p web/src/design && touch web/src/design/.gitkeep
```

- [ ] **Step 3: Import Inter weights in main.tsx**

In `web/src/main.tsx`, after the JetBrains Mono imports, add:

```ts
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
```

- [ ] **Step 4: Verify build**

Run: `cd web && npm run build`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/package.json web/package-lock.json web/src/main.tsx web/src/design/.gitkeep
git commit -m "chore(design): scaffold web/src/design/ + add Inter font"
```

---

## Task 2: Define tokens.ts (single source of truth)

**Files:**
- Create: `web/src/design/tokens.ts`

- [ ] **Step 1: Write tokens.ts with full token map**

Create `web/src/design/tokens.ts`:

```ts
// Design tokens — single source of truth.
// Mirror these in tokens.css as CSS variables.
// Mirror these in antd-theme.ts as AntD ThemeConfig.

export type ThemeMode = 'dark' | 'light'

export interface DesignTokens {
  surface: { 0: string; 1: string; 2: string; 3: string }
  border: { subtle: string; default: string; strong: string }
  text: { primary: string; secondary: string; tertiary: string; disabled: string }
  accent: { electric: string; electricSoft: string; electricGlow: string }
  quadrant: { q1: string; q2: string; q3: string; q4: string }
  ai: {
    running: string
    thinking: string
    pendingConfirm: string
    idle: string
    error: string
  }
  shadow: { subtle: string; elevated: string; floating: string }
}

export const darkTokens: DesignTokens = {
  surface: { 0: '#0a0d12', 1: '#13171f', 2: '#1a1f2a', 3: '#1f2532' },
  border: {
    subtle: 'rgba(255, 255, 255, 0.06)',
    default: 'rgba(255, 255, 255, 0.10)',
    strong: 'rgba(255, 255, 255, 0.18)',
  },
  text: {
    primary: '#e5e9f0',
    secondary: '#a0a8b8',
    tertiary: '#6b7280',
    disabled: '#4a5160',
  },
  accent: {
    electric: '#4DE5FF',
    electricSoft: 'rgba(77, 229, 255, 0.12)',
    electricGlow: 'rgba(77, 229, 255, 0.45)',
  },
  quadrant: { q1: '#ff5cb1', q2: '#4DE5FF', q3: '#ffb84d', q4: '#8a93a5' },
  ai: {
    running: '#4ade80',
    thinking: '#4DE5FF',
    pendingConfirm: '#ffb84d',
    idle: '#6b7280',
    error: '#ef4444',
  },
  shadow: {
    subtle: '0 1px 2px rgba(0,0,0,0.30)',
    elevated: '0 6px 18px rgba(0,0,0,0.45)',
    floating: '0 18px 40px rgba(0,0,0,0.55)',
  },
}

export const lightTokens: DesignTokens = {
  surface: { 0: '#f5f6f9', 1: '#ffffff', 2: '#eef0f5', 3: '#ffffff' },
  border: {
    subtle: 'rgba(0, 0, 0, 0.05)',
    default: 'rgba(0, 0, 0, 0.10)',
    strong: 'rgba(0, 0, 0, 0.18)',
  },
  text: {
    primary: '#0a0d12',
    secondary: '#4a5160',
    tertiary: '#6b7280',
    disabled: '#a0a8b8',
  },
  accent: {
    electric: '#00a3c4',
    electricSoft: 'rgba(0, 163, 196, 0.10)',
    electricGlow: 'rgba(0, 163, 196, 0.40)',
  },
  quadrant: { q1: '#d63384', q2: '#00a3c4', q3: '#d97706', q4: '#6b7280' },
  ai: {
    running: '#16a34a',
    thinking: '#00a3c4',
    pendingConfirm: '#d97706',
    idle: '#6b7280',
    error: '#dc2626',
  },
  shadow: {
    subtle: '0 1px 2px rgba(0,0,0,0.04)',
    elevated: '0 6px 18px rgba(0,0,0,0.08)',
    floating: '0 18px 40px rgba(0,0,0,0.14)',
  },
}

export const tokensByMode: Record<ThemeMode, DesignTokens> = {
  dark: darkTokens,
  light: lightTokens,
}

// Spacing / radius / motion are mode-independent (same in dark & light)
export const spacing = {
  1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 48, 9: 64,
} as const

export const radius = {
  sm: 4, md: 6, lg: 8, xl: 12, full: 999,
} as const

export const fontFamily = {
  sans: `'Inter', -apple-system, system-ui, sans-serif`,
  mono: `'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace`,
} as const

export const fontSize = {
  xs: 11, sm: 12, base: 13, md: 14, lg: 16, xl: 20, '2xl': 24,
} as const

export const motion = {
  duration: { fast: 120, normal: 200, slow: 320 },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    out: 'cubic-bezier(0, 0, 0.2, 1)',
    spring: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)',
  },
} as const
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/design/tokens.ts && rm web/src/design/.gitkeep
git add -u web/src/design/.gitkeep
git commit -m "feat(design): add tokens.ts as single source of truth"
```

---

## Task 3: Define tokens.css (CSS variables, dark + light)

**Files:**
- Create: `web/src/design/tokens.css`
- Modify: `web/src/main.tsx` (import tokens.css before TodoManage.css)

- [ ] **Step 1: Write tokens.css**

Create `web/src/design/tokens.css`:

```css
/* Design tokens — CSS variables.
   MUST mirror values in tokens.ts. If you change one, change both. */

:root,
[data-theme="dark"] {
  /* Surface */
  --surface-0: #0a0d12;
  --surface-1: #13171f;
  --surface-2: #1a1f2a;
  --surface-3: #1f2532;

  /* Border */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.10);
  --border-strong: rgba(255, 255, 255, 0.18);

  /* Text */
  --text-primary: #e5e9f0;
  --text-secondary: #a0a8b8;
  --text-tertiary: #6b7280;
  --text-disabled: #4a5160;

  /* Accent */
  --accent-electric: #4DE5FF;
  --accent-electric-soft: rgba(77, 229, 255, 0.12);
  --accent-electric-glow: rgba(77, 229, 255, 0.45);

  /* Quadrant */
  --q1: #ff5cb1;
  --q2: #4DE5FF;
  --q3: #ffb84d;
  --q4: #8a93a5;

  /* AI session */
  --ai-running: #4ade80;
  --ai-thinking: #4DE5FF;
  --ai-pending-confirm: #ffb84d;
  --ai-idle: #6b7280;
  --ai-error: #ef4444;

  /* Shadow */
  --shadow-subtle: 0 1px 2px rgba(0,0,0,0.30);
  --shadow-elevated: 0 6px 18px rgba(0,0,0,0.45);
  --shadow-floating: 0 18px 40px rgba(0,0,0,0.55);
}

[data-theme="light"] {
  --surface-0: #f5f6f9;
  --surface-1: #ffffff;
  --surface-2: #eef0f5;
  --surface-3: #ffffff;

  --border-subtle: rgba(0, 0, 0, 0.05);
  --border-default: rgba(0, 0, 0, 0.10);
  --border-strong: rgba(0, 0, 0, 0.18);

  --text-primary: #0a0d12;
  --text-secondary: #4a5160;
  --text-tertiary: #6b7280;
  --text-disabled: #a0a8b8;

  --accent-electric: #00a3c4;
  --accent-electric-soft: rgba(0, 163, 196, 0.10);
  --accent-electric-glow: rgba(0, 163, 196, 0.40);

  --q1: #d63384;
  --q2: #00a3c4;
  --q3: #d97706;
  --q4: #6b7280;

  --ai-running: #16a34a;
  --ai-thinking: #00a3c4;
  --ai-pending-confirm: #d97706;
  --ai-idle: #6b7280;
  --ai-error: #dc2626;

  --shadow-subtle: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-elevated: 0 6px 18px rgba(0,0,0,0.08);
  --shadow-floating: 0 18px 40px rgba(0,0,0,0.14);
}

/* Spacing / radius / typography (mode-independent) */
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-7: 32px; --space-8: 48px; --space-9: 64px;

  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px; --radius-full: 999px;

  --font-sans: 'Inter', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace;

  --text-xs: 11px; --text-sm: 12px; --text-base: 13px; --text-md: 14px;
  --text-lg: 16px; --text-xl: 20px; --text-2xl: 24px;

  --motion-fast: 120ms;
  --motion-normal: 200ms;
  --motion-slow: 320ms;
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

/* Apply default app background + transition for theme switch */
html, body {
  background: var(--surface-0);
  color: var(--text-primary);
  transition: background var(--motion-normal) var(--ease-standard),
              color var(--motion-normal) var(--ease-standard);
}
```

- [ ] **Step 2: Import tokens.css in main.tsx (must be first CSS import)**

In `web/src/main.tsx`, replace the CSS import block. Find:

```ts
import '@xterm/xterm/css/xterm.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import './TodoManage.css'
import './mobile.css'
```

Replace with:

```ts
import './design/tokens.css'   // MUST be first — defines variables used by everything below
import '@xterm/xterm/css/xterm.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './TodoManage.css'
import './mobile.css'
```

(Remove the duplicate Inter imports added in Task 1 if present — they belong in this block now.)

- [ ] **Step 3: Verify dev server**

Run: `cd web && npm run dev` in background; open http://localhost:5173 (or whatever port Vite picks).
Expected: app still renders. Background may shift slightly to `--surface-0` but layout intact.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add web/src/design/tokens.css web/src/main.tsx
git commit -m "feat(design): add tokens.css with dark+light CSS variables"
```

---

## Task 4: Create antd-theme.ts (map tokens to AntD ThemeConfig)

**Files:**
- Create: `web/src/design/antd-theme.ts`

- [ ] **Step 1: Write antd-theme.ts**

Create `web/src/design/antd-theme.ts`:

```ts
import type { ThemeConfig } from 'antd'
import { theme as antdTheme } from 'antd'
import { tokensByMode, type ThemeMode, fontFamily, fontSize, radius } from './tokens'

/**
 * Build an AntD ThemeConfig from our design tokens.
 * Call from main.tsx with the active mode.
 */
export function getAntdTheme(mode: ThemeMode): ThemeConfig {
  const t = tokensByMode[mode]
  const algorithm = mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm

  return {
    algorithm,
    token: {
      // Brand
      colorPrimary: t.accent.electric,
      colorInfo: t.accent.electric,
      colorSuccess: t.ai.running,
      colorWarning: t.ai.pendingConfirm,
      colorError: t.ai.error,

      // Surface
      colorBgBase: t.surface[0],
      colorBgContainer: t.surface[1],
      colorBgElevated: t.surface[3],
      colorBgLayout: t.surface[0],

      // Text
      colorText: t.text.primary,
      colorTextSecondary: t.text.secondary,
      colorTextTertiary: t.text.tertiary,
      colorTextQuaternary: t.text.disabled,

      // Border
      colorBorder: t.border.default,
      colorBorderSecondary: t.border.subtle,

      // Typography
      fontFamily: fontFamily.sans,
      fontFamilyCode: fontFamily.mono,
      fontSize: fontSize.base,
      fontSizeSM: fontSize.sm,
      fontSizeLG: fontSize.lg,

      // Geometry
      borderRadius: radius.md,
      borderRadiusSM: radius.sm,
      borderRadiusLG: radius.lg,

      // Motion
      motionDurationFast: '120ms',
      motionDurationMid: '200ms',
      motionDurationSlow: '320ms',
    },
    components: {
      Drawer: { colorBgElevated: t.surface[1] },
      Modal: { colorBgElevated: t.surface[3] },
      Popover: { colorBgElevated: t.surface[3] },
      Tooltip: { colorBgSpotlight: t.surface[3] },
    },
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/design/antd-theme.ts
git commit -m "feat(design): map tokens to AntD ThemeConfig"
```

---

## Task 5: Build ThemeProvider with localStorage persistence

**Files:**
- Create: `web/src/design/ThemeProvider.tsx`

- [ ] **Step 1: Write ThemeProvider.tsx**

Create `web/src/design/ThemeProvider.tsx`:

```tsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ThemeMode } from './tokens'

const STORAGE_KEY = 'agentquad:theme'

interface ThemeContextValue {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function detectInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'dark' || stored === 'light') return stored
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(detectInitialMode)

  // Sync data-theme attribute on <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore storage errors (private mode etc)
    }
  }, [])

  const toggle = useCallback(() => {
    setMode(mode === 'dark' ? 'light' : 'dark')
  }, [mode, setMode])

  return (
    <ThemeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/design/ThemeProvider.tsx
git commit -m "feat(design): add ThemeProvider with localStorage + system preference"
```

---

## Task 6: Wire ThemeProvider + dynamic ConfigProvider + AntD `<App>` into main.tsx

**Files:**
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Replace main.tsx**

Replace the entire body of `web/src/main.tsx` with:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './design/tokens.css'
import '@xterm/xterm/css/xterm.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './TodoManage.css'
import './mobile.css'
import TodoManage from './TodoManage'
import { ThemeProvider, useTheme } from './design/ThemeProvider'
import { getAntdTheme } from './design/antd-theme'

dayjs.locale('zh-cn')

function ThemedApp() {
  const { mode } = useTheme()
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(mode)}>
      <AntdApp message={{ maxCount: 3 }}>
        <TodoManage />
      </AntdApp>
    </ConfigProvider>
  )
}

const root = document.getElementById('root')!
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <ThemedApp />
    </ThemeProvider>
  </React.StrictMode>,
)
```

- [ ] **Step 2: Run dev server and check**

Run: `cd web && npm run dev` (background or separate terminal)
Open in browser. App should render with dark background (`--surface-0`).

Open devtools → Elements → confirm `<html data-theme="dark">`.

Stop the dev server.

- [ ] **Step 3: Verify build**

Run: `cd web && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat(design): wire ThemeProvider + dynamic AntD theme + <App> wrapper"
```

---

## Task 7: Create useAppMessages hook + ThemeToggle component

**Files:**
- Create: `web/src/design/useAppMessages.ts`
- Create: `web/src/components/ThemeToggle/ThemeToggle.tsx`
- Create: `web/src/components/ThemeToggle/ThemeToggle.css`
- Create: `web/src/components/ThemeToggle/index.ts`

- [ ] **Step 1: Create useAppMessages.ts**

Create `web/src/design/useAppMessages.ts`:

```ts
import { App } from 'antd'

/**
 * Ergonomic re-export of AntD's App.useApp hook.
 * Returns { message, notification, modal } that respect the active theme.
 *
 * Usage:
 *   const { message } = useAppMessages()
 *   message.success('Saved')
 *
 * MUST be called inside the <App> component (which main.tsx mounts).
 */
export function useAppMessages() {
  return App.useApp()
}
```

- [ ] **Step 2: Create ThemeToggle.tsx**

Create `web/src/components/ThemeToggle/ThemeToggle.tsx`:

```tsx
import { Button, Tooltip } from 'antd'
import { useTheme } from '../../design/ThemeProvider'
import './ThemeToggle.css'

export function ThemeToggle() {
  const { mode, toggle } = useTheme()
  const isDark = mode === 'dark'
  return (
    <Tooltip title={isDark ? 'Switch to light' : 'Switch to dark'}>
      <Button
        type="text"
        size="small"
        className="theme-toggle-btn"
        onClick={toggle}
        aria-label="Toggle theme"
      >
        {isDark ? '🌙' : '☀️'}
      </Button>
    </Tooltip>
  )
}
```

- [ ] **Step 3: Create ThemeToggle.css**

Create `web/src/components/ThemeToggle/ThemeToggle.css`:

```css
.theme-toggle-btn {
  font-size: 14px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 4: Create barrel index.ts**

Create `web/src/components/ThemeToggle/index.ts`:

```ts
export { ThemeToggle } from './ThemeToggle'
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/design/useAppMessages.ts web/src/components/ThemeToggle/
git commit -m "feat(design): add useAppMessages hook + ThemeToggle component"
```

---

## Task 8: Mount ThemeToggle in TodoManage (temporary placement)

**Files:**
- Modify: `web/src/TodoManage.tsx`

This is a temporary mount so the toggle is reachable until M2 builds the proper topbar.

- [ ] **Step 1: Find the existing topbar/header area in TodoManage.tsx**

Run: `grep -n "Settings\|⚙\|topbar\|header\|toolbar" web/src/TodoManage.tsx | head -20`

Identify the area where existing top-of-page action buttons (Settings, Stats, etc.) are rendered.

- [ ] **Step 2: Import ThemeToggle**

At the top of `web/src/TodoManage.tsx`, add:

```ts
import { ThemeToggle } from './components/ThemeToggle'
```

- [ ] **Step 3: Mount ThemeToggle next to Settings button**

In the JSX where the existing topbar action buttons live, add `<ThemeToggle />` adjacent to other icon buttons. If the topbar is a flex container, just drop it in. If unsure, place it right before the Settings (`⚙`) button.

- [ ] **Step 4: Run dev server, verify toggle works**

Run: `cd web && npm run dev`
Open browser. Click ThemeToggle button → background flips light/dark, AntD components flip too. Refresh → preference persists.

Open devtools console: confirm no errors.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(theme): mount ThemeToggle in TodoManage topbar (temporary)"
```

---

## Task 9: Migrate AntD static APIs to App.useApp() — batch 1 (drawers + dialogs)

**Files to modify:**
- `web/src/SettingsDrawer.tsx`
- `web/src/StatsDrawer.tsx`
- `web/src/WikiDrawer.tsx`
- `web/src/TemplateDrawer.tsx`
- `web/src/pipeline/PipelineRunDrawer.tsx`
- `web/src/transcripts/TranscriptSearchDrawer.tsx`
- `web/src/ExportDialog.tsx`
- `web/src/ForkDialog.tsx`
- `web/src/TelegramProbeModal.tsx`

For each file: replace static API imports with the hook, call once at the top of the component, use the returned instances.

- [ ] **Step 1: For each file, find static API usage**

Run for each file:
```bash
grep -n "import.*\(message\|notification\|Modal\).*from 'antd'\|message\.\(success\|error\|info\|warning\|loading\)\|notification\.\|Modal\.confirm" web/src/SettingsDrawer.tsx
```

Repeat for each file in the list.

- [ ] **Step 2: Replace pattern in each file**

In each file, do these substitutions:

**Before (typical):**
```tsx
import { Drawer, message, Modal } from 'antd'

export function SettingsDrawer() {
  const onSave = () => {
    message.success('Saved')
  }
  const onDelete = () => {
    Modal.confirm({ title: 'Delete?', onOk: () => { /* ... */ } })
  }
  // ...
}
```

**After:**
```tsx
import { Drawer } from 'antd'
import { useAppMessages } from './design/useAppMessages'

export function SettingsDrawer() {
  const { message, modal } = useAppMessages()
  const onSave = () => {
    message.success('Saved')
  }
  const onDelete = () => {
    modal.confirm({ title: 'Delete?', onOk: () => { /* ... */ } })
  }
  // ...
}
```

Note the import path adjusts to `'../design/useAppMessages'` for files in subfolders (`pipeline/`, `transcripts/`).

For `notification.*` → `notification` from the hook (same shape).

For `Modal.confirm` / `Modal.info` etc → use `modal.confirm` / `modal.info` (lowercase `m`, from the hook).

- [ ] **Step 3: Verify each file compiles**

After each file, run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run dev server, smoke-test toasts**

Run: `cd web && npm run dev`. Trigger one notification per migrated drawer (e.g., open Settings, hit Save). Confirm toast appears with correct theme styling (dark bg in dark mode).

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add web/src/SettingsDrawer.tsx web/src/StatsDrawer.tsx web/src/WikiDrawer.tsx \
        web/src/TemplateDrawer.tsx web/src/pipeline/PipelineRunDrawer.tsx \
        web/src/transcripts/TranscriptSearchDrawer.tsx web/src/ExportDialog.tsx \
        web/src/ForkDialog.tsx web/src/TelegramProbeModal.tsx
git commit -m "refactor(antd): migrate drawers + dialogs to App.useApp() hook"
```

---

## Task 10: Migrate AntD static APIs — batch 2 (terminal + transcript + telegram)

**Files to modify:**
- `web/src/AiTerminalMini.tsx`
- `web/src/TranscriptView.tsx`
- `web/src/TelegramSyncButton.tsx`
- `web/src/dock/TerminalDock.tsx`
- `web/src/TodoManage.tsx`

- [ ] **Step 1: Apply the same pattern as Task 9 to each file**

For each file, replace static `message.*` / `notification.*` / `Modal.confirm` calls with the hook pattern shown in Task 9, Step 2. Adjust import paths for subfolder files (`./dock/...` → `../design/useAppMessages`).

For `TodoManage.tsx`: this is the largest file (2502 lines). Search for ALL call sites first:
```bash
grep -n "message\.\(success\|error\|info\|warning\|loading\)\|notification\.\|Modal\.confirm" web/src/TodoManage.tsx
```
Then call `useAppMessages()` exactly once at the top of the component, and replace every call site to use the destructured names.

- [ ] **Step 2: Verify all files compile**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run dev server, smoke-test**

Run: `cd web && npm run dev`. Trigger toasts from terminal actions, transcript search, telegram sync. Confirm theme is respected.

Stop dev server.

- [ ] **Step 4: Verify no static-API call sites remain**

Run from project root:
```bash
rg "(\bmessage|\bnotification|\bModal)\.(success|error|info|warning|loading|confirm)\b" web/src --type ts --type tsx
```
Expected: only matches inside `useAppMessages.ts` (the wrapper itself) and possibly inside test files; otherwise empty.

If any remain, migrate them now.

- [ ] **Step 5: Commit**

```bash
git add web/src/AiTerminalMini.tsx web/src/TranscriptView.tsx web/src/TelegramSyncButton.tsx \
        web/src/dock/TerminalDock.tsx web/src/TodoManage.tsx
git commit -m "refactor(antd): migrate remaining static API call sites to App.useApp()"
```

---

## Task 11: Wire xterm theme to design tokens + refresh on switch

**Files:**
- Modify: `web/src/terminalThemes.ts`
- Modify: `web/src/AiTerminalMini.tsx`

xterm renders to canvas/WebGL — CSS variables don't reach it. We must reset `terminal.options.theme` and call `terminal.refresh()` whenever the design theme switches.

- [ ] **Step 1: Add a token-driven xterm preset to terminalThemes.ts**

Open `web/src/terminalThemes.ts`. Add a new exported function at the bottom:

```ts
import type { ITheme } from '@xterm/xterm'
import { tokensByMode, type ThemeMode } from './design/tokens'

/**
 * Build an xterm ITheme from active design tokens.
 * Used when the terminal preset is 'design-tokens' (default for new installs).
 */
export function getTokenDrivenTheme(mode: ThemeMode): ITheme {
  const t = tokensByMode[mode]
  // Spread base preset first so its ANSI 16-color palette (ansiRed, etc) is preserved.
  // Then override surface / foreground / cursor / selection from design tokens.
  return {
    ...TERMINAL_PRESETS['default'],
    background: t.surface[0],
    foreground: t.text.primary,
    cursor: t.accent.electric,
    cursorAccent: t.surface[0],
    selectionBackground: t.accent.electricSoft,
    selectionForeground: t.text.primary,
  }
}
```

(If the `import type { ITheme }` line already exists at the top, don't duplicate it.)

- [ ] **Step 2: Hook xterm in AiTerminalMini.tsx to react to theme changes**

Open `web/src/AiTerminalMini.tsx`. Locate the area around line 997 where `term.options.theme = theme` is set.

Add at the top of the component (with other imports):

```tsx
import { useTheme } from './design/ThemeProvider'
import { getTokenDrivenTheme } from './terminalThemes'
```

Inside the component body, near other hooks, get the active mode:

```tsx
const { mode } = useTheme()
```

Find where `term.options.theme` is currently assigned (around line 997). Add a `useEffect` that re-applies the theme whenever `mode` changes:

```tsx
useEffect(() => {
  const term = termRef.current  // or however the terminal instance is referenced — adjust to actual ref name
  if (!term) return
  term.options.theme = getTokenDrivenTheme(mode)
  // Force xterm to redraw scrollback with new colors
  term.refresh(0, term.rows - 1)
}, [mode])
```

(If the existing code already binds theme based on the user-selected preset, keep that path but add this branch for the new "design-tokens" preset, OR—simpler for M1—just always use `getTokenDrivenTheme(mode)` as the source of truth.)

- [ ] **Step 3: Verify build**

Run: `cd web && npm run build`
Expected: PASS.

- [ ] **Step 4: Smoke test**

Run: `cd web && npm run dev`. Open a todo, start an AI terminal. Toggle theme — terminal background flips, scrollback colors flip too (no leftover patches of old color).

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add web/src/terminalThemes.ts web/src/AiTerminalMini.tsx
git commit -m "feat(theme): wire xterm to design tokens with refresh on switch"
```

---

## Task 12: CSS hex literal audit — TodoManage.css (largest)

**Files:**
- Modify: `web/src/TodoManage.css`

This file has 153 hex literals. Replace each with the closest-matching token. If no token matches, decide: extend tokens, or accept the literal in a comment-marked exception (must be justified).

- [ ] **Step 1: List all hex/rgba literals**

Run: `rg -n '#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)' web/src/TodoManage.css`

Read the output and note grouped patterns (the same color used 10 times = one token).

- [ ] **Step 2: Build a sed/manual replacement table**

Common substitutions you'll make (verify against actual file contents):

| Old | New |
|---|---|
| `#fff` / `#ffffff` (text) | `var(--text-primary)` |
| `#0a0d12` / dark backgrounds | `var(--surface-0)` |
| `#13171f` / card-ish dark | `var(--surface-1)` |
| `rgba(255,255,255,0.0X)` borders | `var(--border-subtle)` / `var(--border-default)` per opacity |
| Quadrant colors (magenta/blue/amber/gray) | `var(--q1)` / `var(--q2)` / `var(--q3)` / `var(--q4)` |
| AntD primary (`#1677ff` etc) | `var(--accent-electric)` |
| Status greens/reds/ambers | `var(--ai-running)` / `var(--ai-error)` / `var(--ai-pending-confirm)` |

For each unique color, replace ALL occurrences in the file.

- [ ] **Step 3: Apply replacements**

Use Edit tool with `replace_all: true` per unique color, OR use a sequence of targeted Edits. After every batch of ~20 replacements, run:

```bash
rg -c '#[0-9a-fA-F]{3,8}' web/src/TodoManage.css
```

Watch the count drop.

- [ ] **Step 4: Verify visually**

Run: `cd web && npm run dev`. Walk through the app in dark mode. Compare with pre-migration visual (you may have a screenshot from M1 start). Major regressions → identify the wrong token mapping and fix.

Toggle to light mode. Confirm colors reasonable.

Stop dev server.

- [ ] **Step 5: Final hex count**

Run: `rg -c '#[0-9a-fA-F]{3,8}' web/src/TodoManage.css`
Target: ≤ 5 (only justified exceptions, with `/* token-exception: <reason> */` comment).

- [ ] **Step 6: Commit**

```bash
git add web/src/TodoManage.css
git commit -m "refactor(theme): migrate TodoManage.css hex literals to design tokens"
```

---

## Task 13: CSS hex literal audit — remaining CSS files

**Files to modify (in order of literal count):**
- `web/src/TranscriptView.css` (62 literals)
- `web/src/dock/dock.css` (31 literals)
- `web/src/pipeline/PipelineRunDrawer.css` (29 literals)
- `web/src/ReportDrawer.css` (29 literals)
- `web/src/onboarding/onboarding.css` (14 literals)
- `web/src/dock/popout.css` (10 literals)
- `web/src/WikiDrawer.css` (10 literals)
- `web/src/mobile.css` (5 literals)

- [ ] **Step 1: For each file, apply the same workflow as Task 12**

Per file:
1. List literals: `rg -n '#[0-9a-fA-F]{3,8}|rgba?\(' web/src/<FILE>.css`
2. Map each unique color to a token (use the same table from Task 12)
3. Replace via Edit with `replace_all: true`
4. Verify count drops to ≤ 2 per file (or 0)

- [ ] **Step 2: Verify build + smoke test**

Run: `cd web && npm run build`
Then `npm run dev`, walk through transcript view, terminal dock, pipeline drawer, report drawer, onboarding modal, wiki drawer in both themes.

Stop dev server.

- [ ] **Step 3: Final aggregate hex count**

Run from project root:
```bash
rg --count-matches '#[0-9a-fA-F]{3,8}' web/src --type css | awk -F: '{sum+=$2} END {print "Total:", sum}'
```

Subtract the count inside `web/src/design/tokens.css` (those are intentional). Target net total ≤ 10.

- [ ] **Step 4: Commit**

```bash
git add web/src/TranscriptView.css web/src/dock/dock.css web/src/pipeline/PipelineRunDrawer.css \
        web/src/ReportDrawer.css web/src/onboarding/onboarding.css web/src/dock/popout.css \
        web/src/WikiDrawer.css web/src/mobile.css
git commit -m "refactor(theme): migrate remaining CSS files to design tokens"
```

---

## Task 14: M1 verification + gate check

**No file changes. Just confirm the milestone landed.**

- [ ] **Step 1: TypeScript build clean**

Run: `cd web && npm run build`
Expected: PASS, no errors, no warnings about unresolved imports.

- [ ] **Step 2: Hex literal acceptance check**

Run from project root:
```bash
EXCLUDED='web/src/design/tokens.css'
rg --count-matches '#[0-9a-fA-F]{3,8}' web/src --type css \
  | grep -v "$EXCLUDED" \
  | awk -F: '{sum+=$2} END {print "Net hex literals (excluding tokens.css):", sum+0}'
```
Expected: ≤ 10 (justified exceptions only).

- [ ] **Step 3: Run all backend tests (no regression)**

Run from project root:
```bash
npm test
```
Expected: PASS. (Backend tests should be unaffected by frontend changes; this catches any accidental cross-cutting damage.)

- [ ] **Step 4: Manual walkthrough**

Run: `cd web && npm run dev` (or run the full app: `agentquad start` from project root).

Walk through this checklist in BOTH dark and light modes:
1. Open app — background and text legible in chosen mode
2. Toggle theme — instant switch, no flicker, AntD components flip too
3. Refresh page — preference persists
4. Open Settings drawer — drawer bg matches mode
5. Open Stats drawer
6. Open Wiki drawer
7. Open a todo with an active AI terminal — terminal bg flips on toggle, scrollback colors flip
8. Trigger a `message.success` from any drawer (e.g., save settings) — toast appears in correct theme
9. Trigger a `Modal.confirm` (e.g., delete) — modal bg matches theme
10. Drag a todo card — drag still works (no regression)
11. Open in mobile emulator (iPhone Safari) — basic layout still works (don't fix mobile bugs in M1, just confirm no NEW breakage)

Stop dev server.

- [ ] **Step 5: Tag M1 done**

```bash
git tag ui-overhaul-m1
git log --oneline -20
```

Confirm the milestone's commits are clean and ordered logically.

- [ ] **Step 6: Push if user requests**

(Skip until user explicitly asks to push.)

---

## Acceptance criteria for M1 (from spec §12)

| Check | Pass criterion | How to verify |
|---|---|---|
| Tokens defined | `web/src/design/tokens.ts` + `tokens.css` exist | `ls web/src/design/` |
| AntD theme integrated | ConfigProvider receives dynamic theme | Open app, toggle theme, AntD button colors flip |
| Dark default | First visit defaults to dark | Clear localStorage, reload, observe |
| Light fully works | Switch to light, all surfaces flip | Manual walkthrough (Step 4 above) |
| xterm theme follows | Terminal bg/cursor/scrollback flip on toggle | Manual (Step 4 #7) |
| AntD static API migrated | No `message.*` / `notification.*` / `Modal.confirm` outside the hook wrapper | `rg "(\bmessage\|\bnotification\|\bModal)\.(success\|error\|info\|warning\|loading\|confirm)\b" web/src --type ts --type tsx` returns nothing useful |
| CSS hex literals migrated | Net ≤ 10 across all CSS (excluding tokens.css) | Step 2 above |
| Build clean | `npm run build` passes | Step 1 above |
| Backend tests pass | `npm test` from project root | Step 3 above |

---

## Out of scope for M1 (lands in M2/M3/M4)

- Topbar redesign (M2)
- ⌘K command palette (M2)
- Hero TodoCard (M3)
- QuadrantBoard extraction (M3)
- TodoManage.tsx file split to ≤ 400 lines (M3)
- AI terminal status bar + thinking animation (M3)
- Terminal split-view (M4)
- Drawer consolidation (M4)
- Mobile responsive pass (M4)
- A11y, i18n (out of scope entirely)
- New backend fields (out of scope entirely)

---

## Risk register (M1-specific)

| Risk | Mitigation |
|---|---|
| Hex migration produces visual regressions when wrong token chosen | Walkthrough after each file (Task 12 step 4); compare against pre-M1 screenshot |
| AntD `App.useApp()` migration misses a call site → toast doesn't theme | Task 10 step 4 final grep catches stragglers |
| xterm theme refresh fails on certain renderers (canvas vs WebGL) | Task 11 step 4 manual smoke; if WebGL renderer caches, also toggle `term.refresh(0, term.rows-1)` already covers it |
| dnd-kit drag regressed by CSS changes | Task 14 step 4 #10 catches it |
| Mobile layout broken by new variables on `body` | Task 14 step 4 #11; if broken, scope fix to M4 (don't extend M1) |

---

## After M1

When all tasks above are checked and verification passes, write the M2 plan: `docs/superpowers/plans/2026-05-12-ui-overhaul-m2-topbar-cmdk.md`. M2 will build on the tokens + ThemeProvider that M1 establishes.

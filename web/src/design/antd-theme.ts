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

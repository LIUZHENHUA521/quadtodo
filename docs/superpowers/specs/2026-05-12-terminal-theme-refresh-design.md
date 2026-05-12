# Terminal Theme Refresh — 内置预设升级设计

- 日期：2026-05-12
- 范围：`web/src/terminalThemes.ts`、`web/src/hooks/useTerminalTheme.ts`
- 相关历史：`docs/superpowers/specs/2026-04-15-terminal-theme-customization-design.md`（首次引入内置 + 自定义预设的设计）

## 背景

当前 5 个内置终端预设（Quadtodo / Dracula / Solarized Dark / One Dark / Solarized Light）整体审美偏老。本次替换为 2024–2026 期间在 GitHub / 开发者社区最受欢迎的现代调色板，并顺手把作为默认主题的 `Quadtodo` 也重制一次（保留品牌背景 `#1a1a2e`，但 ANSI 16 色向 Catppuccin 美学靠拢）。

## 决策摘要（已与用户确认）

| 项 | 选择 |
|---|---|
| 方案 | C：Catppuccin 全家族（Mocha / Macchiato / Frappé / Latte） + Tokyo Night Storm + 重制后的 Quadtodo |
| 旧 preset 迁移 | b：做映射，静默迁移到对应新主题 |
| Quadtodo 默认主题 | b：重制 ANSI 16 色（保留 background `#1a1a2e`） |
| 下拉预览色块 | a：保持 `background + foreground` 45° 渐变 |

## 6 个内置预设

`PRESET_ORDER` 顺序按"默认 → Catppuccin 由暗到亮 → Tokyo Night"排列：

```
default
catppuccin-mocha
catppuccin-macchiato
catppuccin-frappe
catppuccin-latte
tokyo-night-storm
```

### 1. `default` — Quadtodo（重制）

保留品牌色 `background = #1a1a2e` 和蓝色光标 `cursor = #569cd6`，其余调色板向 Catppuccin Mocha 的"粉彩柔和"靠拢，但保持稍高饱和以维持品牌识别度。

| 字段 | 值 |
|---|---|
| background | `#1a1a2e` |
| foreground | `#e4e6f1` |
| cursor | `#569cd6` |
| cursorAccent | `#1a1a2e` |
| selectionBackground | `#264f78` |
| selectionForeground | `#ffffff` |
| black | `#2a2a44` |
| red | `#f06292` |
| green | `#82d779` |
| yellow | `#f1c987` |
| blue | `#6da8f5` |
| magenta | `#c084fc` |
| cyan | `#5dd9c5` |
| white | `#d6d8e8` |
| brightBlack | `#4a4d72` |
| brightRed | `#ff7aa6` |
| brightGreen | `#9ce28f` |
| brightYellow | `#ffd89b` |
| brightBlue | `#88baff` |
| brightMagenta | `#d5a3ff` |
| brightCyan | `#7eebd7` |
| brightWhite | `#ffffff` |

### 2. `catppuccin-mocha`

采用 Catppuccin 官方 Mocha 调色板（github.com/catppuccin/catppuccin · `palette.json`，commit pinned at spec time），ANSI 16 色按官方推荐的 terminal mapping。

| 字段 | 值 | 官方名 |
|---|---|---|
| background | `#1e1e2e` | Base |
| foreground | `#cdd6f4` | Text |
| cursor | `#f5e0dc` | Rosewater |
| cursorAccent | `#1e1e2e` | Base |
| selectionBackground | `#585b70` | Surface2 |
| selectionForeground | `#cdd6f4` | Text |
| black | `#45475a` | Surface1 |
| red | `#f38ba8` | Red |
| green | `#a6e3a1` | Green |
| yellow | `#f9e2af` | Yellow |
| blue | `#89b4fa` | Blue |
| magenta | `#f5c2e7` | Pink |
| cyan | `#94e2d5` | Teal |
| white | `#bac2de` | Subtext1 |
| brightBlack | `#585b70` | Surface2 |
| brightRed | `#f38ba8` | Red |
| brightGreen | `#a6e3a1` | Green |
| brightYellow | `#f9e2af` | Yellow |
| brightBlue | `#89b4fa` | Blue |
| brightMagenta | `#f5c2e7` | Pink |
| brightCyan | `#94e2d5` | Teal |
| brightWhite | `#a6adc8` | Subtext0 |

### 3. `catppuccin-macchiato`

| 字段 | 值 | 官方名 |
|---|---|---|
| background | `#24273a` | Base |
| foreground | `#cad3f5` | Text |
| cursor | `#f4dbd6` | Rosewater |
| cursorAccent | `#24273a` | Base |
| selectionBackground | `#5b6078` | Surface2 |
| selectionForeground | `#cad3f5` | Text |
| black | `#494d64` | Surface1 |
| red | `#ed8796` | Red |
| green | `#a6da95` | Green |
| yellow | `#eed49f` | Yellow |
| blue | `#8aadf4` | Blue |
| magenta | `#f5bde6` | Pink |
| cyan | `#8bd5ca` | Teal |
| white | `#b8c0e0` | Subtext1 |
| brightBlack | `#5b6078` | Surface2 |
| brightRed | `#ed8796` | Red |
| brightGreen | `#a6da95` | Green |
| brightYellow | `#eed49f` | Yellow |
| brightBlue | `#8aadf4` | Blue |
| brightMagenta | `#f5bde6` | Pink |
| brightCyan | `#8bd5ca` | Teal |
| brightWhite | `#a5adcb` | Subtext0 |

### 4. `catppuccin-frappe`

| 字段 | 值 | 官方名 |
|---|---|---|
| background | `#303446` | Base |
| foreground | `#c6d0f5` | Text |
| cursor | `#f2d5cf` | Rosewater |
| cursorAccent | `#303446` | Base |
| selectionBackground | `#626880` | Surface2 |
| selectionForeground | `#c6d0f5` | Text |
| black | `#51576d` | Surface1 |
| red | `#e78284` | Red |
| green | `#a6d189` | Green |
| yellow | `#e5c890` | Yellow |
| blue | `#8caaee` | Blue |
| magenta | `#f4b8e4` | Pink |
| cyan | `#81c8be` | Teal |
| white | `#b5bfe2` | Subtext1 |
| brightBlack | `#626880` | Surface2 |
| brightRed | `#e78284` | Red |
| brightGreen | `#a6d189` | Green |
| brightYellow | `#e5c890` | Yellow |
| brightBlue | `#8caaee` | Blue |
| brightMagenta | `#f4b8e4` | Pink |
| brightCyan | `#81c8be` | Teal |
| brightWhite | `#a5adce` | Subtext0 |

### 5. `catppuccin-latte`（浅色）

| 字段 | 值 | 官方名 |
|---|---|---|
| background | `#eff1f5` | Base |
| foreground | `#4c4f69` | Text |
| cursor | `#5c5f77` | Subtext1（覆盖官方 Rosewater，因官方值对 Latte bg 对比度 < 3:1，不满足验收 #3） |
| cursorAccent | `#eff1f5` | Base |
| selectionBackground | `#acb0be` | Surface2 |
| selectionForeground | `#4c4f69` | Text |
| black | `#bcc0cc` | Surface1 |
| red | `#d20f39` | Red |
| green | `#40a02b` | Green |
| yellow | `#df8e1d` | Yellow |
| blue | `#1e66f5` | Blue |
| magenta | `#ea76cb` | Pink |
| cyan | `#179299` | Teal |
| white | `#5c5f77` | Subtext1 |
| brightBlack | `#acb0be` | Surface2 |
| brightRed | `#d20f39` | Red |
| brightGreen | `#40a02b` | Green |
| brightYellow | `#df8e1d` | Yellow |
| brightBlue | `#1e66f5` | Blue |
| brightMagenta | `#ea76cb` | Pink |
| brightCyan | `#179299` | Teal |
| brightWhite | `#6c6f85` | Subtext0 |

### 6. `tokyo-night-storm`

采用 folke/tokyonight.nvim 的 Storm flavor `terminal_colors`（github.com/folke/tokyonight.nvim/blob/main/lua/tokyonight/colors/storm.lua）。

| 字段 | 值 |
|---|---|
| background | `#24283b` |
| foreground | `#c0caf5` |
| cursor | `#c0caf5` |
| cursorAccent | `#24283b` |
| selectionBackground | `#364a82` |
| selectionForeground | `#c0caf5` |
| black | `#1d202f` |
| red | `#f7768e` |
| green | `#9ece6a` |
| yellow | `#e0af68` |
| blue | `#7aa2f7` |
| magenta | `#bb9af7` |
| cyan | `#7dcfff` |
| white | `#a9b1d6` |
| brightBlack | `#414868` |
| brightRed | `#f7768e` |
| brightGreen | `#9ece6a` |
| brightYellow | `#e0af68` |
| brightBlue | `#7aa2f7` |
| brightMagenta | `#bb9af7` |
| brightCyan | `#7dcfff` |
| brightWhite | `#c0caf5` |

### `PRESET_LABELS`

```ts
{
  'default': 'Quadtodo',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-macchiato': 'Catppuccin Macchiato',
  'catppuccin-frappe': 'Catppuccin Frappé',
  'catppuccin-latte': 'Catppuccin Latte',
  'tokyo-night-storm': 'Tokyo Night Storm',
}
```

## 旧 preset 名迁移

在 `web/src/hooks/useTerminalTheme.ts` 新增常量：

```ts
const LEGACY_PRESET_MIGRATION: Record<string, TerminalPresetName> = {
  'dracula': 'catppuccin-mocha',
  'solarized-dark': 'catppuccin-macchiato',
  'one-dark': 'tokyo-night-storm',
  'solarized-light': 'catppuccin-latte',
}
```

**设计原则**：`readStored()` 保持纯函数（用于 `useSyncExternalStore` 快照，不能有副作用），迁移的"读取层"和"写回层"分开实现。

**读取层 — `readStored()`**：解析出原始 `presetCandidate` 后，先查 `LEGACY_PRESET_MIGRATION`，命中则把返回值改写为映射目标。**仅改返回值，不写 localStorage**。`custom:*` 前缀和已经合法的新 key 走原有分支。

**写回层 — `useTerminalTheme()` 内新增一次性 `useEffect`**：在 hook 首次挂载时检查 localStorage 原始 raw 值里的 `preset` 是否需要迁移；如果需要，调用 `writeStored()` 把迁移后的新值持久化（同时触发 event，让所有订阅者重新读到一致值）。`useEffect` 的依赖数组为空，只跑一次。

这样保证：
- `useSyncExternalStore` 快照是纯函数，符合 React 契约
- 用户首次进入页面就完成持久化，后续读取不再触发迁移分支
- 多 tab / 多 hook 实例下，第一个跑完的 `useEffect` 写入后其他实例通过 storage event 同步

## 技术契约

### 改动文件

- `web/src/terminalThemes.ts`
  - 重写 `TerminalPresetName` 联合类型为 6 个新 key
  - 重写 `PRESET_LABELS` 和 `PRESET_ORDER`
  - 重写 `TERMINAL_PRESETS` 为 6 个新预设
  - `isPresetName`、`isValidColor`、`deriveChrome`、所有色彩工具函数保持不变

- `web/src/hooks/useTerminalTheme.ts`
  - 新增 `LEGACY_PRESET_MIGRATION` 常量
  - 在 `readStored()` 中嵌入迁移逻辑（命中映射 → 改写候选值 → 落盘）
  - 其余 API 不变

### 不动的接口（向下兼容）

- `useTerminalTheme()` 返回类型完全不变（`UseTerminalTheme` 接口）
- `deriveChrome()` 算法不变（已自动适配深/浅主题）
- `AiTerminalMini.tsx` 中 `bg + fg` 的渐变 swatch 不动
- `custom:*` 自定义主题流程不动

## 验收标准

1. ✅ 6 个主题每个都有完整 17 个字段（background / foreground / cursor / cursorAccent / selectionBackground / selectionForeground + 16 ANSI 色）
2. ✅ 每个主题 fg/bg 对比度 ≥ 4.5:1（WCAG AA）。`default`（Quadtodo）作为默认主题要求 ≥ 7:1（WCAG AAA）
3. ✅ cursor 与 background 对比度 ≥ 3:1
4. ✅ selectionBackground 与 background 相对亮度（relative luminance，WCAG 定义）绝对差 ≥ 0.05，确保选区可见
5. ✅ `deriveChrome()` 对 6 个主题都不返回 `CHROME_FALLBACK`（即 background/foreground 都是合法 hex）
6. ✅ 旧 key（`dracula` / `solarized-dark` / `one-dark` / `solarized-light`）在 `readStored()` 处理后转为对应新 key，且 localStorage 写回新值
7. ✅ `custom:*` 主题在迁移逻辑里保持原样，不被误改
8. ✅ xterm 切换主题实时生效，不报错
9. ✅ 下拉菜单中 6 个色块肉眼可区分（Catppuccin Mocha 和 Tokyo Night Storm 都偏深蓝紫，需特别检查）
10. ✅ 视觉验证：在浏览器里逐个主题切换，确认终端正文 + AI Markdown 渲染区 + 自定义主题模态框都显示正常

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Catppuccin Mocha 与 Tokyo Night Storm bg 都接近深蓝紫，下拉色块预览相似 | 验收标准 #9 显式要求人眼区分；如不达标，再讨论换 swatch 方案 |
| 浅色主题（Latte）下 `deriveChrome()` 的 surface/border 对比度 | 既有算法已有 `isLight` 分支；按验收 #5 检查并视觉确认 |
| 迁移触发额外一次 `writeStored()` 引发的事件循环 | 迁移写回放在 `useEffect` 内，仅在挂载时跑一次；`readStored()` 保持纯函数；二次读取已无 legacy key |
| Quadtodo 重制后用户感觉"和老版本不一样了" | 保留 background 和 cursor，foreground 仅微调；预期感知差异为"更柔和"，不属于破坏性变化 |

## 不在范围

- 不新增"重置为出厂"按钮（已有自定义模态框里的"恢复预设默认"）
- 不改 swatch 渲染方式（保持 `bg + fg` 45° 渐变）
- 不动 AI Markdown 渲染区 / highlight.js 主题（这是另一套系统）
- 不引入主题切换动画

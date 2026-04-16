# 终端主题定制 — 设计规格

**日期**: 2026-04-15
**范围**: `web/src/AiTerminalMini.tsx` 及其配套 hook / 预设表
**目标**: 让内嵌终端的背景色与文字色可定制。提供 5 套预设主题一键切换,并允许用户覆盖背景/前景两色。偏好纯本地持久化,实时预览,所有终端实例联动。

---

## 1. 决策摘要

| 维度 | 决定 |
|------|------|
| 定制范围 | 预设主题切换 + 背景/文字色自定义覆盖 |
| 持久化 | 纯 localStorage,不走服务端 |
| UI 入口 | 终端工具栏下拉(与 autoMode / followTail 同一排风格) |
| 交互 | Popover 内 `ColorPicker` 实时预览,关闭即生效 |
| 联动机制 | `useSyncExternalStore` + 自定义事件,跨多终端实例同步 |

---

## 2. 数据模型

**localStorage key**: `quadtodo.terminalTheme`

```ts
interface StoredTheme {
  preset: 'default' | 'dracula' | 'solarized-dark' | 'one-dark' | 'solarized-light'
  override: {
    background?: string
    foreground?: string
  }
}
```

- 默认值: `{ preset: 'default', override: {} }`
- 切换预设时清空 `override`(避免深色 override 污染浅色主题)
- 颜色值校验:非 `#rrggbb` / `#rrggbbaa` / `rgb(...)` / `rgba(...)` 格式的 override 字段丢弃
- 解析失败或 preset 名未知 → 回退到默认,不抛错

---

## 3. 预设主题表

**文件**: `web/src/terminalThemes.ts`(新建)

每个预设导出完整的 xterm `ITheme` 对象,覆盖 19 个色位(background、foreground、cursor、cursorAccent、selectionBackground、selectionForeground、black/red/green/yellow/blue/magenta/cyan/white 及对应 bright)。

| 预设 | background | foreground | 备注 |
|------|-----------|-----------|------|
| `default` | `#1a1a2e` | `#d4d4d4` | 当前硬编码色,保持兼容 |
| `dracula` | `#282a36` | `#f8f8f2` | Dracula 官方色卡 |
| `solarized-dark` | `#002b36` | `#839496` | Solarized Dark |
| `one-dark` | `#282c34` | `#abb2bf` | Atom One Dark |
| `solarized-light` | `#fdf6e3` | `#657b83` | 白天场景 |

导出结构:

```ts
export type TerminalPresetName = 'default' | 'dracula' | ...
export interface TerminalTheme extends ITheme { ... }
export const TERMINAL_PRESETS: Record<TerminalPresetName, TerminalTheme>
export const PRESET_LABELS: Record<TerminalPresetName, string>
```

---

## 4. `useTerminalTheme` hook

**文件**: `web/src/hooks/useTerminalTheme.ts`(新建)

### 职责

- 读取 / 写入 localStorage 中的 `StoredTheme`
- 订阅 `window` 的 `storage` 事件(跨 tab)+ 自定义 `quadtodo:terminalTheme` 事件(同 tab)
- 合并 `preset` + `override`,返回完整的 xterm `ITheme` 对象
- 暴露变更方法,变更后广播自定义事件

### 接口

```ts
interface UseTerminalTheme {
  theme: ITheme              // 合并后供 xterm 使用
  preset: TerminalPresetName
  override: { background?: string; foreground?: string }
  setPreset: (name: TerminalPresetName) => void     // 清空 override
  setOverride: (patch: Partial<Override>) => void   // 合并式覆盖
  resetOverride: () => void
}

export function useTerminalTheme(): UseTerminalTheme
```

### 实现要点

- 用 `useSyncExternalStore(subscribe, getSnapshot)`
- `subscribe`: 注册 `storage` + `quadtodo:terminalTheme` 两个事件源,返回清理函数
- `getSnapshot`: 读 localStorage → 校验 → 合并 preset + override → 返回 `ITheme`
  - 需要稳定引用:缓存上次返回的对象,若序列化后相同则返回同一引用,避免 React 无限重渲
- 写操作 (`setPreset` / `setOverride` / `resetOverride`):
  1. 写 localStorage
  2. `window.dispatchEvent(new CustomEvent('quadtodo:terminalTheme'))`

### 为什么不用 Zustand / Context

- 项目已有 `web/src/store/` 但里面是业务状态(todos),颜色偏好语义不同
- hook 方案零依赖、生命周期与 React 自然契合
- 跨 tab 同步必须借 `storage` 事件,无论哪种状态管理都要走这一步

---

## 5. `AiTerminalMini.tsx` 接入

### 构造阶段

```tsx
const { theme, preset, override, setPreset, setOverride, resetOverride } = useTerminalTheme()

// Terminal 构造时使用初始 theme
const term = new Terminal({
  ...,
  theme,  // 不再写死 { background: '#1a1a2e', ... }
})
```

### 运行时同步

```tsx
useEffect(() => {
  if (termRef.current) termRef.current.options.theme = theme
}, [theme])
```

xterm.js 支持运行时 `options.theme` 赋值触发全屏重绘,成本低。

### 色值联动的工具栏

当前工具栏 `background: '#16213e'` 与硬编码终端底色配套。切到 Solarized Light 时会出现「终端白底、工具栏深蓝」的割裂观感。

**处理**: 工具栏 / 拖拽条 / 全屏提示条的 `background` 从 `theme` 派生:
- 工具栏背景 = `theme.background` 轻微加深(深色主题)或轻微加深(浅色主题),通过一个小工具函数 `deriveToolbarBg(theme)` 计算
- 或更简单的降级方案:工具栏使用 `theme.background`,文字颜色用 `theme.foreground`,依赖用户选择的主题自身协调性

**采纳**: 简单方案——工具栏直接用 `theme.background`,borderBottom 用 `theme.foreground` 20% 透明度。不新增颜色计算依赖。

---

## 6. 工具栏下拉组件

**位置**: `AiTerminalMini.tsx` 工具栏中,插入到 `autoMode Dropdown` 之前(或之后)。

### 结构

```tsx
<Dropdown
  menu={{
    items: [
      { key: 'default', label: <PresetItem name="default" /> },
      { key: 'dracula', label: <PresetItem name="dracula" /> },
      { key: 'solarized-dark', label: ... },
      { key: 'one-dark', label: ... },
      { key: 'solarized-light', label: ... },
      { type: 'divider' },
      { key: 'custom', label: '自定义...' },
    ],
    selectedKeys: [preset],
    onClick: ({ key }) => {
      if (key === 'custom') setCustomPopoverOpen(true)
      else setPreset(key as TerminalPresetName)
    },
  }}
>
  <Tag style={{...}}>
    {PRESET_LABELS[preset]} <DownOutlined />
  </Tag>
</Dropdown>
```

### `PresetItem` 子组件

显示预设名 + 一个小色块(圆形,左右两色拼接展示 background / foreground)作为视觉预览。

---

## 7. 自定义覆盖 Popover

### 触发

点击下拉中的「自定义...」项,打开 AntD `<Popover>`(注意不是 `<Modal>`,避免遮挡终端看不到预览)。

### 内容

```
┌───────────────────────────┐
│ 背景色  [ColorPicker]     │
│ 文字色  [ColorPicker]     │
│ ─────────────────────     │
│ [恢复预设默认]  [取消]    │
└───────────────────────────┘
```

### 行为

- 打开 Popover 时,**快照**当前 `override`,存入本地 state `snapshotRef`
- `ColorPicker.onChange`: 立刻调 `setOverride({ background })` / `setOverride({ foreground })`,所有终端实例实时重绘
- 「恢复预设默认」: `resetOverride()`
- 「取消」: `setOverride(snapshotRef)` 回滚到打开前状态,然后关闭
- 直接点 Popover 外部关闭: 保留当前 override(视为接受)
- 关闭后不保留弹窗内部状态

---

## 8. 数据流图

```
用户操作(下拉 / ColorPicker)
  │
  ▼
setPreset / setOverride / resetOverride
  │
  ├─ 写 localStorage
  └─ window.dispatchEvent('quadtodo:terminalTheme')
                 │
                 ▼
  所有订阅的 useSyncExternalStore 实例 getSnapshot 重算
                 │
                 ▼
  theme 对象引用变化,AiTerminalMini 的 useEffect 触发
                 │
                 ▼
  term.options.theme = newTheme(xterm 重绘)
```

跨 tab 时 `storage` 事件走同一条通道进入 `getSnapshot`。

---

## 9. 错误处理与边界

| 场景 | 处理 |
|------|------|
| localStorage 解析失败 | 使用默认 `{ preset: 'default', override: {} }` |
| preset 名未知 | 回退到 `default`,不抛错 |
| override 颜色值格式非法 | 丢弃该字段,保留合法字段 |
| localStorage 被禁用 | try/catch 包裹,内存变量兜底;刷新后丢失偏好,不崩溃 |
| 多个 AiTerminalMini 同时挂载 | 共享同一 hook,统一广播,互不干扰 |
| xterm 实例已 dispose | `termRef.current?.options.theme = ...`,可选链保护 |

---

## 10. 测试

### 新增单测

- `web/src/terminalThemes.test.ts`
  - 5 个预设都导出,每个都包含 19 个色键
  - 色值格式都是合法 `#rrggbb`

- `web/src/hooks/useTerminalTheme.test.ts`
  - 默认值读取
  - `setPreset` 清空 override
  - `setOverride` 合并(不覆盖不传的字段)
  - `resetOverride` 清空 override
  - 损坏 JSON 回退默认值
  - 未知 preset 名回退默认
  - 非法颜色格式字段被丢弃
  - `dispatchEvent('quadtodo:terminalTheme')` 触发订阅者重算

### 不新增集成测试的位置

- `AiTerminalMini.tsx` 集成测试:xterm 是 DOM 依赖,jsdom 支持薄、xterm 本身初始化对 canvas 有要求,集成测试维护成本高,靠单元 hook 测 + 手工验证即可

---

## 11. 文件清单

### 新建

- `web/src/terminalThemes.ts`
- `web/src/terminalThemes.test.ts`
- `web/src/hooks/useTerminalTheme.ts`
- `web/src/hooks/useTerminalTheme.test.ts`

### 修改

- `web/src/AiTerminalMini.tsx`
  - 引入 `useTerminalTheme`
  - 替换构造阶段硬编码 theme
  - 新增 `useEffect([theme])` 运行时同步
  - 工具栏背景改用 `theme.background`
  - 工具栏新增主题下拉 Dropdown + 自定义 Popover

### 不动

- 后端 `src/` 全部无改动
- `SettingsDrawer.tsx` 无改动(偏好不入抽屉)
- `web/src/store/` 无改动

---

## 12. 非目标 (YAGNI)

- 不支持自定义光标色、选区色、ANSI 16 色
- 不支持导入/导出主题 JSON
- 不做服务端同步
- 不做系统浅深色自动跟随(`prefers-color-scheme`)
- 不做预设管理(新增/删除用户自定义预设)

这些功能未来有需求再加;hook + 数据模型已为此留好扩展点(`StoredTheme` 可加字段,hook 方法可补 signature)。

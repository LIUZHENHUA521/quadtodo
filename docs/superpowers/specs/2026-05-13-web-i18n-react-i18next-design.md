# Web 前端国际化（react-i18next 全量迁移）设计文档

- 日期：2026-05-13
- 触发点：用户反馈 Command+K 命令面板（CommandPalette）"全是英文"，希望统一改成中文版本，同时希望顺势把项目做成可国际化的。
- 范围决策：方案 C（react-i18next 全项目接入）；默认语言 zh-CN，预留 en-US。

## 1. 背景与目标

### 1.1 当前现状
- `web/` 前端无任何 i18n 基础设施（package.json 无 `i18next`/`react-i18next`/`react-intl` 依赖）。
- `web/src/main.tsx` 已注入 antd `zhCN` locale 和 dayjs `zh-cn` 本地化 → 整个项目运行语境就是中文。
- 实际项目中：
  - 大部分 UI 模块（TodoManage、SessionFocus、TranscriptView、WikiDrawer 等）使用中文硬编码字面量。
  - **`web/src/components/CommandPalette/CommandPalette.tsx` 是英文孤岛**：组占位符、group 标题、菜单项文案全是英文。
  - 统计：`web/src/**` 内含中文字面量约 **505 处**，分布在 **49 / 70** 个 `.tsx`/`.ts` 文件中（约 70%）。

### 1.2 目标
1. 修复 CommandPalette 英文孤岛问题（用户原始诉求）—— 改为中文，且可日后切英文。
2. 把整个 `web/` 前端的用户可见字面量全部迁移到 i18next 资源文件中。
3. 搭好基础设施，使日后新增英文/其他语言时只需在 `en-US.ts` 等资源文件中补 key，无需再改组件代码。

### 1.3 非目标
- **不迁移后端字符串**：`src/*.js`、`src/routes/*`、`src/transcripts/*` 等 Node 服务端代码暂不动；如有返回给前端的用户可见 message，由前端在展示前自行 i18n 或保留为 raw 文本。
- **不接入语言切换 UI**：本期仅以 zh-CN 为默认语言运行；未来要加 language switcher 时由后续 PR 完成。
- **不改 markdown/注释/console.log/调试日志中的中文**。
- **不改 antd / dayjs 已注入的本地化配置**。

## 2. 技术选型

| 技术 | 选择 | 理由 |
|---|---|---|
| i18n 框架 | `i18next` + `react-i18next` | React 生态事实标准，文档充分，TS 类型生态成熟 |
| 翻译资源格式 | TS 模块（不是 JSON） | 可通过 `declare module 'i18next'` 注入类型，IDE 补全 + 编译期检查拼写错 |
| 加载策略 | 静态 import，全部 bundle 进主包 | 当前只有一个默认语言 zh-CN；en-US 仅 stub。资源量小，无需异步分包 |
| 复数 | i18next 内置 ICU-like `_one` / `_other` | 中文虽无复数，但保留扩展位（en 需要） |
| 插值 | i18next 默认 `{{var}}` 语法 | 与字符串拼接/模板字面量一一映射 |
| 命名空间 | 按"功能域"切分（见下） | 跨组件复用同一 key，避免散乱 |

## 3. 目录结构

```
web/src/
  i18n/
    index.ts                  // i18next.init({...})；导出 i18n 实例与初始化副作用
    resources.ts              // { 'zh-CN': zh, 'en-US': en } 资源聚合
    types.d.ts                // declare module 'i18next' { interface CustomTypeOptions { ... } }
    locales/
      zh-CN.ts                // 中文资源（默认 + 兜底）
      en-US.ts                // 英文资源（CommandPalette 已填，其余模块为占位 stub）
```

`web/src/main.tsx` 顶部 `import './i18n'`（副作用导入，触发 i18next.init），不需要包裹 `<I18nextProvider>`（react-i18next 18+ 全局工作）。

## 4. 命名空间设计

| namespace | 覆盖范围 | 关键 key 示例 |
|---|---|---|
| `common` | 通用按钮、状态词、确认/取消 | `common.confirm`、`common.cancel`、`common.restore`、`common.todo`、`common.done`、`common.running`、`common.idle` |
| `palette` | CommandPalette 全部 | `palette.placeholder`、`palette.groups.quickActions`、`palette.actions.createTodo`、`palette.actions.startAi`、`palette.a11y.commandPalette`（aria label）、`palette.empty.noResults` |
| `topbar` | TopbarDispatch、StatPill、StageTagChip、ThemeToggle | `topbar.stats.unread`、`topbar.theme.toggle` |
| `todo` | TodoManage、TodoCard、看板筛选、四象限 | `todo.create`、`todo.delete`、`todo.restoredAs`、`todo.quadrant.q1` |
| `session` | SessionFocus、FocusSubbar、AiTerminalMini、AI 会话相关 | `session.start`、`session.tool.claude`、`session.awaitingReply` |
| `transcript` | TranscriptView 及子组件 | `transcript.empty`、`transcript.copyAll` |
| `wiki` | WikiDrawer | `wiki.projects`、`wiki.sources` |
| `settings` | 设置抽屉 | `settings.theme`、`settings.telegram` |
| `errors` | message.error / message.success 提示文案 | `errors.restoreFailed`、`errors.networkError` |

**命名规则**：
- 嵌套对象，层级 ≤ 3：`namespace.section.item`
- 动作类用动词：`palette.actions.createTodo`
- 文案类用名词或描述：`palette.groups.quickActions`、`palette.empty.noResults`
- 错误统一在 `errors.*`，便于审计

## 5. 迁移策略（增量、按 module 推进）

10 步推进，每步可独立通过 build/test：

| Step | 内容 | 风险 | 验收 |
|---|---|---|---|
| 1 | 装依赖（i18next、react-i18next）；新建 `web/src/i18n/` 骨架；写 `index.ts` 初始化代码；`main.tsx` 中 import；写 `types.d.ts` 注入类型 | 低 | `npm run build` 通过；浏览器仍能正常打开（语言未切换前 UI 不变） |
| 2 | **CommandPalette**：完整迁移（用户原始诉求 + 英文最集中） | 中（cmdk 搜索行为） | 浏览器手测：中文输入能命中 fuzzy；esc/N 等按键 hint 保留英文 |
| 3 | **common + topbar + errors**：高频被引用的小尺寸文案 | 低 | 顶栏渲染正常，message.* 提示文案正常 |
| 4 | **TodoManage / TodoCard / 四象限**：项目核心看板 | 高（最大模块） | 看板增删改查、筛选、跳转都正常 |
| 5 | **SessionFocus / FocusSubbar / AiTerminalMini** | 中 | AI 会话启动、关闭、状态切换正常 |
| 6 | **TranscriptView** + 子组件 | 中 | Transcript 渲染、复制等交互正常 |
| 7 | **WikiDrawer / Settings / 其他抽屉** | 低 | 各抽屉打开、操作正常 |
| 8 | **剩余零散组件**（StageTagChip、StatPill、ThemeToggle 等） | 低 | grep 残留 |
| 9 | **测试用例修正**：`test/` 下断言中文的测试，必要时同步更新或保留（UI 渲染仍是中文，断言通常不需要改） | 中 | `npm test`（前端）全部通过 |
| 10 | **收尾扫描**：执行约定 grep 命令统计残留中文字面量；执行 `npm run build`；浏览器全链路手测 | 低 | 残留中文 ≤ 20 处（误判 / 边界情况）；本人确认无遗漏 |

每步独立成一次 commit，可中断、可 rebase、可拆分 PR。

## 6. 关键技术细节

### 6.1 i18next 初始化（`web/src/i18n/index.ts` 雏形）

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources } from './resources'

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'palette', 'topbar', 'todo', 'session', 'transcript', 'wiki', 'settings', 'errors'],
    interpolation: {
      escapeValue: false, // React 自带 XSS 保护
    },
    returnNull: false,
  })

export default i18n
```

### 6.2 类型注入（`web/src/i18n/types.d.ts`）

```ts
import 'i18next'
import type zh from './locales/zh-CN'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zh
  }
}
```

→ 在组件中写 `t('palette.placeholder')`，TS 校验 key 是否存在。

### 6.3 组件中的使用

```tsx
import { useTranslation } from 'react-i18next'

export function CommandPalette() {
  const { t } = useTranslation()
  // ...
  <Command.Input placeholder={t('palette.placeholder')} />
  <Command.Group heading={t('palette.groups.quickActions')}>
```

### 6.4 模板字符串处理示例

迁移前：
```ts
message.success(`已恢复为待办`)
const label = parentTitle ? `↳ ${parentTitle} / ${t.title}` : t.title
```

迁移后：
```ts
message.success(t('todo.restoredAs'))
const label = parentTitle
  ? t('todo.subtaskLabel', { parent: parentTitle, title: t.title })
  : t.title
```

zh-CN 资源：
```ts
todo: {
  restoredAs: '已恢复为待办',
  subtaskLabel: '↳ {{parent}} / {{title}}',
}
```

### 6.5 不强制翻译的内容（与范围内对照）
- 注释（`// 这里是 xxx`）保留
- `console.log` / `console.error` 保留
- 单元测试断言中的中文字符串保留（除非该断言对应的 UI 文案改动）
- 调试用 `debugger` / `throw new Error('xxx')` 保留
- **键盘快捷键提示**：CommandPalette 中的 `<kbd>esc</kbd>`、`Create new todo` 右侧 `<span className="cmdk-meta">N</span>` 等按键名保留英文（国际通用）
- **a11y label / aria-label**：本期纳入范围。`<Command label="Command Palette">` 这类不可见的辅助技术标签也通过 `t()` 访问，namespace 内放在 `palette.a11y.commandPalette` 之类子段中

### 6.6 cmdk fuzzy 搜索与 i18n 的协同
- `cmdk` 的 `Command.Item` 的 `value` 字段（CommandPalette 中如 `value={`todo-${t.id}-${label}`}`）当前嵌入了 `label` 文本用于模糊匹配。
- i18n 化后 `label = t(...)` 会自动随当前语言变化 —— 用中文输入搜中文 label、英文输入搜英文 label 都能命中，**这是设计上的预期行为，不需要额外适配**。
- 若日后真的需要"输入中文也能命中英文文案"或反过来，需另设 alias 字段，不在本期范围。

### 6.7 收尾扫描命令

```bash
# 扫描残留 CJK 字面量（覆盖基本中文 + CJK 扩展A + 全角标点）
cd web/src
grep -rEnP "['\"\`][\x{4e00}-\x{9fff}\x{3400}-\x{4dbf}\x{3000}-\x{303f}\x{ff00}-\x{ffef}][^'\"\`]{0,80}['\"\`]" \
  --include="*.tsx" --include="*.ts" \
  --exclude-dir=i18n \
  | grep -v '^\s*//' \
  | grep -v 'console\.' \
  > /tmp/i18n-residue.txt
wc -l /tmp/i18n-residue.txt
```

预期 ≤ 20 行（注释里嵌的、调试日志、`new Error()` 等可以接受）。

> 注：若环境不支持 `-P`（Perl regex），可降级为 `grep -rEn "['\"\`][一-龥…「」（）！？]"`，覆盖度略低但可用。

## 7. 测试策略

| 类型 | 验证手段 |
|---|---|
| 编译 | `npm run build` 必须通过；`tsc --noEmit` 校验 key 类型 |
| 单元测试 | `npm test`（web/）必须通过；针对断言 UI 渲染结果的测试，渲染输出仍是中文，断言通常不动 |
| 视觉回归 | 浏览器手测 CommandPalette / TodoManage / SessionFocus / TranscriptView 主路径 |
| 交互回归 | cmdk 中文搜索 fuzzy 命中、四象限拖拽、AI 会话启动、Transcript 复制 |

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 500+ 字符串迁移工作量巨大，单 PR 风险高 | 高 | 高 | 按 module 分 10 步 commit，每步独立通过 build/test |
| 模板字面量中变量插值漏改（`${x}` 没换成 `{{x}}`） | 中 | 中 | 每个文件迁完用 grep 校验该文件不再有 `'[一-龥]'` 字面量 |
| TS 类型注入与 i18next 版本兼容性 | 低 | 中 | 采用文档化的官方写法；如有报错降级为不强制类型（`returnObjects`） |
| 测试断言中的中文与 UI 文案脱节 | 中 | 低 | 迁移 module 后立刻跑 `npm test`，逐个修正 |
| cmdk 中文 fuzzy 搜索行为异常 | 低 | 中 | 浏览器手测；如果命中率下降，调整 `Command.Item` 的 `value` 字段 |
| antd / dayjs 已注入 locale 与 i18next 冲突 | 极低 | 低 | 各管各的：antd locale 管控件内部文案，i18next 管业务文案 |
| 翻译质量差（机翻感强、术语不一致） | 中 | 中 | 中文以"现有项目文案的语气"为准；en-US 本期不强求质量，stub 优先 |

## 9. 验收标准（最终）

- [ ] `web/src/i18n/` 目录完整，含 `index.ts` / `resources.ts` / `types.d.ts` / `locales/zh-CN.ts` / `locales/en-US.ts`
- [ ] `web/src/main.tsx` 已导入 i18n 初始化
- [ ] `web/package.json` 含 `i18next` + `react-i18next` 依赖
- [ ] `web/src/**` 内用户可见中文字面量全部迁移（残留 ≤ 20 行，且都属于注释/console/Error 之类可接受场景）
- [ ] CommandPalette 渲染中文（截图前后对比）
- [ ] TodoManage / SessionFocus / TranscriptView / WikiDrawer 主路径渲染中文，无破损
- [ ] `npm run build` 通过
- [ ] `npm test`（web/）通过
- [ ] `en-US.ts` 至少包含 CommandPalette 的英文版（其他 namespace 为 stub，可直接复用中文 key 作兜底）
- [ ] 提交记录按 10 步 module 拆分（或合理合并），每个 commit 独立通过 build/test

## 10. 后续工作（不在本 PR 范围）

- 加 language switcher UI（设置抽屉中"语言"项）
- 完整翻译 en-US.ts（除 CommandPalette 外其余 namespace 的英文）
- 后端返回给前端的 user-facing message 集中走 i18n（如果存在）
- 接入 i18next-browser-languagedetector，按浏览器语言自动选择

## 11. 关键决策记录

| 决策 | 取舍 | 拍板人 / 时间 |
|---|---|---|
| 全项目接入 vs 仅 CommandPalette | 全项目（C3） | 用户，2026-05-13 |
| react-i18next vs 自建 messages | react-i18next | 用户，2026-05-13 |
| 默认语言 zh-CN，fallback zh-CN | 项目就是中文语境 | 设计师建议，用户同意 |
| TS 模块 vs JSON 资源 | TS 模块（类型安全） | 设计师建议 |
| 按 module 增量迁移 vs 一次性大 PR | 按 module 增量（10 步） | 设计师建议（降低风险） |

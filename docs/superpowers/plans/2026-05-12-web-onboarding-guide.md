# Web 端首次启动欢迎 Modal 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 AgentQuad web 端首次访问加一个居中欢迎 Modal（极简苹果风），关掉后写 localStorage 永不再弹。

**Architecture:** 新增 `web/src/onboarding/` 模块（store 纯函数 + hook + Modal 组件 + CSS）。TodoManage.tsx 顶层用 hook 控制 Modal open 状态。无后端改动，无新增依赖。

**Tech Stack:** React 18 + AntD 5 + `@ant-design/icons` 5.5 + Vite + 根目录 Vitest。

**Spec：** [`docs/superpowers/specs/2026-05-12-web-onboarding-guide-design.md`](../specs/2026-05-12-web-onboarding-guide-design.md)

---

## 文件结构

新增 4 个文件，改 1 个文件：

```
web/src/onboarding/
├── onboardingStore.ts        # 纯函数 readWelcomeDismissed/writeWelcomeDismissed + KEY 常量
├── useWelcomeDismissed.ts    # React hook，基于 store
├── WelcomeModal.tsx          # AntD Modal 组件
└── onboarding.css            # 极简苹果风样式（含移动端 @media）

test/onboarding-store.test.js # 纯函数测试（根 test/ 目录，与现有测试一致）

web/src/TodoManage.tsx        # 顶层挂载 WelcomeModal（仅 import + hook + JSX 三处插入）
```

**为什么把 store 和 hook 拆两个文件**：store 是纯函数，测试可以在 Node 环境直接跑（vitest 默认 pool）。Hook 文件 import store + React，避免在测试 import 链里牵扯 React。

---

## Task 1：onboardingStore.ts —— 纯函数 + 单元测试（TDD）

**Files:**
- Create: `web/src/onboarding/onboardingStore.ts`
- Test: `test/onboarding-store.test.js`

---

- [ ] **Step 1.1：写失败测试**

创建 `test/onboarding-store.test.js`：

```js
import { describe, it, expect, beforeEach } from 'vitest'
import {
  readWelcomeDismissed,
  writeWelcomeDismissed,
  WELCOME_DISMISSED_KEY,
} from '../web/src/onboarding/onboardingStore.ts'

function makeMockStorage({ throwOnRead = false, throwOnWrite = false } = {}) {
  let store = {}
  return {
    getItem(k) {
      if (throwOnRead) throw new Error('boom')
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null
    },
    setItem(k, v) {
      if (throwOnWrite) throw new Error('boom')
      store[k] = String(v)
    },
    removeItem(k) {
      if (throwOnWrite) throw new Error('boom')
      delete store[k]
    },
  }
}

beforeEach(() => {
  globalThis.localStorage = makeMockStorage()
})

describe('onboardingStore', () => {
  it('exports the expected key constant', () => {
    expect(WELCOME_DISMISSED_KEY).toBe('agentquad:welcome:dismissed')
  })

  it('returns false when no key is set', () => {
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('writes "1" and reads true after writeWelcomeDismissed(true)', () => {
    writeWelcomeDismissed(true)
    expect(globalThis.localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe('1')
    expect(readWelcomeDismissed()).toBe(true)
  })

  it('removes the key after writeWelcomeDismissed(false)', () => {
    writeWelcomeDismissed(true)
    writeWelcomeDismissed(false)
    expect(globalThis.localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe(null)
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('writeWelcomeDismissed swallows storage exceptions', () => {
    globalThis.localStorage = makeMockStorage({ throwOnWrite: true })
    expect(() => writeWelcomeDismissed(true)).not.toThrow()
    expect(() => writeWelcomeDismissed(false)).not.toThrow()
  })

  it('readWelcomeDismissed returns false when storage throws', () => {
    globalThis.localStorage = makeMockStorage({ throwOnRead: true })
    expect(readWelcomeDismissed()).toBe(false)
  })

  it('readWelcomeDismissed returns false when localStorage is missing', () => {
    globalThis.localStorage = undefined
    expect(readWelcomeDismissed()).toBe(false)
  })
})
```

---

- [ ] **Step 1.2：跑测试验证 FAIL**

Run:

```bash
npx vitest run test/onboarding-store.test.js
```

Expected: 测试 fail，错误信息类似 `Cannot find module '../web/src/onboarding/onboardingStore.ts'`（文件还不存在）。

---

- [ ] **Step 1.3：写最小实现**

创建 `web/src/onboarding/onboardingStore.ts`：

```ts
export const WELCOME_DISMISSED_KEY = 'agentquad:welcome:dismissed'

export function readWelcomeDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOME_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeWelcomeDismissed(v: boolean): void {
  try {
    if (v) globalThis.localStorage?.setItem(WELCOME_DISMISSED_KEY, '1')
    else globalThis.localStorage?.removeItem(WELCOME_DISMISSED_KEY)
  } catch {
    /* localStorage 不可用（隐私模式等）静默失败 */
  }
}
```

---

- [ ] **Step 1.4：跑测试验证 PASS**

Run:

```bash
npx vitest run test/onboarding-store.test.js
```

Expected: 全部 7 个用例 PASS。

---

- [ ] **Step 1.5：Commit**

```bash
git add web/src/onboarding/onboardingStore.ts test/onboarding-store.test.js
git commit -m "$(cat <<'EOF'
feat(onboarding): localStorage-backed welcome dismissed store

Pure functions readWelcomeDismissed/writeWelcomeDismissed gated by
'agentquad:welcome:dismissed' key; silent fallback when localStorage
is unavailable. Vitest covers read/write/missing/throws scenarios.
EOF
)"
```

---

## Task 2：useWelcomeDismissed.ts —— React Hook

**Files:**
- Create: `web/src/onboarding/useWelcomeDismissed.ts`

---

- [ ] **Step 2.1：写 hook**

创建 `web/src/onboarding/useWelcomeDismissed.ts`：

```ts
import { useState, useCallback } from 'react'
import { readWelcomeDismissed, writeWelcomeDismissed } from './onboardingStore'

export function useWelcomeDismissed(): [boolean, (v: boolean) => void] {
  const [dismissed, setDismissedState] = useState<boolean>(readWelcomeDismissed)
  const setDismissed = useCallback((v: boolean) => {
    writeWelcomeDismissed(v)
    setDismissedState(v)
  }, [])
  return [dismissed, setDismissed]
}
```

---

- [ ] **Step 2.2：Commit**

```bash
git add web/src/onboarding/useWelcomeDismissed.ts
git commit -m "$(cat <<'EOF'
feat(onboarding): useWelcomeDismissed hook

Thin React hook around onboardingStore; lazy init from localStorage,
setter writes through.
EOF
)"
```

---

## Task 3：onboarding.css —— 极简苹果风样式

**Files:**
- Create: `web/src/onboarding/onboarding.css`

---

- [ ] **Step 3.1：写完整 CSS**

创建 `web/src/onboarding/onboarding.css`：

```css
/* ─── Modal 容器与遮罩 ─── */
.welcome-modal-root .ant-modal-mask {
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.welcome-modal .ant-modal-content {
  padding: 48px 40px 40px;
  border-radius: 20px;
  background: #ffffff;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.12),
    0 4px 16px rgba(0, 0, 0, 0.04);
}

.welcome-modal .ant-modal-close {
  top: 20px;
  inset-inline-end: 20px;
  color: rgba(0, 0, 0, 0.35);
  transition: color 160ms ease;
}

.welcome-modal .ant-modal-close:hover {
  color: rgba(0, 0, 0, 0.85);
  background: transparent;
}

/* ─── 主体 ─── */
.welcome-modal__body {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.welcome-modal__title {
  margin: 0 0 12px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: #1a1a1a;
  text-align: center;
}

.welcome-modal__subtitle {
  margin: 0 0 36px;
  max-width: 380px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.6;
  color: #666;
  text-align: center;
}

/* ─── 三步 ─── */
.welcome-modal__steps {
  list-style: none;
  margin: 0 0 36px;
  padding: 0;
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.welcome-modal__steps li {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.welcome-modal__step-icon {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: #f5f5f7;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: #1a1a1a;
}

.welcome-modal__step-label {
  font-size: 14px;
  font-weight: 500;
  color: #1a1a1a;
}

.welcome-modal__step-desc {
  font-size: 12px;
  line-height: 1.5;
  color: #888;
}

/* ─── 主按钮 ─── */
.welcome-modal__cta.ant-btn {
  width: 200px;
  height: 44px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(22, 119, 255, 0.2);
  transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease;
}

.welcome-modal__cta.ant-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.28);
}

/* ─── 移动端 (≤480px) ─── */
@media (max-width: 480px) {
  .welcome-modal.ant-modal {
    width: calc(100vw - 32px) !important;
    max-width: 480px;
    margin: 0 16px;
  }

  .welcome-modal .ant-modal-content {
    padding: 32px 24px 28px;
    border-radius: 18px;
  }

  .welcome-modal__title {
    font-size: 22px;
  }

  .welcome-modal__subtitle {
    margin-bottom: 28px;
  }

  .welcome-modal__steps {
    grid-template-columns: 1fr;
    gap: 14px;
    margin-bottom: 28px;
  }

  .welcome-modal__steps li {
    flex-direction: row;
    align-items: center;
    text-align: left;
    gap: 12px;
  }

  .welcome-modal__step-icon {
    flex-shrink: 0;
  }

  .welcome-modal__step-label {
    flex: 0 0 auto;
  }

  .welcome-modal__step-desc {
    flex: 1;
    text-align: left;
  }

  .welcome-modal__cta.ant-btn {
    width: 100%;
  }
}
```

> 注：`!important` 仅用在移动端宽度覆盖（AntD Modal 的 width prop 会注入 inline style，必须用 !important 才能在 @media 下覆盖）。其他全部走选择器权重。

---

- [ ] **Step 3.2：Commit**

```bash
git add web/src/onboarding/onboarding.css
git commit -m "$(cat <<'EOF'
feat(onboarding): minimalist apple-style modal CSS

White card, 20px radius, soft shadow, 48x48 icon tiles, 200x44 primary
CTA; mobile @media stacks steps vertically and full-width button.
EOF
)"
```

---

## Task 4：WelcomeModal.tsx —— 组件

**Files:**
- Create: `web/src/onboarding/WelcomeModal.tsx`

---

- [ ] **Step 4.1：写组件**

创建 `web/src/onboarding/WelcomeModal.tsx`：

```tsx
import React from 'react'
import { Modal, Button } from 'antd'
import { EditOutlined, RobotOutlined, CheckCircleOutlined } from '@ant-design/icons'
import './onboarding.css'

interface WelcomeModalProps {
  open: boolean
  onClose: () => void
}

export function WelcomeModal({ open, onClose }: WelcomeModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      centered
      width={520}
      closable
      maskClosable
      keyboard
      className="welcome-modal"
      rootClassName="welcome-modal-root"
      destroyOnClose
    >
      <div className="welcome-modal__body">
        <h2 className="welcome-modal__title">欢迎使用 AgentQuad</h2>
        <p className="welcome-modal__subtitle">
          四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话，全本地
        </p>
        <ol className="welcome-modal__steps">
          <li>
            <span className="welcome-modal__step-icon"><EditOutlined /></span>
            <span className="welcome-modal__step-label">新建 todo</span>
            <span className="welcome-modal__step-desc">标题写你想做的事</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><RobotOutlined /></span>
            <span className="welcome-modal__step-label">启动 AI 终端</span>
            <span className="welcome-modal__step-desc">在卡片上点 "AI 执行"</span>
          </li>
          <li>
            <span className="welcome-modal__step-icon"><CheckCircleOutlined /></span>
            <span className="welcome-modal__step-label">协作完成</span>
            <span className="welcome-modal__step-desc">关注右上 Rail 提示</span>
          </li>
        </ol>
        <Button
          type="primary"
          size="large"
          onClick={onClose}
          className="welcome-modal__cta"
        >
          开始使用
        </Button>
      </div>
    </Modal>
  )
}

export default WelcomeModal
```

---

- [ ] **Step 4.2：跑 web build 验证编译**

Run:

```bash
npm run -w web build
```

Expected: build 通过，无 TS 报错。产物在 `dist-web/`。

如失败：常见原因
- `RobotOutlined` / `CheckCircleOutlined` 拼写错误 → 在 @ant-design/icons 文档里核对
- TS strict 类型错误 → 项目 `web/tsconfig.json` strict=false，应该不会报，但 props 接口名需完全匹配

---

- [ ] **Step 4.3：Commit**

```bash
git add web/src/onboarding/WelcomeModal.tsx
git commit -m "$(cat <<'EOF'
feat(onboarding): WelcomeModal component

AntD Modal with three icon-tile steps and a primary CTA; closes on
button click, mask click, X, or Esc — all routed through onClose.
EOF
)"
```

---

## Task 5：接入 TodoManage.tsx

**Files:**
- Modify: `web/src/TodoManage.tsx`

---

- [ ] **Step 5.1：加 import**

在 `web/src/TodoManage.tsx` 现有 import 区域末尾（紧挨着 `import ExportDialog ...` 这些 onboarding 之外的 import 之后），追加：

```tsx
import { WelcomeModal } from './onboarding/WelcomeModal'
import { useWelcomeDismissed } from './onboarding/useWelcomeDismissed'
```

放置位置参考：和 `import SettingsDrawer from './SettingsDrawer'` 那批 import 同一片区域。

---

- [ ] **Step 5.2：加 hook 调用**

在 `TodoManage` 组件函数体顶部，与其他 `useState` 邻近的位置（例如 `const [todos, setTodos] = useState<Todo[]>([])` 附近的 state 声明区域），追加：

```tsx
const [welcomeDismissed, setWelcomeDismissed] = useWelcomeDismissed()
```

---

- [ ] **Step 5.3：加 JSX 挂载**

在 `TodoManage` 组件的 JSX `return` 区域末尾（与 `<SettingsDrawer ...>` 等其他 Drawer 同层级，紧挨着即可），追加：

```tsx
<WelcomeModal
  open={!welcomeDismissed}
  onClose={() => setWelcomeDismissed(true)}
/>
```

注意：必须放在最外层 fragment 或顶层 wrapper 内，与已有的 `<SettingsDrawer>`、`<WikiDrawer>`、`<StatsDrawer>`、`<TemplateDrawer>`、`<ExportDialog>` 等同层。如果找不到准确锚点，先 grep `<SettingsDrawer` 在 JSX 中的位置，把 `<WelcomeModal ... />` 加在它之前或之后皆可。

---

- [ ] **Step 5.4：跑 web build**

Run:

```bash
npm run -w web build
```

Expected: 通过。

---

- [ ] **Step 5.5：Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "$(cat <<'EOF'
feat(onboarding): mount WelcomeModal in TodoManage

Wire useWelcomeDismissed and render WelcomeModal at the top-level JSX
alongside other drawers; open on first visit, persists dismissal.
EOF
)"
```

---

## Task 6：验证（自动测试 + 手动验收）

**Files:**
- 无新增；本任务仅运行命令 + 手动验证。

---

- [ ] **Step 6.1：跑全量测试，确认无回归**

Run:

```bash
npm test
```

Expected: 全部 PASS，包括新增的 `test/onboarding-store.test.js`。

如有失败的非 onboarding 测试且失败信息明显与本次改动无关：先记下，不在本计划范围内处理。

---

- [ ] **Step 6.2：跑前端 build**

Run:

```bash
npm run build
```

Expected: 通过；`dist-web/` 有产物。

---

- [ ] **Step 6.3：启动 web 端，手动验证 Modal 首次弹出**

Run:

```bash
# 一个终端窗口跑 dev server
cd web && npm run dev
```

在浏览器打开 `http://localhost:5173`（vite dev server 端口；如端口不同看 dev 输出）。

**操作**：

1. 打开 DevTools → Application → Local Storage → 清空 `agentquad:welcome:dismissed`
2. 刷新页面

**期望**：

- 居中 Modal 自动弹出
- 标题"欢迎使用 AgentQuad"
- 副标题"四象限里的 AI 调度台 —— ..."
- 三个 icon 步骤横排，icon 容器灰色圆角
- 主按钮"开始使用"蓝色填充
- 右上角细线 ✕ 关闭按钮

---

- [ ] **Step 6.4：手动验证 4 种关闭路径**

依次测试（每次先清 `agentquad:welcome:dismissed` + 刷新）：

| 关闭方式 | 期望结果 |
|---|---|
| 点"开始使用"按钮 | Modal 关闭，DevTools 中 `agentquad:welcome:dismissed === '1'` |
| 点右上角 ✕ | 同上 |
| 点遮罩（Modal 外的暗化区域） | 同上 |
| 按 Esc 键 | 同上 |

再次刷新页面，**期望**：Modal 不再出现。

---

- [ ] **Step 6.5：视觉验收（对照 spec §4.4）**

逐项检查：

- [ ] 圆角 20px（Modal 外框）
- [ ] padding 上 48 / 左右 40 / 下 40
- [ ] 阴影柔和（不是 AntD 默认的硬阴影）
- [ ] 遮罩比默认深、有 backdrop-filter 模糊
- [ ] 标题 24px / 字重 600 / 紧字距
- [ ] 副标题灰色 #666 / 14px / 1.6 行高
- [ ] icon 容器 48x48 / 圆角 14 / 浅灰 #f5f5f7
- [ ] 主按钮 200x44 / 圆角 12 / 蓝色
- [ ] 主按钮 hover 微上移 + 阴影加深

如某项明显跑偏，调 `onboarding.css` 后回到 Step 6.3 重看。

---

- [ ] **Step 6.6：移动端验证**

DevTools 切到 iPhone SE 视图（375x667）或更窄（chrome devtools 自定义 320×568）：

- [ ] Modal 宽度 ≈ 屏宽 - 32px，不溢出
- [ ] 三步从横排变纵排（icon 在左，文字在右）
- [ ] 主按钮变 100% 宽
- [ ] 各文字不溢出、不重叠

---

- [ ] **Step 6.7（条件）：如有 CSS 修补，commit**

如果 6.5 / 6.6 发现需要 CSS 微调：

```bash
git add web/src/onboarding/onboarding.css
git commit -m "style(onboarding): visual tuning from manual review"
```

如果没改动，跳过本步。

---

## 自检（plan 完成后）

跑一遍验收标准（spec §3）：

- [ ] 新用户首次打开 → Modal 弹出 → 见 Task 6
- [ ] 4 种关闭路径都写入 dismissed → 见 Task 6
- [ ] 已 dismiss 后不再弹 → 见 Task 6
- [ ] 与 todos.length 无关 → 默认实现就是无关（hook 状态唯一来源）
- [ ] 视觉规范全部命中 → 见 Task 6.5
- [ ] 移动端窄屏适配 → 见 Task 6.6
- [ ] 无新增第三方依赖 → 整个计划只用了已装的 antd / @ant-design/icons / react
- [ ] `npm run -w web build` 通过 → Task 5.4
- [ ] 既有测试不回归 → Task 6.1
- [ ] 新增 onboardingStore 单元测试 → Task 1

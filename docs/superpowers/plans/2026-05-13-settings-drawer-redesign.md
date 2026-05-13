# 设置抽屉布局重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `web/src/SettingsDrawer.tsx` 从「顶 Tab + 右上角按钮 + 顶部状态表」改造为「左 nav + sticky 底栏 + 760px 宽」的两栏布局，提升视觉层次与扫读效率。

**Architecture:** 单文件改造。AntD `<Drawer>` 加 `footer` prop 承载 sticky 操作栏；`<Tabs>` 加 `tabPosition="left"`；删除 `<Descriptions>` 状态块；新增一个 `web/src/SettingsDrawer.css`。不动表单字段、保存逻辑、API。

**Tech Stack:** React 18, AntD 5, Vite, Vitest（项目用源码字符串匹配做轻量回归）

设计文档：`docs/superpowers/specs/2026-05-13-settings-drawer-redesign-design.md`

---

## 工作目录约定

所有命令在 `/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo` 下执行（quadtodo 仓库根）。

## 提交规约

本仓库（quadtodo / AgentQuad）的用户偏好是 **每个 commit 立即 push origin main**。每个 Task 最后一步都有显式的 commit + push 命令。

---

### Task 1: 基线检查

确认改动前测试和构建都是绿的，避免后面把别人的 bug 算到自己头上。

**Files:** （只读）

- [ ] **Step 1.1: 跑现有 SettingsDrawer 相关测试**

Run:
```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npx vitest run test/settings-drawer-cross-tab-save.test.js test/settings-drawer-lark-config.test.js --reporter=basic
```
Expected: 两个测试文件全 PASS

- [ ] **Step 1.2: 跑 web 构建**

Run:
```bash
npm --prefix web run build 2>&1 | tail -10
```
Expected: `vite build` 成功，无 TS 报错

如果以上任一不通过，**停止**并先排查现有问题，不要继续改动。

---

### Task 2: 新建 SettingsDrawer.css

**Files:**
- Create: `web/src/SettingsDrawer.css`

- [ ] **Step 2.1: 创建 CSS 文件**

Write file `web/src/SettingsDrawer.css`：

```css
.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-footer-path {
  font-size: 12px;
  color: var(--text-secondary);
  user-select: all;
}

.settings-section-title {
  font-weight: 600;
  margin-top: 8px;
  margin-bottom: 12px;
  color: var(--text-primary);
}
```

- [ ] **Step 2.2: Commit + push**

```bash
git add web/src/SettingsDrawer.css
git commit -m "feat(settings): 新增 SettingsDrawer.css 用于布局重构"
git push origin main
```

---

### Task 3: 删除顶部状态块 + getStatus 调用

抽屉顶部的版本/活跃会话数 Descriptions 整块删除（用户已确认不需要）。同时清理 `getStatus` 调用、`status` state、未使用的 imports。

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 3.1: 引入新 CSS 文件**

在 `web/src/SettingsDrawer.tsx` 第 11 行（`larkSetupMd` import 之后）追加一行：

```typescript
import './SettingsDrawer.css'
```

- [ ] **Step 3.2: 从 antd 顶部 import 中移除 `Descriptions`**

文件第 1 行原本：
```typescript
import { Drawer, Descriptions, Alert, Typography, Form, Input, InputNumber, Button, Radio, Space, Tag, Switch, Collapse, Tabs, Segmented } from 'antd'
```

改为：
```typescript
import { Drawer, Alert, Typography, Form, Input, InputNumber, Button, Radio, Space, Tag, Switch, Collapse, Tabs, Segmented } from 'antd'
```

- [ ] **Step 3.3: 从 api import 中移除 `getStatus`**

文件第 8 行原本：
```typescript
import { getStatus, getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic, testTelegram, testLark, type ProbeHit, type DispatchChannelConfig } from './api'
```

改为：
```typescript
import { getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic, testTelegram, testLark, type ProbeHit, type DispatchChannelConfig } from './api'
```

- [ ] **Step 3.4: 删除 `status` state**

文件第 99 行整行删除：
```typescript
  const [status, setStatus] = useState<{ version: string; activeSessions: number } | null>(null)
```

- [ ] **Step 3.5: 改造 useEffect — 只调 getConfig，不再 Promise.all + getStatus**

文件第 164-170 行附近，原本：
```typescript
  useEffect(() => {
    if (!open) return
    Promise.all([getStatus(), getConfig()])
      .then(([s, result]) => {
        setStatus(s)
        setConfig(result.config)
        setToolDiagnostics(result.toolDiagnostics)
        form.setFieldsValue({
```

改为：
```typescript
  useEffect(() => {
    if (!open) return
    getConfig()
      .then((result) => {
        setConfig(result.config)
        setToolDiagnostics(result.toolDiagnostics)
        form.setFieldsValue({
```

注意：`setStatus(s)` 和 `Promise.all` 的解构都要去掉，参数从 `([s, result])` 变成单参数 `(result)`。

- [ ] **Step 3.6: 删除 Descriptions 渲染块**

文件第 1176-1179 行整块删除：
```typescript
      <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="版本">{status?.version ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="活跃 AI 会话数">{status?.activeSessions ?? '-'}</Descriptions.Item>
      </Descriptions>
```

- [ ] **Step 3.7: 验证构建通过**

Run:
```bash
npm --prefix web run build 2>&1 | tail -10
```
Expected: 构建成功，无 TS 报错（特别注意：不应该有 "status is not defined" 或未使用 import 报错）

- [ ] **Step 3.8: 验证现有测试仍 PASS**

Run:
```bash
npx vitest run test/settings-drawer-cross-tab-save.test.js test/settings-drawer-lark-config.test.js --reporter=basic
```
Expected: 两个测试文件全 PASS

- [ ] **Step 3.9: Commit + push**

```bash
git add web/src/SettingsDrawer.tsx web/src/SettingsDrawer.css
git commit -m "refactor(settings): 删除顶部版本/活跃会话块及 getStatus 调用"
git push origin main
```

（CSS 文件其实在 Task 2 已经 commit 了，这里只 add SettingsDrawer.tsx 即可；但保险起见 add 两个，git 会忽略无改动的文件。）

---

### Task 4: Drawer 改造 — 加宽 760、按钮移底栏、删除底部 Paragraph

把 Drawer 的 `extra` 按钮区改成 `footer` 区，宽度从 560 改成 760，同时把抽屉最底部那行"配置文件位置"的 Paragraph 删掉（路径已并入底栏左侧）。

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 4.1: 改 Drawer 头部（width + footer）**

文件第 1162-1173 行附近，原本：
```typescript
    <Drawer
      title="AgentQuad 设置"
      open={open}
      onClose={onClose}
      width={560}
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
        </Space>
      }
    >
```

改为：
```typescript
    <Drawer
      title="AgentQuad 设置"
      open={open}
      onClose={onClose}
      width={760}
      footer={
        <div className="settings-footer">
          <Text code className="settings-footer-path">~/.agentquad/config.json</Text>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
          </Space>
        </div>
      }
    >
```

注意：`Text` 已经在文件第 13 行通过 `const { Paragraph, Text } = Typography` 解构出来了，不需要额外 import。

- [ ] **Step 4.2: 删除底部配置文件位置 Paragraph**

文件第 1207-1209 行整块删除：
```typescript
      <Paragraph type="secondary" style={{ marginTop: 16 }}>
        配置文件位置：<Text code>~/.agentquad/config.json</Text>
      </Paragraph>
```

注意：`Paragraph` 在 pricing tab 还在用（第 1078、1096 行附近的 "默认费率（fallback）" / "按模型匹配"），所以 `const { Paragraph, Text }` 解构**不要动**。

- [ ] **Step 4.3: 验证构建**

Run:
```bash
npm --prefix web run build 2>&1 | tail -10
```
Expected: 构建成功

- [ ] **Step 4.4: 验证现有测试**

Run:
```bash
npx vitest run test/settings-drawer-cross-tab-save.test.js test/settings-drawer-lark-config.test.js --reporter=basic
```
Expected: 两个测试 PASS

- [ ] **Step 4.5: Commit + push**

```bash
git add web/src/SettingsDrawer.tsx
git commit -m "refactor(settings): Drawer 加宽到 760，保存按钮挪到底部 sticky footer"
git push origin main
```

---

### Task 5: 顶 Tab 改左 Tab

把 `<Tabs>` 从顶部水平 tab 改成左侧纵向 nav，并把"运行"重命名为"通用"、"Lark / 飞书"简化为"飞书"。

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 5.1: 给 Tabs 加 `tabPosition` 和 `tabBarStyle`，重命名两个 label**

文件第 1182-1192 行附近，原本：
```typescript
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as typeof activeTab)}
          items={[
            { key: 'run', label: '运行', children: runTab },
            { key: 'tools', label: 'AI 工具', children: toolsTab },
            { key: 'telegram', label: 'Telegram', children: telegramTab },
            { key: 'lark', label: 'Lark / 飞书', children: larkTab },
            { key: 'pricing', label: '价目表', children: pricingTab },
          ]}
        />
```

改为：
```typescript
        <Tabs
          tabPosition="left"
          tabBarStyle={{ width: 132 }}
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as typeof activeTab)}
          items={[
            { key: 'run', label: '通用', children: runTab },
            { key: 'tools', label: 'AI 工具', children: toolsTab },
            { key: 'telegram', label: 'Telegram', children: telegramTab },
            { key: 'lark', label: '飞书', children: larkTab },
            { key: 'pricing', label: '价目表', children: pricingTab },
          ]}
        />
```

注意 `key` 值保持原样（`run` / `lark`），只改显示 label，避免破坏 `activeKey` 类型联合 `'run' | 'tools' | 'telegram' | 'lark' | 'pricing'`。

- [ ] **Step 5.2: 验证构建**

Run:
```bash
npm --prefix web run build 2>&1 | tail -10
```
Expected: 构建成功

- [ ] **Step 5.3: 验证现有测试**

Run:
```bash
npx vitest run test/settings-drawer-cross-tab-save.test.js test/settings-drawer-lark-config.test.js --reporter=basic
```
Expected: 两个测试 PASS

- [ ] **Step 5.4: Commit + push**

```bash
git add web/src/SettingsDrawer.tsx
git commit -m "refactor(settings): 顶 Tab 改左 Tab，运行→通用，Lark/飞书→飞书"
git push origin main
```

---

### Task 6: 通用 tab — 加分组小标题 + 端口换 InputNumber

把"通用"（原"运行"）tab 内的 3 个字段加上"启动"/"服务"两个小标题分组，并把"服务端口"从原生 `<Input type="number">` 换成 `<InputNumber>`（视觉上跟价目表风格统一）。

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`

- [ ] **Step 6.1: 重写 `runTab`**

文件第 495-537 行附近，原本：
```typescript
  const runTab = (
    <>
      <Form.Item
        label="默认启动目录"
        extra="新开的 AI 会话会默认在这个目录里启动。保存后立即对新会话生效。"
      >
        <Space.Compact block>
          <Form.Item name="defaultCwd" noStyle rules={[{ required: true, message: '请输入默认启动目录' }]}>
            <Input allowClear placeholder="/Users/liuzhenhua/Desktop/code/crazyCombo" />
          </Form.Item>
          <Button loading={pickingDefaultCwd} onClick={handlePickDefaultCwd}>选择目录</Button>
        </Space.Compact>
      </Form.Item>

      <Form.Item
        label="终端链接打开编辑器"
        extra="终端中的文件路径点击时会使用该编辑器打开；也是卡片「代码」按钮的默认项。"
      >
        <Radio.Group
          value={linkEditor}
          onChange={(e) => {
            const v = e.target.value as 'trae-cn' | 'trae' | 'cursor'
            setLinkEditor(v)
            // rebrand: localStorage key kept for backward compatibility
            try { localStorage.setItem('quadtodo.editor', v) } catch {}
          }}
        >
          <Radio.Button value="trae-cn">Trae CN</Radio.Button>
          <Radio.Button value="trae">Trae</Radio.Button>
          <Radio.Button value="cursor">Cursor</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <Form.Item
        name="port"
        label="服务端口"
        rules={[{ required: true, message: '请输入服务端口' }]}
        extra="端口会保存到配置文件，重启 AgentQuad 后生效。"
      >
        <Input type="number" min={1} max={65535} />
      </Form.Item>
    </>
  )
```

改为：
```typescript
  const runTab = (
    <>
      <div className="settings-section-title">启动</div>

      <Form.Item
        label="默认启动目录"
        extra="新开的 AI 会话会默认在这个目录里启动。保存后立即对新会话生效。"
      >
        <Space.Compact block>
          <Form.Item name="defaultCwd" noStyle rules={[{ required: true, message: '请输入默认启动目录' }]}>
            <Input allowClear placeholder="/Users/liuzhenhua/Desktop/code/crazyCombo" />
          </Form.Item>
          <Button loading={pickingDefaultCwd} onClick={handlePickDefaultCwd}>选择目录</Button>
        </Space.Compact>
      </Form.Item>

      <Form.Item
        label="终端链接打开编辑器"
        extra="终端中的文件路径点击时会使用该编辑器打开；也是卡片「代码」按钮的默认项。"
      >
        <Radio.Group
          value={linkEditor}
          onChange={(e) => {
            const v = e.target.value as 'trae-cn' | 'trae' | 'cursor'
            setLinkEditor(v)
            // rebrand: localStorage key kept for backward compatibility
            try { localStorage.setItem('quadtodo.editor', v) } catch {}
          }}
        >
          <Radio.Button value="trae-cn">Trae CN</Radio.Button>
          <Radio.Button value="trae">Trae</Radio.Button>
          <Radio.Button value="cursor">Cursor</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <div className="settings-section-title">服务</div>

      <Form.Item
        name="port"
        label="服务端口"
        rules={[{ required: true, message: '请输入服务端口' }]}
        extra="端口会保存到配置文件，重启 AgentQuad 后生效。"
      >
        <InputNumber min={1} max={65535} style={{ width: 160 }} />
      </Form.Item>
    </>
  )
```

注意：`handleSave` 第 253 行 `port: Number(values.port)` 已经做了 `Number()` 转换，不论字段是 `<Input type="number">` 返回字符串还是 `<InputNumber>` 返回数字都 OK，不需要改 handleSave。

- [ ] **Step 6.2: 验证构建**

Run:
```bash
npm --prefix web run build 2>&1 | tail -10
```
Expected: 构建成功

- [ ] **Step 6.3: 验证现有测试**

Run:
```bash
npx vitest run test/settings-drawer-cross-tab-save.test.js test/settings-drawer-lark-config.test.js --reporter=basic
```
Expected: 两个测试 PASS

- [ ] **Step 6.4: Commit + push**

```bash
git add web/src/SettingsDrawer.tsx
git commit -m "refactor(settings): 通用 tab 加启动/服务分组，端口换 InputNumber"
git push origin main
```

---

### Task 7: 手工视觉验证

UI 布局重构，真验收要在浏览器里看。下面是 checklist，跑 dev server 后逐项核对。

**Pre-flight:**

启动后端（项目根 README 给的方式）+ web dev：
```bash
# 在 quadtodo 仓库根另起一个 shell
npm --prefix web run dev
```
然后浏览器打开 web 地址（一般 http://localhost:5173 或 5174），点设置图标打开抽屉。

**Visual checklist:**

- [ ] **Step 7.1: 抽屉骨架**
  - [ ] Drawer 宽度看起来 ~760px（占屏 ~55% on 1440 宽）
  - [ ] 左侧出现 5 项纵向 nav：**通用 / AI 工具 / Telegram / 飞书 / 价目表**
  - [ ] 顶部不再有版本/活跃 AI 会话数表
  - [ ] 底部出现 sticky footer：左侧 `~/.agentquad/config.json` + 右侧 关闭/保存
  - [ ] Drawer 标题"AgentQuad 设置"右侧只有默认的 X 关闭图标（没有原来的"关闭/保存"按钮）

- [ ] **Step 7.2: 通用 tab**
  - [ ] 进入"通用"后看到"启动"小标题（粗体）
  - [ ] 下方依次是：默认启动目录、终端链接打开编辑器
  - [ ] 再下方看到"服务"小标题
  - [ ] 服务端口控件是 InputNumber（带 ▴▾ 微调），宽度固定（不再全宽）

- [ ] **Step 7.3: 跨 section 切换不丢输入**
  - [ ] 在"通用"改默认启动目录 → 切到 Telegram → 切回"通用" → 输入仍在
  - [ ] 在 Telegram 改 Bot Token → 切到飞书 → 切回 Telegram → 输入仍在

- [ ] **Step 7.4: 保存按钮始终可见**
  - [ ] 切到价目表 → 滚到最底（按模型匹配的添加模型按钮以下）→ 底部 footer 的保存按钮仍可见
  - [ ] 切到 Telegram → 展开"高级（不动也行）"折叠面板 → 滚到最底 → 保存按钮仍可见

- [ ] **Step 7.5: 保存功能仍工作**
  - [ ] 在"通用"改服务端口为 5678 → 点底部"保存" → 看到 `设置已保存。默认目录和工具对新会话立即生效，端口需重启后生效。` 消息
  - [ ] 关闭抽屉、重开 → 端口字段值仍是 5678
  - [ ] 改回 5677 → 保存 → 验证回到原值

- [ ] **Step 7.6: 关闭按钮工作**
  - [ ] 点底部"关闭" → 抽屉关闭
  - [ ] 重开 → 点右上角 X → 抽屉关闭

- [ ] **Step 7.7: 配置文件路径**
  - [ ] 底部 footer 左侧能看到 `~/.agentquad/config.json` 等宽样式
  - [ ] 单击该路径文本 → 文本全选（user-select: all 生效）

- [ ] **Step 7.8: 既有子交互不回归**
  - [ ] Telegram tab：点 Bot Token 旁的"测试"按钮 → 行为正常（连通或报错都行，不应崩溃）
  - [ ] Telegram tab：点 Supergroup ID 旁"抓 ID"按钮 → Modal 弹出
  - [ ] 飞书 tab：点 App Secret 旁的"测试"按钮 → 行为正常
  - [ ] AI 工具 tab：点工具的"重新检测"按钮 → 行为正常
  - [ ] 价目表 tab：点"添加模型"按钮 → 新增一行；点行内"删除"按钮 → 删除该行

- [ ] **Step 7.9: 1440×900 视窗**
  - [ ] 在 1440×900 浏览器窗口下打开抽屉，主内容区仍清晰可见、不撞屏边

**如以上全部通过**：无需额外 commit（代码已在 Task 2-6 提交过）。在 PR 描述或本地总结里勾完即可。

**如发现视觉/交互问题**：

1. 在 SettingsDrawer.tsx 或 SettingsDrawer.css 里就地修补
2. 重新跑 build + 现有测试
3. Commit + push 一条修补：
```bash
git add web/src/SettingsDrawer.tsx web/src/SettingsDrawer.css
git commit -m "fix(settings): <一句话描述修补点>"
git push origin main
```

---

## 完工汇总（执行完最后写给用户）

任务完成时给主人的回执应该包含：

- 6 次正向 commit + 0/N 次修补 commit 的 SHA 列表
- web build 通过
- 现有 2 个 vitest 文件 PASS
- 手工 checklist 勾完情况（哪几项通过，是否有跳过）
- 如有跳过 / 已知问题 → 列出来等用户决策

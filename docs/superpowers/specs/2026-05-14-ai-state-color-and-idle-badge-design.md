# AI 状态色重映射 & TodoCard 空闲徽标显示规则

> 日期：2026-05-14
> 状态：设计中，待用户审阅

## 背景与诉求

### 问题 1：全站 AI 状态色不直观
顶栏三个 StatPill（运行中 / 空闲 / 待确认）当前配色：
- 运行中 → 绿（合理）
- 空闲 → 中性灰（用户认为应该是黄，更醒目，提示"待派遣"）
- 待确认 → 橙黄（用户认为应该是红，体现"阻塞型动作项"的紧急感）

### 问题 2：TodoCard 历史会话行不显示「空闲中」徽标
`TodoCard.tsx:281-283` 当前以 `sessionState !== 'idle'` 守卫显式过滤掉了 idle 状态徽标，原因是历史 session 绝大多数都是 idle 终态，全部挂徽标会变成视觉噪音。但用户希望看到"刚跑完、还能继续 resume 的会话"的 idle 状态，否则无从一眼判断哪些会话还活着。

## 已确认方案

**方案 C（颜色）+ 方案 ②（空闲徽标）。**

### 颜色 token 调整 — `web/src/design/tokens.css`

#### 深色主题 `:root`（line 35-39）
| Token | 旧值 | 新值 | 含义 |
|---|---|---|---|
| `--ai-pending-confirm` | `#ffb84d` | `#f97316` | 暖橙红（与 error 红 #ef4444 拉开色相） |
| `--ai-idle` | `#6b7280` | `#facc15` | 明黄（吸睛，提示"待派遣"） |
| `--heat-base`（新增） | — | `#ffb84d` | 沿用旧 pending 黄，专供热力图等"活跃度/成就"语义 |

#### 浅色主题 `[data-theme="light"]`（line 76-80）
| Token | 旧值 | 新值 | 含义 |
|---|---|---|---|
| `--ai-pending-confirm` | `#d97706` | `#ea580c` | 暖橙红浅色变体 |
| `--ai-idle` | `#6b7280` | `#eab308` | 琥珀黄浅色变体（比 #facc15 柔和，亮主题对比度更好） |
| `--heat-base`（新增） | — | `#d97706` | 沿用旧 pending 浅色橙 |

### StatsReportsDrawer 改用 `--heat-base`

热力图、成就大数字、奖杯图标等用 pending_confirm 表示"活跃度/成就"语义的位置全部改用 `--heat-base`，避免被新的"待确认 = 红"语义牵连。

涉及文件：
1. `web/src/components/StatsReportsDrawer/ReportPanel.css`
   - line 20-21：hero 卡片背景渐变 + 边框（2 处 `var(--ai-pending-confirm)`）
   - line 42：hero 大数字色（`color: var(--ai-pending-confirm)`）
   - line 85-88：热力图 L1-L4 渐变（4 处）
   - line 154：日历下方 `b` 标签的数字色
2. `web/src/components/StatsReportsDrawer/StatsReportsDrawer.tsx`
   - line 54：标题区奖杯图标 `<TrophyOutlined style={{ color: 'var(--ai-pending-confirm)' }} />` → 改为 `var(--heat-base)`

> 注意：`ReportPanel.css` line 53-54 的 `--ai-error` streak badge（连续打卡）**保留不动**，是另一套语义。

### TodoCard 空闲徽标显示规则 — `web/src/components/TodoCard/TodoCard.tsx`

第 281-283 行：
```tsx
{sessionState !== 'idle' && (
  <span className={`todo-ai-state todo-ai-state-${sessionState}`}>{AI_STATE_ICON[sessionState]()}{' '}{t(AI_STATE_LABEL_KEY[sessionState])}</span>
)}
```

改为：
```tsx
{(sessionState !== 'idle' || liveSession) && (
  <span className={`todo-ai-state todo-ai-state-${sessionState}`}>{AI_STATE_ICON[sessionState]()}{' '}{t(AI_STATE_LABEL_KEY[sessionState])}</span>
)}
```

`liveSession` 第 210 行已经从 `liveSessionsMap.get(session.sessionId)` 取过，无需重复取。

同步更新第 215-218 行注释：把旧的「idle 不渲染徽标」改成「idle 仅在 liveSession 存在时渲染 —— 与顶栏 idle pill 的计数口径保持一致：顶栏数它则卡片显示它，反之亦然」。

## 验收标准

1. **顶栏 StatPill**
   - 「空闲」图标 + 数字 → 深色主题 `#facc15` / 浅色主题 `#eab308`
   - 「待确认」图标 + 数字 + alert pulse 阴影 → 深色主题 `#f97316` / 浅色主题 `#ea580c`
   - 「运行中」保持绿色不变

2. **TodoCard 历史会话行**
   - 只有 `liveSession` 存在（本次 app 启动后开过、仍在 `useAiSessionStore` 内存中）的 idle 会话显示「⏸ 空闲中」徽标
   - 久远历史 session（done/stopped 早已不在 liveSession 中）仍**不显示** idle 徽标
   - running / pending 徽标显示规则不变

3. **StatsReportsDrawer**
   - 「今日成果」大数字、热力图四级渐变、奖杯图标 → 保留**旧黄色** `#ffb84d`（深色）/ `#d97706`（浅色）
   - 不被「待确认」新红色牵连

4. **跨视图色彩语义统一**
   - TodoCard 上的「待确认」徽标 = TranscriptView 状态栏的告警点 = 顶栏「待确认」pill → 同色
   - TodoCard 上的「空闲中」徽标 = 顶栏「空闲」pill → 同色

5. **暗 / 亮主题均通过验证**

6. **「错误」红与「待确认」红可一眼区分**
   - error 仍为 `#ef4444` / `#dc2626`
   - pending_confirm 为 `#f97316` / `#ea580c`
   - 二者色相差异 > 20°（橙 vs 正红），并排可识别

## 风险与边界

- **pending_confirm 与 error 的红色区分依赖色相差异，弱视/色盲用户体验需用图标辅助**：当前两者的图标已经不同（`MessageCircleWarning` vs 其他），可作为副渠道。
- **idle 黄 #facc15 与象限 Q3 黄 #ffb84d 仍接近**：但 idle 用于 session/avatar 上下文，Q3 用于 quadrant 标签上下文，不会同时出现在同一密集视觉区，撞色风险可接受。
- **liveSession 取决于本次 app 运行**：重启 app 后未恢复的 idle session（PTY 已被后端 30 分钟清理或前端 store 未恢复）会失去 idle 徽标。这与顶栏 idle pill 的统计规则一致，符合"看得见的空闲 = 还能 resume 的空闲"心智模型。
- **改动范围仅限**：`tokens.css`、`ReportPanel.css`、`StatsReportsDrawer.tsx`、`TodoCard.tsx`。不动 `TranscriptView.css`、`TodoManage.css`、`SessionFocus.css`、`TopbarDispatch.css` 等其它使用这两个 token 的文件 —— 它们用的是「待确认/空闲」语义而非「活跃度」，应跟着 token 联动变色，这是方案 C 的设计意图。

## 实现步骤（粗）

1. 改 `tokens.css`：调两个旧 token 的色值，加新 `--heat-base`（深 + 浅各一份）
2. 改 `ReportPanel.css`：批量替换 6 处 `--ai-pending-confirm` → `--heat-base`
3. 改 `StatsReportsDrawer.tsx`：第 54 行奖杯图标色源
4. 改 `TodoCard.tsx`：第 281 行守卫 + 第 215-218 行注释
5. 启动 web 开发模式 + 浏览器实地验收（明暗双主题、顶栏 pill、热力图、卡片徽标）
6. commit + push（按用户偏好：commit 完立即 push origin main）

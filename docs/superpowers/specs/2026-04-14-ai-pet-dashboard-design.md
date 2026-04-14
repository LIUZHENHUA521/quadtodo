# AI 宠物视图 + 数据面板 设计文档

日期：2026-04-14
作者：lzh（通过 Claude Code 协作）

## 背景与目标

quadtodo 目前以四象限列表形式展示待办，每张卡片可内嵌启动 Claude Code / Codex 的 PTY 会话。当多个 AI 会话并行运行时，用户缺少一个**跨待办**的全局视角：

- 看不到「当下所有活跃会话」的总览
- 看不到会话级的历史统计（总数、成功率、耗时等）
- 看不到每个 PTY 进程的资源占用

本次新增两件事：

1. **宠物视图**：将四象限看板切换为「宠物模式」，每个正在运行的 AI 会话化身为一只小机器人，在所属象限内活动，状态/节奏由会话状态与输出速率驱动
2. **数据抽屉**：右侧抽屉 3 个 Tab——实时瞥视 / 历史统计 / 资源占用

## 用户体验设计

### 入口

- 顶部工具栏新增 **视图切换 Segmented**：`列表` / `宠物`
- 顶部工具栏新增 **📊 按钮**：点击打开右侧数据抽屉（独立于当前视图模式）

### 宠物视图

- 视觉上保留当前四象限布局；每个象限是一块独立的 Pixi Canvas
- 一只宠物 = 一个正在运行的 AI 会话（或刚结束 5 分钟内的雕像）
- 形态由 tool 决定（claude 圆润 / codex 棱角），颜色由象限决定（P0 红 / P1 蓝 / P2 黄 / P3 灰绿）
- 点击宠物 → 全屏展开对应 AiTerminalMini 终端
- 同象限最多 12 只，超出部分聚合为「+N」角标

### 宠物状态机

| 宠物状态 | 触发条件 | 视觉表现 |
|---|---|---|
| `idle` | 刚启动无 output | 站立 + 缓慢呼吸 |
| `working` | running + 持续 output | 蹦跳 + 象限内随机游走 |
| `thinking` | running + ≥10 秒无 output | 站立 + 头顶「...」浮动 |
| `calling` | pending_confirm | 原地高频跳 + 感叹号 + 震动 |
| `celebrating` | done + exitCode=0 | 转圈 + 星星粒子 |
| `fallen` | done/stopped + exitCode≠0 | 躺倒 + 灰阶 |
| `statue` | 进入 celebrating/fallen 后立即切换 | 定格 + 低饱和度，5 分钟后销毁 |

### 输出速率 → 动画节奏

前端在 WebSocket `output` 事件里累计字节数，用 5 秒滑动窗口得出 `bytesPerSec`：

| 范围 | 动画倍率 |
|---|---|
| <50 B/s | 0.5x |
| 50–500 B/s | 1.0x |
| 500–5000 B/s | 1.5x |
| >5000 B/s | 2.0x + 轻微抖动 |

`sprite.animationSpeed = baseSpeed * rateMultiplier`；游走目标点切换频率同比放大。

### 数据抽屉（3 Tab）

**Tab B 实时瞥视**：每行一个活跃会话，字段包括宠物缩略图、待办标题、tool、象限、状态、运行时长、最近一行 output（单行截断 60 字）、托管模式、操作按钮（展开终端、停止、跳转待办）。

**Tab C 历史统计**：顶部 range 切换（今天/本周/本月）；4 张数字卡片（总数、成功率、总时长、平均时长）；4 张图表（结束状态饼图、tool 分布柱状、象限分布柱状、时间趋势折线）。

**Tab D 资源占用**：总计卡片（活跃数/总 CPU/总内存）；表格逐行展示（待办标题、tool、PID、CPU%、内存 MB、运行时长、30 秒 CPU sparkline）。

## 架构

### 前端

```
TodoManage.tsx
├── 工具栏
│   ├── 视图切换 Segmented（列表 | 宠物）
│   └── 📊 按钮 → DashboardDrawer
├── 列表视图（现状）
└── PetView.tsx
    └── PetQuadrantCanvas × 4（每象限独立 PIXI.Application）

DashboardDrawer.tsx（右侧抽屉）
├── LiveGlanceTab.tsx
├── HistoryStatsTab.tsx
└── ResourceTab.tsx
```

### 后端

- 新增 DB 表 `ai_session_log`（每次会话 done/failed/stopped 落一条）
- 新增 REST 路由：
  - `GET /api/ai-terminal/sessions`
  - `GET /api/ai-terminal/stats?range=today|week|month`
  - `GET /api/ai-terminal/resource`
- 会话对象 `session` 扩展字段 `lastOutputAt`；状态 `done/failed/stopped` 的会话在内存保留 5 分钟再清理（支撑雕像）
- `PtyManager` 新增 `getPids()`，由 `/resource` 调用 `pidusage` 采样

### 技术选型

- **动画引擎**：PixiJS（每象限一个独立 Canvas，不走 DOM 对齐）
- **状态管理**：Zustand（PetView 与 DashboardDrawer 共享 session/rate/resource store）
- **图表**：复用 AntD 生态（@ant-design/charts 或 recharts，二选一，先 recharts 因为包更小）
- **资源采集**：`pidusage` npm 包（跨平台）

## 数据流

### 宠物视图

1. 挂载 → `GET /api/ai-terminal/sessions` 初始化 store
2. store 对每个 sessionId 建立 WebSocket（复用现有 `/api/ai-terminal/stream/:sessionId`）；**只消费 `output/status/done` 事件，不渲染终端文本**
3. `output` → `recordOutputBytes(sessionId, data.length)`，滑动窗口算出 bytesPerSec
4. `status/done` → 更新宠物状态机
5. 卸载 → 关闭所有 WebSocket、销毁 Pixi 应用

### 数据抽屉

- **Tab B**：直接读 store（与宠物视图共享）
- **Tab C**：打开时按 range 调 `/stats`，切 range 重新拉
- **Tab D**：打开时 2 秒轮询 `/resource`；关闭立即停

### 雕像机制

- 后端 `pty.on('done')` 触发时：
  - 写 `ai_session_log`
  - 标记 `session.status = 'done'|'failed'|'stopped'`、`session.completedAt = now`
  - 保留在 `sessions` Map，不立即删除
- 定时清扫：30 秒轮询，删除 `completedAt > 5min` 的条目
- 前端宠物同步：`status` 事件切至 `celebrating/fallen`，立即进入 `statue`；5 分钟后下一次 `/sessions` 拉取发现已清 → `removeSession` → Pet 实例 `destroy()`

## 错误处理

- WebSocket 断开 → 复用 AiTerminalMini 的自动重连；宠物显示 `disconnected` 状态（灰色问号）
- `/resource` 中某个 PID 已退出 → 捕获 `pidusage` 错误，过滤该条，其他正常返回
- Pixi/WebGL 初始化失败 → 降级到 `<div>` 占位，提示「宠物视图不可用，请切换到列表视图」
- 同象限 >12 只 → 渲染前 12 只 + 「+N」角标
- 雕像超时后端已清 → 前端对齐下一次 `/sessions` 返回，`destroy` 对应 Pet

## 后端模块清单

### `src/db.js`

新增表 + 函数：
```sql
CREATE TABLE IF NOT EXISTS ai_session_log (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  quadrant INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX idx_ail_completed_at ON ai_session_log(completed_at);
```

新函数：`insertSessionLog(row)`、`querySessionStats({ since, until })`。

### `src/pty.js`

新增 `getPids(): Array<{sessionId, pid}>`。

### `src/routes/ai-terminal.js`

- `pty.on('done')` 处理器内追加 `db.insertSessionLog`
- `session` 对象新增 `lastOutputAt`；`output` 事件更新该字段
- 新增 3 个路由：`GET /sessions`、`GET /stats`、`GET /resource`
- 改造：`done` 事件不再立即从 `sessions` Map 删除；新增 30 秒轮询清扫器

### `package.json`

新增依赖：`pidusage@^3.0.2`。

## 前端模块清单

### 新文件

- `web/src/store/aiSessionStore.ts` — Zustand store
- `web/src/PetView.tsx` — 四象限宠物视图容器
- `web/src/pet/PetQuadrantCanvas.tsx` — 单象限 Pixi 画布
- `web/src/pet/Pet.ts` — Pet 精灵类
- `web/src/pet/petAssets.ts` — tool/quadrant → 外观映射
- `web/src/DashboardDrawer.tsx` — 右侧抽屉容器
- `web/src/dashboard/LiveGlanceTab.tsx`
- `web/src/dashboard/HistoryStatsTab.tsx`
- `web/src/dashboard/ResourceTab.tsx`

### 改动文件

- `web/src/TodoManage.tsx` — 加视图切换 Segmented、📊 按钮
- `web/src/api.ts` — 新增 `getSessions`、`getStats`、`getResource` 封装
- `web/package.json` — 新增 `pixi.js`、`zustand`、`recharts`

## YAGNI — 明确不做的事

- 宠物间互动/碰撞物理
- 宠物喂养/升级/命名系统
- 自定义时间范围（只给 today/week/month）
- 资源面板的长期历史曲线（只要当前快照 + 30 秒 sparkline）
- 雕像额外菜单（5 分钟内保持可点击，走现有展开终端逻辑）
- 移动端宠物视图优化（MVP 只保证桌面端）

## 测试策略

### 后端

- `test/db.test.js`：`ai_session_log` CRUD + 聚合查询（覆盖 today/week/month 边界）
- `test/ai-terminal.route.test.js`：
  - `GET /sessions` 返回活跃 + 雕像期会话
  - `GET /stats` 聚合正确
  - `GET /resource` mock `pidusage`，验证格式
  - 雕像保留 5 分钟后清扫（fake timers）
- `test/pty.test.js`：`getPids()` 返回当前活跃 PID

### 前端

- `aiSessionStore` 单测：upsert / remove / recordOutputBytes 滑动窗口
- 三个 Tab 组件的渲染快照（mock store）
- `PetView` 轻量测试：mock PIXI，验证 N 个 session → N 个 Pet 实例
- **不覆盖**：Pixi 内部动画帧、视觉回归

## 风险与回退

- **Pixi 体积**：增加约 300KB。可接受，一次性成本
- **pidusage 性能**：对每个 pid 调用是同步 spawn-ish，pid 数量 <20 时可忽略
- **雕像 Map 内存**：每个 session 只是元数据对象，5 分钟内最多累积几十个，可忽略
- **回退路径**：宠物视图 Pixi 失败 → 降级 div；整个特性通过视图切换入口，不影响列表视图稳定性

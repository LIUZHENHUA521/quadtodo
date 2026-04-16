# Todo 卡片 Git 面板(阶段 1)— 设计规格

**日期**: 2026-04-16
**范围**: quadtodo 每个 todo 卡片上展示 `workDir` 对应仓库的 git 状态,并内嵌 git diff 查看器。
**非范围(留给后续阶段)**: 分支创建 / checkout / stash、commit message 生成、PR 创建、提交记录反向关联、`git fetch`。

---

## 1. 决策摘要

| 维度 | 决定 |
|------|------|
| 阶段 | 只做"只读展示 + diff 查看";不做任何写操作 |
| 拉取时机 | 应用打开时批量拉一次 + AI 会话结束后自动重拉该 workDir + 手动刷新 |
| ahead/behind 数据源 | 纯本地 `git rev-list`,**不** 自动 `git fetch` |
| UI 位置 | 卡片内嵌,与"AI 终端"、"历史会话"并列第 3 个可折叠区块;不用抽屉 |
| Diff 渲染 | `diff2html` 库,直接渲染 `git diff HEAD` 输出 |
| 缓存 | 服务端进程内 Map,无 TTL,靠显式 invalidate |
| 前端状态 | zustand store,多 todo 共享同一 workDir 条目 |

---

## 2. 数据流

```
[App mount] ─── Promise.all(GET /api/git/status?workDir=X) for each unique workDir
                        │
                        ▼
              服务端 Map<workDir, {status, timestamp, inflight}>
                        │
     [AI session done] ─┤ (后端调 invalidate(workDir);前端 onDone 回调里 refresh)
                        │
     [用户点刷新按钮] ──┤ POST /api/git/refresh
                        │
                        ▼
              前端 zustand `gitStatusStore`
                        │
           ┌────────────┴────────────┐
           ▼                         ▼
  <TodoGitBadge>               <TodoGitDiffPanel>
  (卡片一行,常亮)             (可折叠面板,按需展开)
                                    │
                                    ▼ 展开时
                             GET /api/git/diff
                                    │
                                    ▼
                            diff2html 渲染
```

---

## 3. 后端

### 3.1 Git 读取库 — `src/git/gitStatus.js`

提供两个异步函数,均**不抛异常**,所有失败通过返回对象上的 `state` 字段表达。

```js
// 状态读取
async function readGitStatus(workDir): GitStatus
async function readGitDiff(workDir, { maxBytes = 200 * 1024 } = {}): GitDiff
```

`GitStatus` 联合类型:

| state | 附带字段 | 说明 |
|-------|---------|------|
| `'ok'` | `branch, dirty, ahead, behind, hasUpstream` | 正常 |
| `'not_found'` | - | workDir 不存在或非目录 |
| `'not_a_repo'` | - | workDir 存在但不在 git 工作树内 |
| `'git_missing'` | - | `git` 二进制不在 PATH(spawn ENOENT) |
| `'timeout'` | - | 某一步 git 调用超过 5s |
| `'error'` | `message` | 其他 git 错误,message 为截断后的 stderr |

`GitDiff`:

```ts
{ state: 'ok', diff: string, untracked: string[], truncated: boolean }
| { state: 'not_found' | 'not_a_repo' | 'git_missing' | 'timeout' | 'error', message? }
```

### 实现要点

- 用 `child_process.spawn('git', args, { cwd: workDir })`,Promise 封装;每次调用 5s 超时(`setTimeout` + `proc.kill('SIGTERM')`,超时返回 `{ state: 'timeout' }`)
- 顺序调用(命令都很快,串行代码更简单):
  1. `fs.existsSync(workDir) && fs.statSync(workDir).isDirectory()` — 否则 `not_found`
  2. `git rev-parse --is-inside-work-tree` — 非零或输出非 `true` → `not_a_repo`
  3. `git rev-parse --abbrev-ref HEAD` → `branch`(detached 时为字面量 `HEAD`,同时取 `git rev-parse --short HEAD` 拼 tooltip)
  4. `git status --porcelain` → 按非空行数得 `dirty`
  5. `git rev-list --count --left-right @{upstream}...HEAD`:
     - 成功 → 解析两数字为 `{ behind, ahead }`(git 左右顺序是 upstream/HEAD),`hasUpstream = true`
     - stderr 含 `no upstream` → `hasUpstream = false, ahead/behind 留空`
- Diff:
  - `git diff HEAD`,边读边累加 bytes,超 `maxBytes` 就 kill 进程,`truncated = true`,保留已读部分
  - `git ls-files --others --exclude-standard` → `untracked` 字符串数组
- `spawn` 触发 `error` 事件且 `err.code === 'ENOENT'` → `git_missing`

### 3.2 路由 — `src/routes/git.js`

工厂函数 `createGitRouter()` 返回 `{ router, invalidate }`。

**端点**:

| 方法 | 路径 | 参数 | 返回 |
|------|------|------|------|
| `GET` | `/api/git/status` | query `workDir`(绝对路径,必填) | `{ ok: true, status: GitStatus, timestamp: number }` |
| `POST` | `/api/git/refresh` | body `{ workDir }` | `{ ok: true, status: GitStatus, timestamp: number }` |
| `GET` | `/api/git/diff` | query `workDir` | `{ ok: true, diff: GitDiff }` |

`GitStatus` 和 `GitDiff` 见 § 3.1;前端根据里面的 `state` 字段分支渲染。`ok: false` 仅在请求参数层面(缺 workDir、相对路径)出现,携带 `error: 'bad_request'`;git 层面的错误都用 `ok: true` + `state` 语义字段表达,让前端渲染路径统一。

- `workDir` 必须以 `/` 开头(绝对路径),否则 400 `bad_request`
- `GET /api/git/status` 命中缓存直接返回;无缓存则同步算并写入缓存
- 相同 workDir 的并发 status 请求通过 `inflight` Promise 去重
- `POST /api/git/refresh` 强制重算并覆盖缓存
- `/api/git/diff` 不进缓存,每次实时算

**缓存**:

```js
const cache = new Map<string /* resolved absolute workDir */, {
  status: GitStatus,
  timestamp: number,
  inflight: Promise<GitStatus> | null,
}>()
```

- key 用 `path.resolve(workDir)` 规范化
- 无 TTL;进程重启清空
- `invalidate(workDir)` 删 key

### 3.3 AI 会话结束回调

在 `createServer.js` 中把 git 路由的 `invalidate` 注入到 `createAiTerminal`:

```js
const gitRouter = createGitRouter()
const ait = createAiTerminal({
  db, pty, logDir,
  onSessionDone: (session) => {
    if (session?.cwd) gitRouter.invalidate(session.cwd)
  },
  ...
})
app.use('/api/git', gitRouter.router)
```

`ai-terminal.js` 在 pty `done` 事件里(以及 WebSocket `done` 消息发送附近)调用这个可选回调。保持松耦合,不在 ai-terminal 里直接 import git。

---

## 4. 前端

### 4.1 zustand store — `web/src/store/gitStatusStore.ts`

```ts
type GitEntry =
  | { state: 'loading' }
  | { state: 'ok', branch, dirty, ahead, behind, hasUpstream, headShort?, timestamp }
  | { state: 'not_found' | 'not_a_repo' | 'git_missing' | 'timeout' | 'error', timestamp, message? }

interface GitStatusStore {
  byWorkDir: Record<string, GitEntry>
  fetch(workDir: string): Promise<void>        // 条目已存在(任意非 undefined 状态)则跳过;要强刷用 refresh()
  refresh(workDir: string): Promise<void>      // 强制:写入 loading → 调 POST /refresh → 写入返回
  fetchMany(workDirs: string[]): Promise<void> // 并发调 fetch,内部去重同 workDir
}
```

- 多 todo 共享 workDir → 共享一份条目,一次请求更新所有订阅的组件
- `fetch` 是幂等的(已有条目直接 resolve)

### 4.2 `<TodoGitBadge workDir />`

**文件**: `web/src/todo/TodoGitBadge.tsx`

卡片上一行紧凑展示:

| state | 渲染 |
|-------|------|
| `loading` | 骨架 `...` |
| `ok`,dirty=0,ahead=0,behind=0 | `⎇ main`(最简洁) |
| `ok`,有 dirty/ahead/behind | `⎇ main · ●3 · ↑2 ↓0`(仅显示非零段) |
| `ok`,detached | `⎇ HEAD (a1b2c3d)` |
| `not_found` | 红 `⚠ 目录不存在` |
| `not_a_repo` | 整个组件返回 null(不渲染) |
| `git_missing` | 灰 `git 未安装` + tooltip |
| `timeout` / `error` | 灰 `? 状态获取失败` + tooltip(error 显示 message) |

- 右侧小刷新图标按钮,点击调 `refresh()`
- 挂载时调 `fetch(workDir)`(幂等)
- 点击整行(非按钮区)展开 Git Diff 面板

### 4.3 `<TodoGitDiffPanel todo visible onClose />`

**文件**: `web/src/todo/TodoGitDiffPanel.tsx`

内嵌折叠面板,复用现有 `todo-terminal-panel` 的 CSS 结构(collapse-bar + body),加专属类名 `todo-git-panel`。

**结构**:

```
┌ collapse-bar ─────────────────────────────────────┐
│ Git Diff · main · ●3 · ↑2       [刷新] [✕]        │
├───────────────────────────────────────────────────┤
│ Untracked (2): newfile.ts, docs/draft.md         │  (仅有 untracked 时显示)
├───────────────────────────────────────────────────┤
│ [diff2html 渲染区]                                │
└───────────────────────────────────────────────────┘
```

- 展开时(visible 且 state=ok 且 workDir 是 git 仓库):`GET /api/git/diff?workDir=...`
- 若 status 显示 `dirty=0 && untracked=[]` 且没在 loading → 主体显示占位"工作区干净",不发 diff 请求
- 返回 `truncated: true` → 顶部黄条 "diff 已截断(> 200KB)"
- 渲染:`Diff2Html.html(diffText, { drawFileList: true, outputFormat: 'line-by-line' })`,`dangerouslySetInnerHTML`;父容器 `overflow: auto; max-height: 60vh`
- 刷新按钮同步刷新 status 和 diff
- `state === 'not_a_repo'` → 显示"此目录不是 git 仓库"

### 4.4 `TodoManage.tsx` 集成

五处改动:

1. 顶部挂载效果:拿到 todos 后 `gitStatusStore.fetchMany(uniq workDirs with workDir!=null)`
2. 工具栏:加 `[Git Diff▾]` 按钮(仅 `workDir && state!=='not_a_repo'` 时显示,控制 `<TodoGitDiffPanel>` 的 visible)
3. 历史会话/工具栏附近:插入 `<TodoGitBadge workDir={todo.workDir} />`
4. 内嵌区:AI 终端面板之后插 `<TodoGitDiffPanel>`
5. `SessionViewer.onDone` 回调里追加 `gitStatusStore.refresh(todo.workDir)`(若存在)

### 4.5 diff2html 集成

- `web/package.json` 加 `"diff2html": "^3.x"` (最新稳定版本,npm install 时锁定)
- 引入:
  ```ts
  import * as Diff2Html from 'diff2html'
  import 'diff2html/bundles/css/diff2html.min.css'
  ```
- diff2html 会 HTML escape 文件内容,XSS 面不大,但仍然不给它接收用户输入的分支名/自定义文本,只喂 `git diff` 原始输出。

---

## 5. 错误处理表

| 场景 | 后端返回 | 前端展示 |
|------|---------|---------|
| `workDir` 为 null/空 | 组件侧跳过,不请求 | Badge 不渲染、Diff 按钮不显示 |
| `workDir` 相对路径 | 400 `bad_request` | 同上(前端也校验一次,防止绕过) |
| workDir 不存在 | `state: 'not_found'` | 红 `⚠ 目录不存在` |
| 非 git 仓库 | `state: 'not_a_repo'` | Badge 不渲染;Diff 按钮不显示 |
| `git` 缺失 | `state: 'git_missing'` | 灰 `git 未安装` |
| 5s 超时 | `state: 'timeout'` | 灰 `超时,点刷新重试` |
| 无上游 | `hasUpstream: false` | 不显示 ↑↓ |
| detached HEAD | `branch='HEAD'` + `headShort='a1b2c3d'` | `⎇ HEAD (a1b2c3d)` |
| diff > 200KB | `truncated: true` | 黄条 "diff 已截断" |
| diff API 500 | express 抛 500 | Antd `message.error` |
| 并发同 workDir | `inflight` 去重 | 自动合并 |

---

## 6. 测试

### 6.1 后端单测 — `test/git-status.test.js`(vitest)

以临时 tmpdir + 真实 `git init` 做黑盒:

- 非目录 → `not_found`
- 空目录(未 `git init`) → `not_a_repo`
- 新仓库无提交 → `branch` 为 `main` 或 `master`(取决于 git 默认),`dirty=0`,`hasUpstream=false`
- `touch a.txt` → `dirty=1`
- 建 upstream 并做两个提交 → `ahead=2`
- 造大文件(> 200KB)并 diff → `truncated: true`
- PATH 去掉 git → `git_missing`(通过 `{ env: { PATH: '' } }` 传入,而不是改 process.env)

为支持环境变量透传,`readGitStatus` 允许第二参数 `{ env }` 覆盖 spawn 时的 env。

### 6.2 路由测 — `test/git.route.test.js`(supertest)

- `GET /api/git/status` 命中缓存不重算(spy)
- `POST /api/git/refresh` 必然重算
- `workDir` 为相对路径返回 400
- `GET /api/git/diff` 正常返回

### 6.3 AI 会话 invalidate 集成 — `test/ai-terminal.route.test.js`(扩展)

在已有 AI 终端测试里加一个 case:session done 时,`onSessionDone` 被调用且携带正确的 `cwd`。

### 6.4 前端

**不写单测**(同 terminal-theme 设计,zustand 薄、diff2html 纯第三方渲染):

- 手动验证:打开带 workDir 的 todo → Badge 出现 → 点 Git Diff 展开 → 修改文件后刷新 → diff 实时更新
- 手动验证:非 git 目录 todo → Badge 不显示 → Git Diff 按钮不显示
- 手动验证:AI 会话跑完写了文件 → session done 后 Badge 自动更新

---

## 7. 文件清单

### 新建

- `src/git/gitStatus.js`
- `src/routes/git.js`
- `test/git-status.test.js`
- `test/git.route.test.js`
- `web/src/store/gitStatusStore.ts`
- `web/src/todo/TodoGitBadge.tsx`
- `web/src/todo/TodoGitDiffPanel.tsx`

### 修改

- `src/server.js` — 挂载 `/api/git`;把 `invalidate` 通过 `onSessionDone` 注入 ai-terminal
- `src/routes/ai-terminal.js` — 接受可选 `onSessionDone` 回调,在 pty `done` 事件里调
- `test/ai-terminal.route.test.js` — 追加 onSessionDone 集成断言
- `web/src/TodoManage.tsx` — 见 § 4.4
- `web/src/SessionViewer.tsx`(可能) — 确保 `onDone` 能带出 workDir(或沿用 TodoManage 里已有的 todo 引用,不改此文件)
- `web/package.json` — 加 `diff2html` 依赖

### 不动

- `client/` / `server/` / `tasks/` / `wechatGame/` 四个兄弟子项目完全无改动
- 游戏核心云函数无改动
- `todos` 表 schema 不加字段(`work_dir` 已存在)
- 无 DB migration

---

## 8. 非目标 (YAGNI)

不做:

- 分支创建、checkout、stash、commit
- commit message 生成(LLM)
- PR 创建(`gh` CLI)
- 提交记录反向关联 todo
- `git fetch`(自动或手动)
- 文件级 stage/unstage
- 历史 commit 列表
- worktree / submodule 特殊处理(当作普通仓库即可)
- 多仓库嵌套(monorepo 的子包作为独立 workDir,天然按 workDir 隔离)

这些是 phase 2 / phase 3 的范围,当前 phase 刻意保持"只读 + 展示",验证 UX 和数据路径。

---

## 9. 后续阶段预留

本设计为后续阶段留的接口:

- `src/git/gitStatus.js` 只做只读,但内部实现会把 `spawn('git', args, { cwd })` 封装成复用函数,phase 2 做写操作(checkout/stash)可直接复用
- `src/routes/git.js` 已有 `invalidate(workDir)` 接口,phase 2 写操作后调用它即可
- 前端 store 的条目结构已区分 state,phase 2 新增字段(`expectedBranch`、`lastCommitAt` 等)直接往 ok 分支加即可
- AI 会话 → git 的耦合点(`onSessionDone`)已抽成回调,phase 2 如要在 session 开始前 checkout 分支,在 ai-terminal 里加对应钩子即可

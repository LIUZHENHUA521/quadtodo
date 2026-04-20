# Auto Wiki Memory — 设计文档

> 日期：2026-04-20
> 状态：Design / Pending review
> 作者：lzh（与 Claude brainstorm 产出）
> 灵感来源：Karpathy《LLM Wiki》（https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f）
> 对应 todo：README 中「五、数据与知识沉淀 → 17. 可复用经验抽取」

## 一、目标 & 非目标

### 目标
让 LLM 自动把 **已完成的 todo + 关联 AI 会话** 增量沉淀成一份本地 markdown wiki，供人翻浏。随 todo 数量增长，wiki 里自然形成跨 todo 的主题页（踩过的坑、复用的套路、项目结构摘要），降低"过段时间回头看忘了当时在干啥"的成本。

### 非目标（v1 明确不做）
- 不做 RAG / embedding / 向量检索
- 不把 wiki 内容自动注入新 todo 的 prompt
- 不做多机同步 / 自动 push（wiki 自己是 git 仓库，你手动 push 到 private repo 即可）
- 不做"人工确认 plan 再执行"的 human-in-loop 流程（加了就不是自动化了）
- 不做 wiki 内跨机搜索（浏览器 Ctrl+F 够用；后续真有需要再接 FTS）

## 二、核心架构

Karpathy 原文的关键观察：LLM 不是"查一次就走"，而是**增量维护一份 markdown 知识库**。新素材来了 → LLM 读现有页面 → 决定哪些页改、哪些页新建、更新 index 与 log。quadtodo 已经有：

- `~/.claude` / `~/.codex` 的 jsonl 会话扫描 + 与 todo 绑定（`src/transcripts/`）
- `src/summarize.js` 会话摘要（spawn claude/codex CLI）
- 跨项目的 SQLite（`~/.quadtodo/data.db`）

本方案复用上述能力，新增一块「wiki 引擎」，本质是：
**收集新 done todo 的素材 → 写入 `sources/` → spawn `claude` 以 wiki 目录为 cwd 批量更新 markdown → git commit。**

## 三、存储布局

```
~/.quadtodo/wiki/
├── .git/                             # 首次启动时 `git init`
├── WIKI_GUIDE.md                     # 给 LLM 看的维护规则（只读，程序首次写入）
├── index.md                          # 顶级导航（LLM 维护）
├── log.md                            # append-only 运行日志（LLM 追加一段 / 程序追加一行）
├── topics/*.md                       # 主题/概念页（LLM 自建、自维护）
├── projects/*.md                     # 项目专属页（LLM 自建、按 workDir 聚合）
└── sources/
    └── YYYY-MM-DD-<todoId-short>.md  # 程序写的原始素材归档；LLM 只读不改
```

**设计理由**：
- `sources/` 是"事实"、其他目录是"抽象"。明确告诉 LLM 只改抽象层、不改事实层，避免 LLM 把原始输入改飞。
- wiki 目录自己是 git 仓库，误改可回滚，演化历史可查。
- 所有 markdown，可读性最好；人可以手动编辑（下次 LLM 跑之前会感知到，纳入新的 state）。

## 四、触发

**只有手动，没有定时。** 沉淀是"我现在想整理一下"的动作，不是后台任务。不自动跑还有一个好处：永远不会在你不知情的情况下烧 token。

三个入口：

1. **todo 详情抽屉 → 「沉淀到记忆」按钮**
   - 单条 todo 立刻走一次流程（生成 source → 调 claude → commit）
   - 这条 todo 不必是 `done`；任何状态都能沉淀（但按钮在 `done` 状态更显眼）
   - 如果这条已经被沉淀过：按钮变成「重新沉淀」，点击前弹确认

2. **顶栏 🧠 记忆 → Wiki 抽屉 → 「批量沉淀」按钮**
   - 打开后默认展示「未沉淀的 done todo」列表，每条带 checkbox
   - 我勾选一批 → 点「沉淀选中」→ 合并成一个 wiki_run
   - 也能选已沉淀过的重跑

3. **Wiki 抽屉 → 「只生成 sources（预览）」**
   - 可选的 dry-run 按钮；不默认不强制
   - 用途：我不确定要不要烧 token，先看 sources 组装出来的素材有没有料

### init 时机
`quadtodo start` 时检查 `wikiDir`：
- 不存在 → 创建目录 + 写 `WIKI_GUIDE.md` + 空 `index.md` / `log.md` + `git init`
- 存在且已经是 git 仓库 → 什么都不做
- 存在但非 git 仓库 → **不自动 init**，前端 wiki 抽屉顶部挂红色横幅：「检测到 ~/.quadtodo/wiki 已存在但非 git 仓库，为避免覆盖你的数据拒绝自动初始化。请手动处理（mv 走或进去 git init）」

init 不触发任何 LLM 调用，无费用。

## 五、批处理执行流程（一次）

入参：`{ todoIds: string[], dryRun?: boolean }`。`todoIds` 由前端明确传入（哪怕是单条"沉淀到记忆"按钮也传一个 id 的数组）——后端不做"默认处理所有未沉淀 done todo"的隐式行为，避免误触。

```
1. 校验 todoIds 非空；每个 id 能在 DB 查到；否则 400
2. 对每条 todo：
   a. loadTranscript 每个关联 ai_session（走现有 src/transcript.js）
   b. 每个会话取最后 maxTailTurns 轮原始对话
   c. 调 summarizeTurns 生成一条总摘要（如果会话没缓存摘要）
   d. 读 comments
   e. 组装成 sources/YYYY-MM-DD-<todoIdShort>.md（统一模板）
      ├─ 脱敏：匹配常见 key 格式（见下 §九）替换成 [REDACTED]
3. 在 wiki_runs 表插入一行：started_at, todo_count, dry_run, status='running'
4. 若 dryRun：跳到 步骤 8（只落 sources，不调 LLM、不 commit）
5. spawn claude：
   - 命令从 config.tools.claude.bin || config.tools.claude.command 解析
   - cwd = ~/.quadtodo/wiki
   - 方式：claude -p --output-format text < 读 WIKI_GUIDE.md + 本批次新 sources 的文件名列表
   - 超时：默认 10 min，可配
6. 等 claude 退出，捕获 stdout/stderr
7. 在 wiki 目录：git add -A && git commit -m "wiki: YYYY-MM-DD-HH ({n} todos)"
   - 若无变更（LLM 啥也没改）则跳过 commit
8. 写 wiki_todo_coverage：记录这次覆盖了哪些 todoId + 对应 source_path
9. 更新 wiki_runs：completed_at, exit_code, note
10. 追加一行到 log.md（程序加，独立于 LLM 加的段落）
11. 前端收 SSE/WS 推送"批处理完成"事件

dry-run 下仍会写 `wiki_todo_coverage`——方便前端展示"当前已经生成 sources 但未正式沉淀的 todo 有哪些"。但确认后"正式运行"时，这批 todo 不算"已覆盖"，需要重新跑 LLM。因此 `wiki_todo_coverage` 额外有一列 `llm_applied INTEGER NOT NULL DEFAULT 0`（dry-run=0，正式跑完=1），"未沉淀 done todo"的判断条件是 `todo.status='done' AND NOT EXISTS (coverage with llm_applied=1)`。
```

## 六、WIKI_GUIDE.md 内容（程序首次写入，用户可后续手工改）

```markdown
# Wiki 维护指南（LLM 读这个）

## 你的职责
每次被调用时，`sources/` 下会有一批新的 todo 素材文件。你的任务是：读完新 sources，把其中可沉淀的知识融入 `topics/` / `projects/` / `index.md`，让 wiki 保持有条理、可检索。

## 硬规则
- `sources/*.md` 是输入，**永远不要修改它们**
- 页面命名：kebab-case，例如 `topics/cloudbase-cloud-function-deploy.md`
- 页面间用相对 markdown 链接互相引用（例如 `[CloudBase 部署](../topics/cloudbase-cloud-function-deploy.md)`）
- 每个页面专注一个主题，不要让单页膨胀到难读

## 决策流程
对每个新 source，问自己：
1. 这条 todo 揭示了什么**可复用**的知识？（踩过的坑、通用模式、项目结构摘要、外部工具配置）
2. 对应 topic 页是否已经存在？
   - 存在 → 在合适的段落追加；合并类似条目
   - 不存在 → 新建 topic 页
3. 这条 todo 有 workDir（项目路径）吗？
   - 有 → 同时更新 `projects/<projectName>.md`：项目概述、该项目沉淀过的主要知识点列表（带链接指向 topic）
4. 如果这条 todo 只是琐碎任务（比如"写邮件"、"买东西"），可以跳过，不强行产出内容

## 更新 index.md
`index.md` 是顶级目录。每次都确保：
- 列出 topics/ 下所有页面（按主题分类）
- 列出 projects/ 下所有页面
- 最近 7 天的变更可以用一个 "Recent" 段落点出

## 追加 log.md
最后一步：往 log.md 追加一个 `## YYYY-MM-DD HH:MM` 段落，写清楚你这次改了/新增了哪些页，每条一句话。

## 语言
中文优先，代码/命令/路径保留原文。
```

## 七、前端

新增组件 `web/src/WikiDrawer.tsx`（参考 `StatsDrawer.tsx` 的抽屉模式）：

- **左侧树**：文件树，按目录分组（`topics/` / `projects/` / `sources/` / 顶层）
- **右侧阅读区**：选中文件后渲染 markdown
  - 如果项目已有 markdown 渲染能力（检查 `TranscriptView.tsx`），复用；否则加 `react-markdown` + `remark-gfm`
  - markdown 中相对链接能点击跳转到树里对应文件
- **顶部工具条**：
  - 上次批处理时间 / 状态徽标（绿=成功 / 红=失败 / 灰=从未跑过）
  - 「打开目录」按钮 → `window.open('file://' + wikiDir)`（macOS 能打开 Finder）
- **未沉淀列表区**（抽屉顶部下方）：
  - 展示"已 done 但未沉淀"的 todo，每条一行，带 checkbox + title + workDir + 完成时间
  - 按钮：「沉淀选中」→ 传 todoIds 调 `POST /api/wiki/run`
  - 次要按钮：「只生成 sources（预览）」→ 同接口，带 `dryRun: true`
  - 次要按钮：「全选」/「清空选择」
- **v1 不做**：wiki 内搜索、编辑页面、定时任务开关（先用 Ctrl+F 顶住）

todo 详情抽屉增量：
- 每条 todo 详情底部加一行「沉淀到记忆」按钮
  - 未沉淀：显示「沉淀到记忆」
  - 已沉淀：显示「已沉淀 · 重新沉淀」（点击前弹确认）
  - 点击都走 `POST /api/wiki/run { todoIds: [thisId] }`

## 八、后端

### 新文件
```
src/wiki/
├── index.js         # createWikiService：导出 runOnce(opts) / status() / init()
├── sources.js       # 把 todo + transcripts → source markdown 的字符串
├── redact.js        # 简单正则脱敏
└── guide.js         # WIKI_GUIDE.md 的字符串常量（init 时写入）

src/routes/wiki.js   # express 路由
```
（不需要 `scheduler.js`——没有定时任务）

### API
| Method | Path | Body / Query | 说明 |
|---|---|---|---|
| GET | `/api/wiki/status` | — | 返回 `{ lastRun, wikiDir, initState, pendingTodoIds }`；`initState` ∈ `"ready" / "missing" / "exists-not-git"` |
| GET | `/api/wiki/pending` | — | 未沉淀 done todo 的详细列表（id/title/workDir/completedAt） |
| GET | `/api/wiki/tree` | — | wiki 目录的文件树 |
| GET | `/api/wiki/file` | `?path=topics/foo.md` | 单文件内容；严格校验 path 不越出 wikiDir |
| POST | `/api/wiki/run` | `{ todoIds: string[], dryRun?: bool }` | 触发一次批处理；`todoIds` 必传非空 |
| POST | `/api/wiki/init` | — | 手动初始化 wiki（start 阶段自动尝试；非 git 情况需要手动调） |
| GET | `/api/wiki/runs` | `?limit=20` | 批处理历史 |

所有 `path` 参数用 `path.resolve(wikiDir, p)` + `startsWith(wikiDir)` 防目录穿越。

### DB 新表
```sql
CREATE TABLE wiki_runs (
  id            INTEGER PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  todo_count    INTEGER NOT NULL DEFAULT 0,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  exit_code     INTEGER,
  error         TEXT,
  note          TEXT
);

CREATE TABLE wiki_todo_coverage (
  wiki_run_id   INTEGER NOT NULL,
  todo_id       TEXT NOT NULL,
  source_path   TEXT,
  llm_applied   INTEGER NOT NULL DEFAULT 0,  -- 0: dry-run only, 1: LLM 正式跑过
  PRIMARY KEY (wiki_run_id, todo_id)
);
```

`wiki_todo_coverage` 保证幂等：同一条 todo 被处理过的记录可以查；也能支持"找出未沉淀的 done todo"（`done_todos - covered_todos`）。

### 配置（`~/.quadtodo/config.json` 新段）
```json
"wiki": {
  "wikiDir": "~/.quadtodo/wiki",
  "maxTailTurns": 20,
  "tool": "claude",
  "timeoutMs": 600000,
  "redact": true
}
```
没有 `enabled` / `autoRunCron` / `dryRunOnFirstRun`——全部是手动触发，不需要总开关。不想用就别点「沉淀到记忆」按钮。

## 九、脱敏规则（`src/wiki/redact.js`）

默认匹配并替换成 `[REDACTED]`：
- `sk-[a-zA-Z0-9]{20,}` — OpenAI / Anthropic key
- `AKIA[0-9A-Z]{16}` — AWS
- `ghp_[a-zA-Z0-9]{30,}` / `gho_...` / `ghs_...` — GitHub token
- `AIza[0-9A-Za-z_-]{30,}` — Google
- `xoxb-...` / `xoxp-...` — Slack
- 通用：`(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"',}]{6,}` → 把值替换成 `[REDACTED]`
- `.env` 风格：行首 `[A-Z_]+(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*=\s*.+` → 保留键、值换成 `[REDACTED]`

用户可以在 `config.wiki.redact = false` 时完全关掉。

## 十、Source markdown 模板（`src/wiki/sources.js` 输出）

```markdown
---
todoId: {id}
title: {title}
quadrant: {1-4}
workDir: {path or "-"}
createdAt: 2026-04-18T...
completedAt: 2026-04-20T...
durationHours: 3.2
---

# {title}

## 描述
{description}

## 评论（{n}）
- [2026-04-19 10:12] {comment}
- [2026-04-19 11:00] {comment}

## AI 会话
### Session 1 — claude （42 轮，完成时间 2026-04-20 09:41）
**摘要**：{summarizeTurns 产出}

**最后 {N} 轮原文**：
【用户】...
【AI】...
【用户】...
（脱敏已应用）

### Session 2 — codex ...
...
```

**长度上限**：单条 source 超过 X KB（默认 128 KB）时截断 transcript 尾部，保留摘要。

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM token 成本不可控 | 全手动触发，不点就不跑；提供"只生成 sources（预览）"入口让你先看素材再决定 |
| claude CLI 未安装 / 网络故障 | 捕获 spawn 错误，wiki_runs 记失败；sources 已生成可下次用（llm_applied=0） |
| LLM 把 wiki 改乱 | git 自动 commit；人可 `cd ~/.quadtodo/wiki && git reset --hard HEAD~1` 回滚 |
| 路径穿越（前端请求任意文件） | `GET /api/wiki/file` 用 resolve + startsWith 校验 |
| transcript 含密钥泄漏到 wiki | §九 的脱敏正则；可关闭（明确知情） |
| 并发触发（连点两次按钮） | `runOnce` 内部加互斥锁；第二次调用直接返回 "already running" |
| wiki 目录已存在但非 git | init 时检测到就拒绝，前端横幅提示用户手动处理 |

## 十二、验收标准

- [ ] 全新环境 `quadtodo start` → `~/.quadtodo/wiki/` 自动创建，含 `WIKI_GUIDE.md`（内容非空）、空 `index.md`、已 `git init`
- [ ] 不点任何按钮，LLM 永远不会被调用（验证"纯手动"）
- [ ] 配置里 `tools.claude.bin = /usr/local/bin/claude-w` 时，wiki 批处理走这个命令（不是硬编码 `claude`）
- [ ] 把一条挂有 AI 会话的 todo 改成 done → 详情抽屉能看到「沉淀到记忆」按钮 → 点击后 claude 跑完 → wiki 里有新/更新页面
- [ ] 打开 wiki 抽屉 → 看到"未沉淀 done todo"列表 → 全选 → 点「沉淀选中」走一次批处理 → 成功
- [ ] 批处理 5 条相关 todo（比如都是"云函数部署"类），产出的 `topics/` 不应是 5 个分开文件，应合并到 1 个主题页（验证 LLM 在做"抽象"而不是"翻译"）
- [ ] 每次成功批处理后，`~/.quadtodo/wiki/` 里 `git log` 多一条 commit
- [ ] 「只生成 sources（预览）」按钮能用，生成后 todo 仍然显示在"未沉淀"列表里（因为 llm_applied=0）
- [ ] 已沉淀过的 todo 再次点击「重新沉淀」会有确认弹窗
- [ ] 批处理失败时，前端 wiki 抽屉顶部红色横幅显示错误摘要；重试能成功
- [ ] `sources/` 里的 markdown 不含明文 API key（脱敏生效）
- [ ] 并发触发（两次快速点「沉淀选中」）第二次得到 "already running" 响应，不重复 spawn
- [ ] `~/.quadtodo/wiki/` 已存在但非 git 仓库时，启动不自动覆盖，前端横幅提示
- [ ] 杀掉 quadtodo 进程中途断电（模拟 kill -9 在 claude 运行期间）→ 下次启动能检测到孤儿 run（`wiki_runs.completed_at IS NULL`）并标记为 failed

## 十三、开发阶段（简略，详细拆分留给 writing-plans）

按依赖顺序：

1. `src/wiki/redact.js` + 单测
2. `src/wiki/sources.js` + 单测（给假 todo/transcript 固定输入，断言输出）
3. `src/wiki/guide.js`（常量）
4. DB schema 迁移（`wiki_runs` / `wiki_todo_coverage`）
5. `src/wiki/index.js`：init / runOnce（支持 dryRun）/ status / pending + 单测
6. `src/routes/wiki.js` + 路由集成到 `server.js`
7. 启动流程里挂 init（失败不影响主进程）
8. 前端 `WikiDrawer.tsx` + markdown 渲染 + 未沉淀列表
9. todo 详情「沉淀到记忆」按钮
10. 端到端联调（需要真实的 claude 命令可用）

## 十四、开放问题（实现时需要再决定）

- `WikiDrawer.tsx` 里 markdown 是用已有库还是新装 `react-markdown`？—— 启动实现第一步先 `grep` 检查。
- 前端怎么实时收到"批处理进度"？v1 可用轮询 `/api/wiki/status`（1-2s 间隔）顶过去；后期如果其他地方已经有 WS 可以改推送。
- 初始 `maxTailTurns=20` 是拍脑袋选的，跑起来看看实际效果再调。

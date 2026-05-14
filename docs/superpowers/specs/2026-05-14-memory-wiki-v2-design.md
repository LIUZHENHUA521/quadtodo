# Memory Wiki v2 — 设计文档

> 日期：2026-05-14
> 状态：Design / Pending review
> 作者：lzh（与 Claude brainstorm 产出）
> 灵感来源：
> - 老 spec：[2026-04-20 auto-wiki-memory](./2026-04-20-auto-wiki-memory-design.md)
> - [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)（Tauri/Rust 桌面 app）
> 触发：用户反馈"记忆 Wiki 用不上"

## 一、问题诊断

老版本（v1）实际上是一个**被动归档工具**，不是辅助用户工作的"记忆"。证据来自用户的实际数据：

- 04-23 跑过 1 次正式 batch，3 个 sources 写入 `~/.agentquad/wiki/sources/`，claude 退出码 0 ✅
- **但 `topics/` 和 `projects/` 完全为空，`index.md` 仍是占位符** ❌
- 也就是说"沉淀知识"这一步 claude 实际跑成功了，但因为 WIKI_GUIDE.md 第 4 条规则给了"如果琐碎可以跳过"的宽松退出条件，对 3 条素材判定为可跳过，**真的一页 topic 都没产出**

更深层的体验问题：

1. **入口门槛太高**：291 条已完成 todo 摆在那等用户勾选，像永远清不完的收件箱
2. **回报不可见**：哪怕沉淀成功，内容藏在 1100px 宽的 Drawer 里，平时不会主动打开
3. **没有正反馈循环**：新建/打开 todo 时不会自动提示"你以前做过类似的事，看记忆里的 X"
4. **手动批处理**：选 → 等 claude → 看结果，整个流程像运维任务，不是自然产物

**结论**：v1 的核心问题不是"功能少"，而是"价值闭环没跑通"——产出质量不稳定、产出没回到工作流中。本 spec 要解决的就是这两件事。

## 二、目标 & 非目标

### 目标
1. **产出稳定**：跑一次必有像样产出（实体页 / 概念页 / chores 兜底），不再出现"跑完一页 topic 都没生成"
2. **价值找上门**：新建/打开 todo 时，自动召回相关历史经验展示在 todo 详情面板，让用户即便不主动开 Drawer 也能受益
3. **沉淀过程不再是负担**：积压清零策略 + 半自动入队，让用户停止"凝视未沉淀列表"

### 非目标（v2 仍然不做）
- 不做知识图谱可视化（YAGNI；llm_wiki 的 sigma.js 图谱先不抄）
- 不做 Web 剪裁 / 浏览器插件
- 不做 wiki 内全文搜索（Ctrl+F 顶住）
- 不做多机同步（用户手动 push 到 private repo）
- 不做"自动跑 claude"（保留手动触发为 MVP；阶段 2 才考虑后台队列）

## 三、借鉴 nashsu/llm_wiki 的设计精华

不复用代码（技术栈不兼容：他们 Rust/Tauri/LanceDB，我们 Node/Express/sqlite），但复用以下设计：

| llm_wiki 设计 | 我们怎么落地 |
|---|---|
| **purpose.md**（用户可编辑的"研究目标"） | 写一份默认 purpose.md：「这个记忆库是给我开发工作流准备的，关注踩过的坑/可复用模式/项目结构/工具配置；琐碎事务（写邮件、买东西）不需要沉淀」。用户可改 |
| **schema.md**（结构规则） | 写一份默认 schema.md，明确：哪些目录有哪些类型的页（entities / concepts / projects），命名约定（kebab-case），引用约定（相对 markdown 链接） |
| **两阶段链式 prompt**（先抽实体/概念，再生成页面） | 改造 `src/wiki/index.js` 的 prompt：第一阶段调一次 claude 抽"实体（工具/库/服务）+ 概念（模式/坑/经验）+ 关联到的现有页面"输出 JSON；第二阶段再调一次生成页面更新。**直接解决"产出不稳定"** |
| **entities/ + concepts/** 分类 | 新增这两个目录与老的 topics/ 并存。LLM 默认产出到 entities/concepts；老 topics/ 留着不动，由用户后续手动迁移或自然衰减 |
| **chores 兜底** | 增加 `chores.md`：判定为琐碎的 todo 也归一行进去，不直接丢弃。**消除"跑完啥也没有"的失败感** |
| **检索召回链路** | 阶段 1 做关键词召回（标题/描述/page body 的 BM25 或简单分词匹配）；阶段 2 才加向量（sqlite-vec） |
| **图扩展 4 信号公式** | 阶段 2 才接入；MVP 不做 |
| **审查面板** | MVP 不做；阶段 1 只在 Drawer 里加"这次跑产出了哪些页"的清单，让用户能 1 屏看完一次跑的结果 |

## 四、分阶段路线图

```
阶段 0：诊断验证（半天，先做）
  ↓ 如果产出有质量
阶段 1：召回前置 + 修复版 prompt + purpose/schema + entities/concepts（2-3 天，MVP）
  ↓ 如果用户实际用了
阶段 2（可选）：向量召回 + 后台自动消化队列 + 审查面板
```

如果阶段 0 发现 LLM 从 todo 这种短文本里根本提炼不出有用的知识，**立即回退到方向 C**（用户完成 todo 时手写经验卡片），本 spec 作废。这是关键的"先验证再投入"门控。

## 五、阶段 0：诊断验证

### 目标
用 30 分钟到半天，回答："改用两阶段 prompt + 强制产出后，claude 能不能从用户的 todo 里产出像样的 entities/concepts？"

### 做法
1. **临时改 prompt**（不修改主代码，写一个 `scripts/wiki-diagnose.js`）：
   - 复用现有 `src/wiki/sources.js` 生成 source markdown
   - 注入临时 purpose（"这是给我开发工作流准备的记忆库"）和临时 schema（"输出 entities/ 与 concepts/ 两类页面"）
   - 第一阶段 prompt：让 claude 读 sources，输出 JSON `{ entities: [...], concepts: [...], chores: [...] }`
   - 第二阶段 prompt：让 claude 基于 JSON 与现有页面（首次为空）输出 markdown 页面
2. **挑 10 条非琐碎 todo**：从用户 291 条未沉淀里手动挑 10 条（涉及 cloudbase 部署、AI 状态机、消息队列、终端键盘事件等技术类）
3. **跑一次，看产出**：把 entities/concepts 文件交给用户评估"这是我想要的'记忆'吗"

### 退出条件
- ✅ 产出有质量（用户认为至少 5 个页面对未来工作有参考价值）→ 进入阶段 1
- ❌ 产出鸡肋（用户觉得仍是流水账、抽象层级不够）→ 本 spec 作废，回到方向 C 重新设计

### 验收
- 跑通脚本，能在 `~/.agentquad/wiki-diagnose-2026-05-14/` 看到产出
- 用户对每个页面打分（有用 / 凑合 / 没用），并给出"该补/该改"的反馈

## 六、阶段 1：MVP

### 6.1 目录结构变更

```
~/.agentquad/wiki/
├── .git/
├── WIKI_GUIDE.md         # （保留，但内容由 purpose+schema 替代，主要变为引导链接）
├── purpose.md            # 新增：用户可编辑的研究目标
├── schema.md             # 新增：结构规则
├── index.md              # 顶级导航（LLM 维护）
├── log.md                # 运行日志
├── entities/*.md         # 新增：工具/服务/库（"是什么"）
├── concepts/*.md         # 新增：模式/坑/经验（"怎么做/避免什么"）
├── chores.md             # 新增：琐碎事务一行一条
├── topics/*.md           # 保留：v1 老页面不动，自然衰减
├── projects/*.md         # 保留：v1 行为不变
└── sources/*.md          # 保留：v1 行为不变
```

**理由**：选择"折中"方案（C），不强行迁移 v1 产出。entities/concepts 与 topics/projects 短期并存，让用户在使用中自然选择是否手动迁移 topics → entities/concepts。

### 6.2 默认 purpose.md（程序首次写入）

```markdown
# Wiki Purpose

这是我（{username}）的工作记忆库。LLM 沉淀内容时请遵循以下意图：

## 我关心什么
- 踩过的坑 + 解决方案（命令行参数、依赖版本陷阱、API 边界）
- 可复用的模式（项目骨架、配置模板、调试技巧）
- 工具与服务的关键事实（API 文档要点、CLI 常用命令、错误码含义）
- 项目结构摘要（每个 workDir 对应项目是干嘛的、关键目录）

## 我不关心什么
- 日常事务（买东西、写邮件、约会、提醒）→ 这类只在 chores.md 留一行
- 一次性脚本的具体输出（保留在 sources/ 即可，不要复制到 entities/concepts）
- 我个人的隐私信息（密钥、密码、身份信息）

## 语言
中文优先，代码/命令/路径保留原文。
```

### 6.3 默认 schema.md（程序首次写入）

```markdown
# Wiki Schema

## 页面类型
- `entities/<kebab>.md` — "是什么"。一个工具/库/服务/概念一页。例子：`cloudbase-functions.md`、`xterm-js.md`、`anthropic-sdk.md`
- `concepts/<kebab>.md` — "怎么做 / 避免什么"。一个模式或踩坑一页。例子：`websocket-keepalive-pattern.md`、`monorepo-shared-deps-pitfall.md`
- `projects/<kebab>.md` — 一个 workDir 对应一页项目摘要（LLM 自动生成，含该项目沉淀过的页面列表）
- `chores.md` — 琐碎事务的归档，一行一条，不展开

## 页面结构（entities/concepts 必须满足）
```
---
title: <人类可读标题>
type: entity | concept
tags: [tag1, tag2]
sources: [sources/2026-04-23-abc.md, ...]
---

# <title>

## 摘要（1-2 句）

## 关键事实 / 步骤
（条目，不超过 1 屏；超出就拆页）

## 关联
- [[../entities/foo]]
- [[../concepts/bar]]
```

## 强制规则
- LLM 每次跑必须产出至少 1 个新建/更新的 entity 或 concept 页面，**或**在 chores.md 追加一行。不能"什么都不写"
- 单页超过 ~3KB 就要考虑拆页
- 引用其他页用相对 markdown 链接
```

### 6.4 两阶段 Prompt 设计

**第一阶段（抽取，输出 JSON）**：

```
你正在维护用户的工作记忆 wiki。

[purpose.md 全文]
[schema.md 全文]

## 现有 wiki 页面索引
entities/: foo.md, bar.md, ...
concepts/: x.md, y.md, ...
（只列文件名，不读内容）

## 本批新 sources
[sources/2026-05-14-abc.md 全文]
[sources/2026-05-14-def.md 全文]
...

## 任务
对每条 source，判定其内容应该归入哪一类，并输出严格 JSON：
{
  "items": [
    {
      "sourceFile": "sources/2026-05-14-abc.md",
      "decision": "entity" | "concept" | "chore",
      "targetPage": "entities/cloudbase-functions.md" | "concepts/...md" | null,
      "isNew": true | false,
      "summary": "1 句话概括",
      "relatedPages": ["entities/foo.md", ...]
    }
  ]
}

注意：
- 不要遗漏任何 source；每条 source 必须有对应 item
- 如果信息不足以归入 entity/concept，归入 chore
- targetPage 命名遵循 schema.md 中的 kebab-case 规则
```

**第二阶段（生成，输出 markdown 操作）**：

```
[purpose.md 全文]
[schema.md 全文]
[第一阶段输出的 JSON]

读取第一阶段决策中涉及的 targetPage 现有内容（如果存在），然后：

1. 对每个 decision=entity/concept 的 item，生成或更新对应页面（满足 schema 结构）
2. 把所有 chore items 追加到 chores.md（一行格式：`- YYYY-MM-DD [source-todo-title](sources/xxx.md) — 摘要`）
3. 更新 index.md：列出所有 entities/concepts/projects，按字母序
4. 追加 log.md：本次跑了多少条 source，产出了哪些页面

输出方式：用工具调用直接读写文件（cwd 已是 wiki 目录），最后不要在终端打印总结
```

### 6.5 召回 panel（todo 详情侧栏）

**触发**：打开任意 todo 详情时，后端用 todo 的 title + description 对 wiki 做关键词检索（v1 不上向量）。

**检索算法（MVP）**：
1. 把 entities/ 和 concepts/ 下所有 md 文件加载到内存（启动时一次，文件 mtime 变化时重新加载）
2. 对查询字符串和每个页面，分词（中文用 `intl-segmenter` 或简单 unicode 单字 + bigram；英文按空格 + 小写化）
3. 用 TF 评分 或 简单的"匹配词数 / 词长"打分
4. 返回 top-3 分数 ≥ 阈值的页面

**UI（todo 详情抽屉新增"相关记忆"区块）**：
```
[相关记忆]
🔹 cloudbase-functions — 03-15 沉淀 ★ 匹配 4 词
   云函数部署与 cloudbaserc.json 配置...

🔹 websocket-keepalive-pattern — 04-02 沉淀 ★ 匹配 2 词
   PVP 服务保活与跨实例广播...

[展开/收起]
```

- 点击页面卡片 → 打开 WikiDrawer 并定位到该页
- 没有命中时该区块隐藏（不要显示"无相关记忆"占位，避免每条 todo 都背一个空区块）
- 配置：`config.wiki.recallEnabled = true`（默认开），用户嫌烦可关

### 6.6 修复版 wiki 跑批流程

把 `src/wiki/index.js` 的 `runOnce` 改造：

1. 写 sources（与 v1 相同）
2. dry-run 时跳过 LLM（不变）
3. **正式跑改为两阶段**：
   a. 第一阶段：调 claude，强制 JSON 输出（用 `--output-format json` 或在 prompt 里强约束）
   b. 校验 JSON 解析成功；失败则记录到 wiki_runs.error，整个 run 标记失败但保留 sources
   c. 第二阶段：调 claude，传入第一阶段 JSON，让 claude 写文件
4. git commit + log.md（不变）
5. **新增**：返回值包含 `produced: { entities: [...], concepts: [...], chores: number, updated: [...] }`，前端 toast 用这个展示"本次新增 N 个 entity / M 个 concept"

### 6.7 积压处理（291 条）

提供一次性脚本 `npm run wiki:dismiss-legacy`：

- 把所有当前 `done` 但未在 `wiki_todo_coverage` 中的 todo，全部插入 `wiki_todo_coverage` 一行 `llm_applied=2`（新增状态：legacy-dismissed）
- 这些 todo 之后不会再出现在"未沉淀"列表里
- 同时用户在 WikiDrawer 提供一个「从已忽略中挑出来沉淀」入口（次要 UI），可选 N 条手动沉淀
- 之后只有"今天起新完成"的 todo 自动入队

**理由**：291 条积压的心理负担远大于其知识价值。从今天开始重新累积，质量优先。

### 6.8 配置变更

```json
"wiki": {
  "wikiDir": "~/.agentquad/wiki",
  "maxTailTurns": 20,
  "tool": "claude",
  "timeoutMs": 600000,
  "redact": true,
  "recallEnabled": true,
  "recallTopK": 3,
  "recallMinScore": 0.2,
  "schemaVersion": 2
}
```

`schemaVersion=2` 用于检测老版本 wiki 目录并触发"补写 purpose.md / schema.md"（不动其他文件）。

### 6.9 DB 变更

```sql
-- wiki_todo_coverage 的 llm_applied 列扩展取值：
-- 0: dry-run only
-- 1: LLM 正式跑过
-- 2: legacy-dismissed（积压清零标记）

-- 新增：保存第一阶段 JSON 决策（方便回溯）
ALTER TABLE wiki_runs ADD COLUMN stage1_decisions_json TEXT;
ALTER TABLE wiki_runs ADD COLUMN produced_summary_json TEXT;
```

### 6.10 API 变更

| Method | Path | 变更 |
|---|---|---|
| GET | `/api/wiki/status` | 返回值增加 `schemaVersion`、`purposeExists`、`schemaExists` |
| GET | `/api/wiki/pending` | 不变，但默认过滤掉 `llm_applied=2`（legacy-dismissed） |
| GET | `/api/wiki/recall` | 新增：`?todoId=xxx` 或 `?q=xxx`，返回 top-K 相关页面 `[{ path, title, score, snippet }]` |
| POST | `/api/wiki/run` | 返回值结构变更：`{ runId, dryRun, exitCode, produced: { entities: [...], concepts: [...], choresAppended: number } }` |
| POST | `/api/wiki/dismiss-legacy` | 新增：批量标记积压为 legacy-dismissed |

### 6.11 前端变更

1. **TodoDetail 抽屉**：新增"相关记忆"区块（§6.5）
2. **WikiDrawer**：
   - 顶栏增加"打开 purpose.md / schema.md"快捷按钮（教用户怎么调整意图）
   - 跑批成功后的 toast 改为详细的"本次产出 N entities / M concepts / K chores"
   - 树形导航增加 entities/ 和 concepts/ 分组
   - 新增"从已忽略中挑选沉淀"次要入口
3. **i18n**：zh-CN / en-US 新增对应文案

## 七、阶段 2（可选，不在 MVP 范围）

- 向量召回：sqlite-vec 或 `@xenova/transformers`（本地嵌入）替换关键词检索
- 后台自动消化队列：done todo 默认入队，每天 N 条限速自动跑（用户可关）
- 审查面板：第一阶段 JSON 低置信度的让用户在 UI 上修正后才进第二阶段
- 知识图谱可视化：sigma.js + graphology（如果用户真的会看）

进入阶段 2 的前提：用户连续 2 周实际使用阶段 1 的 MVP，召回 panel 有可观察的点击行为。

## 八、风险与缓解

| 风险 | 缓解 |
|---|---|
| 阶段 0 发现 LLM 提炼能力不足 | 这本身就是 spec 设计的退出门；回退到方向 C 重新设计，不浪费阶段 1 的工作量 |
| 两阶段 prompt 第一阶段 JSON 解析失败 | 失败时保留 sources、wiki_runs 标失败、UI 给重试按钮；不污染 wiki 内容 |
| 关键词召回噪声大 | 设阈值 `recallMinScore`，调到只展示高置信度结果；用户实际反馈再调 |
| 第一阶段 + 第二阶段 token 翻倍 | 接受成本（手动触发，量可控）；阶段 2 引入缓存（同样 source 不重复抽取） |
| schemaVersion=2 升级误判 | 只补写 purpose.md / schema.md 两个文件（若不存在），不动其他；用户已有的 v1 wiki 继续工作 |
| 召回 panel 影响 todo 详情打开速度 | 关键词检索在内存中完成（页面索引常驻），<10ms；用户感受不到延迟 |

## 九、验收标准

### 阶段 0 验收
- [ ] 跑通诊断脚本，产出落到 `~/.agentquad/wiki-diagnose-2026-05-14/`
- [ ] 用户对每个产出页面打分（有用/凑合/没用）；至少 5/N 页面用户认为"对未来工作有参考价值"才能进入阶段 1

### 阶段 1 验收（MVP）
- [ ] 启动时若 wiki 已存在且 schemaVersion<2 → 自动补写 purpose.md / schema.md，不动其他文件
- [ ] 选 5 条新 done todo 跑批 → 必有 entities/concepts/chores 至少一类产出；不存在"跑完 0 页变更"
- [ ] 跑批结果 toast 显示"本次新增 N entities、M concepts、K chores"
- [ ] 打开任意 todo 详情 → 如果 wiki 中存在相关页，"相关记忆"区块显示 top-K 命中；否则不显示空区块
- [ ] 点击相关记忆卡片 → WikiDrawer 打开并定位到该页
- [ ] `npm run wiki:dismiss-legacy` 跑完后，"未沉淀"列表清零
- [ ] 用户在 WikiDrawer 的"从已忽略中挑选"入口能挑出特定 todo 沉淀
- [ ] 第一阶段 JSON 解析失败 → wiki_runs 标失败，UI 显示错误并提供重试，不污染 wiki 文件
- [ ] purpose.md / schema.md 被用户修改后，下次跑批使用用户编辑后的版本
- [ ] entities/ 和 concepts/ 下产出的页面满足 schema 结构（含 frontmatter、章节、关联链接）
- [ ] 老的 topics/ 和 projects/ 在新跑批中不被破坏

## 十、阶段划分（详细拆分留给 writing-plans）

按依赖：

1. **阶段 0**：写 `scripts/wiki-diagnose.js`，跑一次让用户评估
2. **阶段 1.A 基础设施**：
   - 在 `src/wiki/guide.js` 增加 PURPOSE_CONTENT / SCHEMA_CONTENT 常量
   - `src/wiki/index.js` 的 init 补写 purpose/schema，schemaVersion 升级逻辑
   - DB 迁移：扩展 llm_applied 取值、添加 stage1_decisions_json
3. **阶段 1.B 两阶段 prompt**：
   - 改造 `runOnce` 为两阶段；第一阶段 JSON 校验 + 失败处理
   - 返回 produced 统计
4. **阶段 1.C 召回**：
   - 新增 `src/wiki/recall.js`：页面索引常驻 + 关键词检索
   - 新增 `GET /api/wiki/recall` 路由
   - 前端 TodoDetail 增加"相关记忆"区块
5. **阶段 1.D 积压处理**：
   - 新增 `npm run wiki:dismiss-legacy` 脚本
   - 新增 `POST /api/wiki/dismiss-legacy` 路由
   - 前端 WikiDrawer 增加"从已忽略中挑选"入口
6. **阶段 1.E 前端打磨**：
   - WikiDrawer 树形导航增加 entities/concepts 分组
   - 跑批成功 toast 详情化
   - i18n 文案补全

## 十一、开放问题（实施时再决定）

- 第一阶段 prompt 是否要传"现有页面索引"全量？数量多时是否要截断？（初期页面少，先全量传；阶段 2 优化）
- 召回算法初期用最简单的"匹配词数"打分，还是直接上 BM25？（先匹配词数，质量不够再换 BM25）
- 中文分词用 `Intl.Segmenter` 还是 bigram？（Node 18+ 自带 Segmenter，优先用）
- 召回结果展示"摘要片段"还是首段？（首段最简单；阶段 2 再做语义高亮）
- 老 topics/ 与新 entities/concepts 命名冲突时（同样讲 cloudbase-functions）怎么办？（先并存，由用户在使用中手动合并；不做自动迁移）

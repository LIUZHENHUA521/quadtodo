// Rendered verbatim into ~/.quadtodo/wiki/WIKI_GUIDE.md on first init.
// Users are free to edit the file afterwards; we only write it if it's missing.
export const WIKI_GUIDE_CONTENT = `# Wiki 维护指南（LLM 读这个）

## 你的职责
每次被调用时，\`sources/\` 下会有一批新的 todo 素材文件。你的任务是：读完新 sources，把其中可沉淀的知识融入 \`topics/\` / \`projects/\` / \`index.md\`，让 wiki 保持有条理、可检索。

## 硬规则
- \`sources/*.md\` 是输入，**永远不要修改它们**
- 页面命名：kebab-case，例如 \`topics/cloudbase-cloud-function-deploy.md\`
- 页面间用相对 markdown 链接互相引用（例如 \`[CloudBase 部署](../topics/cloudbase-cloud-function-deploy.md)\`）
- 每个页面专注一个主题，不要让单页膨胀到难读

## 决策流程
对每个新 source，问自己：
1. 这条 todo 揭示了什么**可复用**的知识？（踩过的坑、通用模式、项目结构摘要、外部工具配置）
2. 对应 topic 页是否已经存在？
   - 存在 → 在合适的段落追加；合并类似条目
   - 不存在 → 新建 topic 页
3. 这条 todo 有 workDir（项目路径）吗？
   - 有 → 同时更新 \`projects/<projectName>.md\`：项目概述、该项目沉淀过的主要知识点列表（带链接指向 topic）
4. 如果这条 todo 只是琐碎任务（比如"写邮件"、"买东西"），可以跳过，不强行产出内容

## 更新 index.md
\`index.md\` 是顶级目录。每次都确保：
- 列出 topics/ 下所有页面（按主题分类）
- 列出 projects/ 下所有页面
- 最近 7 天的变更可以用一个 "Recent" 段落点出

## 追加 log.md
最后一步：往 log.md 追加一个 \`## YYYY-MM-DD HH:MM\` 段落，写清楚你这次改了/新增了哪些页，每条一句话。

## 语言
中文优先，代码/命令/路径保留原文。
`

export const EMPTY_INDEX_CONTENT = `# Wiki Index

还没有沉淀任何主题。去 quadtodo 里点「沉淀到记忆」按钮开始。
`

export const EMPTY_LOG_CONTENT = `# Wiki 更新日志

`

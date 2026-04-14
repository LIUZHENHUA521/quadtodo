# quadtodo

本地四象限待办 CLI，每条 todo 可内嵌一个 Claude Code 或 Codex 终端会话。单 Node 进程自包含，不依赖云服务。

GitHub 仓库：`git@github.com:LIUZHENHUA521/quadtodo.git`

## 依赖

- Node 20+
- npm 10+
- `claude` / `codex`，或公司内封装命令（如 `claude-w` / `codex-w`）可在 PATH 中找到
- macOS / Linux（node-pty 需要 C++ 编译工具链）

## 安装

### 从 npm 全局安装

```bash
npm install -g quadtodo
```

首次安装后，建议先执行：

```bash
quadtodo doctor
```

### 从源码安装

```bash
cd quadtodo
npm install                 # 后端依赖 + node-pty 原生编译
cd web && npm install       # 前端依赖
cd ..
npm run build               # 前端构建，产物在 dist-web/
cd ..
npm link                    # 全局链接 `quadtodo` 命令
```

## 快速开始

```bash
quadtodo doctor             # 检查环境是否就绪
quadtodo start              # 启动服务并自动打开浏览器
# → http://127.0.0.1:5677
```

停止：在前台会话按 Ctrl+C，或在另一个终端里 `quadtodo stop`。

## 命令

| 命令 | 作用 |
|---|---|
| `quadtodo start [--port 5677] [--no-open] [--cwd <path>]` | 启动服务 |
| `quadtodo stop` | 停止服务（SIGTERM 3 秒后 SIGKILL） |
| `quadtodo status` | 查看运行状态 + 活跃会话数 |
| `quadtodo doctor` | 环境自检 |
| `quadtodo config get <key>` | 读配置项 |
| `quadtodo config set <key> <value>` | 写配置项 |
| `quadtodo config list` | 打印整份配置 |

## 配置

配置文件：`~/.quadtodo/config.json`

```json
{
  "port": 5677,
  "defaultTool": "claude",
  "defaultCwd": "~",
  "tools": {
    "claude": { "command": "claude", "bin": "claude", "args": [] },
    "codex":  { "command": "codex",  "bin": "codex",  "args": [] }
  }
}
```

示例：

```bash
quadtodo config set port 6000
quadtodo config set tools.claude.command claude-w
quadtodo config set tools.codex.command codex-w
quadtodo config set tools.claude.bin /usr/local/bin/claude
quadtodo config set tools.codex.bin /opt/homebrew/bin/codex
```

说明：

- `tools.<tool>.command`：启动命令名，适合 `claude-w` / `codex-w` 这种公司内封装命令
- `tools.<tool>.bin`：绝对路径覆盖，优先级高于 `command`

## 数据存储

```
~/.quadtodo/
├── config.json      # 配置
├── data.db          # SQLite: todos 表
├── quadtodo.pid     # 服务运行时的 PID
└── logs/            # 每个 AI 会话的完整日志（最后 512KB）
    └── ai-*.log
```

导出/迁移：整个 `~/.quadtodo/` 是一个普通目录，tar 打包即可。

## 迁移到另一台电脑

```bash
# 在源机器
git clone <this-repo-url> ~/code/quadtodo
cd ~/code/quadtodo/quadtodo
npm install
cd web && npm install && npm run build && cd ..
npm link

# 如果要带走现有 todo 数据：
scp -r ~/.quadtodo target-host:~/
```

## 从零开始的目录结构

```
quadtodo/
├── package.json      # 后端 deps: express / ws / node-pty / better-sqlite3
├── src/
│   ├── cli.js        # commander 入口
│   ├── config.js     # ~/.quadtodo/config.json 读写
│   ├── db.js         # better-sqlite3 包装
│   ├── pty.js        # PtyManager（node-pty 会话 Map）
│   ├── server.js     # Express + ws + 路由组装
│   └── routes/
│       ├── todos.js
│       └── ai-terminal.js
└── web/
    ├── package.json  # 前端独立：vite + react + antd + dnd-kit + xterm
    └── src/
        ├── main.tsx
        ├── TodoManage.tsx   # 四象限看板主页
        ├── TodoManage.css
        ├── AiTerminalMini.tsx
        ├── SettingsDrawer.tsx
        └── api.ts
```


## 故障排除

- **端口占用**：`quadtodo config set port <new>`
- **`claude` 找不到**：`quadtodo config set tools.claude.bin /full/path/to/claude`
- **`node-pty` 安装报错**：通常是 node-gyp 找不到 C++ 工具链。macOS 装 Xcode Command Line Tools (`xcode-select --install`)
- **终端显示 `session_not_found`**：会话已超时（30 分钟已结束的会话会被清理），重新点"启动 AI 终端"



todo
请完成以下待办任务:

标题: 后续工作
描述:  一、提升 AI 协作效率（高价值）                                                                                                                    
   
  1. 会话对话增强                                                                                                                                   
    - 在待办详情里查看每个会话的完整历史（现在 log 落盘了但没 UI 查看），支持搜索 / 关键字高亮
    - 一键从某个历史会话 fork 出新会话（基于已有上下文继续问不同方向）                                                                              
    - 会话间对比视图（同一任务用 Claude vs Codex 分别跑，并排看输出差异）                                                                           
  2. Prompt 模板库                                                                                                                                  
    - 把"脑爆模式"抽象成 prompt 预设系统：Bug 修复模板、重构模板、写测试模板、代码评审模板...                                                       
    - 支持变量占位符（{{title}} / {{workDir}} / {{lastCommitDiff}}）                                                                                
    - 每个待办可选模板组合叠加                                                                                                                      
  3. 多会话编排                                                                                                                                     
    - 一个待办拆成多个子会话（规划 → 实现 → 测试 → review），可串行/并行触发                                                                        
    - 上一个会话的产出自动作为下一个的 prompt 前缀                                                                                                  
                                                                                                                                                    
  二、状态感知 & 通知（中价值）                                                                                                                     
                                                                                                                                                    
  4. 桌面通知 + 系统托盘                                                                                                                            
    - pending_confirm 状态触发 macOS 原生通知（不用只靠飞书/企微 webhook）
    - 菜单栏图标显示"有 N 个待交互会话"徽标                                                                                                         
  5. 静默工作时长统计                                                                                                                               
    - 记录每个会话实际运行时长、token 消耗估算（解析 Claude 输出里的 usage）                                                                        
    - 每周/每月报告：我花最多时间的任务 Top10、AI 帮我完成了 X 小时工作                                                                             
  6. 智能暂停检测                                                                                                                                   
    - 检测 AI 输出 N 分钟无变化 → 自动判定"卡住了"并通知                                                                                            
    - 区分"在思考"和"真的卡了"（有 spinner / 没 spinner）                                                                                           
                                                                                                                                                    
  三、Git & 项目集成（高价值，crazyCombo 多仓库场景尤其适合）                                                                                       
                                                                                                                                                    
  7. Git 状态面板                                                                                                                                   
    - 每个待办关联 workDir，卡片上直接显示：当前分支、未提交文件数、落后/领先 origin 情况
    - 一键"开始任务"：自动 checkout 新分支、命名来自 todo 标题                                                                                      
  8. 完成闭环                                                                                                                                       
    - AI 会话跑完后，自动 git diff --stat 展示到卡片上                                                                                              
    - 一键生成 commit message（调 AI 基于 diff）                                                                                                    
    - 一键创建 PR（集成 gh CLI）                                                                                                                    
  9. 提交记录反向关联                                                                                                                               
    - 扫描仓库最近 commit，自动匹配是哪个 todo 完成的（靠分支名/关键字）                                                                            
                                                                                                                                                    
  四、任务管理体验（中低价值但体验好）                                                                                                              
                                                                                                                                                    
  10. 快捷键系统：n 新建、1-4 切象限、⌘K 命令面板、e 编辑                                                                                           
  11. 子任务 / Checklist：一个 todo 里可以有勾选列表
  12. 标签系统：# 标签筛选，颜色区分                                                                                                                
  13. 重复任务：每日/每周自动生成（如"每日 standup"）                                                                                               
  14. 归档 & 回顾：done 超过 N 天自动归档到独立视图，避免列表臃肿                                                                                   
  15. 拖拽排序持久化 + 看板快照：每天结束自动存快照，能回看"昨天的看板长啥样"                                                                       
                                                                                                                                                    
  五、数据与知识沉淀（长期价值）                                                                                                                    
                                                                                                                                                    
  16. 全文检索                                                                                                                                      
    - 搜索词同时命中：todo 标题、描述、评论、AI 会话输出
    - 这是相对独有的价值 —— 你的 AI 对话历史在本地，可被检索                                                                                        
  17. "可复用经验"抽取                                                                                                                              
    - 会话完成后，AI 自动生成一个摘要 + "下次遇到类似问题可复用的知识点"                                                                            
    - 沉淀到一个知识库 tab，下次新建相似 todo 时推荐相关经验                                                                                        
  18. 导出 / 分享                                                                                                                                   
    - 一个待办 + 其会话输出 → 导出为 Markdown（用于写周报、故障复盘）                                                                               
    - 飞书文档直推（你本身就有 lark skills） 

请先理解需求和当前项目上下文，再开始执行。
完成后请给出变更摘要、验证结果，以及仍需我确认的事项。
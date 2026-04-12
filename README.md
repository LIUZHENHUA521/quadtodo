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

## 限制

- MVP 不做多用户 / 权限 / 软删除 / 附件 / 评论 / 定时重复
- Codex 的 `--resume` 能否捕获取决于其 CLI 行为；若不可用则每次新会话
- 不做自动换端口：被占用时直接报错
- 前台进程模型：后台跑请自行用 `nohup` / `tmux`

## 故障排除

- **端口占用**：`quadtodo config set port <new>`
- **公司内命令不是 `claude/codex`**：`quadtodo config set tools.claude.command claude-w`
- **`claude` 找不到**：`quadtodo config set tools.claude.bin /full/path/to/claude`
- **`node-pty` 安装报错**：通常是 node-gyp 找不到 C++ 工具链。macOS 装 Xcode Command Line Tools (`xcode-select --install`)
- **终端显示 `session_not_found`**：会话已超时（30 分钟已结束的会话会被清理），重新点"启动 AI 终端"

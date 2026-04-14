# quadtodo macOS SEA 单文件打包 + Homebrew 分发设计

- 作者：lzh
- 日期：2026-04-14
- 状态：Draft

## 背景

当前 quadtodo 只能通过 `npm i -g quadtodo` 分发，对用户环境要求：
1. 装 Node.js 20+
2. `node-gyp` 编译链（给 `better-sqlite3` / `node-pty` 用）
3. 安装后还得自己装 claude / codex CLI

目标：**让不愿装 Node 的 macOS 用户也能一行命令装上 quadtodo**。同时继续保留 npm 路径给熟悉 Node 的开发者。

不在本期范围：
- Windows / Linux 平台（只做 macOS）
- Apple Developer ID 代码签名（作者无 ID）
- Tauri GUI 外壳（Phase 2 预留）
- claude / codex 自动安装（保留现有 installHint 提示）

## 成功标准

- macOS arm64 + x64 两个 tarball，每个 ≤ 100MB
- 用户 `brew install lzh/quadtodo/quadtodo` 后直接能跑，无任何系统弹窗
- 用户不用装 Node、不用装 node-pty/better-sqlite3
- `quadtodo start` 的所有既有功能（WebSocket 终端、SQLite 持久化、Web UI）保持一致
- npm 路径 `npm i -g quadtodo` 不受影响
- 发版流程：一次 `npm run release:macos` 产出两个 tgz + sha256，并自动更新 Homebrew Formula

## 总体方案

用 **Node.js Single Executable Application（SEA）** 把 Node 22 运行时 + quadtodo JS bundle 压进一个可执行文件；两个 native 模块（better-sqlite3、node-pty）以 **sidecar `.node`** 形式与主程序同目录分发。分发载体是 GitHub Release 的 tgz，Homebrew tap 作为一层「自动下载 + 清 quarantine + 软链到 PATH」的包装。

```
quadtodo-macos-arm64.tgz  (~70MB)
├── bin/
│   └── quadtodo              ← SEA 单文件（Node 22 + 嵌入 JS bundle + 嵌入 web/dist）
└── lib/
    ├── better_sqlite3.node   ← arm64 预编译
    └── pty.node              ← arm64 预编译
```

### 架构决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 打包器 | Node SEA（官方）| 官方支持、长期维护；pkg 已停更；Bun compile 对 native 模块支持不稳 |
| 前端静态资源 | 嵌入 SEA asset | 避免再带一个 `web/` 目录，降低损坏/路径错位风险 |
| native 模块 | 外挂 sidecar `.node` | SEA 官方不支持内嵌 native；Node `dlopen` 要求落到磁盘 |
| 代码签名 | ad-hoc `codesign -s -`（无 ID）| 满足 macOS Sequoia 对 arm64 二进制的「必须至少 ad-hoc 签名」要求；Homebrew 自动清 quarantine |
| SQLite 持久化 | 保持 better-sqlite3 | 已有数据兼容；不引入 sqlite3/libsql 迁移成本 |
| 架构支持 | arm64 + x64 两份独立 tarball | Universal binary 会双倍膨胀至 ~140MB，超预算 |

## 构建流程

### 1. 前端打包（沿用既有）

```bash
cd web && npm run build
# 产出 web/dist/index.html + assets/*
```

### 2. JS Bundle

用 `esbuild` 把 `src/cli.js` 及其依赖打成单个 CJS 文件：

```bash
esbuild src/cli.js \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --external:better-sqlite3 \
  --external:node-pty \
  --outfile=dist/sea/quadtodo.cjs
```

external 列表只保留两个 native 模块。其它纯 JS 依赖（express、ws、commander…）全部打入 bundle。

### 3. 静态资源嵌入

`sea-config.json`：

```json
{
  "main": "dist/sea/quadtodo.cjs",
  "output": "dist/sea/prep.blob",
  "assets": {
    "web/index.html": "web/dist/index.html",
    "web/assets/index.js": "web/dist/assets/index-<hash>.js",
    "web/assets/index.css": "web/dist/assets/index-<hash>.css"
  }
}
```

动态构建脚本 `scripts/build-sea.mjs` 自动扫描 `web/dist/` 下所有文件生成 assets 映射，避免手写 hash 文件名。

### 4. SEA 组装

```bash
# 生成 blob
node --experimental-sea-config dist/sea/sea-config.json

# 复制 Node 可执行
cp "$(which node)" dist/sea/quadtodo

# 清理原 Node 签名（macOS 必须）
codesign --remove-signature dist/sea/quadtodo

# 注入 blob
# 注意：sentinel-fuse 哈希与 Node 版本绑定，下面是 Node 22 的值；
# 升级 Node 大版本时必须重新执行 `node -p "require('node:sea')"` 拿新值。
npx postject dist/sea/quadtodo NODE_SEA_BLOB dist/sea/prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

# ad-hoc 签名（覆盖改动后的 Mach-O）
codesign --sign - --force --deep dist/sea/quadtodo
```

### 5. Native sidecar 抽取

```bash
node scripts/pack-natives.mjs --arch arm64 --out dist/sea/lib/
# 从 node_modules/.../prebuilds/darwin-arm64/*.node 抽出
# 校验 file 输出里包含 "Mach-O 64-bit dynamically linked" + "arm64"
```

用 `prebuildify` 预产的 `.node` 还是从 npm 装的 `build/Release/*.node`？**决策**：优先读 `node_modules/<pkg>/prebuilds/darwin-<arch>/`（如 better-sqlite3 走 `@mapbox/node-pre-gyp`），失败回退到 `build/Release/`。构建脚本在本地交叉编译场景下**直接使用 npm 包内置的预编译**，不再本地 rebuild。

### 6. 打包 tarball

```bash
mkdir -p dist/release/quadtodo-macos-arm64/{bin,lib}
cp dist/sea/quadtodo dist/release/quadtodo-macos-arm64/bin/
cp dist/sea/lib/*.node dist/release/quadtodo-macos-arm64/lib/
tar -C dist/release -czf dist/release/quadtodo-macos-arm64.tgz quadtodo-macos-arm64
shasum -a 256 dist/release/quadtodo-macos-arm64.tgz > dist/release/quadtodo-macos-arm64.tgz.sha256
```

arm64 / x64 各跑一次（`--arch` 参数）。

**架构构建路径（决策）**：本期采用 GitHub Actions 双 runner（`macos-14` arm64 + `macos-13` x64）各跑一次完整流水。本地脚本 `npm run build:sea:arm64` 仅产 arm64，x64 强制走 CI；这避免本地 Rosetta 下 native sidecar 误带 arm64 段。CI 工作流文件在 Step 7 落地。

## 代码改动清单

### 1. Native 模块加载路径

SEA 下 `__dirname` / `import.meta.url` 行为不可靠。改为基于 `process.execPath` 解析 sidecar 位置。

**新文件：`src/native-loader.js`**

> 注意：esbuild 会把入口打成 CJS（见 §2），为避免 `import.meta.url` 在 CJS bundle 下不存在，这里也写成 CJS（或写成 ESM 并在 esbuild 阶段把它打进 bundle，由 esbuild 转译 `import.meta.url` → `__filename`）。下面以 ESM 源 + esbuild 转译为前提。

```js
// src/native-loader.js
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'   // Node 22+；非 SEA 环境也可 import，返回 false

const requireFn = createRequire(import.meta.url)

export function sidecarDir() {
  if (!isSea()) return null
  // SEA: /opt/homebrew/Cellar/quadtodo/<ver>/libexec/quadtodo
  //      → 与 quadtodo 同目录的 lib/
  return join(dirname(process.execPath), '..', 'lib')
}

export function loadNative(name) {
  const dir = sidecarDir()
  if (dir) return requireFn(join(dir, `${name}.node`))
  if (name === 'better_sqlite3') return requireFn('better-sqlite3')
  if (name === 'pty') return requireFn('node-pty')
  throw new Error(`unknown native module: ${name}`)
}
```

- `src/db.js` — 把 `import Database from 'better-sqlite3'` 改成 `import { loadNative } from './native-loader.js'; const Database = loadNative('better_sqlite3')`
- `src/pty.js` — 同理改 node-pty 加载

> Homebrew 路径关键点：Formula 把可执行装到 `libexec/quadtodo` 并把 `lib/` 整个 install 到 `libexec/lib/`，因此 `dirname(execPath) + '/../lib'` 等于 `libexec/lib`。Cellar 版本目录每次升级会变，但 sidecar 只用相对路径解析，不缓存绝对路径。

### 2. 静态资源路径

**修改 `src/server.js`**：在 SEA 模式下通过 `node:sea` API 读取嵌入的前端。

```js
import { getAsset, isSea } from 'node:sea'

if (isSea()) {
  app.get(/\.(js|css|html|svg|png|ico|json|woff2?)$/, (req, res) => {
    try {
      const asset = getAsset('web' + req.path)
      if (!asset) return res.status(404).end()
      const buf = Buffer.from(asset)
      res.type(req.path).send(buf)
    } catch { res.status(404).end() }
  })
  app.get('*', (req, res) => {
    const html = getAsset('web/index.html')
    res.type('html').send(Buffer.from(html))
  })
} else {
  // 既有静态服务
  app.use(express.static(join(__dirname, '../web/dist')))
  app.get('*', (_req, res) => res.sendFile(join(__dirname, '../web/dist/index.html')))
}
```

### 3. 首启环境自检

**修改 `src/cli.js`**：start 命令先检查 sidecar，并修正 PATH。

```js
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSea } from 'node:sea'
import { sidecarDir } from './native-loader.js'

function verifyRuntime() {
  if (!isSea()) return
  const dir = sidecarDir()
  for (const name of ['better_sqlite3', 'pty']) {
    if (!existsSync(join(dir, `${name}.node`))) {
      console.error(`[quadtodo] 缺少原生模块 ${name}.node。请 brew reinstall quadtodo。`)
      process.exit(1)
    }
  }
}
```

### 4. 子进程 PATH 修正（claude / codex）

SEA 进程通常被 Homebrew 用最小 PATH 拉起（`/usr/bin:/bin:/usr/sbin:/sbin`），用户在 `~/.zshrc` 里配的 nvm / Homebrew / 自定义 bin 都看不到，导致 `spawn('claude')` ENOENT。

**方案**：进程启动时在 `src/cli.js` 里扩展 `process.env.PATH`：

```js
function fixPath() {
  const home = process.env.HOME || ''
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.bun/bin`,
    `${home}/.deno/bin`,
  ]
  // 兼容 nvm：找最近一个 default 链
  const nvmDefault = `${home}/.nvm/alias/default`
  if (existsSync(nvmDefault)) {
    try {
      const v = readFileSync(nvmDefault, 'utf8').trim()
      extra.push(`${home}/.nvm/versions/node/v${v}/bin`)
    } catch {}
  }
  const cur = (process.env.PATH || '').split(':')
  const merged = Array.from(new Set([...cur, ...extra.filter(existsSync)]))
  process.env.PATH = merged.join(':')
}
```

PtyManager 已在子进程 spawn 时使用 `process.env.PATH`，无须再改。配套 `quadtodo doctor` 子命令打印解析后的 PATH + `which claude` / `which codex`，方便诊断。

### 5. 配置 / 日志路径

现有 `src/config.js` 把 `~/.quadtodo/` 作为配置目录——SEA 下不变。

- SQLite WAL/SHM 文件：随 db 文件一起放在 `~/.quadtodo/`，与 Homebrew Cellar 升级互不影响（数据目录在 `$HOME` 下，brew upgrade 不动它）。
- 升级策略：迁移由 `db.js` 内置（已有 schema 演进函数）。`brew uninstall quadtodo` **不会**删除 `~/.quadtodo/`，README 提示用户手动 `rm -rf ~/.quadtodo` 才能彻底卸载。
- 多版本回滚：`brew switch quadtodo <ver>`（或新的 `brew uninstall && brew install foo@x`）回滚二进制后，DB schema 若已升级则可能需要回滚 SQL；本期不做自动 down-migration，README 注明「跨大版本回滚需先备份 ~/.quadtodo/quadtodo.sqlite」。

### 6. 版本号注入

SEA 二进制读不到 `package.json`，且 `quadtodo --version` 必须能跑（Homebrew Formula 的 test 块会调用）。在 esbuild 阶段注入：

```bash
esbuild ... --define:__QUADTODO_VERSION__='"0.2.0"'
```

`src/cli.js` 改用 `program.version(__QUADTODO_VERSION__)`，并确保 `--version` 输出格式包含字符串 `quadtodo`，以匹配 Formula 的 `assert_match "quadtodo"`。

## Homebrew tap 仓库

新仓库 `lzh/homebrew-quadtodo`（GitHub 用户名待确认：实际 repo 下 `LIUZHENHUA521/quadtodo`，若选 `lzh` 需先注册该账号或把 quadtodo 主仓库迁过去）。

### 仓库结构

```
homebrew-quadtodo/
├── Formula/
│   └── quadtodo.rb
└── README.md
```

### Formula 模板（Formula/quadtodo.rb）

```ruby
class Quadtodo < Formula
  desc "Local four-quadrant todo CLI with embedded Claude Code / Codex terminal"
  homepage "https://github.com/LIUZHENHUA521/quadtodo"
  version "0.2.0"

  if Hardware::CPU.arm?
    url "https://github.com/LIUZHENHUA521/quadtodo/releases/download/v#{version}/quadtodo-macos-arm64.tgz"
    sha256 "<ARM64_SHA256>"
  else
    url "https://github.com/LIUZHENHUA521/quadtodo/releases/download/v#{version}/quadtodo-macos-x64.tgz"
    sha256 "<X64_SHA256>"
  end

  def install
    libexec.install "bin/quadtodo"
    libexec.install "lib"
    (bin/"quadtodo").write <<~SH
      #!/bin/bash
      exec "#{libexec}/quadtodo" "$@"
    SH
    chmod 0755, bin/"quadtodo"
  end

  test do
    assert_match "quadtodo", shell_output("#{bin}/quadtodo --version")
  end
end
```

用户命令：

```bash
brew tap lzh/quadtodo
brew install quadtodo
# 或一行
brew install lzh/quadtodo/quadtodo
```

### 发版脚本（新文件 `scripts/release.mjs`）

流程：
1. 读 `package.json` 的 version
2. 执行 `npm run build:sea:arm64` + `npm run build:sea:x64` 产出两个 tgz
3. `gh release create vX.Y.Z dist/release/*.tgz dist/release/*.sha256 --generate-notes`
4. 生成新的 `quadtodo.rb`（填入版本号 + 两个 sha256），打开 `homebrew-quadtodo` 仓库拉 PR：
   - 用 `gh pr create` 或直接 `git push` 到 tap 仓库 main
5. 可选：`npm publish` 同步 npm registry

## 降级 / 排障

| 情况 | 说明 |
|---|---|
| 用户直接下载 tgz 解压双击 | macOS 弹「来自未识别开发者」。**必须**对整棵目录递归清 quarantine（含 sidecar `.node`）：`xattr -dr com.apple.quarantine ~/Downloads/quadtodo-macos-arm64`。首次 `quadtodo start` 仍可能触发 `spctl` 评估，提示用户在「系统设置 → 隐私与安全性」点「仍要打开」。Homebrew 路径自动免除此步 |
| `brew install` 失败（网络） | Formula 里支持 `HOMEBREW_NO_AUTO_UPDATE=1` |
| native 模块加载失败 | `cli.js` 启动时自检，给出「重装 quadtodo」提示 |
| 用户同时装了 npm 版和 brew 版 | `brew` 安装到 `/opt/homebrew/bin/quadtodo`，npm 装到 nvm 目录，两者 PATH 顺序决定优先级 —— README 里说明 |

## 非目标（明确不做）

- Linux / Windows 构建（下一期）
- Universal binary（双架构合并，200MB 超预算）
- Apple Developer ID 签名 + notarize（需要年费，留 Phase 2）
- Auto-updater（Homebrew `brew upgrade` 已足够）
- Tauri / Electron GUI 外壳（Phase 2）

## 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SEA 对某些 npm 包不兼容（比如动态 require） | 构建失败 | esbuild 阶段出错就暴露；小范围 polyfill |
| better-sqlite3 prebuild 在新 macOS 版本失效 | 用户运行时 crash | 固定 Node 22 版本；CI 用最新 macOS runner 验证 |
| Homebrew tap 仓库 URL（用 `lzh` 还是 `LIUZHENHUA521`）不一致 | 用户找不到 | **开放问题 1**：实施前敲定 |
| arm64 机器上编译 x64 sidecar | 本地编译链限制 | CI 矩阵 macos-13（x64）+ macos-14（arm64）双 runner |
| 用户 Gatekeeper 策略极严（企业 MDM） | ad-hoc 也被拒 | README 给出临时豁免命令；长期方案是买 Apple ID |

## 开放问题

1. **tap 仓库的实际 GitHub 账号**：用户答「lzh」，但当前 quadtodo 主仓库在 `LIUZHENHUA521` 下。方案 A：新建 `lzh` 账号并把 tap 放那里，方案 B：统一改到 `LIUZHENHUA521/homebrew-quadtodo`，命令变成 `brew install LIUZHENHUA521/quadtodo/quadtodo`（稍长）。**需 lzh 确认后再生成 Formula**：上文 Formula 的 `homepage`/`url` 暂指向 `LIUZHENHUA521`，但 tap 命令里写的是 `lzh/quadtodo`，二者必须统一才能进入 release 阶段。
2. **CI 基础设施**：本地能否长期维护多架构构建？如果走 GitHub Actions，要加两个 runner 成本；如果只本地构 arm64、不支持 x64，可能遗失 Intel Mac 用户（但已是少数）。
3. **版本号策略**：SEA 版本和 npm 版本是否同步？建议同步，Formula 版本号 = `package.json` 版本。

## 实施阶段拆分（留给 writing-plans）

概略，细节在 plan 阶段落：

- Step 1：封装 `src/native-loader.js`，迁移 db.js / pty.js，跑既有测试确认无回归
- Step 2：SEA 构建脚本 + 本机跑通 arm64 单文件（不含 Homebrew）
- Step 3：静态资源 SEA asset 嵌入 + 前端功能回归测试
- Step 4：x64 sidecar 抽取（在 Intel Mac 或 Rosetta 上验证）
- Step 5：建 `lzh/homebrew-quadtodo` 仓库、Formula 初版、人工 `brew install --HEAD` 验证
- Step 6：`scripts/release.mjs` 一键发版、首个正式版本 tag + release
- Step 7：README 更新安装指引、增加 GitHub Actions CI（可选，收尾）

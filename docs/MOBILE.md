# 手机访问 quadtodo（Tailscale 私网模式）

> **目标**：在外面用手机打开 quadtodo，看待办 / 继续 AI 会话 / 查统计。**不暴露到公网**。
>
> **原理**：Tailscale 在你的设备之间拉一张私有虚拟网络，Mac 和手机都挂在里面，手机通过 `100.x.x.x` 或 MagicDNS 主机名访问本机服务。只有你自己账号的设备能连。

## ⚠️ 为什么不推荐公网穿透

quadtodo 内置能力包括：

- 本机 shell PTY
- Claude Code / Codex 终端（使用你的 API 凭据）
- 任意文件读写
- 启动 Trae / Cursor 等编辑器

暴露到公网等于送出一把远程 shell + AI 账号。**Tailscale 私网是目前最省事又安全的访问方式**：代码不用改鉴权，流量完全走你的 Tailscale 账号。

---

## 一、MacBook 端设置

### 1. 安装 Tailscale

```bash
brew install --cask tailscale
```

装完打开 App，登录你的账号（支持 Google / GitHub / Email）。免费 Personal 计划：最多 100 台设备、3 个用户。

### 2. 开启 MagicDNS（推荐）

登录 https://login.tailscale.com/admin/dns → 打开 **MagicDNS**。开启后你可以用可读的主机名访问设备，而不用记 `100.x.x.x`。

### 3. 查看本机 Tailscale 信息

```bash
tailscale status       # 查看本机名字和 IP
tailscale ip -4        # 只看 IPv4（形如 100.64.xx.xx）
```

记下：
- **主机名**：比如 `lzh-mac`（MagicDNS 启用时可用 `lzh-mac.xxx.ts.net`）
- **IP**：比如 `100.64.12.34`

### 4. 启动 quadtodo 并开放 Tailscale 网口

默认 quadtodo 只监听 `127.0.0.1`（安全第一）。要让 Tailscale 网络访问，必须显式放开：

```bash
# 方法 A（一次性）
quadtodo start --expose

# 方法 B（持久配置）
quadtodo config set host 0.0.0.0
quadtodo start
```

启动后终端会打印：

```
quadtodo listening on http://all-interfaces:5677  (port 5677)

⚠️  SECURITY: quadtodo exposes a shell + AI terminal. Reachable URLs:
   Tailscale (recommended — private mesh VPN):
     http://100.64.12.34:5677    [utun5]
   Tip: with MagicDNS you can also use  http://<your-mac-name>:5677
```

### 5. （可选）macOS 防火墙白名单

**系统设置 → 网络 → 防火墙**。如果启用了防火墙，首次 `node` 启动会弹窗问"允许/拒绝"，选"允许"。

---

## 二、iPhone 端设置

### 1. 装 App 并登录

App Store 搜 **Tailscale** → 登录同一个账号。开关打开后会出现 `VPN` 状态图标。

### 2. 配置 On-Demand（按需启用）

iOS 一次只能开一个 VPN。如果你平常还挂着另一个 VPN（翻墙/工作），建议用 **On-Demand** 模式：只在访问 Tailscale 私网地址时临时启用 Tailscale，其他时间让位给你的另一个 VPN。

**在 Tailscale iOS App 里：**

1. 右下角 **Settings**（齿轮）
2. 打开 **Connect on Demand** （或叫 "Start on Demand"）
3. 在规则里添加：当访问 `100.64.0.0/10` 或 `*.ts.net` 时连接

参考官方文档：https://tailscale.com/kb/1115/on-demand

### 3. 访问 quadtodo

Safari / Chrome 打开：

```
http://<mac-hostname>:5677
```

例如 `http://lzh-mac:5677`（MagicDNS 生效的话）或 `http://100.64.12.34:5677`（用 IP 直接访问）。

**首次打开可以"加到主屏幕"**：Safari 分享 → 添加到主屏幕。之后就像个 App 一样一键打开。

---

## 三、Android 端设置

### 1. 装 App 并登录

Google Play 搜 **Tailscale** → 登录。

### 2. 配置 "Always-on VPN 例外" / 按需

Android 系统允许一个 "Always-on VPN"。Tailscale 支持配合其他 VPN 的方案相对有限：

- **方案 1（最简单）**：平时不挂 Tailscale，要用 quadtodo 时在通知栏一键打开。
- **方案 2**：如果你的另一个 VPN 客户端支持 **分流规则**（Clash / Shadowrocket 等），把 `100.64.0.0/10` 网段设为"直连"或"不代理"，然后手动挂 Tailscale。

### 3. 访问 quadtodo

Chrome 打开 `http://<mac-hostname>:5677` 或 `http://100.64.12.34:5677`。

---

## 四、常见问题

### Q: Mac 关机 / 休眠后手机连不上了？

这是正常的，quadtodo 跑在你的 Mac 上。Mac 醒着、quadtodo 进程还活着、Tailscale 正常，手机才能访问。

**小技巧**：系统设置 → 节能 → **禁用"插电源时进入睡眠"**，可以让关盖的 Mac 连接电源时保持 quadtodo 运行。

### Q: 我想临时给别人看一眼，他没有 Tailscale 账号，怎么办？

用 `tailscale funnel`：

```bash
sudo tailscale funnel 5677
```

会给你一个永久的 `https://<name>.ts.net` 公网 URL。**这时对全公网开放**，强烈建议先在 quadtodo 端加 token 鉴权（暂未实现；如果你需要可以提 issue）。

### Q: 怎么确认 Tailscale 通了？

Mac 上：

```bash
tailscale status          # 看到两台设备都显示 "active"
tailscale ping <phone>    # 看延迟
```

手机上：Tailscale App 的 **Admin** 或 **Machines** 列表能看到你的 Mac 在线。

### Q: 访问 quadtodo 报 "ERR_CONNECTION_REFUSED"

检查清单：

1. Mac 上 `quadtodo status` 显示 running；
2. Mac 上 `lsof -i :5677` 能看到进程，且 LISTEN 地址不是 `127.0.0.1`（应该是 `*:5677` 或 `0.0.0.0:5677`）；
3. 手机 Tailscale 开启中，且登录的是同一个账号；
4. 关掉再打开一下手机 Tailscale；
5. 直接用 IP 访问（排除 MagicDNS 问题）：`http://100.x.x.x:5677`。

### Q: 我在手机上想用 AI 终端

目前手机上仍是完整的 xterm，用软键盘操作比较别扭。**建议用法**：

- 手机上只看会话输出 + 通过 `/api/ai-terminal` 的 "发送一行" 接口追加指令；
- 复杂交互还是回 Mac 上做。

（"好用档"的改造——把手机终端做成只读输出 + 单行输入框——留给后续迭代。）

### Q: iOS Safari 里，底部按钮被地址栏吃掉

已在 CSS 里用 `100dvh` + `env(safe-area-inset-*)` 做了适配。如果你仍遇到这个问题，截图丢过来。

---

## 五、回到纯本机模式

不想外网访问了，一行切回默认：

```bash
quadtodo config set host 127.0.0.1
quadtodo stop
quadtodo start
```

或者临时用：`quadtodo start --host 127.0.0.1`。

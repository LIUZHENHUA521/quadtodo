# 飞书 / Lark 配置教程

> AgentQuad 通过飞书自建应用 + 长连接（WSClient）订阅事件，把任务消息发到话题群的 thread 里，群里 @bot 可以反向触发任务。
> **不需要公网 callback URL**，长连接走 WebSocket 出站。

## 1. 在飞书开放平台建一个自建应用

打开 <https://open.feishu.cn/app>（国际版 Lark：<https://open.larksuite.com/app>）→ **创建应用** → **企业自建应用**

填：

- 应用名称：随便起，譬如 `agentquad`
- 描述、图标：可选

创建完进入应用后台，**凭证与基础信息** 页能看到：

- **App ID**（形如 `cli_xxxxxxxxxxxxxxxx`）
- **App Secret**（点眼睛图标显示）

→ 这两个一会要填进设置抽屉。

## 2. 给应用配置必需的权限（Scope）

在应用后台左侧 → **权限管理** → 搜索并开通这些权限：

| Scope | 用途 |
|---|---|
| `im:message:send_as_bot` | 以应用身份发消息（必填） |
| `im:message` | 接收 / 读取消息（事件订阅必填） |
| `im:message.reaction` 或 `im:message:reaction` | 表情回应（AgentQuad 用来标记任务状态） |
| `im:chat` | 获取群信息、判断是否话题群 |
| `im:resource` | 接收图片附件（任务里需要图片时） |

> 飞书的 scope 命名偶尔有 `im:xxx` / `im:xxx:yyy` 两种写法，没把握就把 IM 板块下相关项都勾上。

开权限后，**右上角 → 创建版本 → 申请发布**（自建应用要走"发布"才能让权限生效，企业内部审批通常秒批）。

## 3. 启用事件订阅（长连接，无需公网）

应用后台左侧 → **事件与回调** → **事件订阅**：

- **订阅方式** 选 **长连接** （而不是 webhook 回调地址）
- 不需要填 Encrypt Key 或 Verification Token（走长连接时这些字段非必需）

然后在 **添加事件** 里勾上：

- ✅ `im.message.receive_v1`（接收消息事件，必填）
- ✅ `card.action.trigger`（卡片按钮点击事件，让权限申请等交互卡片可用）

> **⚠️ 易踩坑：消息事件的接收范围**
>
> `im.message.receive_v1` 默认只投递 **"@机器人 + 用户回复机器人消息"** 这两类。如果你
> 想在群里**直接发新消息**（不 @、不长按回复）也让 bot 收到（譬如向导第二步直接发 `1`
> 选工作目录），需要在这条事件旁边的 **「订阅范围 / 数据权限」** 里把范围改成
> **「群组所有消息」**（飞书后台不同版本叫法略有差异，关键词：群消息接收范围 / 群聊消息）。
>
> 改完同样要 **创建版本 → 申请发布**才生效。
>
> 不改也能用，只是后续每条消息都得用 **长按 bot 那条消息 → 回复** 的方式发。

## 4. 建话题群并把 bot 加进去

> AgentQuad 默认要求"话题群 / thread group"，普通群发出去的消息没法做线程隔离。

在飞书客户端：

- **新建群** → 选 **话题群**（或者已有群 → 群设置里检查是否话题群；不是的话需要群主转换）
- 群设置 → **群机器人** / 添加成员 → 搜你的应用名 → 加进来
- 给 bot 发言权限（默认就有，不用动）

## 5. 拿 Chat ID

群设置里飞书没直接给 chat_id，最简单的方法：

**方法 A：在群里 @bot 发条消息**

AgentQuad 启动后会打 log：

```
[lark-event] receive_v1 chat=oc_xxxxxxxxxxxxxxxxxxxx user=ou_xxx text=...
```

这里的 `oc_xxxx...` 就是 chat_id。复制出来。

**方法 B：用飞书开放平台调试器**

<https://open.feishu.cn/api-explorer> → 选 `获取群组信息` API → 用你的 token 调一次能看到所有群的 chat_id。

## 6. 在本面板填 AppID / Secret / ChatID + 测试

回到本设置抽屉 → **Lark / 飞书** Tab：

- **启用 Lark / 飞书通知** → ON
- **App ID**：粘贴第 1 步的 `cli_xxx`
- **App Secret**：粘贴 secret
- 点 **测试** 按钮 → 看到 `✓ 来源：当前输入，保存后生效`
- **话题群 Chat ID**：粘贴第 5 步拿到的 `oc_xxx`
- **要求目标群为话题群**：保持开启（避免误用普通群）
- **启用事件订阅**：开（让 @bot 能反向触发任务）
- **Web/CLI 起 session 自动镜像到 Lark thread**：开（在 Web 里起的任务自动同步到飞书）
- **默认权限模式**：Lark 远程驱动建议选 **完全托管（bypass）**，否则等待授权时只能干等

抽屉右上角 **保存**。

## 7. 验证

启动 log（终端）应有：

```
[lark] bot started; chatId=oc_xxx eventSubscribe=on
[lark-event] websocket connected
```

到飞书话题群里 @bot 发：

```
@agentquad 帮我做：写一个 nodejs hello world demo
```

预期：

1. bot 在群里回复 "📁 选个工作目录…"
2. 走完向导后，回话以 thread / 子话题形式回到该消息下
3. 后续 AI 输出全部在同一个 thread 里，不污染主群

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 测试通过但 @bot 没反应 | 事件订阅没开 / 没勾 `im.message.receive_v1` / 应用没发布版本 |
| 第一条 @bot 起向导有回复，但向导第二步在群里发 `1` / `2` 没反应 | `im.message.receive_v1` 的**订阅范围**只覆盖了「@机器人 和 回复机器人消息」，不包含「群组所有消息」。改成后者并重新发布版本；或者用**长按 bot 消息 → 回复**方式发后续步骤。详见 §3 易踩坑。 |
| log 里 `lark_credentials_missing` | App ID 或 Secret 没填或填错 |
| log 里 `lark_send_failed: ... 99991663` | 缺少 `im:message:send_as_bot` 权限 |
| log 里 `lark_send_failed: ... robot ... not in chat` | bot 没加进群、或加错群了 |
| `不是话题群` 错误 | Chat ID 对应的是普通群；要么换群，要么关掉「要求目标群为话题群」开关 |
| Web 里起的任务没同步到飞书 | 「自动镜像到 Lark thread」开关没开 |
| 表情回应 / 卡片按钮报错 | `im:message.reaction` 或 `card.action` 权限没开，或权限改了之后没"创建版本发布" |

排查命令：

```bash
agentquad doctor                        # lark 段应全 ✓
tail -100 ~/.agentquad/logs/agentquad.log | grep -E '\[lark'
```

---

## 字段速查

`~/.agentquad/config.json` 的 `lark` 段：

| 字段 | 含义 |
|---|---|
| `enabled` | 启用 AgentQuad 自己的 Lark 长连接 |
| `appId` | 飞书自建应用 App ID（`cli_xxx`） |
| `appSecret` | 飞书自建应用 App Secret |
| `chatId` | 目标话题群的 chat_id（`oc_xxx`） |
| `requireThreadGroup` | 强制要求目标群是话题群（防止误用普通群） |
| `eventSubscribeEnabled` | 启用事件订阅（关掉就只能单向推送，不能 @bot 反向触发） |
| `autoCreateTopic` | Web/CLI 起 session 时自动在话题群里建 thread anchor |
| `defaultPermissionMode` | 新建/恢复任务的默认权限模式（远程建议 `bypass`） |
| `notificationCooldownMs` | 同一会话 idle 提醒的最小间隔（默认 600000 = 10 分钟） |

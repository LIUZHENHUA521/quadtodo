# Telegram 配置教程（精简版）

> 跟着这 6 步走完就能把 AgentQuad 接到 Telegram 群里。完整版（CLI 自动化、故障排查、字段表）见 `docs/TELEGRAM.md`。

## 1. 在 Telegram 建一个 Supergroup 并启用 Topics

- 在 Telegram 客户端 → 新建 **Group**
- 进入群设置 → 升级为 **Supergroup**
- 群设置 → **Topics** 开关打开（必须开，否则没法按任务建独立话题）

## 2. 跟 BotFather 拿 bot token

- 在 Telegram 搜 [@BotFather](https://t.me/BotFather) → 发 `/newbot`
- 起名字、起 username（必须 `_bot` 结尾）
- BotFather 会回一串 token（形如 `7846123456:AAH9xK_xxxxxxxxxxxxxxxxxxxxxx`）→ **复制保存**

## 3. 把 bot 拉进群并给权限

- 在群里 → 添加成员 → 搜你的 bot 用户名 → 加进来
- 群设置 → Administrators → 把 bot 提权为 admin
- 必须勾选这两项：
  - ✅ **Manage Topics**（让 bot 能建/关/改话题）
  - ✅ **Send Messages**

## 4. 在本面板填 token + 测试连通

回到本设置抽屉 → **Telegram** Tab → **基础**：

- 「启用 Telegram」开关 → ON
- **Bot Token** 输入框 → 粘贴第 2 步拿到的 token
- 点旁边 **测试** 按钮
- 看到 `✓ @yourbot（来源：当前输入，保存后生效）` 就说明 token 没问题

## 5. 抓 Supergroup ID（最省事的一步）

- 点 **Supergroup ID** 旁边的 **抓 ID** 按钮 → 弹出 60 秒监听窗口
- 切到 Telegram 群里随便发一句话（譬如 `hi`）
- 抓 ID 弹窗会出现该群的一行 → **点选** → 自动填回 Supergroup ID 和白名单 chatIds
- 关闭弹窗

> 不想用抓 ID 的话，也可以手动加 [@RawDataBot](https://t.me/RawDataBot) 进群拿到 chat id（带 `-100` 前缀）。

## 6. 保存

抽屉右上角 **保存** → 后端会自动重启 Telegram 长轮询，**不用** `agentquad stop && start`。

启动 log（终端里）应有：

```
[telegram] bot started; supergroup=-1001234567890 allowedChatIds=-1001234567890
```

---

## 验证：试着跑一个任务

在 Supergroup 的 **General** 频道里发：

```
帮我做：写一个 nodejs hello world demo
```

预期：

1. 1~2 秒后 bot 回："📁 选个工作目录…"
2. 走完目录 / 象限 / 模板向导
3. 群里多出一个新 Topic "#tXX 写一个…"
4. AI 回话只推到这个 Topic，不污染 General

任务结束时：

- Topic 收到 "✅ 任务 X 已结束" + 整段 transcript .md 附件
- Topic 自动 close，标题加 `✅ ` 前缀

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 测试按钮报 401 / Unauthorized | token 复制时少字符 / 多空格，重新粘贴 |
| 测试通过但群里 @bot 没反应 | bot 没在群里、或没给 Manage Topics 权限 |
| 消息发送被 drop | log 里有 `dropped message from unauthorized chat` → 把那个 chat id 加到「白名单 chatIds」 |
| Topic 没建出来 | 群没开 Topics（步骤 1）、或 bot 没 Manage Topics 权限（步骤 3） |
| token 来源显示「来自 ~/.openclaw」 | 老用户兜底路径，重新填一次 token 后保存即可迁到 AgentQuad 自己的 config |

排查命令：

```bash
agentquad doctor                          # 应有 telegram 段全 ✓
tail -50 ~/.agentquad/logs/agentquad.log  # 启动/连接 log
```

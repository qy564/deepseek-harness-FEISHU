# DSH ↔ 飞书 远程助手桥接器

让飞书成为你访问本机 DeepSeek Harness（DSH）的远程入口：在飞书里给机器人发
消息，DSH 的 AI 会处理并回复到飞书；支持多轮对话（记住上下文）、群聊 @ 触发、
单聊直连，以及 `/new` `/cancel` `/status` 命令。

```
飞书聊天 ──(长连接)──> feishu_bridge.py ──(/api RPC)──> DSH Web (127.0.0.1:<当前端口>)
```

**技术要点**：飞书官方"自建应用 + 长连接事件订阅"（无需公网 IP、无需域名备案），
DSH 侧复用浏览器同款 `/api` RPC 协议（`session.create` / `session.prompt` /
`session.history`），每个飞书聊天对应一个独立的 DSH 会话。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `feishu_bridge.py` | 主程序（飞书长连接 + DSH RPC 转发） |
| `config.example.json` | 配置模板，复制为 `config.json` 后填写 |
| `requirements.txt` | Python 依赖 |
| `bridge.log` | 运行日志（自动生成） |
| `state.json` | 飞书聊天 ↔ DSH 会话映射（自动生成） |

> **隐私说明**：`config.json`（含 App Secret）、`bridge.log`、`state.json`
> 都是本地文件，已加入 `.gitignore`，不要提交到仓库；仓库内的 `config.json`
> 已脱敏（凭证留空，插件模式由 DSH 配置注入凭证，不受影响）。

---

## 第一步：本机准备（1 分钟）

```powershell
cd <本目录>   # 本项目文件夹（含 feishu_bridge.py）
python -m pip install -r requirements.txt
copy config.example.json config.json
```

确认 DSH Web 正在运行（浏览器能打开 DSH 界面；插件模式下端口自动跟随，无需手动改）。

---

## 第二步：飞书开放平台配置（10 分钟，只做一次）

1. **注册飞书并创建团队**（如果还没有）
   - 用手机号注册飞书，进入 [飞书开放平台](https://open.feishu.cn/)，
     点"创建企业/团队"（个人可免费创建，作为你自己的开发环境）。

2. **创建自建应用**
   - 打开 [开发者后台](https://open.feishu.cn/app) → **创建企业自建应用**，
     填写名称（如"我的DSH助手"）、图标，创建。

3. **启用机器人**
   - 进入应用 → **应用能力 → 机器人** → 启用机器人。

4. **开通权限**（应用 → 权限管理 → API 权限，逐个开通）
   - `im:message` —— 读取消息
   - `im:message:send_as_bot` —— 以应用身份发消息
   - `im:message.group_at_msg` —— 接收群聊中 @ 机器人的消息
   - `im:message.p2p_msg` —— 接收用户发给机器人的单聊消息

5. **开启事件订阅（关键：选"长连接"）**
   - 应用 → **事件与回调 → 事件配置** → 订阅方式选择 **长连接**
     （不要选"将事件发送至开发者服务器"，那需要公网地址）。
   - 添加事件：**接收消息 im.message.receive_v1**（在"消息"分类下）。
   - 保存后页面会显示"长连接已开启"。

6. **发布版本（让权限生效）**
   - 应用 → **版本管理与发布 → 创建版本 → 申请线上发布**。
   - 因为你自己就是团队管理员，审批会直接通过（或自己点同意）。

7. **拿凭证**
   - 应用 → **凭证与基础信息** → 复制 **App ID** 和 **App Secret**
     （App Secret 只显示一次，复制后妥善保存）。

8. **把机器人加进聊天**
   - 在飞书里搜索你的应用名，找到机器人，**添加为联系人**（单聊），
     或拉进一个**私人群**（建议私人群，别放公开大群）。

---

## 第三步：填写配置并启动

编辑 `config.json`：

```json
{
  "feishu_app_id": "cli_xxxxxxxxxxxxxxxx",
  "feishu_app_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "feishu_domain": "feishu",
  "dsh_base_url": "http://127.0.0.1:52199",
  "dsh_cwd": "C:\\Users\\你的用户名\\Desktop\\deepseek FEISHU",
  "poll_interval_seconds": 2.0,
  "turn_timeout_seconds": 600.0,
  "reply_chunk_chars": 8000
}
```

> `dsh_cwd`：AI 的工作目录（新建 DSH 会话时使用，可留空）。改了这个路径后，
> 删掉 `state.json` 再重启桥接，下一次对话就会在新目录里开新会话。
>
> `dsh_base_url`：**插件模式（推荐）下会自动使用当前 DSH Web 的实际端口**，
> 不用管这个字段（DSH 每次启动端口都可能变化，写死会导致连不上）。
> 只有手动运行 `python feishu_bridge.py` 时才需要把它改成当前端口
> （看 DSH 启动时打印的 URL，或 `netstat -ano | findstr LISTENING` 找 127.0.0.1 的端口）。

启动：

```powershell
cd <本目录>
python feishu_bridge.py
```

看到日志 `DSH 连接正常` 和 `启动飞书长连接事件订阅` 即成功。保持这个窗口
开着（想开机自启可以之后做成计划任务/服务，见文末）。

---

## 插件模式（推荐：打开 DSH 自动连接飞书）

桥接已经打包成 DSH 插件 `dsh-feishu-bridge`（源码在 `plugin/` 目录）：

- 安装：`dsh plugin --profile web add file:<本目录>\plugin`
- 注册：在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 里加了
  `feishu-bridge` 行（App ID/Secret、工作目录等都在那里配置）
- 效果：**打开 DSH 应用 → 桥接自动启动并连上飞书；关闭 DSH → 桥接自动停止**。
  桥接进程崩溃也会自动重启（配置错误除外）。DSH 端口变化也会自动跟随。
- 改配置：编辑 `cordis.patch.yml` 里 `feishu-bridge` 的 `config`，保存后
  重启 DSH 生效（Web 组合当前未启用热重载）。
- 卸载：从 `cordis.patch.yml` 删除该行，再执行
  `dsh plugin --profile web remove dsh-feishu-bridge`。

> 注意：插件模式和手动模式不要同时运行（会双重回复）。插件模式下不需要
> 手动执行 `python feishu_bridge.py`。

---

## UI 入口（v0.2 新增，v0.2.1 改为站内打开对话页面）

插件带一个浏览器端 UI（无需单独安装，随插件一起加载）：

- **侧边栏底部"飞书"按钮**（在"设置"齿轮旁边）：小圆点显示桥接状态
  （绿=已连上飞书，黄=运行中，灰=未运行）。点击**在 DSH 内打开
  飞书对话页面**——就是普通对话页，内容为飞书上的交流，不跳转飞书。
  打开逻辑：优先用 `state.json` 的飞书聊天 → DSH 会话映射；没有映射时
  自动找工作区里最新的飞书会话；再没有就在工作区新建一个。
- **设置 → 插件 → 飞书对话卡片**：显示运行状态、工作区、当前飞书会话，
  可 打开对话页面、启动/停止 桥接，并查看最近日志。

> 新增/修改 UI 后需要**重启 DSH 应用**（关闭 DeepSeek Harness 再打开），
> 浏览器刷新页面即可看到入口。

---

## 使用方式

- **单聊**：直接给机器人发消息，AI 会回复。
- **群聊**：`@机器人 你的问题`，只有 @ 时才会响应。
- **命令**：
  - `/new` —— 开新对话（清空上下文）
  - `/cancel` —— 取消正在执行的任务
  - `/status` —— 查看当前绑定的 DSH 会话

说明：
- 每个飞书聊天（chat）独立绑定一个 DSH 会话，上下文互不干扰；
  该会话也会出现在 DSH Web 的会话列表里，可以随时在网页上查看历史。
- AI 回复较长时会分段发送。
- 机器人当前只处理文字消息，图片/文件会收到提示。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 启动报 "无法连接 DSH" | DSH Web 没开，或端口不是 52199（改 `dsh_base_url`） |
| 机器人收不到/发不出消息 | 权限没发布（第 6 步）、事件订阅不是长连接（第 5 步）、机器人没加进会话（第 8 步） |
| 群聊 @ 了没反应 | 确认开通 `im:message.group_at_msg` 并重新发布版本 |
| 报错 403 | DSH 的 /api 信任围栏拒绝了请求；确保 `dsh_base_url` 用的是 127.0.0.1 |
| 回复一直不出 | 看 `bridge.log`；可能是 AI 任务耗时长，`turn_timeout_seconds` 可调大 |
| 想让 AI 干活但不想被授权 | 桥接创建的会话使用 DSH 默认权限设置，注意在飞书里别把机器人拉进不可信群 |

---

## 可选：开机自启（Windows）

1. 在 `feishu-bridge` 目录运行：
   ```powershell
   python -m pip install pywin32
   python -c "import win32serviceutil"
   ```
2. 用任务计划程序（taskschd.msc）新建任务：
   - 触发器：登录时 / 系统启动时
   - 操作：启动程序 → `python`，参数 `<本目录>\feishu_bridge.py`，
     起始于 `<本目录>`
   - 条件：取消"只有在计算机使用交流电源时才启动"

## 安全提示

- 本桥接把"能指挥你电脑的 AI"接入了飞书：机器人回复会执行命令、读写文件。
  请务必只把机器人拉进**你自己**的私人群/单聊，不要公开分享。
- 修改 `turn_timeout_seconds` 可限制单次任务时长；DSH 侧还有权限预设
  （permission-presets）可以进一步收窄（例如只读）。

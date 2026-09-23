# Codex 接入与远程任务操作

小梦通过 Codex App Server 读取主机数据、创建和恢复任务，通过同用户桌面 IPC 操作桌面当前持有的任务。设计参考 ChatGPT Remote 的 **主机 → 项目 → 任务 → 指令 / 停止 / 审批 / 输出** 流程。手机连接小梦中心服务，模型调用和工具执行发生在 Codex 主机。

## 已实现

- 按主机组织 Claude、Codex 和自定义 Agent，按任务显示可用操作。
- 支持整台宿主机的项目和会话索引：所有模型提供商、历史工作目录、置顶与归档任务。
- 会话正文按需分页读取，每页 40 个条目，通过“加载更早的消息”继续读取。打开列表不加载所有会话正文。
- 实时助手回复、工具调用、终端输出、计划、文件 diff、完成 / 失败 / 中断状态。
- 新建、恢复、继续任务；运行中追加指令，校验当前轮次；停止当前执行。
- 命令、文件修改、额外权限审批，只授权本次请求，并等待主机确认。
- `requestUserInput` 问题的选项与文字回复。异步问题显示在消息中，可以通过追加指令回答。
- Android 后台通知；问题通知打开手机回复表单。

**v1.5 可直接操作当前桌面会话。** 接入端与 Codex 桌面在同一宿主机、同一用户下运行时，自动连接 Windows `\\.\pipe\codex-ipc`，发现会话持有者并订阅快照和增量更新。指令、停止、模型设置和审批交给持有者执行，避免另开一个写入同一会话的进程。未连接执行通道的活动任务仍保持只读。

会话顶部的“模型与主机能力”从 `model/list` 加载主机模型和支持的推理强度。修改模型、推理强度或执行 / 计划模式后等待主机回执，下一轮生效。空闲任务可压缩上下文；技能、MCP 服务和插件通过有名称的主机操作查询。

桌面适配使用 **内部版本化 IPC**，当前验证版本为 Windows Codex **26.903.8094.0**、状态协议 **11**。协议不匹配会停止订阅并提示更新适配器；这是兼容性限制，不能当作官方稳定 API。macOS / Linux 端点尚未实机验证。

本次不接入 ChatGPT 私有设备配对 / 中继，不提供屏幕视频、鼠标键盘远控、跨主机 Git 移交。截图附件、MCP 表单 / URL elicitation 尚未接入网页；桌面上的这些请求仍需在桌面处理。自定义 Agent 的额外能力通过目录和命名操作逐项接入，并非任意进程都已拥有完整远控。

## 启动

本机扫码连接推荐在 `server` 目录运行 `npm run host`，一并启动中心服务和 Codex 接入端。绑定入口以启动日志为准，网页会显示 Agent 在线状态。配置、令牌和数据库保存在用户目录 `.xiaomeng/host/`，可通过 `XIAOMENG_HOST_CONFIG` 指定独立配置文件。该入口默认导入整台主机的项目与会话，使用 `CODEX_SCOPE=projects` 和 `CODEX_PROJECTS` 可以限制范围。`LOCAL_CODEX=0` 可禁用本机 Codex 接入。

仅打开 Codex 桌面或仅启动 `npm start` 不会自动把 Codex 接入小梦；分别部署中心服务和接入端时按以下步骤运行。

中心服务设置 `AUTH_TOKEN` 后运行 `npm start`，参见主 README。

在 Codex 主机安装 Node.js ≥22.5、安装并登录 Codex CLI，然后在本项目 `server` 目录安装依赖。本版本以 **codex-cli 0.154.0** 导出的协议验证。

```powershell
$env:HUB_URL = 'http://中心电脑的局域网IP:4820'
$env:HUB_TOKEN = '中心服务的注册令牌'
$env:NODE_ID = 'codex-workstation-a'
$env:NODE_NAME = '开发电脑 A'
$env:CODEX_SCOPE = 'host'
$env:CODEX_PROJECTS = '["D:\\work\\project-a", "D:\\work\\project-b"]'
npm run agent:codex
```

`CODEX_SCOPE=host` 同步宿主机全部 Codex 会话，包括归档和旧模型提供商的记录。`CODEX_PROJECTS` 在此模式下只提供初始项目目录。桌面端保存的项目名称与项目归属从当前用户的 Codex 元数据索引只读补全，正文仍通过官方 App Server 获取。

不设置 `CODEX_SCOPE` 时，只同步 `CODEX_PROJECTS` 中的精确目录。它是绝对路径 JSON 数组，Windows 反斜杠需要转义；工作树目录也需加入。未设置项目时使用命令启动目录。

接入端必须以实际使用 Codex 的宿主机用户运行。自定义数据目录请设置 `CODEX_HOME`，并确保 CLI 使用相同目录。本地元数据结构可能随 Codex 版本变化，读取失败会记录日志并退回官方协议列表。远程 WebSocket 模式只索引该 App Server 提供的数据，不读取接入机的本地索引。

这里同步的是主机上已经保存的 **Codex 数据**。普通 ChatGPT 网页/手机端的云端聊天、尚未同步到此主机的数据，需要另行接入；本地索引不能读取这些内容。图片/音频结果目前显示附件提示，文本、终端输出和文件差异可以展开查看。

日志出现 `ready` 后，手机“远程主机与 Agent”中会出现 Codex。没有历史任务的项目也会显示，可通过项目右上角菜单新建会话。

默认使用本机 stdio App Server，不开放 Codex 网络端口。新建与恢复任务沿用主机模型、沙箱和审批策略，不修改为自动批准。Codex 凭据留在主机上。

## 电脑终端与小梦共享实时任务

第一个主机终端启动共享 App Server：

```powershell
codex app-server --listen ws://127.0.0.1:4500
```

第二个终端连接它：

```powershell
codex --remote ws://127.0.0.1:4500
```

第三个终端保留上一节的小梦环境变量，再设置：

```powershell
$env:CODEX_APP_SERVER_URL = 'ws://127.0.0.1:4500'
npm run agent:codex
```

接入端会订阅同一 App Server 内接受直接输入的活动任务，受所选 `CODEX_SCOPE / CODEX_PROJECTS` 范围约束。其他客户端处理了审批后，小梦会关闭对应待处理项。

显式配置 `CODEX_APP_SERVER_URL` 时使用共享服务，不连接本机桌面 IPC。保持默认 stdio 配置即可启用桌面发现。两种方式都需要在升级后回归验证。

## 配置

| 变量 | 说明 |
|---|---|
| `HUB_URL / HUB_TOKEN` | 小梦中心地址与注册令牌，与 Codex 登录凭据不同 |
| `NODE_ID / NODE_NAME` | 稳定主机标识与名称 |
| `AGENT_KEY / AGENT_NAME` | 默认 `codex / Codex`，同机多个实例使用不同 KEY |
| `CODEX_PROJECTS` | 精确匹配的绝对项目路径 JSON 数组 |
| `CODEX_SCOPE` | `host` 为全部主机会话；省略时按项目目录接入 |
| `CODEX_HOME` | 可选，Codex 数据目录，默认当前用户的 `.codex` |
| `CODEX_BIN` | 可选，Codex 可执行文件；Windows 支持 `codex.exe` 或 npm 包 `bin/codex.js` |
| `CODEX_APP_SERVER_URL` | 可选，共享 App Server 的 WebSocket 地址 |
| `CODEX_APP_SERVER_TOKEN` | 可选，共享 App Server 的传输认证令牌 |
| `CODEX_DESKTOP` | 默认自动连接本机桌面；设为 `0` 可关闭 |
| `CODEX_DESKTOP_PIPE` | 可选，覆盖本机桌面 IPC 路径 |
| `AGENT_STATE_FILE` | 默认用户目录 `.xiaomeng/agents/` 下的接入身份文件 |
| `CODEX_AGENT_STATE_FILE` | 默认身份文件旁的 `.threads.json`，保存 Codex 与小梦会话 ID 映射 |

保留身份和映射文件，重启后才能使用同一 Agent 与会话。每个实例仅运行一个接入进程。Codex 连接断开后接入端退出，中心在心跳过期后显示离线；重新运行相同命令恢复连接。操作不会因重连而自动重放。

`ws://` 只允许 loopback / SSH 本地转发；远程 App Server 必须使用 `wss://`。推荐在 Codex 主机运行接入端，主动连接中心。当前手机中心连接仍为 HTTP/WS，适用于可信局域网。

审批与问题默认 10 分钟过期；超时、停止与断线都不会自动批准。额外权限只授予展示的请求范围，作用域为当前轮。接入端收到相应 `serverRequest/resolved` 后才确认手机操作；未收到确认时报告结果未知。

## 验证与官方参考

```powershell
cd server
node --disable-warning=ExperimentalWarning --test test/codex.test.mjs test/codex-desktop.test.mjs test/codex-host.test.mjs test/platform.test.mjs
```

集成测试使用模拟桌面持有者、App Server 与真实小梦中心服务，不调用模型。真实宿主机已验证当前桌面会话实时状态、5 个可用模型，以及保留当前模型的设置回执（本机一次往返约 69 ms；非跨机器延迟承诺）。通过 Web 的“追加指令”发出的连通性测试消息，已由当前正在执行的桌面任务实际收到。跨机器网络和手机后台存活需部署后实机验证。

- [ChatGPT Remote 功能与主机连接](https://learn.chatgpt.com/docs/remote-connections)
- [Codex App Server 协议、任务和审批](https://learn.chatgpt.com/docs/app-server)

参考核对日期：2026-09-16。

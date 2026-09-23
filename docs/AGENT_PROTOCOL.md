# 小梦 Agent 接入协议 v1

中心服务提供统一的任务视图和远程操作队列。接入端在 Agent 所在机器运行，主动向中心服务发起 HTTP 请求。手机通过 REST/WebSocket 访问中心服务。接入端无需开放入站端口。

## 1. 身份与认证

平台模型是 **机器 → Agent 实例 → 项目 → 会话 → 事件/审批**。一个会话是当前 UI 中的任务执行单元。

- `nodeId`：稳定且在局域网内唯一的机器标识。建议显式配置；SDK 默认使用主机名，同名机器需要指定不同的 `NODE_ID`。
- `agentKey`：同一机器上的 Agent 实例名，例如 `claude-bridge`、`research-worker`。
- 平台生成 `agentId` 和独立的随机 Agent token。数据库仅保存 token 的 SHA-256 摘要。
- 接入端上传项目、会话和审批的原始 ID。平台根据所属 Agent 生成独立公共 ID；App 使用公共 ID，发给接入端的操作使用原始 ID。
- 每个 Agent token 只能上报自己的数据和读取自己的操作队列，不能访问手机端 `/api`。

中心服务必须配置 `AUTH_TOKEN` 才能接入远程 Agent。注册令牌可以另设 `AGENT_TOKEN`；未设置时使用 `AUTH_TOKEN`。已接入远程 Agent 的数据库不能在缺少 `AUTH_TOKEN` 时启动。

本协议面向可信局域网。HTTP 不提供传输加密；需要加密时在中心服务前配置 HTTPS 反向代理。SDK 支持 HTTPS 地址。

### 注册

`POST /agent/register`，请求头 `Authorization: Bearer <注册令牌>`：

```json
{
  "nodeId": "workstation-a",
  "nodeName": "开发电脑 A",
  "agentKey": "research-worker",
  "name": "研究助手",
  "provider": "custom",
  "capabilities": ["message.send", "session.stop", "approval.respond"]
}
```

返回 `201 {agentId, token, protocolVersion:1, heartbeatIntervalMs}`。后续 `/agent/*` 请求使用返回的独立 token。相同 `nodeId + agentKey` 不能重复注册，返回 409；请保留接入端凭据文件。

`POST /agent/profile` 可更新 `name/nodeName/provider/capabilities`，不能更改身份。SDK 重连时会把当前处理器对应的能力同步到平台。

`POST /agent/heartbeat {}` 更新在线状态。所有认证成功的 `/agent/*` 请求也会更新心跳。默认 45 秒未收到请求即离线。离线保留历史和最后任务状态，但禁止新远程操作。

## 2. 发布项目与会话

`POST /agent/projects {id, name, cwd}` 可单独发布尚无任务的项目，供手机新建会话。SDK 对应 `client.project(project)`。

`POST /agent/sessions`：

```json
{
  "project": {"id":"repo-a", "name":"业务系统", "cwd":"/work/repo-a"},
  "session": {"id":"task-42", "summary":"修复登录问题", "status":"running"}
}
```

返回 `{projectId, sessionId}`（公共 ID）。该接口是 upsert，可以重复上报。`session.updatedAt` 可指定历史更新时间，默认当前时间。默认禁止变更会话项目；宿主机项目归属同步可显式传入顶层 `allowProjectMove:true`，仍限制在同一 Agent 内。

项目可携带 `saved` 标记宿主机保存的项目。会话可携带 `archived/pinned/model/source/cwd`，保留归档、置顶、模型、来源和实际工作目录。

会话可提供 `capabilities`（Agent 能力的进一步限制）和 `controlReason`。空数组表示该任务只读；省略时兼容原行为。中心服务与手机都检查任务能力，新建任务仍检查项目所属 Agent 的能力。

状态：`running / waiting_input / needs_approval / done / ended / error / paused / rejected`。没有心跳不会被当成任务完成。项目优先显示待审批会话，否则显示最近更新的会话。

## 3. 事件与流式回复

`POST /agent/events`：

```json
{
  "sessionId":"task-42",
  "eventId":"message-unique-id",
  "type":"message.assistant",
  "text":"已完成修改。"
}
```

| type | 用途 | 其他字段 |
|---|---|---|
| `message.user` | 用户消息 | `text` |
| `message.assistant` | 助手文字，写入历史 | `text`, `phase?` |
| `thinking` | 执行方主动公开的思考摘要 | `text` |
| `tool.started` | 工具调用开始 | `toolName`, `text`（输入） |
| `tool.finished` | 工具调用结束 | `toolName`, `text`（结果）, `ok` |
| `tool.output` | 运行中的累计工具输出 | `toolName`, `toolCallId`, `text` |
| `task.status` | 状态与说明 | `status`, `text` |
| `assistant.start` | 开始回复 | — |
| `assistant.delta` | 流式更新 | `text` 是当前累计全文 |
| `assistant.done` | 结束回复 | `ok`, `error?`, `aborted?` |

非流式事件必须有 `eventId`，在同一 Agent、同一会话内去重，持久化到 SQLite。流式消息是即时广播；接入端必须另外发送 `message.assistant` 保存最终全文。

工具开始、输出与完成事件可携带同一 `toolCallId`，手机据此匹配并行工具。历史事件可提供毫秒 `createdAt`。`assistant.done` 的 `aborted:true` 表示中断，状态为 `paused`。

v1.6 可选展示字段：`turnId` 标识轮次，`itemId` 标识消息，`phase` 为 `commentary`（进度说明）或 `final_answer`（最终回复）。`assistant.delta` 与对应的 `message.assistant` 应提供相同标识与阶段，避免历史和实时内容重复。未提供 `phase` 的助手文字仍显示为普通回复。工具可通过 `toolInput` 保留原始输入，让详情区独立展示输入与结果。历史接口使用对应的 `turn_id/item_id/phase/tool_input` 字段。仅上传执行方主动公开的思考摘要。

旧 `/api/sessions/:id/events` 保留最近 2000 条的兼容行为。新版使用鉴权端点 `GET /api/sessions/:id/history?limit=40&cursor=...`，返回 `{events,nextCursor}`，事件从新到旧，limit 范围 1–100。

声明 `history.read` 能力的 Agent 接收 `{sessionId,cursor,limit}`，回执结果为 `{events,nextCursor}`。事件格式为 `session_id/hook_event_name/detail/created_at`，建议提供稳定 `event_key` 以便历史页与实时事件去重；工具可提供 `tool_name/tool_call_id/ok`。Codex 通过官方 `thread/items/list` 实现，不恢复或启动任务。相同页的并发请求会合并，正文只返回请求方，读取后清除命令回执正文。

未声明 `history.read` 的 Agent 从中心事件库分页。Codex 主机离线时完整历史读取返回错误，界面提供重试，项目和会话索引仍保留。

## 4. 接收与确认远程操作

`GET /agent/stream` 提供经过 Agent token 认证的 SSE。`data: commands` 通知 SDK 立即领取操作；重连后发送一次通知以检查未交付队列。流断开时自动恢复轮询，至多一次交付规则不变。

`GET /agent/commands` 返回最多 20 条操作。SDK 在 SSE 通知到达时立即请求，连接健康时最多每 5 秒检查一次，断线时最多每秒轮询（同时遵守心跳间隔）：

```json
[
  {
    "commandId":"平台生成的 UUID",
    "type":"message.send",
    "payload":{"sessionId":"task-42","text":"继续"},
    "expiresAt":1790000000000
  }
]
```

| 能力 / 操作 | payload | 接入方责任 |
|---|---|---|
| `message.send` | `sessionId, text` | 将消息交给对应会话，发送回复事件 |
| `message.steer` | `sessionId, text` | 向正在执行的轮次追加指令，轮次已结束时返回失败 |
| `session.start` | `projectId, sessionId, text` | 使用平台指定的原始 `sessionId` 创建会话并上报 |
| `session.stop` | `sessionId` | 停止对应任务并报告状态；不支持停止时返回失败 |
| `approval.respond` | `approvalId, decision, scope` | 确认审批仍有效，再交给实际权限控制流程 |
| `agent.catalog` | `sessionId?` | 返回主机实际模型、模式、命名操作目录 |
| `session.configure` | `sessionId, settings` | `model/reasoningEffort/mode`；确认主机已应用或保存后返回 |
| `session.compact` | `sessionId` | 压缩当前会话上下文 |
| `agent.action` | `sessionId?, name, arguments` | 执行接入端实现的命名操作；必须校验名称和参数 |

`POST /agent/commands/:commandId/result`：

```json
{"ok":true,"result":{"accepted":true}}
```

失败返回 `{"ok":false,"error":"具体原因"}`。`ok:true` 表示接入端已接受并应用相应操作，不代表整个任务完成；任务完成通过事件上报。耗时任务应在处理器中启动工作后及时返回，避免等待整个模型回复后才确认。

操作状态：`queued → delivered → succeeded/failed`。默认 60 秒内必须收到回执。已经交付但超时或中心服务重启时，标为“执行结果未知”，不会自动再次交付。接入端收到操作后也必须检查 `expiresAt`。

交付采用**至多一次**策略：如果轮询响应在网络中丢失，操作可能没有执行，最终会超时。平台优先避免工具动作因网络重试被重复执行。SDK 只重试回执，不重新执行处理器。接入端进程重启后丢失的未确认回执由中心服务超时处理。

App 可在提交消息、新会话、停止时附带 `requestId`，同一 Agent 下同键同参数返回原操作；同键不同参数返回 409。通过 `GET /api/commands/:id` 查询结果。

## 5. 审批

`POST /agent/approvals`：

```json
{
  "id":"permission-42",
  "sessionId":"task-42",
  "kind":"command",
  "title":"允许执行此操作？",
  "command":"实际操作内容",
  "risk":"normal",
  "ttlMs":120000
}
```

`kind` 支持 `command/file_edit/input`，文件操作可传 `filePath/diff`。`ttlMs` 为 1000～1800000，默认 30 分钟。

`input` 携带 `questions:[{id,question,isSecret?,options:[{label,description?}]}]`。用户回复时发送 `decision:"approve", answers:{问题ID:"回复文字"}`；所有问题必须回答。`decision:"reject"` 表示取消。接入端 `approval.respond` 处理器收到相同 `answers`，只在原问题仍有效时交给主机。

用户提交决定后进入操作队列。**收到接入端成功回执后**才把审批标为 approved/denied，随后广播 `approval.resolved`。通用审批只支持 `scope:"once"`，不假设其他 Agent 存在 Claude 的会话级永久授权语义。

接入端本地处理了审批、停止任务或原审批已失效时，调用 `POST /agent/approvals/:原始ID/resolve {status:"approved"|"denied"|"expired"}` 同步状态，同时取消尚未交付的审批决定。审批到期后不再交付决定；接入端必须自行终止等待或回到本地权限流程，**不能因为断线或超时而自动批准**。

## 6. 手机端接口

以下接口使用 `Authorization: Bearer <AUTH_TOKEN>`：

- `GET /api/agents`：所有本地/远程 Agent 与能力。
- `GET /api/projects`、`GET /api/projects/:id/sessions`：统一项目与会话。
- `GET /api/sessions/:id/events`：统一会话历史。
- `POST /api/sessions/:id/message {text, requestId?}`：发送消息，返回 202。
- `POST /api/sessions/:id/steer {text, requestId?}`：运行中追加指令，返回 202；WebSocket 对应 `message.steer`。
- `POST /api/projects/:id/sessions {text, requestId?}`：新会话，返回 202 和公共 `sessionId`。
- `POST /api/sessions/:id/control {action:"stop", requestId?}`：停止。
- `GET /api/approvals`、`POST /api/approvals/:id {decision, scope?, answers?}`：审批或问题回复。
- `GET /api/commands/:id`：远程操作状态。
- `GET /api/agents/:id/catalog?sessionId=...`：模型与能力目录。
- `POST /api/sessions/:id/configure {settings, requestId?}`：等待主机确认模型、推理强度、模式设置；最多等待 30 秒。
- `POST /api/sessions/:id/compact {requestId?}`：上下文压缩。
- `POST /api/agents/:id/actions {sessionId?, name, arguments, requestId?}`：主机命名操作。平台检查 Agent 与会话归属，接入端负责操作白名单和参数校验。

目录格式：`{models:[{id,name,description?,reasoningEfforts:[],defaultReasoningEffort?}], modes:[{id,name}], actions:[{id,name,description}], settingsApply:"next_turn"}`。当前 Web 对命名操作提供无参数查询入口，额外输入交互需在前端添加对应表单。配置结果格式为 `{confirmed:true,appliesTo:"next_turn",settings}`；失败不得返回成功回执。会话可上报 `model/reasoningEffort/mode/controlTransport` 元数据。

WebSocket 为 `/ws?token=<AUTH_TOKEN>`。除原来的项目、历史、审批和回复事件外，增加 `agents.snapshot`、`approvals.snapshot`、`command.accepted`、`command.result`、`command.error`。`command.result.operation` 表示操作名；顶层 `type` 始终是消息类型。

Claude Code 的本机适配保留原始公共 ID，因此旧 App 的项目和会话关联仍然有效。本机 Claude hooks 继续使用 `/hooks/event` 与 `/hooks/gate`。

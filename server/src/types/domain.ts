/** 中心服务的领域契约；显式区分远端输入、存储行与客户端视图，保留现有协议字段名。 */

/** 下一轮执行的可选设置，不隐式更改正在运行的轮次。 */
export interface SessionSettings {
  /** 主机提供的模型标识。 */
  model?: string;
  /** 模型推理强度，由主机能力目录校验。 */
  reasoningEffort?: string;
  /** 执行或计划模式。 */
  mode?: string;
}

/** Agent 声明的身份和能力；用于隔离不同主机的资源。 */
export interface AgentProfile {
  /** 持久主机标识。 */
  nodeId: string;
  /** 展示给用户的主机名称。 */
  nodeName: string;
  /** 同一主机内稳定的 Agent 标识。 */
  agentKey: string;
  /** Agent 显示名称。 */
  name: string;
  /** 执行提供方，例如 claude 或 codex。 */
  provider: string;
  /** 已实现的操作名称，未声明的操作不可分发。 */
  capabilities: string[];
  /** 接入协议版本。 */
  protocolVersion?: number;
}

/** 加入在线状态的 Agent 客户端视图。 */
export interface AgentView extends AgentProfile {
  /** 中心分配的身份 ID。 */
  agentId: string;
  /** 心跳是否仍在有效期内。 */
  online: boolean;
  /** 最近心跳的毫秒时间戳。 */
  lastSeenAt?: number;
}

/** 首次注册后保存到本机的接入凭据。 */
export interface Credentials {
  /** 中心分配的 Agent ID。 */
  agentId: string;
  /** 只供该 Agent 接入使用的令牌。 */
  token: string;
  /** 中心支持的协议版本。 */
  protocolVersion?: number;
  /** 建议的心跳周期。 */
  heartbeatIntervalMs?: number;
}

/** 接入端上报的项目元数据。 */
export interface RemoteProjectInput {
  /** Agent 范围内的项目标识。 */
  id: string;
  /** 项目显示名称。 */
  name: string;
  /** 项目工作目录。 */
  cwd?: string;
  /** 是否由主机显式保存。 */
  saved?: boolean;
}

/** 接入端上报的会话状态。 */
export interface RemoteSessionInput {
  /** Agent 范围内的会话标识。 */
  id: string;
  /** 执行时使用的目录。 */
  cwd?: string;
  /** 列表中的简短说明。 */
  summary?: string;
  /** 当前任务状态。 */
  status?: string;
  /** 最后变化的毫秒时间戳。 */
  updatedAt?: number;
  /** 该会话可执行的能力；覆盖 Agent 默认能力。 */
  capabilities?: string[];
  /** 可控或只读状态的原因。 */
  controlReason?: string;
  /** 是否已归档。 */
  archived?: boolean;
  /** 是否在主机置顶。 */
  pinned?: boolean;
  /** 当前模型。 */
  model?: string;
  /** 会话来源客户端。 */
  source?: string;
  /** 当前推理强度。 */
  reasoningEffort?: string;
  /** 工作模式。 */
  mode?: string;
  /** 主机实际执行操作的通道。 */
  controlTransport?: string;
}

/** 项目与会话一起上报，以维持归属一致性。 */
export interface SessionInput {
  /** 会话所属项目。 */
  project: RemoteProjectInput;
  /** 最新会话状态。 */
  session: RemoteSessionInput;
  /** 主机索引同步时是否允许调整项目归属。 */
  allowProjectMove?: boolean;
}

/** 提供给客户端的会话摘要，兼容原有下划线字段。 */
export interface SessionView extends SessionSettings {
  /** 中心或本机会话 ID。 */
  session_id: string;
  /** 旧记录可能缺失的文本信息。 */
  cwd?: string | null;
  /** 任务状态。 */
  status: string;
  /** 旧记录可能缺失的文本信息。 */
  summary?: string | null;
  /** 首次活动的毫秒时间戳。 */
  started_at?: number | null;
  /** 最近更新时间，单位毫秒。 */
  updated_at?: number;
  /** 最近 hook 事件名称。 */
  last_event?: string;
  /** 最近一次调用的工具名称。 */
  last_tool?: string | null;
  /** 会话级能力限制。 */
  capabilities?: string[];
  /** 操作可用性的解释。 */
  controlReason?: string;
  /** 归档标记。 */
  archived?: boolean;
  /** 置顶标记。 */
  pinned?: boolean;
  /** 会话来源。 */
  source?: string;
  /** 控制通道标识。 */
  controlTransport?: string;
}

/** 用户输入问题的候选项。 */
export interface QuestionOption {
  /** 提交时使用的选项文字。 */
  label: string;
  /** 选项影响的补充说明。 */
  description?: string;
}

/** 主机请求用户补充的信息。 */
export interface InputQuestion {
  /** 关联答案的稳定问题 ID。 */
  id: string;
  /** 完整问题。 */
  question: string;
  /** 是否需要在客户端隐藏输入。 */
  isSecret?: boolean;
  /** 可选答案；缺省允许自由输入。 */
  options?: QuestionOption[];
}

/** 中心向客户端发送的审批或输入请求。 */
export interface ApprovalView {
  /** 中心审批 ID。 */
  approvalId: string;
  /** 所属会话 ID。 */
  sessionId: string;
  /** 所属项目 ID。 */
  projectId: string;
  /** command、file_edit 或 input。 */
  kind: string;
  /** 用户可读的审批标题。 */
  title: string;
  /** 待执行命令或权限说明。 */
  command?: string | null;
  /** 受影响文件路径。 */
  filePath?: string | null;
  /** 供用户审阅的文本差异。 */
  diff?: string | null;
  /** 风险提示等级。 */
  risk?: string | null;
  /** 允许的审批范围。 */
  options: string[];
  /** pending 或最终结果。 */
  status?: string;
  /** 创建时间，单位毫秒。 */
  createdAt: number;
  /** 最晚有效时间，单位毫秒。 */
  expiresAt: number;
  /** 输入型审批的问题。 */
  questions?: InputQuestion[];
}

/** 接入端提交审批时使用的标识和时限。 */
export interface ApprovalInput {
  /** 主机审批 ID。 */
  id: string;
  /** 主机会话 ID。 */
  sessionId: string;
  /** 审批种类，默认命令。 */
  kind?: string;
  /** 展示给用户的标题。 */
  title: string;
  /** 命令或权限说明。 */
  command?: string;
  /** 相关文件。 */
  filePath?: string;
  /** 文件差异。 */
  diff?: string;
  /** 风险等级。 */
  risk?: string;
  /** 用户输入问题。 */
  questions?: InputQuestion[];
  /** 审批有效时长。 */
  ttlMs?: number;
}

/** 聚合会话、审批和在线状态的项目卡片。 */
export interface ProjectView {
  /** 中心或本机项目 ID。 */
  projectId: string;
  /** 项目显示名称。 */
  name: string;
  /** 工作目录。 */
  cwd: string;
  /** 优先展示待审批，否则展示活跃会话状态。 */
  status: string;
  /** 当前代表会话。 */
  activeSessionId: string | null;
  /** 活跃会话摘要。 */
  summary?: string | null;
  /** 可选进度。 */
  progress?: number | null;
  /** 当前待处理审批。 */
  pendingApproval: ApprovalView | null;
  /** 最近事件时间。 */
  lastEventAt: number;
  /** 会话总数。 */
  sessionCount?: number;
  /** 按更新时间排序的会话。 */
  sessions?: SessionView[];
  /** 项目所属 Agent。 */
  agentId?: string;
  /** Agent 名称。 */
  agentName?: string;
  /** 执行提供方。 */
  provider?: string;
  /** 主机 ID。 */
  nodeId?: string;
  /** 主机名称。 */
  nodeName?: string;
  /** 主机是否在线。 */
  online?: boolean;
  /** 主机支持的操作。 */
  capabilities?: string[];
}

/** 历史记录与实时追加共用的事件格式。 */
export interface TaskEvent {
  /** 存储序号或页面内顺序。 */
  id?: number;
  /** 跨同步去重的事件键。 */
  event_key?: string;
  /** 所属会话。 */
  session_id?: string | null;
  /** 兼容客户端的事件类别。 */
  hook_event_name: string;
  /** 工具显示名称。 */
  tool_name?: string | null;
  /** 配对工具开始与结束事件的 ID。 */
  tool_call_id?: string | null;
  /** 工具输入摘要。 */
  tool_input?: string | null;
  /** 执行轮次 ID。 */
  turn_id?: string | null;
  /** 轮次内项目 ID。 */
  item_id?: string | null;
  /** 回复阶段。 */
  phase?: string | null;
  /** 事件对应的任务状态。 */
  status?: string;
  /** 简短说明。 */
  summary?: string | null;
  /** 正文或工具输出。 */
  detail?: string | null;
  /** 成功标记，null 表示未知。 */
  ok?: boolean | null;
  /** 原始 hook 的审计副本。 */
  raw_json?: string;
  /** 事件发生时间，单位毫秒。 */
  created_at?: number | null;
}

/** Agent 上报事件；瞬时 delta 不进入历史存储。 */
export interface EventInput {
  /** 所属主机会话 ID。 */
  sessionId?: string;
  /** 协议事件类别。 */
  type?: string;
  /** 持久事件去重标识。 */
  eventId?: string;
  /** 正文或输出。 */
  text?: string | null;
  /** 回复阶段。 */
  phase?: string | null;
  /** 轮次 ID。 */
  turnId?: string | null;
  /** 轮次内项目 ID。 */
  itemId?: string | null;
  /** 工具名称。 */
  toolName?: string | null;
  /** 工具调用关联 ID。 */
  toolCallId?: string | null;
  /** 工具输入文本。 */
  toolInput?: string | null;
  /** 任务状态。 */
  status?: string;
  /** 摘要。 */
  summary?: string;
  /** 是否成功。 */
  ok?: boolean | null;
  /** 错误说明。 */
  error?: string | null;
  /** 是否由用户终止。 */
  aborted?: boolean;
  /** 事件时间。 */
  createdAt?: number | null;
}

/** 中心到 Agent 的操作参数；不同操作使用对应字段。 */
export interface CommandPayload {
  /** 目标主机会话。 */
  sessionId?: string;
  /** 新建会话的主机项目。 */
  projectId?: string;
  /** 待回复的主机审批。 */
  approvalId?: string;
  /** 用户指令。 */
  text?: string;
  /** approve 或 reject。 */
  decision?: string;
  /** 审批有效范围。 */
  scope?: string;
  /** 按问题 ID 组织的回复。 */
  answers?: Record<string, string>;
  /** 下一轮设置。 */
  settings?: SessionSettings;
  /** 历史分页游标。 */
  cursor?: string | null;
  /** 历史页大小。 */
  limit?: number;
  /** 主机动作名称。 */
  name?: string;
  /** 动作提供方定义的参数。 */
  arguments?: Record<string, unknown>;
}

/** Agent 完成操作后给出的回执，写入成功不等于执行成功。 */
export interface CommandReceipt {
  /** 主机是否确认执行成功。 */
  ok: boolean;
  /** 主机返回的错误。 */
  error?: string;
  /** 操作专属结果；由调用方按操作类型解码。 */
  result?: unknown;
}

/** 待领取的远程操作。 */
export interface AgentCommand {
  /** 中心命令 ID，也是回执关联键。 */
  commandId: string;
  /** 已声明的操作名称。 */
  type: string;
  /** 与操作匹配的参数。 */
  payload: CommandPayload;
  /** 超过该时刻不可执行。 */
  expiresAt: number;
}

/** 中心记录的远程命令状态。 */
export interface CommandView {
  /** 中心命令 ID。 */
  commandId: string;
  /** 操作名称。 */
  operation: string;
  /** 排队、已投递或最终执行状态。 */
  status: string;
  /** 关联的中心会话。 */
  sessionId: string | null;
  /** 入队时间。 */
  createdAt: number;
  /** 回执期限。 */
  expiresAt: number;
  /** 最终回执；尚未完成时为 null。 */
  result: CommandReceipt | null;
}

/** 一页历史，游标由数据来源解释。 */
export interface HistoryPage {
  /** 当前页事件。 */
  events: TaskEvent[];
  /** 后续页游标；null 表示结束。 */
  nextCursor: string | null;
}

/** 命令关联信息与幂等键。 */
export interface QueueOptions {
  /** 关联中心会话。 */
  sessionId?: string | null;
  /** 关联中心审批。 */
  approvalId?: string | null;
  /** 调用方生成的幂等键。 */
  requestId?: string;
}

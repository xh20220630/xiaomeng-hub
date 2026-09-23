/** SQLite 行契约；只有仓储层可以依赖列名和 JSON 存储布局。 */
import type {
  SessionView,
  TaskEvent,
  AgentProfile,
  RemoteProjectInput,
  ApprovalView,
} from './domain.js';

/** 接入身份及心跳的持久化记录。 */
export interface AgentRow extends JsonRow<AgentProfile> {
  /** 中心 Agent ID。 */
  id: string;
  /** 所属主机。 */
  node_id: string;
  /** 主机内的 Agent 标识。 */
  agent_key: string;
  /** 接入令牌的散列。 */
  token_hash: string;
  /** 序列化 AgentProfile。 */
  data: string;
  /** 最近心跳时间。 */
  last_seen: number;
}

/** 远程项目的归属映射。 */
export interface ProjectRow extends JsonRow<Omit<RemoteProjectInput, 'id'>> {
  /** 中心项目 ID。 */
  id: string;
  /** 拥有该项目的 Agent。 */
  agent_id: string;
  /** 主机项目 ID。 */
  remote_id: string;
  /** 序列化项目元数据。 */
  data: string;
}

/** 远程会话的归属映射。 */
export interface RemoteSessionRow extends Omit<ProjectRow, 'shape'>, JsonRow<SessionView> {
  /** 所属中心项目。 */
  project_id: string;
}

/** 远程审批的状态与时限。 */
export interface RemoteApprovalRow extends Omit<ProjectRow, 'shape'>, JsonRow<ApprovalView> {
  /** 所属中心会话。 */
  session_id: string;
  /** 当前审批状态。 */
  status: string;
  /** 审批有效期限。 */
  expires_at: number;
}

/** 可按序分页的持久事件。 */
export interface RemoteEventRow extends JsonRow<TaskEvent> {
  /** 自增事件序号。 */
  id: number;
  /** 事件来源 Agent。 */
  agent_id: string;
  /** 中心会话 ID。 */
  session_id: string;
  /** 幂等事件键。 */
  event_key: string;
  /** 序列化 TaskEvent。 */
  data: string;
}

/** 远程命令的投递与回执记录。 */
export interface CommandRow {
  /** 中心命令 ID。 */
  id: string;
  /** 执行 Agent。 */
  agent_id: string;
  /** 关联中心会话。 */
  session_id: string | null;
  /** 关联中心审批。 */
  approval_id: string | null;
  /** 调用方幂等键。 */
  request_key: string;
  /** 操作名称。 */
  type: string;
  /** 序列化操作参数。 */
  payload: string;
  /** 投递及完成状态。 */
  status: string;
  /** 创建时间。 */
  created_at: number;
  /** 最后可接受回执时间。 */
  expires_at: number;
  /** 序列化执行回执。 */
  result: string | null;
}

/** 本机 SQLite 会话记录。 */
export interface LocalSessionRow extends SessionView {
  /** 列表排序所用的最后活动时间。 */
  updated_at: number;
  /** 最近状态说明。 */
  summary: string;
  /** 最近 hook 名称。 */
  last_event: string;
  /** 首次记录时间。 */
  started_at: number;
}

/** SQLite 将布尔执行结果编码为整数。 */
export interface LocalEventRow extends Omit<TaskEvent, 'ok'> {
  /** 1 为成功，0 为失败，null 为未知。 */
  ok: number | null;
}

/** 本机 hook 审批的存储行。 */
export interface ApprovalRow {
  /** 审批 ID。 */
  approval_id: string;
  /** 所属会话。 */
  session_id: string | null;
  /** 所属项目。 */
  project_id: string | null;
  /** 审批类别。 */
  kind: string;
  /** 展示标题。 */
  title: string;
  /** 待审命令。 */
  command: string | null;
  /** 相关文件。 */
  file_path: string | null;
  /** 文件差异。 */
  diff: string | null;
  /** 风险等级。 */
  risk: string | null;
  /** 序列化审批选项。 */
  options: string;
  /** 当前审批状态。 */
  status: string;
  /** 创建时间。 */
  created_at: number;
  /** 过期时间。 */
  expires_at: number;
  /** 最终决策时间。 */
  resolved_at: number | null;
  /** 决策来源。 */
  decided_by: string | null;
}

/** JSON 列的编译期关联，不向数据库写入 shape。 */
export interface JsonRow<T> {
  /** 数据库中的序列化正文。 */
  data: string;
  /** 仅供类型推导的领域结构，不存在于运行时行中。 */
  readonly shape?: T;
}

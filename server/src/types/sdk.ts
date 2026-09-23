/** SDK 操作契约；通过操作名约束必需参数，避免缺少会话 ID 的命令进入处理器。 */
import type { AgentCommand, CommandPayload } from './domain.js';

/** 取出某操作必须具备的参数，其余参数保留为可选。 */
export type CommandInput<K extends keyof CommandPayload> = CommandPayload &
  Required<Pick<CommandPayload, K>>;

/** 每种远程操作的参数要求。 */
export interface CommandInputs {
  /** 续聊必须指定会话与指令。 */
  'message.send': CommandInput<'sessionId' | 'text'>;
  /** 向执行中的会话追加指令。 */
  'message.steer': CommandInput<'sessionId' | 'text'>;
  /** 使用中心预分配的会话 ID 创建任务。 */
  'session.start': CommandInput<'sessionId' | 'projectId' | 'text'>;
  /** 终止指定会话当前执行。 */
  'session.stop': CommandInput<'sessionId'>;
  /** 回复指定审批。 */
  'approval.respond': CommandInput<'approvalId' | 'decision'>;
  /** 按游标读取会话历史。 */
  'history.read': CommandInput<'sessionId'>;
  /** 查询主机能力，可按会话细化。 */
  'agent.catalog': CommandPayload;
  /** 修改下一轮设置。 */
  'session.configure': CommandInput<'sessionId' | 'settings'>;
  /** 压缩会话上下文。 */
  'session.compact': CommandInput<'sessionId'>;
  /** 调用主机公开的只读能力。 */
  'agent.action': CommandInput<'name'>;
}

/** 已注册处理器决定向中心声明哪些能力。 */
export type AgentHandlers = {
  [K in keyof CommandInputs]?: (payload: CommandInputs[K], command: AgentCommand) => unknown;
};

/** Agent 接入的连接和身份配置。 */
export interface AgentClientOptions {
  /** 中心 HTTP 地址。 */
  hubUrl: string;
  /** 首次注册使用的管理员或专用注册令牌。 */
  enrollmentToken?: string;
  /** 主机稳定 ID，默认使用主机名。 */
  nodeId?: string;
  /** 展示用主机名。 */
  nodeName?: string;
  /** 同一主机下的 Agent 唯一键。 */
  agentKey: string;
  /** 展示给客户端的 Agent 名称。 */
  name: string;
  /** 执行提供方名称。 */
  provider?: string;
  /** 远程操作处理器。 */
  handlers?: AgentHandlers;
  /** 凭据保存路径，重连应复用。 */
  stateFile?: string;
  /** 后台错误报告，不影响轮询重试。 */
  onError?: (error: Error) => void;
  /** 执行通道可用时才领取命令。 */
  isAvailable?: () => boolean;
}

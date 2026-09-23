/** Codex 协议边界的已使用字段；二进制结果与提供方扩展保留为 unknown。 */
import type { InputQuestion } from './domain.js';

/** 协议中的文本或多媒体内容块。 */
export interface CodexContent {
  /** 内容种类。 */
  type: string;
  /** 可显示文本。 */
  text?: string;
  /** 资源标题。 */
  title?: string;
  /** 资源名称。 */
  name?: string;
  /** 资源地址。 */
  uri?: string;
  /** 嵌入资源的可显示文本。 */
  resource?: {
    /** 可直接展示的文本内容。 */
    text?: string;
  };
  /** 二进制内容的编码，不向历史事件复制。 */
  data?: string;
}

/** 一个轮次中的消息或工具活动。 */
export interface CodexItem {
  /** 轮次内稳定项目 ID。 */
  id: string;
  /** 消息或工具活动类别。 */
  type: string;
  /** 活动执行状态。 */
  status?: string;
  /** 助手消息或计划文本。 */
  text?: string;
  /** commentary 或 final_answer。 */
  phase?: string | null;
  /** 用户输入或多模态内容。 */
  content?: CodexContent[];
  /** 可公开的推理摘要。 */
  summary?: string[];
  /** 终端执行命令。 */
  command?: string;
  /** 累计终端输出。 */
  aggregatedOutput?: string;
  /** 文件路径及修改差异。 */
  changes?: {
    /** 文件位置或请求路径。 */
    path: string;
    /** 供用户审阅的文件差异。 */
    diff: string;
  }[];
  /** MCP 服务器标识。 */
  server?: string;
  /** 工具名称。 */
  tool?: string;
  /** 审查说明。 */
  review?: string;
  /** 工具专属结果。 */
  result?: unknown;
  /** 工具专属参数。 */
  arguments?: unknown;
  /** 外部动作详情。 */
  action?: unknown;
  /** 工具是否成功。 */
  success?: boolean;
  /** 助手消息中附带的选择题。 */
  questions?: {
    /** 展示给用户的标题。 */
    title: string;
    /** 可选择的候选项。 */
    options?: string[];
  }[];
}

/** App Server 的执行轮次。 */
export interface CodexTurn {
  /** 轮次 ID。 */
  id: string;
  /** 轮次执行状态。 */
  status: string;
  /** 轮次内事件，按时间排序。 */
  items?: CodexItem[];
  /** 开始时间，单位秒。 */
  startedAt?: number;
  /** 完成时间，单位秒。 */
  completedAt?: number;
  /** 执行错误。 */
  error?: {
    /** 供用户或等待方理解的说明。 */
    message: string;
  };
}

/** Codex 下一轮协作模式。 */
export interface CollaborationMode {
  /** 执行或计划模式。 */
  mode: string;
  /** 模式对应模型设置。 */
  settings?: {
    /** 主机模型标识。 */
    model?: string;
    /** 主机协作模式使用的推理强度字段。 */
    reasoning_effort?: string | null;
    /** 主机协作模式内的附加指令，默认不覆盖。 */
    developer_instructions?: string | null;
  };
}

/** 主机维护的线程级设置。 */
export interface ThreadSettings {
  /** 模型标识。 */
  model?: string;
  /** 推理强度。 */
  effort?: string | null;
  /** 协作模式。 */
  collaborationMode?: CollaborationMode;
}

/** 本地索引与 App Server 共用的线程摘要。 */
export interface CodexThread {
  /** Codex 线程 ID。 */
  id: string;
  /** 工作目录。 */
  cwd?: string;
  /** 线程名称。 */
  name?: string | null;
  /** 首条指令摘要。 */
  preview?: string;
  /** 运行状态。 */
  status?: {
    /** 决定负载解释方式的协议类别。 */
    type: string;
  };
  /** 已读取的执行轮次。 */
  turns?: CodexTurn[];
  /** 本机历史索引提供的最近轮次状态。 */
  lastTurnStatus?: string;
  /** 最近更新时间，单位秒。 */
  updatedAt?: number;
  /** 创建时间，单位秒。 */
  createdAt?: number;
  /** 是否归档。 */
  archived?: boolean;
  /** 是否在主机置顶。 */
  isPinned?: boolean;
  /** 主机保存项目的 ID。 */
  projectId?: string | null;
  /** 会话来源。 */
  threadSource?: string | null;
  /** 当前模型。 */
  model?: string | null;
  /** 当前推理强度。 */
  reasoningEffort?: string | null;
  /** 当前协作模式。 */
  collaborationMode?: CollaborationMode;
  /** 主机是否允许通过 App Server 输入。 */
  canAcceptDirectInput?: boolean | null;
  /** 是否由桌面通道持有。 */
  desktopOwned?: boolean;
}

/** 主机当前账户可用的模型能力。 */
export interface CodexModel {
  /** 模型标识。 */
  model: string;
  /** 展示名称。 */
  displayName?: string;
  /** 模型说明。 */
  description?: string;
  /** 可选推理强度。 */
  supportedReasoningEfforts?: {
    /** 模型支持的推理强度标识。 */
    reasoningEffort: string;
  }[];
  /** 默认推理强度。 */
  defaultReasoningEffort?: string;
}

/** 只读主机数据库提供的补充索引。 */
export interface HostIndex {
  /** 主机保存的项目。 */
  projects: {
    /** 当前契约中的实体或活动标识。 */
    id: string;
    /** 用于界面展示或协议寻址的名称。 */
    name: string;
    /** 主机执行任务时的工作目录。 */
    cwd: string;
  }[];
  /** 包含归档和旧版本线程的摘要。 */
  threads: CodexThread[];
}

/** Codex 向客户端发起的审批或问题。 */
export interface RequestParams {
  /** 所属线程。 */
  threadId: string;
  /** 所属轮次。 */
  turnId?: string;
  /** 所属工具活动。 */
  itemId?: string;
  /** 输入问题。 */
  questions?: InputQuestion[];
  /** 请求的权限对象。 */
  permissions?: unknown;
  /** 网络访问上下文。 */
  networkApprovalContext?: unknown;
  /** 待批准命令。 */
  command?: string;
  /** 请求理由。 */
  reason?: string;
  /** 额外权限说明。 */
  additionalPermissions?: unknown;
  /** 主机实际接受的决策值。 */
  availableDecisions?: string[];
}

/** 需要客户端回复的 JSON-RPC 请求。 */
export interface ServerRequest {
  /** 协议请求 ID。 */
  id: string | number;
  /** 审批或问题方法。 */
  method: string;
  /** 请求详情。 */
  params: RequestParams;
}

/** 等待用户选择并等待主机确认的审批。 */
export interface PendingApproval {
  /** 中心审批 ID。 */
  id: string;
  /** 原始主机请求 ID。 */
  rpcId: string | number;
  /** 主机方法名称。 */
  method: string;
  /** 请求详情。 */
  params: RequestParams;
  /** 审批最晚有效时刻。 */
  expiresAt: number;
  /** 本地过期计时器。 */
  timer?: ReturnType<typeof setTimeout>;
  /** 是否已经提交决策。 */
  responding?: boolean;
  /** 待主机确认的结果。 */
  outcome?: string;
  /** 等待主机最终确认的回调。 */
  confirm?: {
    /** 收到对应主机确认后完成等待。 */
    resolve: (value: {
      /** 是否已得到主机的最终确认。 */
      confirmed: boolean;
    }) => void;
    /** 主机失败、断线或超时后终止等待。 */
    reject: (error: unknown) => void;
  };
}

/** 为降低推送频率而暂存的终端输出。 */
export interface ToolStream {
  /** 累计且截断的输出。 */
  text: string;
  /** 最近推送时间。 */
  lastAt: number;
  /** 生成去重事件键的序号。 */
  count: number;
  /** 待触发的节流任务。 */
  timer?: ReturnType<typeof setTimeout> | null;
}

/** 桌面 IPC 使用 turnId 表示轮次。 */
export interface DesktopTurn {
  /** 桌面轮次 ID。 */
  turnId: string;
  /** 执行状态。 */
  status: string;
  /** 轮次活动列表。 */
  items?: CodexItem[];
  /** 轮次开始时间，单位毫秒。 */
  turnStartedAtMs?: number;
}

/** 桌面端同步的会话状态。 */
export interface DesktopState {
  /** 桌面会话 ID。 */
  id?: string;
  /** 当前工作目录。 */
  cwd: string;
  /** 会话标题。 */
  title: string;
  /** 更新时间，单位毫秒。 */
  updatedAt: number;
  /** 实时执行状态。 */
  threadRuntimeStatus: {
    /** 决定负载解释方式的协议类别。 */
    type: string;
  };
  /** 最近线程设置。 */
  latestThreadSettings?: ThreadSettings;
  /** 旧版状态中的模型。 */
  latestModel?: string;
  /** 旧版状态中的推理强度。 */
  latestReasoningEffort?: string;
  /** 旧版状态中的工作模式。 */
  latestCollaborationMode?: CollaborationMode;
  /** 旧版状态中的轮次列表。 */
  turns?: DesktopTurn[];
  /** 规范化存储的轮次历史。 */
  turnHistory?: {
    /** 数据结构的表示形式或业务类别。 */
    kind: string;
    /** 规范化的桌面轮次历史。 */
    history: {
      /** 历史中保持顺序的连续片段。 */
      islands: {
        /** 片段内的有序条目引用。 */
        entries: {
          /** 引用键或补丁需要写入的值。 */
          value: string;
        }[];
      }[];
      /** 按稳定键保存的轮次实体。 */
      entitiesByKey: Record<string, DesktopTurn>;
    };
  };
  /** 当前待回复的主机请求。 */
  requests?: ServerRequest[];
}

/** 桌面会话增量补丁；路径禁止原型相关键。 */
export interface DesktopPatch {
  /** add、replace 或 remove。 */
  op: string;
  /** 从状态根节点开始的路径。 */
  path: (string | number)[];
  /** 新增或替换的值。 */
  value?: unknown;
}

/** 桌面操作的传输回执。 */
export interface DesktopReply {
  /** 关联的请求 ID。 */
  requestId: string;
  /** success 或错误状态。 */
  resultType: string;
  /** 实际持有会话的客户端。 */
  handledByClientId?: string;
  /** 操作专属返回内容。 */
  result?: {
    /** 桌面为当前接入端分配的身份。 */
    clientId?: string;
    [key: string]: unknown;
  };
  /** 失败原因。 */
  error?: string;
}

/** 有超时边界的传输请求。 */
export interface RpcPending<T> {
  /** 收到对应回执时调用。 */
  resolve: (value: T) => void;
  /** 连接失败或超时时调用。 */
  reject: (error: unknown) => void;
  /** 用于清理挂起请求的计时器。 */
  timer: ReturnType<typeof setTimeout>;
}

/** App Server 按方法名关联返回类型，防止把模型页当作线程页使用。 */
export interface RpcResults {
  /** 完成能力协商。 */
  initialize: unknown;
  /** 一页线程摘要。 */
  'thread/list': {
    /** 当前页的协议条目或当前记录正文。 */
    data: CodexThread[];
    /** 读取后续一页所需的游标。 */
    nextCursor?: string | null;
  };
  /** 带可选轮次正文的线程。 */
  'thread/read': {
    /** 主机返回的线程详情。 */
    thread: CodexThread;
  };
  /** 恢复后由主机确认的线程。 */
  'thread/resume': {
    /** 主机返回的线程详情。 */
    thread: CodexThread;
  };
  /** 主机创建的线程。 */
  'thread/start': {
    /** 主机返回的线程详情。 */
    thread: CodexThread;
  };
  /** 启动后的轮次。 */
  'turn/start': {
    /** 主机返回的执行轮次。 */
    turn: CodexTurn;
  };
  /** 一页线程活动。 */
  'thread/items/list': {
    /** 当前页的协议条目或当前记录正文。 */
    data: {
      /** 执行轮次标识。 */
      turnId: string;
      /** 历史页中的单个活动。 */
      item: CodexItem;
    }[];
    /** 读取后续一页所需的游标。 */
    nextCursor?: string | null;
  };
  /** 主机模型目录。 */
  'model/list': {
    /** 当前页的协议条目或当前记录正文。 */
    data: CodexModel[];
    /** 读取后续一页所需的游标。 */
    nextCursor?: string | null;
  };
  /** 按项目归组的技能。 */
  'skills/list': {
    /** 当前页的协议条目或当前记录正文。 */
    data: {
      /** 当前项目可用的技能条目。 */
      skills: {
        /** 用于界面展示或协议寻址的名称。 */
        name: string;
        /** 文件位置或请求路径。 */
        path: string;
        /** 适合列表展示的简短说明。 */
        shortDescription?: string;
        /** 界面展示的补充说明。 */
        description?: string;
        /** 此能力或插件当前是否启用。 */
        enabled?: boolean;
        /** 主机提供的名称与说明元数据。 */
        interface?: {
          /** 提供方指定的展示名称。 */
          displayName?: string;
        };
      }[];
      /** 无法加载条目时的错误说明。 */
      errors?: {
        /** 供用户或等待方理解的说明。 */
        message: string;
      }[];
    }[];
  };
  /** 一页 MCP 服务状态。 */
  'mcpServerStatus/list': {
    /** 当前页的协议条目或当前记录正文。 */
    data: {
      /** 用于界面展示或协议寻址的名称。 */
      name: string;
      /** MCP 服务公开的名称与标题。 */
      serverInfo?: {
        /** 展示给用户的标题。 */
        title?: string;
        /** 用于界面展示或协议寻址的名称。 */
        name?: string;
      };
      /** 服务公开的工具目录。 */
      tools?: Record<string, unknown>;
      /** 服务公开的资源列表。 */
      resources?: unknown[];
      /** MCP 服务运行状态。 */
      runtimeStatus?:
        | string
        | {
            /** 决定负载解释方式的协议类别。 */
            type: string;
          };
      /** MCP 服务的认证状态。 */
      authStatus?: string;
    }[];
    /** 读取后续一页所需的游标。 */
    nextCursor?: string | null;
  };
  /** 已安装插件及加载错误。 */
  'plugin/installed': {
    /** 主机已配置的插件市场。 */
    marketplaces: {
      /** 用于界面展示或协议寻址的名称。 */
      name: string;
      /** 当前市场中的插件条目。 */
      plugins: {
        /** 用于界面展示或协议寻址的名称。 */
        name: string;
        /** 插件是否已安装到主机。 */
        installed: boolean;
        /** 此能力或插件当前是否启用。 */
        enabled: boolean;
        /** 已安装插件的本机版本。 */
        localVersion?: string;
        /** 协议或插件版本。 */
        version?: string;
        /** 主机提供的名称与说明元数据。 */
        interface?: {
          /** 提供方指定的展示名称。 */
          displayName?: string;
          /** 适合列表展示的简短说明。 */
          shortDescription?: string;
        };
      }[];
    }[];
    /** 无法读取插件市场的错误说明。 */
    marketplaceLoadErrors?: {
      /** 供用户或等待方理解的说明。 */
      message: string;
    }[];
  };
  /** 下一轮设置更新回执。 */
  'thread/settings/update': unknown;
  /** 上下文压缩受理回执。 */
  'thread/compact/start': unknown;
  /** 追加指令受理回执。 */
  'turn/steer': unknown;
  /** 停止轮次受理回执。 */
  'turn/interrupt': unknown;
}

/** 已支持通知的方法与对应负载。 */
export interface NotificationParams {
  /** 主机已最终处理审批。 */
  'serverRequest/resolved': {
    /** 关联请求与回执的标识。 */
    requestId: string | number;
  };
  /** 更新下一轮设置。 */
  'thread/settings/updated': {
    /** 主机线程标识。 */
    threadId: string;
    /** 主机返回的线程设置变更。 */
    threadSettings: ThreadSettings;
  };
  /** 新轮次开始。 */
  'turn/started': {
    /** 主机线程标识。 */
    threadId: string;
    /** 主机返回的执行轮次。 */
    turn: CodexTurn;
  };
  /** 轮次结束。 */
  'turn/completed': {
    /** 主机线程标识。 */
    threadId: string;
    /** 主机返回的执行轮次。 */
    turn: CodexTurn;
  };
  /** 助手文本增量。 */
  'item/agentMessage/delta': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 轮次内消息或工具的稳定标识。 */
    itemId: string;
    /** 本次流式文本增量。 */
    delta: string;
  };
  /** 工具或消息开始。 */
  'item/started': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 历史页中的单个活动。 */
    item: CodexItem;
  };
  /** 工具或消息结束。 */
  'item/completed': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 历史页中的单个活动。 */
    item: CodexItem;
  };
  /** 终端输出增量。 */
  'item/commandExecution/outputDelta': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 轮次内消息或工具的稳定标识。 */
    itemId: string;
    /** 本次流式文本增量。 */
    delta: string;
  };
  /** 文件差异变化。 */
  'turn/diff/updated': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 供用户审阅的文件差异。 */
    diff: string;
  };
  /** 执行计划变化。 */
  'turn/plan/updated': {
    /** 主机线程标识。 */
    threadId: string;
    /** 执行轮次标识。 */
    turnId: string;
    /** 主机执行计划的步骤列表。 */
    plan: {
      /** 该实体当前的执行或处理状态。 */
      status: string;
      /** 单个计划步骤的可读说明。 */
      step: string;
    }[];
  };
  /** 线程状态变化。 */
  'thread/status/changed': {
    /** 主机线程标识。 */
    threadId: string;
    /** 该实体当前的执行或处理状态。 */
    status: {
      /** 决定负载解释方式的协议类别。 */
      type: string;
    };
  };
  /** 主机卸载线程。 */
  'thread/closed': {
    /** 主机线程标识。 */
    threadId: string;
  };
}
/** 判别联合使方法与负载保持关联。 */
export type CodexNotification = {
  [K in keyof NotificationParams]: {
    /** 需要调用或已收到的协议方法。 */
    method: K;
    /** 与方法名对应的结构化参数。 */
    params: NotificationParams[K];
  };
}[keyof NotificationParams];

/** 桌面广播只接受本地主机且发送者为当前拥有者的状态。 */
export interface DesktopBroadcast {
  /** 协议帧类型。 */
  type: 'broadcast';
  /** 广播方法名称。 */
  method: string;
  /** 方法结构的兼容版本。 */
  version: number;
  /** 实际发送状态的客户端。 */
  sourceClientId: string;
  /** 状态或在线信息。 */
  params: {
    /** 状态归属主机，当前仅接受 local。 */
    hostId?: string;
    /** 桌面会话标识。 */
    conversationId: string;
    /** 该实体当前的执行或处理状态。 */
    status?: string;
    /** 桌面为当前接入端分配的身份。 */
    clientId?: string;
    /** 桌面传来的完整快照或增量补丁。 */
    change:
      | {
          /** 决定负载解释方式的协议类别。 */
          type: 'snapshot';
          /** 由拥有者提供的完整桌面会话状态。 */
          conversationState: DesktopState;
          /** 本次状态变化的修订号。 */
          revision: number;
        }
      | {
          /** 决定负载解释方式的协议类别。 */
          type: 'patches';
          /** 依次应用的增量状态补丁。 */
          patches: DesktopPatch[];
          /** 应用补丁前必须已持有的修订号。 */
          baseRevision: number;
          /** 本次状态变化的修订号。 */
          revision: number;
        };
  };
}
/** 进入桌面适配器的三类受支持帧。 */
export type DesktopMessage =
  | (DesktopReply & {
      /** 决定负载解释方式的协议类别。 */
      type: 'response';
    })
  | DesktopBroadcast
  | {
      /** 决定负载解释方式的协议类别。 */
      type: 'client-discovery-request';
      /** 关联请求与回执的标识。 */
      requestId: string;
    };

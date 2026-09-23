/** Claude 文件与 hook 的外部结构，适配后转换为中心领域事件。 */
/** 只描述当前适配器使用的工具输入字段。 */
export interface ToolInput {
  /** 终端命令。 */
  command?: string;
  /** 单文件路径。 */
  file_path?: string;
  /** Notebook 路径。 */
  notebook_path?: string;
  /** 目录或搜索路径。 */
  path?: string;
  /** 搜索模式。 */
  pattern?: string;
  /** 访问地址。 */
  url?: string;
  /** 工具活动说明。 */
  description?: string;
  /** 计划正文。 */
  plan?: string;
  /** 任务列表内容。 */
  todos?: unknown[];
  /** 写入的完整文件内容。 */
  content?: string;
  /** 待替换文本。 */
  old_string?: string;
  /** 替换后的文本。 */
  new_string?: string;
  /** 同一文件的多次编辑。 */
  edits?: {
    /** 编辑前需要替换的文本。 */
    old_string?: string;
    /** 编辑后的替换文本。 */
    new_string?: string;
  }[];
  /** Notebook 新单元格内容。 */
  new_source?: string;
}

/** 已知的执行成功信号，缺失时保持未知。 */
export interface ToolResponse {
  /** 进程退出码。 */
  exit_code?: number;
  /** 编辑工具成功标记。 */
  success?: boolean;
  /** 终端标准输出。 */
  stdout?: string;
  /** 增加行数。 */
  additions?: number;
  /** 删除行数。 */
  deletions?: number;
}

/** Claude hooks 通知或审批负载。 */
export interface HookPayload {
  /** hook 事件名称。 */
  hook_event_name?: string;
  /** 来源会话 ID。 */
  session_id?: string;
  /** 工作目录。 */
  cwd?: string;
  /** 工具名称。 */
  tool_name?: string;
  /** 工具输入。 */
  tool_input?: ToolInput;
  /** 工具结果。 */
  tool_response?: ToolResponse;
  /** 用户指令。 */
  prompt?: string;
  /** 任务说明。 */
  description?: string;
  /** 通知子类型。 */
  notification_type?: string;
  /** 通知正文。 */
  message?: string;
}

/** JSONL 中助手或用户的内容块。 */
export interface TranscriptBlock {
  /** 文本、思考、工具调用或工具结果。 */
  type: string;
  /** 工具调用 ID。 */
  id?: string;
  /** 工具名称。 */
  name?: string;
  /** 可显示文本。 */
  text?: string;
  /** 可显示的思考摘要。 */
  thinking?: string;
  /** 工具输入。 */
  input?: ToolInput;
  /** 工具结果关联的调用 ID。 */
  tool_use_id?: string;
  /** 工具结果是否失败。 */
  is_error?: boolean;
  /** 工具结果正文。 */
  content?: string | TranscriptBlock[];
}

/** Claude JSONL 的已使用元信息。 */
export interface TranscriptRecord {
  /** 记录类别。 */
  type: string;
  /** 工作目录。 */
  cwd?: string;
  /** ISO 时间。 */
  timestamp?: string;
  /** 主机生成的会话标题。 */
  aiTitle?: string;
  /** 最近指令摘要。 */
  lastPrompt?: string;
  /** 对话内容。 */
  message?: {
    /** 主机返回的文本或多媒体内容。 */
    content?: string | TranscriptBlock[];
  };
  /** CLI 流式事件。 */
  event?: {
    /** 决定负载解释方式的协议类别。 */
    type?: string;
    /** 本次流式文本增量。 */
    delta?: {
      /** 决定负载解释方式的协议类别。 */
      type?: string;
      /** 可直接展示的文本内容。 */
      text?: string;
    };
  };
  /** CLI 文本增量。 */
  delta?: {
    /** 决定负载解释方式的协议类别。 */
    type?: string;
    /** 可直接展示的文本内容。 */
    text?: string;
  };
  /** CLI 初始化等子事件。 */
  subtype?: string;
  /** CLI 初始化返回的实际会话 ID。 */
  session_id?: string;
}

/** 只读取 JSONL 首尾得到的轻量摘要。 */
export interface SessionMetadata {
  /** 本机会话 ID。 */
  sessionId: string;
  /** JSONL 完整路径。 */
  file: string;
  /** 会话工作目录。 */
  cwd?: string | null;
  /** 会话标题。 */
  title?: string | null;
  /** 首次用户输入时间。 */
  startedAt?: number | null;
  /** 最后活动时间。 */
  lastActivityAt?: number;
  /** 文件最后写入时间。 */
  mtimeMs?: number;
}

/** CLI 生命周期回调，异常由调用方隔离。 */
export interface ClaudeCallbacks {
  /** 获知真实会话 ID 时触发。 */
  onInit?: (id: string) => void;
  /** 累计文本发生变化时触发。 */
  onDelta?: (text: string) => void;
  /** 执行结束后传递最终文本。 */
  onDone?: (text: string) => void;
}

/** CLI 执行所需上下文，指令只经 stdin 发送。 */
export interface ClaudeRunOptions extends ClaudeCallbacks {
  /** 固定 CLI 参数。 */
  args: string[];
  /** 执行目录。 */
  cwd?: string | null;
  /** 用户指令。 */
  text: string;
  /** 用于队列和停止任务的会话 ID。 */
  requestKey?: string;
}

/** 进程退出与用户取消共同决定执行结果。 */
export interface ClaudeRunResult {
  /** 是否成功完成。 */
  ok: boolean;
  /** 累计回复。 */
  text: string;
  /** 实际会话 ID。 */
  sessionId: string | null;
  /** 进程退出码。 */
  code?: number | null;
  /** 是否由用户停止。 */
  aborted?: boolean;
  /** 失败原因。 */
  error?: string | null;
}

/** 长轮询返回的审批决定。 */
export interface GateDecision {
  /** 批准、拒绝或交回本地主机处理。 */
  decision: string;
  /** 单次或会话范围。 */
  scope: string;
  /** 拒绝或过期原因。 */
  reason?: string;
}

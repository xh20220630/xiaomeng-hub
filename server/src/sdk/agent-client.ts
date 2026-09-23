/** 通用 Agent SDK 处理接入协议，调用方通过能力处理器接入自己的执行器。 */
import type { AgentClientOptions, AgentHandlers } from '../types/sdk.js';
import type {
  AgentProfile,
  Credentials,
  AgentCommand,
  CommandReceipt,
  CommandPayload,
  RemoteProjectInput,
  RemoteSessionInput,
  EventInput,
  ApprovalInput,
  ApprovalView,
} from '../types/domain.js';
import { asError } from '../utils/errors.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 为独立 Agent 封装中心认证、心跳和命令回执，业务处理器只实现自身能力。 */
export class AgentClient {
  /** 中心服务的固定 HTTP 源地址。 */
  hubUrl: string;
  /** 仅首次注册使用的接入令牌。 */
  enrollmentToken: string | undefined;
  /** 已声明的主机身份、名称与能力。 */
  profile: AgentProfile;
  /** 按操作名注册的处理器。 */
  handlers: AgentHandlers;
  /** 后台异常报告入口。 */
  onError: (error: Error) => void;
  /** 执行通道可用时才允许领取命令。 */
  isAvailable: () => boolean;
  /** 用于复用凭据或会话映射的持久文件。 */
  stateFile: string;
  /** 实例是否正在或已经关闭。 */
  closed: boolean;
  /** 等待中心确认的操作回执，断线后重交。 */
  receipts: Map<string, CommandReceipt>;
  /** 尚未完成的命令执行 Promise。 */
  active: Set<Promise<void>>;
  /** 首次注册后复用的专用 Agent 凭据。 */
  credentials?: Credentials;
  /** SSE 接收与重连循环。 */
  streamLoop?: Promise<void>;
  /** 命令轮询循环。 */
  loop?: Promise<void>;
  /** 是否收到新的命令领取唤醒。 */
  commandPending?: boolean;
  /** 提前结束当前轮询等待。 */
  wake?: () => void;
  /** 关闭或重连时中止事件流读取。 */
  streamAbort?: AbortController;
  /** SSE 是否已建立，用于选择轮询频率。 */
  streamConnected?: boolean;
  /** 提前结束 SSE 重连等待。 */
  streamWake?: () => void;
  /** SSE 重连退避计时器。 */
  streamTimer?: ReturnType<typeof setTimeout>;
  /** 当前操作的超时或重试计时器。 */
  timer?: ReturnType<typeof setTimeout>;

  /**
   * 建立实例独立的依赖与状态，避免不同接入端互相覆盖。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.hubUrl 中心服务的固定 HTTP 源地址。
   * @param options.enrollmentToken 仅首次注册使用的接入令牌。
   * @param options.nodeId 持久主机标识。
   * @param options.nodeName 向客户端展示的主机名称。
   * @param options.agentKey 同一主机内稳定的接入端标识。
   * @param options.name 字段、能力或实体的展示名称。
   * @param options.provider 执行提供方名称，用于区分 Claude、Codex 或自定义接入端。
   * @param options.handlers 按操作名注册的处理器。
   * @param options.stateFile 用于复用凭据或会话映射的持久文件。
   * @param options.onError 后台异常报告入口。
   * @param options.isAvailable 执行通道可用时才允许领取命令。
   * @returns 已初始化但尚未连接的实例。
   */
  constructor({
    hubUrl,
    enrollmentToken,
    nodeId = os.hostname(),
    nodeName = os.hostname(),
    agentKey,
    name,
    provider = 'custom',
    handlers = {},
    stateFile,
    onError = console.error,
    isAvailable = () => true,
  }: AgentClientOptions) {
    const url = new URL(hubUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid hub URL');
    this.hubUrl = url.origin;
    this.enrollmentToken = enrollmentToken;
    this.profile = {
      nodeId,
      nodeName,
      agentKey,
      name,
      provider,
      capabilities: Object.keys(handlers),
    };
    this.handlers = handlers;
    this.onError = onError;
    this.isAvailable = isAvailable;
    const key = createHash('sha256')
      .update(`${this.hubUrl}\0${nodeId}\0${agentKey}`)
      .digest('hex')
      .slice(0, 24);
    this.stateFile = stateFile || path.join(os.homedir(), '.xiaomeng', 'agents', `${key}.json`);
    this.closed = true;
    this.receipts = new Map();
    this.active = new Set();
  }

  /**
   * 携带接入凭据调用中心接口，并将非成功状态转为可处理的错误。
   * @param endpoint 请求路径或本机 IPC 端点。
   * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
   * @param token 待验证或用于认证的凭据。
   * @returns 解码后的中心响应，类型由具体接口指定。
   */
  async request<T = unknown>(
    endpoint: string,
    body?: unknown,
    token = this.credentials?.token,
  ): Promise<T> {
    const response = await fetch(`${this.hubUrl}/agent${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.error || `HTTP ${response.status}`), {
        status: response.status,
      });
    return result as T;
  }

  /**
   * 建立执行通道并同步必要身份，后续操作才可开始。
   * @returns 操作完成的异步信号。
   */
  async connect() {
    if (!this.closed) return;
    try {
      this.credentials = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (cause) {
      const error = asError(cause);
      if (error.code !== 'ENOENT') throw error;
      this.credentials = await this.request<Credentials>(
        '/register',
        this.profile,
        this.enrollmentToken,
      );
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(this.credentials), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    await this.request('/profile', this.profile);
    this.closed = false;
    this.streamLoop = this.listenCommands();
    this.loop = this.poll();
  }

  /**
   * 唤醒轮询器，避免等下一次定时轮询才发现新命令。
   * @returns 无返回值。
   */
  notifyCommands() {
    this.commandPending = true;
    this.wake?.();
  }

  /**
   * 持续接收 SSE 唤醒信号，断线时重连并保留轮询兜底。
   * @returns 操作完成的异步信号。
   */
  async listenCommands() {
    while (!this.closed) {
      this.streamAbort = new AbortController();
      try {
        const response = await fetch(`${this.hubUrl}/agent/stream`, {
          headers: { Authorization: `Bearer ${this.credentials!.token}` },
          signal: this.streamAbort.signal,
          redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
          return;
        this.streamConnected = true;
        const decoder = new TextDecoder();
        let buffer = '';
        if (!response.body) throw new Error('Empty command stream');
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (event.includes('data: commands')) this.notifyCommands();
          }
          if (buffer.length > 65536) throw new Error('Invalid command stream');
        }
      } catch (cause) {
        const error = asError(cause);
        if (!this.closed && error.name !== 'AbortError') this.onError(asError(error));
      } finally {
        this.streamConnected = false;
      }
      if (!this.closed)
        await new Promise<void>((resolve) => {
          this.streamWake = resolve;
          this.streamTimer = setTimeout(resolve, 1500);
        });
    }
  }

  /**
   * 优先补交未确认回执，再领取新命令，保持执行结果可追踪。
   * @returns 操作完成的异步信号。
   */
  async poll() {
    while (!this.closed) {
      this.commandPending = false;
      try {
        if (!this.isAvailable()) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, 1000);
          });
          continue;
        }
        for (const [id, receipt] of this.receipts) {
          await this.request(`/commands/${id}/result`, receipt);
          this.receipts.delete(id);
        }
        const commands = await this.request<AgentCommand[]>('/commands');
        for (const command of commands) {
          const run = this.execute(command);
          this.active.add(run);
          run.finally(() => this.active.delete(run));
        }
      } catch (cause) {
        const error = asError(cause);
        this.onError(error);
      }
      if (!this.commandPending && !this.closed)
        await new Promise<void>((resolve) => {
          this.wake = () => {
            clearTimeout(this.timer);
            resolve();
          };
          this.timer = setTimeout(
            resolve,
            Math.min(
              this.streamConnected ? 5000 : 1000,
              this.credentials!.heartbeatIntervalMs || 1000,
            ),
          );
        });
    }
  }

  /**
   * 检查截止时间后调用能力处理器，并暂存回执以便网络恢复后重交。
   * @param command 待执行命令或中心命令记录。
   * @returns 操作完成的异步信号。
   */
  async execute(command: AgentCommand) {
    let receipt;
    try {
      if (command.expiresAt <= Date.now()) throw new Error('Command expired before execution');
      const handler = this.handlers[command.type as keyof AgentHandlers] as
        ((payload: CommandPayload, command: AgentCommand) => unknown) | undefined;
      if (!handler) throw new Error(`Unsupported operation: ${command.type}`);
      const result = await handler(command.payload, command);
      receipt = { ok: true, result: result ?? null };
    } catch (cause) {
      const error = asError(cause);
      receipt = { ok: false, error: String(error.message).slice(0, 2000) };
    }
    this.receipts.set(command.commandId, receipt);
    try {
      await this.request(`/commands/${command.commandId}/result`, receipt);
      this.receipts.delete(command.commandId);
    } catch (cause) {
      const error = asError(cause);
      this.onError(error);
    }
  }

  /**
   * 将主机项目和会话摘要上报给中心。
   * @param project 会话所属项目或项目摘要。
   * @param session 当前会话或二维码会话数据。
   * @returns 中心分配的项目和会话标识。
   */
  session(project: RemoteProjectInput, session: RemoteSessionInput) {
    return this.request<{
      /** 会话所属项目标识。 */
      projectId: string;
      /** 中心或主机会话标识，由所属契约确定。 */
      sessionId: string;
    }>('/sessions', { project, session });
  }
  /**
   * 向中心发布项目，使尚无会话的保存项目也能出现。
   * @param project 会话所属项目或项目摘要。
   * @returns 中心项目标识或项目查询结果。
   */
  project(project: RemoteProjectInput) {
    return this.request<{
      /** 会话所属项目标识。 */
      projectId: string;
    }>('/projects', project);
  }
  /**
   * 将事件交给领域服务处理，通知路径不等待模型执行。
   * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param type 领域事件或操作的类别。
   * @param fields 附加事件字段，包含内容和关联标识。
   * @returns 事件受理结果。
   */
  event(sessionId: string, type: string, fields: EventInput = {}) {
    return this.request('/events', { eventId: randomUUID(), ...fields, sessionId, type });
  }
  /**
   * 创建有明确有效期限的远程审批请求。
   * @param fields 附加事件字段，包含内容和关联标识。
   * @returns 中心审批信息。
   */
  approval(fields: ApprovalInput) {
    return this.request<ApprovalView>('/approvals', fields);
  }
  /**
   * 依据审批归属选择本机 gate 或远程回执流程。
   * @param id 待处理实体的稳定标识。
   * @param status 本次保存或验证的状态。
   * @returns 已受理命令或已确定的审批状态。
   */
  resolveApproval(id: string, status = 'expired') {
    return this.request(`/approvals/${encodeURIComponent(id)}/resolve`, { status });
  }

  /**
   * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
   * @returns 操作完成的异步信号。
   */
  async close() {
    this.closed = true;
    this.streamAbort?.abort();
    clearTimeout(this.streamTimer);
    this.streamWake?.();
    clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    await this.streamLoop;
    await Promise.allSettled([...this.active]);
  }
}
